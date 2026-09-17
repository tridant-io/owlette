# swoop — drafting notes

Interface decisions and conflict resolutions recorded by the four task drafters (2026-09-17). Task text in tasks.md already reflects them.

## from tasks-w0.md

Drafter notes

- **0.11's file list in the brief is incomplete and the stated done-when would fail.** `cli/__tests__/commands/readiness-docs.test.ts:60` asserts `web/content/docs/cli/readiness.mdx` contains the literal `public-api deferred: live-view-webrtc`, so changing `futurePlan` in `machine.ts` red-lights the cli suite until that test and four doc lines move in lockstep. Added `readiness-docs.test.ts`, `readiness.mdx`, `overview.mdx` to the Files list. Also: `stubs.test.ts:108/:138` assert against the parameterised `fix.futurePlanSubstr`, so only the fixture at `:42` actually changes. And `readiness-docs.test.ts:38-49` forbids the literal `dev/active/live-view-webrtc` in CLI docs — the replacement string must not introduce `dev/active/swoop` either.
- **0.2 has a latent dependency on 0.1's harness.** Resolved by giving 0.2 its own in-harness timing (per-frame host QPC stamps + client arrival/decode/present stamps) plus the on-screen-clock camera method from `research/05-transport-bakeoff.md` §7, and stating that 0.1's `latency-target` / `latency-probe-web` may be copied if they exist but must not be waited on. Same treatment for 0.8/0.9 code per the brief.
- **0.3 and 0.7 both touch `SoftwareSASGeneration`.** No file overlap: 0.3 sets it, records the prior value and restores it on this box; 0.7 only specifies the uninstall restore semantics. Neither edits `agent/owlette_installer.iss`.
- **0.2's impairment tool and 0.3's SYSTEM run both need elevation.** Both are assigned to the human as an explicit click (elevated console / clumsy launch), so no agent path raises a UAC prompt.
- `agent/swoop/` does not exist on `dev`. Every spike creates only `agent/swoop/spikes/<name>/`; no task creates `agent/swoop/Cargo.toml`, `src/`, `PROTOCOL.md` or `testdata/` (Tasks 1.1 and 1.2 own those).


## from tasks-w1-2.md


Drafter notes

- **Lockfile registration moved, not dropped.** `research/review-3-delivery.md` F5 puts
  `agent/swoop/Cargo.lock` and `infra/swoop-signal/package-lock.json` into `scripts/check-security-alerts.mjs`
  + `.github/dependabot.yml` in Tasks 1.2/1.4; plan.md gives that to **Task 3.5**. The plan wins — 1.2, 1.4,
  2.8 are told explicitly not to touch those two files, so nothing collides and 3.5 still has work.
- **`MACHINE_REMOTE_VIEW` sits on the member row.** review-2 M2 wants it admin-only with an opt-in;
  plan.md D10 (owner ruling) grants it to members while `membersMayWatch` is on, default on. The capability
  matrix therefore grants it at `member`, and Task 2.4's `policy.server.ts` refuses a member when the site
  setting is off. Do not relitigate.
- **`SWOOP_SIGNAL_RING_SECRET` is classified `must-match`, not `secret`.** The brief named only the two key
  materials, but the manifest's own definition of the class ("sensitive AND silently catastrophic if it
  differs between mirror targets") fits it exactly: a ring from the Vercel failover origin would 401 against
  a Worker holding railway-prod's value, intermittently and invisibly.
- **The bypass exemption lands in `web/lib/authorizedHandler.server.ts`** (the file that implements the
  `capability_enforcement === false` bypass, lines 609–633), not in the swoop routes that review-2 M1
  preferred — those are Wave 3 and each would have to remember. One exempt-set, one test.
- **Intra-wave interfaces stated twice instead of creating dependencies**: the `{app}\swoop` protected DACL
  (2.1 checks it, 2.6 sets it), `service.swoop_manager` (2.1 provides, 2.7 consumes), the golden-vector
  `index.json` manifest (1.1 defines, 2.9/2.10 iterate), and `requestSwoopSession` vs `sessionStore` (2.11
  writes the command, 2.4 never does).
- **`cleanup_old_logs` stays non-recursive.** review-3 F11 wanted it extended; plan.md makes `logs/swoop`
  self-rotating in the streamer (Task 1.2). Task 1.5 is told not to touch it.
- **Prerequisite:** `dev/active/swoop/spikes/` is empty today. Tasks 1.1 and 1.2 read the G1 memo (spike 0.2)
  and the threat model (spike 0.5); Wave 1 cannot start before those exist and G1 is signed off.
- **`agent/swoop/spikes/**` must contain no `Cargo.toml`** — a nested package inside the crate directory
  breaks `cargo build` in `agent/swoop`. Task 2.12 is told so.

---


## from tasks-w3-5.md


Drafter notes (conflicts found and how they were resolved):

- **`web/components/Footer.tsx` added to Task 4.2's file list.** The root layout renders `<Footer />` (`web/app/layout.tsx:142`), so a nested `layout.tsx` cannot remove it; the Footer already early-returns for `/admin`, `/` and `/hoot` (`components/Footer.tsx:46`) and `/swoop` joins that list. No other Wave 4 or 5 task touches that file.
- **Test files in `web/__tests__/api/swoop/` split by name** so 3.2 and 3.3 never write the same file: 3.2 owns `sessions.test.ts` and `lease.test.ts`, 3.3 owns `agent-routes.test.ts`.
- **Audit ownership between 5.4 and 5.6.** 5.6 owns `web/lib/swoop/audit.server.ts` and edits only the Wave 3 route files. 5.4's two new routes take their audit row from the `authorizedSiteHandler` wrapper (which already writes one per call, `web/lib/auditLog.server.ts:103,123`) and must **not** import or create `audit.server.ts`.
- **Step-up prop contract frozen in Task 4.2** so 5.2 (page + hook) and 5.5 (dialog + ceremony) never share a file. The contract is repeated verbatim in 4.2, 5.2 and 5.5.
- **`agent/tests/integration/` does not exist on `dev`.** Task 3.1 creates it with an `__init__.py`, mirroring `agent/tests/lifecycle/`.
- **`Machine` in `web/hooks/useFirestore.ts:251` has no `capabilities` field today** (the only in-repo reader is `components/charts/DisplayLayoutPanel.tsx:296-309`, which reads the raw snapshot). Task 5.3 adds it.
- **`.github/dependabot.yml` has no `infra/` npm entry**; Task 3.5 appends `/infra/swoop-signal` to the existing npm `directories` list (`:29-33`) rather than adding a second npm block.

---


## from tasks-w6-9.md


Every task is executed by a fresh agent with no conversation context. Read `dev/active/swoop/plan.md` and
`dev/active/swoop/context.md` first, then only the files your task names. Line numbers were read on `dev` at
`c71af4fb`/`69422f9b` — re-locate by symbol if they have drifted. `dev/active/` is gitignored, so search it with
plain `grep -rn`, not ripgrep-based tools.

Standing rules for every task below: Rust commands run with the working directory `agent/swoop` (never
`--manifest-path`, which drops `.cargo/config.toml` and `+crt-static`); a Wave 6+ task fills its own module
directory and **never** edits `session/mod.rs`, `session/features.rs`, `main.rs`, `Cargo.toml` or `Cargo.lock`
(Task 8.8 is the one exception, for `Cargo.toml` default features) — if a crate, stub or hook you need is
missing, stop and log it rather than adding one; hardware-dependent tests are `#[ignore]`d with the manual
invocation in the module doc comment. Web: `npx eslint <file>` clean on every file you touch, all UI copy
lowercase, `lucide-react` icons only, theme tokens only, Firestore only through `web/hooks/`, no new npm
packages. Never block the agent's 5-second loop (`SLEEP_INTERVAL = 5`), never raise a UAC prompt, never log
tokens/keys/bundles, never modify `firestore.rules`, and swoop never changes display configuration.

## Drafter notes

- **8.5 vs 8.8 — both changelogs.** The task list gave `docs/changelog.md` and `web/content/docs/changelog.mdx`
  to 8.5, but 8.8 must edit both at bump time (release order: version bump + both changelogs committed *before*
  the build). Resolved by giving both changelog files to **8.8 only**; 8.5 keeps the CLI, OpenAPI and docs pages.
- **8.4 vs 8.5 — `web/content/docs/dashboard/meta.json`.** Both would register a docs page. Resolved: 8.4
  creates `swoop-usage.mdx` and does **not** touch `meta.json`; 8.5 owns both `meta.json` edits and registers
  8.4's page alongside its own.
- **8.7 — `--source=testpattern --encoder=soft`.** Those flags live in `main.rs`, which Wave 6+ tasks must not
  edit. Resolved by moving the selection into the bundle's optional `overrides` object
  (`{"source":"testpattern","encoder":"soft"}`), same capability, no `main.rs` edit.
- **7.3 selects what 7.1/7.2 build, same wave.** Resolved by pinning the interface in all three task texts:
  every backend module root exposes exactly `pub fn probe() -> BackendCaps` and
  `pub fn create(cfg: &EncoderConfig) -> Result<Box<dyn Encoder>>`, `#[cfg(feature = …)]`-gated, and 7.3's
  selection tests are table-driven over injected `BackendCaps`, so 7.3 lands green without either sibling.
- **7.5 vs 7.6.** 7.6 classifies the path itself from the transport's selected-candidate-pair stats instead of
  reading anything `ice_policy.rs` produces, so the two are independent. `transport/governor.rs` is owned by
  6.5 in Wave 6 and 8.2 in Wave 8, and by nobody in Wave 7.
- **6.1 vs 6.2.** 6.2's "refuse clipboard on the secure desktop" would otherwise need 6.1's desktop watcher.
  Resolved: 6.2 reads the input desktop itself (`OpenInputDesktop` + `GetUserObjectInformationW`) — a cheap,
  deliberately duplicated Win32 read rather than shared state with a sibling.
- **8.1 vs 8.2.** 8.2 needs per-viewer `ctl`/`codec_class`. Resolved by fixing the viewer record's public field
  names in both task texts; 8.2 does not edit `viewers/**`.
- **6.6 — the membership path is named.** `web/app/api/sites/[siteId]/members/[uid]/route.ts` DELETE (after
  `removeMember`, ~:192) and PATCH (after `changeRole`, ~:306 — an admin→member demotion drops
  `MACHINE_REMOTE_CONTROL`), plus `web/lib/actions/removeSiteFromUser.server.ts` (~:100). Deliberately **not**
  `web/lib/membership.server.ts`: its writes are inside Firestore transactions.
- **8.3 — the writer is named.** `OwletteService._write_service_status` (`agent/src/owlette_service.py:1177`)
  and `_write_service_status_early` (`:1138`) are the only writers of `tmp/service_status.json`. The
  write-throttle signature (`:1261-1288`, `MIN_STATUS_WRITE_INTERVAL = 30`) must include the new swoop field or
  the tray badge can be 30 s stale.
- **8.4 needs two env keys the plan's registry does not list** — `CLOUDFLARE_ACCOUNT_ID` and
  `CLOUDFLARE_ANALYTICS_API_TOKEN` (Account Analytics). `CLOUDFLARE_TURN_KEY_API_TOKEN` is the rtc.live bearer
  and cannot query the GraphQL analytics API. Flagged for the owner.
- `agent/tests/integration/` does not exist on `dev`; Task 8.7 creates it.

---

## Corrections applied after the final review (2026-09-17)

Fifteen blocking defects from the final adversarial pass on `tasks.md`, all applied. One line each:

1. **3.3 — agent-only routes need an agent principal.** `requireMachineAuthAndScope` lets a site member with a
   session cookie through (`_shared.ts:553-560` skips the scope check for non-key auth), so all three routes now
   also call `resolveAgentPrincipal` or refuse `decoded.role !== 'agent'`.
2. **1.2/3.7 — the NVENC cargo feature is `encode-nvenc`,** declared by 1.2 with `[features] default =
   ["encode-nvenc"]` so Waves 3–9 have a picture; 3.7 builds behind that spelling. Mirrored in plan.md's Waves
   conventions paragraph.
3. **1.2 owns `encode::BackendCaps` and `encode::EncoderConfig`** in `encode/mod.rs`; 3.7 now exposes
   `probe()` / `create()` at the `encode::nvenc` root, the same two symbols 7.1/7.2 expose and 7.3 calls.
4. **2.4 gains `web/lib/swoop/signal.server.ts`** (+ its test) with `ringDoorbell` and `killSession`; 3.2 rings
   then enqueues the sid-only fallback; 5.4 and 6.6 call `killSession` instead of hand-rolling `POST /v1/kill`.
5. **The bundle `overrides` test hook is gated end to end**: 1.1 schema (test-only, rejected with exit 10),
   non-default `testhooks` feature in 1.2 plus the `capture/testpattern.rs` stub, parsed only under
   `#[cfg(feature = "testhooks")]` in 2.10, honoured with a `status` event in 5.1, proven in 8.7's done-when,
   excluded from `default` in 10.1.
6. **5.4's command-document assertion now matches 2.11's contract** (`type`, `sid` where the type carries one,
   the envelope and `stampCommand`'s lifecycle fields) instead of the illustrative `{type, sid, createdAt,
   expiresAt}`.
7. **Per-type sid rules** in 2.7 and 2.11 (and 5.4): `swoop_session_requested` requires a sid, `swoop_kill`'s is
   optional, `swoop_refresh` carries none — enablement toggles have no session to name.
8. **3.2 no longer re-implements the `capability_enforcement=false` refusal**; it points at Task 1.3's
   `BYPASS_EXEMPT_CAPABILITIES`, and its done-when case is the `capability_missing` 403 for a member.
9. **`indicator` travels in the bundle**, not through a Firestore read in the agent: added to 1.1's schema and
   3.3's bundle response, and 8.3 reads it from the streamer's `status` event via `SwoopManager.status()`.
10. **7.3 no longer claims `swoop_capability.py` parses the `probe` JSON** (2.2 computes the capability from
    binary presence; `probe` must not run on the heartbeat path), and its done-when asserts its own unit test.
11. **`K_session = HKDF(SWOOP_SESSION_MASTER_KEY, sid)`** in 2.4, matching plan.md D8 and 0.5/1.1's
    PROTOCOL.md block — a sid identifies one streamer lifetime on one machine.
12. **0.11's grep done-when** now expects the one legitimate hit, `readiness-docs.test.ts:40`'s stale-needle
    guard, which stays.
13. **1.2 declares `windows` under `[target.'cfg(windows)'.dependencies]`** and gates Windows-only module
    declarations behind `#[cfg(windows)]` from the start; 9.1 keeps a stated one-off `main.rs` exception (now in
    the standing rules, with `main.rs` in its Files list) to re-home any that slipped through.
14. **3.3's `doorbell-token` refuses 403 `swoop_disabled`** for a site with swoop off or an excluded machine, so
    0.6's slow-retry path has a server side and idle sockets match the off-by-default ruling.
15. **The per-type 5 s command throttle is exempted for the three swoop types in Task 3.1** (which owns
    `owlette_service.py` in Wave 3): `:4570-4580`, guard at `:4573`, `COMMAND_RATE_LIMIT_SECONDS = 5` at
    `:4553` — line numbers verified against the file. Done-when proves two `swoop_session_requested` inside 5 s
    are both dispatched.


