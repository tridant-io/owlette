# swoop draft plan — delivery review (adversarial, 2026-09-17)

Reviewer brief: will this plan get built and shipped to a fleet of unattended Windows machines
without breaking them? Findings are ranked by likelihood × damage. Every finding cites a file:line
or a plan section and names the concrete change (task added / split / moved, wave re-cut, gate, label).

---

## Rank 1 — fix before the plan is approved

### F1. The doorbell under `ConnectionManager` turns a Cloudflare outage into a fleet-wide Firestore reconnect storm

**Evidence.** `connection_manager.py:765-786` — `_watchdog_loop` scans `_supervised_threads` every
`WATCHDOG_INTERVAL = 10.0` s (`:217`) and, on *any* dead supervised thread, calls
`report_error(Exception(f"Supervised threads died: {dead_threads}"), context="Watchdog")`.
`report_error` (`:436-472`) sets `ConnectionState.DISCONNECTED` and calls `_trigger_reconnect` — on
the **Firestore** connection. `FAILURE_THRESHOLD = 5` opens the circuit (`:210`), `BACKOFF_BASE = 30.0`
→ `BACKOFF_MAX = 3600.0` (`:205-206`). The plan asks for exactly this wiring: §6 spike 0.5 says
"python `websocket-client` doorbell thread prototype **under ConnectionManager**", and §1 cites the
guardrail "Never spawn reconnection logic outside `ConnectionManager`".

**Damage.** A Cloudflare Worker incident (or a TLS/DNS failure to the signal origin) kills the doorbell
thread on every machine in the fleet simultaneously. Ten seconds later every agent reports a
connection error it did not have, drops to DISCONNECTED, and re-establishes Firestore. Repeat every
10 s until the circuit opens, then every 30 s–1 h. Nothing about Firestore was wrong. This is the
single highest-damage line in the draft because it converts a dependency the fleet does not need into
one it cannot survive.

**Why the guardrail does not actually require it.** `ConnectionManager` is not a generic socket
supervisor — its state *is* the Firestore connection's state (`firebase_client.py:865-871`:
`connection_manager.force_reconnect("Metrics loop detected disconnect")`). The guardrail exists so
nobody writes a second reconnect loop *for Firestore*. A second transport with a different failure
domain is not what it was written about.

**Concrete change.**
1. Add a Wave-1 decision task: **"D-doorbell: failure-domain rule"** — the doorbell owns its own
   backoff inside `swoop_doorbell.py`, is **never** passed to `ConnectionManager.register_thread`
   (`:698-706`), and **never** calls `report_error`. It may *read* `connection_manager.state` to avoid
   dialling while the machine is offline.
2. Add this to the plan's §1 guardrail list as an explicit, reasoned exception so a fresh agent in
   Wave 2 does not "fix" it back.
3. Spike 0.5's pass criteria gain: with the Worker unreachable for 10 minutes, the agent's
   `ConnectionState` never leaves CONNECTED and no extra Firestore reconnect is logged.
4. Flag to the owner — it reads as an exception to a named guardrail and needs a ruling on record.

### F2. The kill switch cannot meet "≤ 7 s (poll)", and the polled fallback cannot meet "first frame ≤ 3 s"

**Evidence.** `firestore_rest_client.py:518-580` — document watching is *adaptive polling*:
`min_interval: float = 2.0`, `max_interval: float = 30.0`, backing off by `backoff_multiplier`
toward 30 s **when idle**. An idle machine (the state every machine is in before a session starts,
and during a session with no command writes) is polling at 30 s, not 2–5 s. The draft asserts
"enqueue a fallback command (polled 2-5 s)" (§3) and "kill switch ends a live session in ≤ 2 s
(doorbell) / ≤ 7 s (poll)" (§7).

Second mechanism, same finding: `firebase_client.py:1570` —
`_FAST_COMMAND_TYPES = frozenset({'mcp_tool_call', 'capture_screenshot', 'cancel_sync', 'cancel_mcp_tool'})`.
Anything not in that set goes to the **single** `_slow_command_queue` worker (`:1589-1596`), behind an
in-flight install or self-update. A swoop kill command on the slow lane can wait ten minutes.

**Damage.** "Kill switch" is a security-posture claim in §7 that will end up in docs and in a sales
conversation. Shipping a 30-second-to-ten-minute kill switch described as ≤ 7 s is the kind of claim
that is only discovered when it matters.

**Concrete change.**
1. Make the **signaling room the authoritative kill path**: the streamer already holds a host WSS to
   the Durable Object, so a `kill` frame reaches a live session in one RTT. The polled command path
   then only has to cover "no streamer is running", where latency does not matter.
2. Restate §7 as: **≤ 2 s while a session is live (host WSS), ≤ 2 s cold with a warm doorbell, ≤ 35 s
   on the polled fallback.** Say plainly in §3 that the doorbell is load-bearing for the start-up
   criterion, not an optimisation — "≤ 3 s relayed" is unreachable on a 30 s poll.
3. Add `swoop_*` command types to `_FAST_COMMAND_TYPES`. **Put that edit in Task 2.2**, which already
   owns `firebase_client.py` — not in 2.7, or two same-wave agents collide on one file
   (`.claude/commands/plan.md:35`, `.claude/commands/execute.md:91`).

### F3. Removing legacy live view in the release that ships swoop strands the entire fleet

**Evidence.** Web deploys on push to `dev`/`main` (CLAUDE.md → Deployment); agents update on their own
schedule. §4 T14 + Wave 8.1/8.2 remove live view "when swoop ships", with the mitigation being a
*disabled* menu item for old agents. Surfaces confirmed: `web/app/api/sites/[siteId]/machines/[machineId]/commands/route.ts:177,351-352`,
`web/lib/actions/executeMachineCommand.server.ts:31-32`, `web/hooks/useFirestore.ts:1745-1749,290`,
`web/components/LiveViewModal.tsx`, `web/components/MachineContextMenu.tsx:49,68,325`,
`cli/src/commands/machine.ts`, `agent/src/owlette_service.py:5382-5386,7268-7315`.

**Damage.** At the moment `main` deploys, every machine that has not yet self-updated — i.e. the whole
fleet — has no live view and no swoop. That is a total loss of visual observability for signage and
kiosk boxes during the exact window when a new agent version is rolling out and you most want to look
at them.

**Precedent already ruled by the owner.** `dev/active/tri-platform-agent/decisions.md:28` (Q20):
retiring `POST /api/agent/screenshot` on the web side was **RULED hold** "until the 3.4 agent is the
fleet floor", with the deletion lifted into a shelved patch. Same shape, same answer.

**Concrete change.** Split 8.1:
- **8.1a (this release)**: add the swoop entry; keep the live-view item rendered for machines with
  `capabilities.swoop != 1`. Dual affordance, no removal.
- **8.1b (a later release)**: removal, gated on a fleet-floor check. The agent half (8.2) may land
  first — agent-removes/web-keeps is harmless; web-removes/agent-keeps is the harmful direction.
- Success criteria gain: **"no machine loses both live view and swoop at any point in the rollout."**

### F4. Wave 3 is not executable by fresh-context agents

**Evidence.** `.claude/commands/execute.md:25-33` — one `general-purpose` agent per task, prompt =
**Do** + **Files** + **Done when** + "read CLAUDE.md", no conversation context. `:60` — the between-wave
build check is `npx tsc --noEmit` and `python -m py_compile src/*.py`. **There is no `cargo` in it.**
Wave 3 as drafted is 14 parallel tasks including 3.8 (str0m + framing + pacing + an app-level rate
governor) and 3.13 (reassembly + `VideoDecoder` + canvas + feedback + capability probe).

**Damage.** Seven fresh agents can land seven non-compiling Rust modules and `/execute` will report
"Build status: pass". The wave then has to be re-opened by hand, which is the exact context-rot the
workflow exists to prevent.

**Concrete change.**
1. Every Rust task's **Done when** must include `cargo clippy -- -D warnings && cargo test`, run with
   **`working-directory: agent/swoop`** — never `--manifest-path` from the repo root, which drops the
   crate's `.cargo/config.toml` and with it `+crt-static` (the trap tri-platform already documents at
   `dev/active/tri-platform-agent/tasks.md:287`, and the reason `agent/host/.cargo/config.toml` exists
   at all — the VCRUNTIME140 fleet failure 3.2.3 shipped to fix).
2. Split 3.8 → **3.8a** framing + per-viewer sink (spec-driven, testable against 1.1's golden vectors,
   no network) and **3.8b** str0m session / ICE / DTLS / data-channel wiring. Split 3.13 → reassembly
   + decode + canvas, and feedback + governor.
3. Add a **Wave-2 task for the shared GPU types** (`gpu::Device`, `Frame`/texture handle, sync
   primitive). 3.5 (dda), 3.6 (nvenc) and 3.7 (convert/scale) all need a D3D11 device and a frame
   type; "one directory each" does not stop three parallel agents inventing three incompatible ones.
   This is the one place the otherwise-good "scaffold every stub up front" convention does not hold:
   a stub file does not fix a shared *type*.

---

## Rank 2

### F5. The security-alert release gate goes red the first time a swoop dependency has an advisory

**Evidence.** `scripts/check-security-alerts.mjs:278-283` hardcodes the manifest list:
`rust`/`cargo` → `['agent/host/Cargo.lock', 'desktop/src-tauri/Cargo.lock']`; npm →
`['package-lock.json', 'web/package-lock.json', 'functions/package-lock.json', 'desktop/package-lock.json']`.
`.github/dependabot.yml:65-71` — the `cargo` ecosystem's `directories` are `/agent/host` and
`/desktop/src-tauri` only. `.claude/skills/build-system.md:57-60` — an alert this checkout **cannot
resolve (`UNRESOLVED`) is BLOCKING**, and "a check that cannot run is itself a blocker".

**Damage.** A GHSA against `rustls`, `str0m` or any of the ~200 transitive crates resolves as
UNRESOLVED → exit 1 → **every installer release is blocked** until someone edits the script. Worse in
the other direction: those crates get no Dependabot PRs at all, so the swoop dependency tree silently
rots — the precise failure the dependency-currency policy was written for.

**Concrete change.** Task 1.2 also adds `agent/swoop/Cargo.lock` to `ECOSYSTEM_MANIFESTS` **and** to
`dependabot.yml`'s cargo `directories`. Task 1.4 does the same for
`infra/swoop-signal/package-lock.json` in the npm entries. Done-when for both:
`node scripts/check-security-alerts.mjs` exits 0 with the new lockfile present. Additionally, the
`websocket-client` pin in Task 2.3 must carry a **written reason and exit condition** (CLAUDE.md →
Dependency Currency), and the Rust pins must too — `str0m` especially, which the plan itself calls
"thin production evidence".

### F6. The signaling Worker has no deploy, secret or rotation owner

**Evidence.** Wave 1.4 creates `infra/swoop-signal/` (Worker, DO, JWT verify, vitest). Wave 1.5 adds
"env manifest entries + `web/proxy.ts`". **No task deploys the Worker.** `scripts/env-manifest.json`
has exactly three targets (`railway-dev`, `railway-prod`, `vercel-prod`), `mirror:
[["railway-prod","vercel-prod"]]`, and a `must-match` class defined as "Sensitive AND silently
catastrophic if it differs between mirror targets".

**Damage.** `owlette.app` sits behind a Cloudflare LB with Vercel as a failover origin
(CLAUDE.md → Deployment). If the EdDSA signing key differs between `railway-prod` and `vercel-prod`,
viewer JWTs minted on one origin fail verification at the Worker after a failover — intermittent,
origin-dependent, and invisible in logs that do not record which origin served the mint. That is the
textbook definition of the `must-match` class.

**Concrete change.**
1. Add **Task 1.6 — swoop-signal deploy pipeline**: `wrangler.toml` with `env.dev` / `env.prod`,
   secrets via `wrangler secret put` (never in the repo), a GitHub Action, and a `/health` route.
2. Classify the swoop JWT signing key as **`must-match`** in `scripts/env-manifest.json`, not `secret`.
3. Add key rotation to 1.4's Do: the Worker verifies against **two** active public keys so a rotation
   is not a flag day. The streamer verifies independently (§4 T8) — it gets the key in the bundle, so
   it inherits rotation for free, but only if the bundle carries the *current* key id.

### F7. The streamer will be replaced while running, and the uninstall leaves machine-wide state behind

**Evidence.** `agent/owlette_installer.iss:98-99` — `CloseApplications=force`, `RestartApplications=no`.
The `InitializeSetup` kill pass (`:1140-1200`) covers `owlette-host`, `nssm`, `owlette-desktop`,
`python`, `pythonw` — **by name, scoped by `.Path -like '*\Owlette\*'`**, never by PID. The comment at
`:1171-1177` explains why Restart Manager misses it: "Restart Manager sees a process running in the
interactive session while Setup is elevated". A SYSTEM streamer in the console session is the same
class of miss. The comment at `:1155-1160` records the consequence of a miss: Inno "will schedule the
locked files for next-reboot replacement (`MoveFileEx DELAY_UNTIL_REBOOT`) **in silent mode** instead
of replacing them immediately, leaving the agent on the old version."

`[UninstallRun]` (`:446-468`) stops the desktop app, deregisters the service, retires the WinRing0
services and removes the Defender exclusions. There is **no `[UninstallDelete]` section**, and
`grep -rn "netsh|SoftwareSASGeneration" agent/` returns nothing — so neither the inbound-UDP firewall
rule (§4 T9) nor the `SoftwareSASGeneration` policy (§4 T2) has any cleanup path.

**Damage.** (a) A self-update while a session is live leaves a NEW python agent talking to an OLD
`owlette-swoop.exe` until the next reboot — a protocol mismatch on a machine nobody is standing next
to. (b) Uninstalling owlette leaves `SoftwareSASGeneration=1` behind, which permits any process on
that machine to synthesise Ctrl+Alt+Del, plus an inbound-UDP allow rule pointing at a deleted exe.
Both are machine-wide changes made by a product that is no longer installed.

**Concrete change.**
1. T13 / Task 2.6: change "pre-kills a running streamer **by PID**" to **kill by name scoped to the
   install path**, mirroring the desktop-app block at `:1176-1184`. A PID read from
   `tmp/swoop_status.json` can be stale or recycled; the existing pattern already works and is
   already reviewed.
2. Add a **protocol-version field to the streamer handshake**, and have `swoop_manager` refuse a
   mismatched binary with a typed `endReason` rather than let it mis-speak. This is the belt for the
   DELAY_UNTIL_REBOOT case the .iss comment says will happen in silent mode.
3. Add a Wave-7 task: **uninstall cleanup** — remove the firewall rule and revert
   `SoftwareSASGeneration` in `[UninstallRun]`, and add `logs/swoop` / `ipc/swoop` to the uninstall
   sweep. State in the task that `owlette_installer.iss` is a guardrailed file (CLAUDE.md) and that
   both 2.6 and this task need the owner's explicit ack before an agent touches it.
4. Upgrade-path note the plan gets *right* and should say out loud: because the **new** installer is
   what runs on the old box, putting the pre-kill in the .iss does cover every fielded version. Write
   that sentence into T13 so a reviewer does not re-litigate it.

### F8. `build-installer.yml` will time out

**Evidence.** `.github/workflows/build-installer.yml` — `build` job has `timeout-minutes: 30`.
`build_installer_full.bat` already runs two cargo release builds ([6/9] the Tauri desktop app,
[7/9] the host — `:196-304`) plus the full Python payload, and the workflow has **no cargo cache
step**. Adding a third crate with str0m, rustls, a TURN client and NVENC FFI, cold, on
`windows-latest`, does not fit.

**Concrete change.** Task 2.6 raises the timeout, adds a cargo cache (`Swatinem/rust-cache`, pinned to
a SHA like everything else in this repo), **or** prebuilds `owlette-swoop.exe` in `rust-build.yml` and
downloads it as an artifact. The acceptance number is the cold-cache build time measured in spike 0.2
— make that an explicit output of 0.2.

Also worth stating as verified: the SLSA subject stays a single file, so T13's
"sign before the subject-hashing step" is exactly what `build-installer.yml:21-25` demands. No conflict.

### F9. Defender: the release profile is a settled decision the plan must inherit verbatim

**Evidence.** `agent/host/Cargo.toml` `[profile.release]` — `opt-level = 2`, `lto = "thin"`,
`strip = false`, with a comment recording that on 2026-09-08 Defender signature set 1.459.111.0
quarantined the size-optimised build as `Trojan:Win32/Bearfoos.B!ml` and **deregistered
OwletteService on the way out**. The same comment mandates: "A rebuilt candidate must be scanned
(`MpCmdRun -Scan -ScanType 3 -File <copy> -DisableRemediation`) before it is packaged".
`build_installer_full.bat:421-424` already fails the build with "Check Windows Security protection
history for owlette-host.exe" when the host exe is missing. `agent/host/.cargo/config.toml` keeps
`+crt-static` deliberately.

The draft's §2 recovered contract mentions VERSIONINFO + icon via build.rs and names Bearfoos — but
not the profile, not the `+crt-static` rationale beyond one clause, and not the scan gate.

**Concrete change.** Task 1.2's Cargo.toml copies the `[profile.release]` block **and its comment**.
Task 2.6 adds the same missing-file guard and the `MpCmdRun` scan step for `owlette-swoop.exe`. A
SYSTEM binary that hooks low-level input and duplicates the desktop is a *worse* static profile for an
ML classifier than a supervisor that sleeps, not a better one — the risk here is higher than the one
that already bit, and the fix until signing lands is the same.

---

## Rank 3

### F10. Wave 2 has silent intra-wave dependencies

2.2 (`swoop_capability.py`) needs the binary-path helper 2.1 adds to `shared_utils.py`; 2.3 (doorbell)
needs 2.1's `ipc/swoop` path constants; 2.7 (`swoop_commands.py`) must call into `swoop_manager`
(2.1). `.claude/commands/plan.md:35` — "Tasks within a wave have no dependencies on each other."

**Concrete change.** Move the `shared_utils.py` additions — path constants plus the
`ensure_data_directories` entries (`shared_utils.py:797-806`) for `ipc/swoop` and `logs/swoop` — into
**Wave 1** as a small task. 2.1 keeps the manager and spawn logic. 2.2 / 2.3 / 2.7 then genuinely have
no sibling dependency. (Note this also matches tri-platform `tasks.md:112`, where `ensure_data_directories`
creating `ipc/swoop/` and `logs/swoop/` is already assigned — one of the two plans must own it and the
other must not re-add it.)

### F11. `logs/swoop/` is never cleaned up

**Evidence.** `shared_utils.py:1097-1138` — `cleanup_old_logs` iterates
`os.listdir(get_data_path('logs'))` and `continue`s on anything that is not a file. Subdirectories are
skipped entirely, so nothing under `logs/swoop/` is ever aged out. `rotate_log_if_oversized`
(`:1145-1174`) is a one-shot rename for externally-appended files, not a rotation policy.

**Damage.** A 24/7 signage box with per-session streamer logs and per-frame timestamp telemetry
accumulates forever on the same volume as the agent. The `_handle_update_owlette` disk check refuses a
self-update below 500 MB free (`owlette_service.py:4985-4989`) — so this eventually blocks upgrades.

**Concrete change.** The task that creates `logs/swoop/` also extends `cleanup_old_logs` to walk one
level down (or adds the swoop directory to the scan), and the streamer uses a size-capped rotating
writer with an explicit cap named in the task. One line each; zero cost now, painful later.

### F12. Hidden work no task owns

- **Keyboard layout / IME / dead keys.** §1 names only "Cmd conversion"; Task 3.14 is "input + keymap".
  A German or French client keyboard against a US-layout host, or any IME, needs `ToUnicodeEx` with the
  host's `HKL`, dead-key state handling, and a `VK_PACKET` fallback for characters the host layout
  cannot produce. Fold this into 3.14's **Do**, explicitly.
- **Multi-monitor coordinate mapping.** Task 5.4 is "output picker, giant-canvas downscale policy,
  headless detection message". Nothing covers the virtual-desktop → output → client-canvas transform.
  Monitors left of or above the primary have **negative** virtual-desktop coordinates, and per-monitor
  DPI means the injection coordinate is not the capture coordinate. Add a 5.4 sub-item with a unit
  test over a negative-origin, mixed-DPI, mixed-refresh layout — this is a classic and it is invisible
  on a single-monitor dev box.
- **Cursor hotspot at non-100% scaling** — `GetFramePointerShape` gives the hotspot in host pixels;
  the plan's "synced visible cursor" needs the same transform. Same sub-item.
- **Time base for the latency telemetry.** §4 T12 says "every frame carries capture/encode/send
  timestamps so the stats overlay can show a per-stage breakdown". Host QPC and browser
  `performance.now()` share no epoch. Spike 0.1's memo must state the offset-estimation method
  (an NTP-style exchange over the control channel) or every per-stage number in the overlay is a
  guess with a plausible-looking decimal point.
- **Crash dumps / support diagnostics** for a SYSTEM process that will crash on somebody's Intel iGPU.
  Nothing collects them. One line in 4.1 (write a minidump into `logs/swoop/` on unhandled panic).
- **Docs + privacy copy.** A feature that streams a machine's screen and injects input needs a docs
  page and a privacy statement, in lowercase (CLAUDE.md → UI Copy Style). Add to 8.3's Do.
- **Pricing / plan gating** — name it in the backlog rather than leaving it implicit.

### F13. `capabilities.swoop` cannot be computed on `dev` as C3 specifies

**Evidence.** Cross-plan rule C3 (`dev/active/tri-platform-agent/plan.md:238`) and tri-platform
`tasks.md:273` define `streamer_capable()` inside `agent/src/osadapter/`. **`agent/src/` has no
`osadapter` package on `dev`** — it lives only on the tri-platform branches, whose Wave 4 was in
flight when it was destroyed (`dev/active/tri-platform-agent/README.md:20-25`). The draft's §2
recovered contract and Task 2.2 both AND against it.

**Concrete change.** Task 2.2 ships a local `swoop_capability.streamer_capable()` (Windows: binary
present) and writes `capabilities.swoop` as a **separate dotted key** per C3. Tri-platform's 4.4
re-points it at `osadapter` when that lands. Record it as a one-line amendment to C3 **in both plans**
so neither plan's fresh agent "fixes" the other's. C3's other constraints hold and must be honoured
verbatim: dotted keys only (a whole-map `capabilities: {...}` write drops `displayRemoteApply` —
`firebase_client.py:1536`), and **absent is Windows** on the reader side. The draft's 4.3 correctly
gates the menu on `capabilities.swoop`, never on `osFamily`; keep it that way.

### F14. C2 vs the SYSTEM-token spawn: no contradiction, but the Wave 9 seam is mis-scoped

C2 (`dev/active/tri-platform-agent/plan.md:213-225`) says only "the service spawns
`owlette-swoop.exe` via `CreateProcessAsUser` with the session bundle on stdin (swoop decision 3)".
It does not name a token. §4 T2's retargeted-SYSTEM-token reading is compatible — **no reconciliation
needed**, and the draft should say so explicitly so nobody re-opens it.

But the *shapes* differ in a way Wave 9 does not capture. On Windows the streamer is a child of the
service (SYSTEM, console session). On macOS/Linux it is a child of the **user's desktop app**, because
C2's whole point is inheriting the bundle's TCC responsibility. So 9.1's `#[cfg]` seams must abstract
**"who owns my lifetime, and where does my bundle come from"** (Job Object + stdin pipe vs job-file
`stdin_path` + parent app), not just capture/encode/input. Add that clause to 9.1's Do. Also note
tri-platform `tasks.md:362` records its Wave 8 as **NOT STARTED**, so nothing is blocked in either
direction today — and its amended decision 12 for macOS is **Apple silicon only, macOS 15.0 floor**,
so do not plan a macOS x86_64 streamer backend.

### F15. Playwright cannot decode H.264, and spike 0.7 is not automatable

**Evidence.** `.github/workflows/e2e.yml:99` — `npx playwright install chromium`.
`web/playwright.config.ts:53-95` — three projects, all `devices['Desktop Chrome']`, **no
`channel: 'chrome'`**. Playwright's bundled Chromium is a plain Chromium build, which by documented
limitation ships without proprietary codecs (H.264/AAC). Task 8.5 feeds "canned H.264 chunks" into an
in-browser fake host peer.

**Concrete change.** Decide this inside spike 0.7 and write the answer into 8.5's **Do**: either add a
`channel: 'chrome'` project plus `npx playwright install chrome` in `e2e.yml`, or use VP8/AV1 canned
chunks for the CI spec, or assert at the reassembly boundary with a stubbed `VideoDecoder` and leave
real decode to the manual matrix. Note this is **not verified here** — see "could not verify".

**Labels the plan is missing entirely.** These tasks cannot be done by an agent and must be marked
**human / hardware / account action** so `/execute` never spawns an agent at them:
0.1 (physical flash-target measurement), 0.2 (dev-box GPU), 0.3 (secure desktop, real logon screen),
0.6 (Cloudflare account + metered billing), 0.7 (four browsers × three OSes + soak), the Wave-4
capture-edge-case spike (TouchDesigner, Mosaic, hybrid GPU, HDR, RDP), the Wave-5 encoder-breadth
spike (Intel/AMD hardware), 2.8 + 8.4 (Azure Trusted Signing identity — the draft already notes the
lead time; make it a labelled owner action with a date), and 8.6 (pilot).

### F16. "changelog" is two files

`.claude/skills/build-system.md:82` — "**BOTH changelogs, always.** `docs/changelog.md` is internal;
`web/content/docs/changelog.mdx` is the one customers actually read at `/docs/changelog`." Wave 8.3
and §4 T13 say "changelog", singular. Name both, in both places.

### F17. `sync-versions.js` pattern detail

`scripts/sync-versions.js:32` — `CARGO_VERSION_PATTERN = /^(version = ")(\d+\.\d+\.\d+)(")/m`, and
`writeCargoVersion` uses `String.replace` with a non-global regex: it rewrites the **first** match
only. Task 1.2 must keep `[package] version` as the first line in `agent/swoop/Cargo.toml` matching
`^version = "X.Y.Z"` — i.e. no `[dependencies.foo]` table with a three-component `version = "..."`
above it. One sentence in the task; otherwise a release silently stamps a dependency's version into
the crate.

---

## What I tried to break and could not

**T11 "no `firestore.rules` change needed" — verified, and stronger than the draft claims.** The only
recursive wildcard in the file is `match /{path=**}/members/{memberUid}` (`firestore.rules:246`),
which matches a collection literally named `members` at any depth — `swoop_sessions` does not collide.
`match /sites/{siteId}/machines/{machineId}` (`:277`) is a document match, and Firestore rules do not
cascade to subcollections without a recursive wildcard. The terminal
`match /{document=**} { allow read, write: if false; }` (`:938-941`) therefore denies
`sites/{s}/machines/{m}/swoop_sessions/{sid}` to every client, and the Admin SDK bypasses rules
entirely. **The denial is explicit, not incidental.**
*Concrete refinement:* the draft's "a task verifies that no existing wildcard rule exposes the new
subcollection" should become a **test in `web/__tests__/rules/`** — the existing 115-test suite
(`.claude/commands/preflight.md:50`, `npm run test:rules`) — asserting member, site-admin and agent
are all denied on `swoop_sessions`. That pins it against a future wildcard without touching the
guardrailed file.

**The `_get_elevated_install_token` claim — the primitive really is in the tree.**
`owlette_service.py:2777-2825` does exactly what §4 T2 describes: `OpenProcessToken` →
`DuplicateTokenEx(TokenPrimary)` → `SetTokenInformation(..., 12 /* TokenSessionId */, ...)` →
`CreateEnvironmentBlock`. No `runas`, no `ShellExecute` verb, no elevation prompt — the UAC guardrail
is honoured in principle by this design. **The part that is not there** is the stdin pipe:
`_launch_command_as_user` (`:2829-2865`) passes `bInheritHandles = 0` at `:2851` and sets no
`STARTF_USESTDHANDLES`. Spike 0.3 must prove the inheritable-read-end variant across a session
boundary, not assume it; add that to 0.3's pass criteria.

**The "scaffold every stub up front" convention — sound where it matters.** Task 1.1 (PROTOCOL.md +
golden vectors in `agent/swoop/testdata/`) gives 3.8a and 3.13 a shared oracle they can each test
against with no coordination. That is the right design for parallel fresh-context agents and it is the
strongest structural idea in the draft. It fails only on shared *types* (F4.3), not on shared files.

**No-workspace / `+crt-static` / per-crate `working-directory` — consistent.** §2's contract matches
`agent/host/Cargo.toml`'s `[workspace]` stanza, `agent/host/.cargo/config.toml`, and tri-platform
`tasks.md:287`. No conflict.

**Signing before SLSA hashing** — §4 T13 matches `build-installer.yml:21-25` exactly. The SLSA subject
construction (`"<hex>␣␣<filename>"`) stays a single subject, so nothing else in that workflow moves.

**Wave 9 vs tri-platform Wave 8** — the dependency direction is right (swoop leaves `#[cfg]` seams,
tri-platform fills them), and tri-platform `tasks.md:362` records its Wave 8 as NOT STARTED, so
neither plan blocks the other today.

**`_FAST_COMMAND_TYPES` / slow-lane discipline and the 5 s loop** — the plan's "manager runs in its own
thread" (2.1) and "emits `log_event`" is the right shape; it mirrors `_process_cortex_ipc_commands`
(`owlette_service.py:2253-2300`), which exists precisely because a 55 s screenshot once stalled the
loop. Nothing in the draft puts blocking work on the tick.

---

## Could not verify

- **Playwright's bundled-Chromium codec set (F15).** I did not run it. The claim rests on Playwright's
  documented limitation, not on a measurement in this repo. Treat F15 as "0.7 must measure it",
  not as established.
- **`swoop_sessions` behaviour under the deployed rules.** I read `firestore.rules` on `dev` and
  reasoned from the rules model; I did not run `npm run test:rules`.
- **Live state on dev/prod.** I did not query the API. `grep -rn swoop` across `web/ agent/ cli/
  desktop/ infra/ scripts/ .github/` returns nothing, so there is no deployed surface to compare
  against — but that is repo evidence, not API evidence.
- **The tri-platform on-disk worktrees** (`<local worktree>\Owlette-wt-tri-w4a` / `-w4b`,
  per `dev/active/tri-platform-agent/README.md:20-25`). Not read. If `jobrunner.rs` already implements
  the `launch` job type with `stdin_path`, part of C2's POSIX half may already exist and Wave 9's
  estimate changes.
- **Everything external.** str0m's feature set and interop record, the moonlight-web / Parsec /
  Stadia latency figures, the Cloudflare TURN billing asymmetry, the NVENC
  `bitstreamRestrictionFlag` claim, Edge's HEVC-in-WebRTC gap, and the HEVC patent position. This
  review takes §4 as given; none of it was checked.

---

## Proposed wave re-cut

Goal: reach the **first real end-to-end session** one wave earlier, and get the *internal* pilot in
front of the owner without dropping anything in §1.

Everything in §1 stays in the first release. What moves is the ordering of work that is not on the
path to a first picture.

**Wave 0 (spikes)** — unchanged, plus:
- label 0.1 / 0.2 / 0.3 / 0.6 / 0.7 and both hardware-gated spikes **human / hardware**;
- add **0.4 doorbell failure-domain decision** (F1), with a Worker-down test;
- add **0.8 cleanup + side-effect inventory** (firewall rule, SAS policy, ipc/logs dirs, uninstall) —
  feeds the Wave-7 uninstall task (F7);
- 0.2 additionally outputs the **cold-cache Rust build time** (F8) and the **MSRV floor**;
- Azure Trusted Signing identity validation starts now as a labelled **owner action with a date**.

**Wave 1 (contracts + scaffolds)** — as drafted, plus:
- move the `shared_utils.py` swoop paths + `ensure_data_directories` entries here (F10);
- **1.6 swoop-signal deploy pipeline** — wrangler environments, secrets, action, `/health` (F6);
- 1.2 and 1.4 each add their lockfile to `check-security-alerts.mjs` and `dependabot.yml` (F5);
- 1.2 copies `agent/host`'s `[profile.release]` verbatim (F9).

**Wave 2 (agent integration, server libs, CI)** — as drafted, plus:
- **2.0 shared GPU types** (`gpu::Device`, `Frame`) so 3.5/3.6/3.7 do not each invent one (F4.3);
- 2.2 owns the `_FAST_COMMAND_TYPES` edit (F2.3);
- 2.6 raises the CI timeout, adds a cargo cache, adds the MpCmdRun scan + missing-file guard, and
  kills the streamer **by name scoped to the install path** (F7, F8, F9);
- owner ack recorded for the `.iss` edits before the wave runs.

**Wave 3a (first picture)** — the thinnest vertical slice: capture/dda, encode/nvenc, gpu convert,
**3.8a framing + sink**, signal client, web signaling + peer, web reassembly + decode + canvas.
**Gate: a frame reaches a canvas over a real signaling round trip on the dev box.** This is the first
end-to-end session and it lands a full wave earlier than the draft's Wave 4.

**Wave 3b + 4 (control loop + product surface)** — input, cursor, keymap (with layout/IME per F12),
**3.8b str0m session/ICE/DTLS**, feedback + governor, viewer lifecycle, linger, status file, exit
codes, the swoop page + toolbar + stats, the dashboard entry, the capture edge-case spike.
**Gate: the 0.2 thresholds, end to end, through the real API and Worker.**

**Wave 5 (pilot-blocking security + the secure desktop)** — 5.1 secure desktop + Ctrl+Alt+Del, 5.2
clipboard, 5.3 audio, 5.4 displays (+ the coordinate transform per F12), 5.5 quality, **plus, moved up
from Wave 7**: site enablement + kill switch (7.5), step-up auth on control-session create (7.6), and
the audit row. These are the owner's "default off, step-up, audit, kill switch" requirement and they
gate letting anyone but the owner near it.
**This is the internal-pilot gate.** One viewer, the owner's own machines, LAN, unsigned.

**Wave 6 (every GPU)** — as drafted (MF MFT, software floor, selection chain, `probe`). Required
before customers; not before the internal pilot.

**Wave 7 (network + remaining hardening)** — host-side TURN (UDP then TLS 443), ICE policy, relay caps
and degraded mode, firewall + SAS side effects **and their uninstall cleanup** (F7.3), multi-user
(moved down from 5.6), encoder tiers for mixed viewers (moved down from 6.4), tray indicator,
logs registry group + metering.

**Wave 8 (integration + release)** — **8.1a add-only** (swoop entry alongside live view, F3), 8.2 agent
removal, 8.3 API enum / OpenAPI / CLI / docs / **both changelogs** (F16) / privacy copy, 8.4 signing,
8.5 e2e with the F15 decision baked in, 8.6 pilot + release.

**Wave 8b (a later release)** — legacy live-view removal, gated on the fleet floor, per the Q20
precedent (F3).

**Wave 9** — as drafted, plus the "who owns my lifetime and my stdin" seam (F14).

Net effect: first picture moves from Wave 4 to Wave 3a; the internal pilot becomes a named gate at the
end of Wave 5 instead of an implicit one at 8.6; multi-user, mixed-codec tiers, TURN-over-TLS,
metering and the tray indicator move behind it; and nothing in §1 is dropped.
