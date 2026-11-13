# desktop-sync — bidirectional desktop ↔ web config sync

The only suite in the repo where **a real agent process is a participant**, not a
mock. `python owlette_runner.py` runs for the whole session against a scratch
`%PROGRAMDATA%` in the OS temp dir, holding an Auth-emulator token with agent
claims, writing through the real `firestore.rules`. On top of that, the Tauri
desktop app can be driven over CDP against the same sandbox.

That closes the loop nothing else covers:

```
desktop app  →  config.json  →  agent  →  config doc  →  dashboard
dashboard    →  config doc   →  agent  →  config.json  →  desktop app
```

The existing `e2e/specs/dashboard/process-config-roundtrip.spec.ts` stops at the
config document, because nothing in the main suite plays the agent. Its own
header says the desktop half "needs a full-machine harness". This is that
harness, at the source-run tier.

---

## Tiers

| Tier | Spec | Needs the desktop app? | Status |
|---|---|---|---|
| 0 | `tier0-spike.spec.ts`, `tier0-rig-safety.spec.ts`, `tier0-check-path.spec.ts` | no | passed, each on its own branch 2026-11-01 on Windows: spike and rig-safety 4 tests, spike and check-path 10 tests |
| 1 | `desktop-to-web.spec.ts`, `web-to-desktop.spec.ts`, `missing-path-warning.spec.ts` | yes | 12 tests passed, last run 2026-11-01 on Windows, by hand, on an isolated build beside the live app and service. Not run on a plain build, on macOS or Linux, or in CI |

Tier 0 stands in for the desktop app by writing `config.json` exactly the way the
app does — scratch file, then rename — which is all the agent can observe (it
watches mtime, not authorship). If tier 0 is red, tier 1 cannot be anything but
red, and tier 0 says *which link* broke. Tier 1 declares `dependencies: ['tier0']`
for that reason.

Tier 1 `test.skip`s with an explanatory message when `OWLETTE_DESKTOP_EXE` is
unset, so a run without a desktop build is a clean skip, not a failure.

### Why tier 1 takes a deliberate run

The desktop app is **single-instance**, and a running copy has to go before a launch.
The suite only ever stops a copy it started. Any other process with the named exe's
file name stops the run with an error, because that may be the operator's own window,
and `tier0-rig-safety.spec.ts` holds it to that. So name an isolated build (below), or
close the app and stop the live service yourself first.

---

## Run recipe

### Prerequisites (same as the main e2e suite)

- JDK 21 on `PATH` (Temurin), `npm i -g firebase-tools@15`,
  `npx playwright install chromium` once.
- A python with the agent's dependencies — the one that runs
  `cd agent && python -m pytest`. Override with `OWLETTE_PYTHON` if it is not
  `python`.

### `SESSION_SECRET`

`lib/sessionManager.server.ts:101` throws at **module load** when `SESSION_SECRET`
is missing or under 32 characters, and `next build` evaluates route modules while
collecting page data. `scripts/e2e-build.mjs` and the web server in
`playwright.config.ts` (which this suite reuses) each set an emulator-only value
when the environment has none, so a checkout without `web/.env.local` — a fresh
worktree, or CI — needs nothing exported.

Do **not** copy `web/.env.local` into a worktree: its
`FIREBASE_PROJECT_ID` points firebase-admin at a real project, and the emulator
run would seed and read the wrong database.

### Tier 0 (headless — safe on a working machine)

```bash
cd web && npm run e2e:desktop-sync            # builds, then runs both projects
# or, reusing an existing .next-e2e build:
npm run e2e:desktop-sync:nobuild -- --project=tier0
```

Run the emulator wrapper from **Bash, not PowerShell**: PowerShell splats
`--only auth,firestore,storage` into three argv entries and the emulators refuse
to start ("No emulators to start").

To run the underlying command directly:

```bash
cd <repo root>
firebase emulators:exec --only auth,firestore,storage --project demo-playwright-e2e \
  "cd web && npx playwright test --config=playwright.config.desktop-sync.ts --project=tier0"
```

### Typechecking

`e2e/**` is excluded from `web/tsconfig.json`, so neither `next build` nor
`tsc --noEmit` covers this suite, and Playwright transpiles without typechecking.
To check it, point `tsc` at it with a throwaway config:

```bash
cd web
cat > tsconfig.e2e-check.json <<'JSON'
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true, "types": ["node"] },
  "include": ["e2e/desktop-sync/**/*.ts", "playwright.config.desktop-sync.ts"],
  "exclude": ["node_modules"]
}
JSON
npx tsc -p tsconfig.e2e-check.json && rm tsconfig.e2e-check.json
```

### Tier 1 beside a live session (the operator's app and service keep running)

Two things keep a test build apart from the installed app. Its own **identifier**
gives it its own single-instance lock (the plugin names the mutex after it) and its
own `%APPDATA%` and `%LOCALAPPDATA%` folders, so a launch cannot fold into the
operator's window or write their `layout.json`. Its own **file name** is what lets the
suite tell it from the operator's `owlette-desktop.exe`. Its window and tray icon do
show on the desktop for the length of the run. A renamed build that keeps the plain
identifier fails the run, but raises the operator's window once on its way out.

```bash
# a json file, because shells disagree on quoting it inline
echo '{ "identifier": "app.owlette.desktop.e2e" }' > "$SCRATCH/tauri-isolate.json"
cd desktop && npx tauri build --no-bundle --config "$SCRATCH/tauri-isolate.json"
cp src-tauri/target/release/owlette-desktop.exe "$SCRATCH/owlette-desktop-e2e.exe"

export OWLETTE_DESKTOP_EXE="$SCRATCH/owlette-desktop-e2e.exe"
cd ../web && npm run e2e:desktop-sync:nobuild
```

`OWLETTE_E2E_KEEP_SCRATCH=1` leaves the sandbox and WebView2 profile in the temp dir
instead of recursively deleting them, and prints their paths.
`E2E_DESKTOP_SYNC_OUTPUT_DIR` and `E2E_DESKTOP_SYNC_REPORT_DIR` move what Playwright
clears at the start of a run.

### Tier 1 on a plain build (only with the live app closed)

1. Build the app:
   ```bash
   cd desktop && npx tauri build --no-bundle
   ```
2. **Stop the live service, or use a clean machine.** With `OwletteService`
   running, it re-spawns a tray on a 30s cooldown and races the suite for the
   single-instance lock all session:
   ```powershell
   powershell -Command "Start-Process cmd -ArgumentList '/c net stop OwletteService' -Verb RunAs -Wait"
   ```
   Close the desktop app too — kill the pid in
   `C:\ProgramData\Owlette\tmp\tray.pid`, **by pid, never by image name**. The suite
   refuses to run while it is up.
3. Point the suite at the build and run it:
   ```bash
   export OWLETTE_DESKTOP_EXE="$PWD/desktop/src-tauri/target/release/owlette-desktop.exe"
   cd web && npm run e2e:desktop-sync:nobuild
   ```
4. Restart the service afterwards (`net start OwletteService`); it re-spawns the
   tray on its next status check.

---

## Timing budgets

Every budget in `fixtures.ts` is a sum of real intervals with a code anchor, and
is a ceiling for `expect.poll` — there is no `waitForTimeout` in this suite.

| Budget | Value | Where it comes from |
|---|---|---|
| `desktopToWireMs` | 15s | 0.5s mtime poll (`owlette_service.LOCAL_CONFIG_POLL_INTERVAL`) + one Firestore write, with headroom for `config_sync.PushBackoff`'s 5s floor after a transient failure |
| `wireToLocalMs` | 30s | agent config listener polls adaptively 2–10s (`firebase_client._config_listener_loop`, backoff 1.3) — a change can wait out a full 10s idle interval |
| `wireToDesktopMs` | 30s | `wireToLocalMs` + the app's 120ms file watcher + React's 80ms debounce + paint |
| `desktopToStatusMs` | 6s | a PRODUCT SLO, not a cadence accommodation — see below |
| `desktopToDashboardMs` | 10s | `desktopToStatusMs` + `onSnapshot` delivery + a React render |

**Measured on a green full run:**

| Link | Measured | Budget |
|---|---|---|
| local `config.json` → config doc | **~0.4 s** | 15 000 ms |
| config doc → local `config.json` | **~1.6 s** | 30 000 ms |
| delete → status doc | **~1.3 s** | 6 000 ms |
| delete → dashboard row gone | **~1.3 s** | 10 000 ms |
| dashboard edit → desktop UI | **~0.7 s** | 30 000 ms |

### The metrics-cadence trap (and why the SLO exists)

`firebase_client._metrics_loop` picks the next interval **after** each upload:
5s while the desktop window is on screen (`tmp/gui.pid` present), 30s with a
process running, 120s idle — and an interval already counting down is not
interrupted. The dashboard renders process ROW MEMBERSHIP from the status doc,
so before 3.0.2's immediate post-push heartbeat, a local add/delete/rename
stayed invisible on the dashboard for 20–120s. An early version of this suite
waited for the fast cadence before measuring — which is precisely why that
field bug went undetected. The suite now does the opposite: `desktopToStatusMs`
asserts the product bar (push ~1s + one metrics collection + one write), and
the negative control (disable the immediate push in
`_check_local_config_changes`) fails the status-doc assertions deterministically.

This matters because of the **oracle split**: the dashboard overlays only
`launch_mode` / `schedules` / `schedulePresetId` live from the config doc. Names,
paths and timing fields render from the **status** doc
(`sites/{siteId}/machines/{machineId}.metrics.processes`), which only the agent
writes, on the metrics cadence. A spec asserting a renamed process in the UI is
asserting the agent's metrics upload, not the config sync. See
`e2e/helpers/processConfig.ts`.

### Setup takes ~100s, and that is expected

The agent opens with a network gate that TCP-probes `api_base`'s host on a
**hardcoded port 443** (`agent/src/health_probe.py:38`, `:326`). That is correct
for the `https` api_base every real agent has, and unreachable for this suite's
loopback `http://127.0.0.1:3100`, so the gate always spends its full 90s budget
(`NETWORK_GATE_MAX_WAIT`) before proceeding. It is non-fatal by design and the
connection succeeds immediately after — a measured run connected in **89.2s**.
`waitForConnected` budgets 180s for this reason; do not lower it to 90s.

---

## Sandbox safety

The agent and the desktop app both resolve their data root from `PROGRAMDATA` on
every call (`shared_utils.get_data_path`, `src-tauri/src/paths.rs`). This suite
redirects it to `mkdtemp()` under the OS temp dir. Nothing here ever writes to
`C:\ProgramData\Owlette` — the operator's live install, whose `config.json`
drives real machines.

Four guarantees, because one is not enough:

1. **`assertSandboxSafe()`** refuses any root equal to `C:\ProgramData` (or
   `%SystemDrive%\ProgramData`) *and* any root not under `os.tmpdir()`. It runs
   on sandbox creation, on every child-env construction, and before the recursive
   teardown delete.
2. **`probeAgentEnv()`** spawns a python child *exactly the way the agent will be
   spawned* and asks the agent's own path code where it would write. If that is
   not the sandbox, setup aborts before any agent process exists.
3. **`seed_tokens.py`** re-checks the resolved data root before writing
   `.tokens.enc`, because it is the process holding the credential.
4. **Case-variant stripping** in `agentEnv()`. Windows environment names are
   case-insensitive but many spawn paths are not — a `PROGRAMDATA=` that loses to
   an inherited `ProgramData=` fails **silently** and points the agent straight at
   the live install. Guarantee 2 exists specifically because guarantee 1 cannot
   see a variable that never arrived.

Other safety properties:

- `processes: []` and **no `rebootSchedule`** in the seeded config — nothing is
  ever launched, and no reboot can ever be scheduled on the test machine.
- `.migrations/legacy-launch-tasks-swept` and `.migrations/content-store-moved`
  are pre-created. Without them the boot migrations run, and
  `_sweep_legacy_launch_tasks` shells out to `schtasks` against the **real**
  machine's task store (`owlette_service.py:9526`) — the sandbox does not contain
  scheduled tasks, so there is nothing there to isolate it.
- `OWLETTE_DISABLE_WATCHDOG_RESTART=1` (`connection_manager.py:56`) — no
  self-restart storms out of a test sandbox.
- The agent is stopped the way `owlette-host` stops it: a `tmp/stop_signal.json`
  sentinel written **while it is running** (freshness is the guard —
  `_read_stop_sentinel` ignores anything older than the process start, so
  pre-creating one stops nothing). Kill by pid is only the fallback, and never by
  image name.
- Teardown is `finally`-wrapped end to end: desktop → agent → sandbox, so an
  earlier failure cannot strand a live agent.

---

## The product change this depends on

One ~5-line seam in `agent/src/firestore_rest_client.py`: `resolve_api_base()`
honours `FIRESTORE_EMULATOR_HOST` — the variable the Firebase CLI already exports
for every other SDK, and which no installed agent ever has. The emulator serves
the same `/v1` REST surface at the same document paths and evaluates the same
`firestore.rules` against Firebase ID tokens, so only the origin changes. The
three endpoints that used to re-derive their URL from the module constant
(`:commit` twice, `:batchWrite`) now append to `self.base_url`, so there is
exactly one seam and no partial redirect is possible.

`agent/tests/unit/test_firestore_api_base.py` pins **both** forms — the
production URLs are asserted as fully written-out literals, so a change to the
constant cannot pass by being consistent with itself.

**Proof the seam is load-bearing:** with it reverted, the agent still reports
`firebase.connected: true` (`_do_connect` only validates the token and
constructs the client — it makes no request), but every REST call goes to
`firestore.googleapis.com` and the config document is never seeded. Global setup
catches this explicitly:

```
[desktop-sync] agent connected in 88.5s (site=site-A, health=ok)
Error: agent connected but never seeded config/site-A/machines/TEC-A4D —
       a rules denial on the config doc looks exactly like this.
```

---

## Relationship to `dev/completed/full-machine-e2e`

That plan is the **release gate**: a dedicated Windows VM, the signed installer
artifact, silent install → headless pair → drive the GUI → observe on live dev →
uninstall → revert the snapshot. This suite is not a replacement for it.

**Supersedes its Wave 2 (GUI tier).** That wave was designed around the
CustomTkinter GUI and needed an env-gated tk-introspection shim, because
"CTk widgets are canvas-drawn and invisible to UIAutomation". That GUI was
**deleted in 3.0.0** — the local UI is the Tauri desktop app, driven over CDP with
ordinary selectors. Wave 2 as written is dead code; the tiers here cover its
intent with no product-side shim at all.

**Builds on its cloud spine.** The oracle split, the wire field names and types,
and the "installer exit code is never a pairing oracle" discipline all carry over.

**Narrows one decision, and only for source-run suites.** The plan's
2026-06-10 entry "Real dev Firebase, not emulator — shipped agent's REST client
cannot reach the emulator" was accurate when written and is still accurate *for
the shipped artifact*, which is what the gate exists to test. The new evidence is
that a **source-run** agent can now reach the emulator, which is what makes this
suite possible. The release-gate decision stands unchanged: install/upgrade/
uninstall of a real signed binary against real cloud is a different job, and this
suite does not touch it.
