# keep screens awake — Tasks
**Progress**: 6/9 complete

Standing rules: work only in the worktree `C:\Users\admin\Documents\Git-restored\Owlette-swoop-mac-wt`, branch
`swoop/macos`; never the main checkout; no commits, pushes or `git add` by workers (the lead reviews and commits);
`firestore.rules` untouched; all user-facing copy lowercase; no hardcoded colours; lucide icons only; no new
npm/pip packages; Rust deps only as plan.md decision 6 allows; never block the agent's 5 s loop; never log
tokens; lint/typecheck/tests clean for every touched file; preserve each file's line endings (CRLF where present);
the Bash tool mangles backslashes in heredocs — use the Write/Edit tools for file content. Read plan.md first.

## Wave 1: the setting, the push, and both holders (parallel; disjoint files)

- [x] **Task 1.1: The site setting, its API, hook and nudge** `[agent]`
  - Files: `web/lib/display/settings.server.ts` (create: doc name `display`, `parseDisplaySettings` with
    `keepAwake: raw.keepAwake !== false`, `loadDisplaySettings(siteId)`), `web/lib/actions/setDisplaySettings.server.ts`
    (create), `web/app/api/sites/[siteId]/display-settings/route.ts` (create), `web/hooks/useDisplaySettings.ts`
    (create), `web/openapi.yaml`, `web/__tests__/api/display-settings.test.ts` (create),
    `web/__tests__/hooks/useDisplaySettings.test.ts` (create).
  - Do: Copy the swoop-settings shape (plan.md research). Route GET/PATCH under `authorizedSiteHandler`,
    capability `MACHINE_CONFIG_WRITE`, API keys refused with 403 like `swoop-settings/route.ts:47-56`. The action
    validates a boolean `keepAwake`, merge-writes `{keepAwake, updatedAt}`, emits `emitMutation`
    (`set_display_settings`), and when the value actually changes queues a `site_settings_refresh` command
    (payload `{}`) to every **online** machine of the site, the way `setSwoopSettings.server.ts:170-207` fans out
    (use the same machine query and command writer pattern; if `requestSwoopSession.server.ts` is swoop-specific,
    write the command with the generic command writer the codebase uses for agent commands — read
    `web/lib/commandLifecycle.ts:92` `writeCommandFanOut` and use it). Response `{ settings, refreshed }`.
    Hook: `onSnapshot` on the doc, `keepAwake` default true while loading and when absent. OpenAPI entry with
    `security`, tags like swoop-settings. Tests: member 403, API key 403, admin PATCH writes and nudges only
    online machines and only on a change, GET defaults to true; hook default/follow.
  - Done when: `cd web && npx eslint <files> && npx tsc --noEmit -p . && npx jest <the two tests>` clean, and
    `npx tsx scripts/validate-openapi.ts` passes.

- [x] **Task 1.2: The agent's view of the setting** `[agent]`
  - Files: `web/app/api/agent/site/route.ts`, `web/__tests__/api/agent/site.test.ts`, `agent/src/firebase_client.py`,
    `agent/src/owlette_service.py` (command registration only), `agent/src/swoop_commands.py` **or** a new
    `agent/src/site_commands.py` (pick the new file), `agent/tests/unit/test_site_commands.py` (create),
    `agent/tests/unit/test_firebase_client.py` (site-metadata cases).
  - Do: Add `keepAwake: (settings/display).keepAwake !== false` to the `/api/agent/site` projection (one more
    admin read; keep the route's shape otherwise; update every `toEqual` in its test). In
    `_fetch_site_metadata` store it as `self.site_keep_awake` (bool, default True when absent or on error; never
    flip on a failed fetch — keep the last known value). New handler module `site_commands.py`:
    `handle_site_settings_refresh(service, cmd_id, cmd_data)` runs `firebase_client._fetch_site_metadata()` on a
    daemon thread (single-flight) and marks the command completed. Register the type with the router, add it to
    `_FAST_COMMAND_TYPES` and to the rate-limit exemptions. Tests: projection includes `keepAwake` (true when the
    doc is absent, false when set false); handler is non-blocking and single-flight; metadata fetch keeps the last
    value on error.
  - Done when: jest for `site.test.ts` and `agent/.venv/Scripts/python -m pytest agent/tests/unit/test_site_commands.py
    agent/tests/unit/test_firebase_client.py agent/tests/unit/test_command_router.py -q` pass, lint/tsc clean.

- [x] **Task 1.3: The daemon holder** `[agent]`
  - Files: `agent/src/keep_awake.py` (create), `agent/src/osadapter/darwin.py` (only if adding IOPMAssertion
    prototypes there is cleaner than in `keep_awake.py`; prefer keeping them in `keep_awake.py` via
    `darwin._frameworks()`), `agent/tests/unit/test_keep_awake.py` (create).
  - Do: `class KeepAwake` with `set_wanted(wanted: bool)` (returns at once; the work runs on its own single-flight
    daemon thread) and `status() -> {'wanted', 'held', 'how', 'reason'}`; `release()` for shutdown. Per OS behind
    small seams so tests can inject fakes: Windows `PowerCreateRequest(REASON_CONTEXT simple string)` +
    `PowerSetRequest(PowerRequestDisplayRequired)` + `PowerRequestSystemRequired`, `PowerClearRequest` + `CloseHandle`
    on release (ctypes, imported lazily — no module-scope Windows imports, see `test_no_platform_imports.py`);
    macOS `IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleDisplaySleep / …SystemSleep, 255, name)`
    and `IOPMAssertionRelease`; Linux a child `systemd-inhibit --what=sleep:idle:handle-lid-switch --who=owlette
    --why="keep screens awake" --mode=block tail --pid=<os.getpid()> -f /dev/null` (terminate it on release;
    `systemd-inhibit` absent → `held False, reason 'no_inhibit'`). Idempotent: `set_wanted(True)` twice holds once.
    `how` names the mechanism (`power_request`, `iopm_assertion`, `systemd_inhibit`). Tests with fakes for all three
    seams run on every OS; nothing real is held in unit tests.
  - Done when: `agent/.venv/Scripts/python -m pytest agent/tests/unit/test_keep_awake.py agent/tests/unit/test_no_platform_imports.py -q`
    passes; on this Windows box also a manual real hold proven with `powercfg /requests` (paste the output in the
    report), then released.

- [x] **Task 1.4: The app holder** `[agent]`
  - Files: `desktop/src-tauri/src/awake.rs` (create), `desktop/src-tauri/src/lib.rs` (spawn it in setup only),
    `desktop/src-tauri/Cargo.toml` (`Win32_System_Power` feature on `windows`; `zbus` as a Linux direct dep at the
    version already in the lock; macOS: IOKit via `extern "C"` link, no new crate), `desktop/src-tauri/Cargo.lock`
    (only the direct-dep lines may change), `desktop/src-tauri/src/paths.rs` (a `KEEP_AWAKE_REPORT_REL =
    "ipc/keep_awake.json"` constant).
  - Do: A thread started in setup reads `tmp/service_status.json` every 5 s for `keep_awake.wanted` (absent →
    false: an old service never asked). On wanted: Windows `SetThreadExecutionState(ES_CONTINUOUS |
    ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED)` **from this same long-lived thread** (the state belongs to the
    thread), and `SystemParametersInfoW(SPI_SETSCREENSAVEACTIVE, FALSE, null, 0)` after reading the prior value
    with `SPI_GETSCREENSAVEACTIVE` (restore it on release; fWinIni 0 = session only, never persisted); macOS
    `IOPMAssertionCreateWithName(PreventUserIdleDisplaySleep)` held + `IOPMAssertionDeclareUserActivity` every 30 s;
    Linux `org.gnome.SessionManager.Inhibit("owlette", 0, "keep screens awake", 8)` over the session bus with zbus
    (blocking API on this thread), falling back to `org.freedesktop.ScreenSaver.Inhibit`, keeping the cookie and
    calling `Uninhibit` on release. On not wanted, release everything. Write `ipc/keep_awake.json` `{held, how,
    reason, at}` on every change and every 60 s (copy `tcc.rs`'s write: create-new + rename, same permissions).
    Unit tests for the decision logic (wanted parsing, state transitions) with the OS calls behind a trait.
  - Done when: `cargo clippy --all-targets --locked -- -D warnings` and `cargo test --locked` pass in
    `desktop/src-tauri` on Windows; the lead runs the same on the Mac and the kiosk VM (report which files to sync).

## Wave 2: wiring and the dashboard

- [x] **Task 2.1: The service wires both layers and reports** `[agent]`
  - Files: `agent/src/owlette_service.py`, `agent/src/firebase_client.py` (heartbeat capability only),
    `agent/tests/unit/test_posix_loop_duties.py`, `agent/tests/unit/test_service_status_file.py`,
    `agent/tests/unit/test_keep_awake_wiring.py` (create), `web/hooks/useFirestore.ts`, 
    `web/__tests__/hooks/useMachines.displayAwake.test.ts` (create), `web/app/api/sites/[siteId]/machines/route.ts`
    (list projection: `displayAwake`).
  - Do: Construct one `KeepAwake` in the service; on each tick read the cached `site_keep_awake` (no I/O) and call
    `set_wanted` only on a change; release on shutdown in the graceful funnel. Add `keep_awake: {wanted}` to
    `service_status.json` and its write signature. Read `ipc/keep_awake.json` with the owner/mode/freshness checks
    `darwin.py` uses for `tcc.json` (on Windows the file lives in a dir the app may write — mirror the `console_dir`
    ACL row in `acl_hardening.py` if a new dir is needed; prefer an existing one). Mirror
    `displayAwake: {wanted, held, session, how, reason}` with `set_machine_flag` on each change (combined daemon +
    session report; `reason 'no_display'` when no session report exists and no seat). Heartbeat adds
    `capabilities.keepAwake: 1`. Web: `Machine.displayAwake` typed and mapped; the machines list route projects it.
  - Done when: full `agent/.venv/Scripts/python -m pytest agent/tests/ -q` and the web jest suites touched pass.
  - Depends on: 1.2, 1.3, 1.4.

- [x] **Task 2.2: The Manage Sites edit panel** `[agent]`
  - Files: `web/components/ManageSitesDialog.tsx`, `web/components/SiteMachinesList.tsx`,
    `web/__tests__/components/ManageSitesDialog.test.tsx` (create), `web/content/docs/dashboard/swoop.mdx`,
    `web/content/docs/dashboard/sites.mdx` (or the docs page that covers manage sites — find it),
    `web/content/docs/reference/firestore-data-model.mdx`.
  - Do: Remove `SwoopSiteToggle` from the machines panel; in the edit panel add a `border-t` section with two
    rows (lowercase): **swoop** — "let admins watch and control this site's machines remotely" — and **keep
    screens awake** — "machines on this site never sleep, blank or lock" — each a `Switch` that PATCHes at once
    (swoop to `swoop-settings`, the other to `display-settings`), follows its snapshot hook, and toasts only on
    failure. `SiteMachinesList` rows show a small muted "awake" label when `displayAwake.held`. Docs: the switch's
    new place, the new setting with its default and what it does per OS, and `displayAwake` in the data model.
    Component test: both switches render in the edit panel and not the machines panel; PATCH bodies; a member sees
    neither.
  - Done when: eslint/tsc/jest clean for the touched files.
  - Depends on: 1.1.

## Wave 3: proof and release

- [ ] **Task 3.1: e2e** `[agent]`
  - Files: `web/e2e/specs/sites/edit-site.spec.ts`, `web/e2e/specs/sites/site-role-boundaries.spec.ts`,
    `web/e2e/specs/mobile/sites-dialogs.spec.ts`.
  - Do: The two switches live in the edit panel and write their documents (Admin SDK read-back); a member sees
    neither; the 390 px layout still reaches them.
  - Done when: those specs pass locally on the emulators.
  - Depends on: 2.2.

- [ ] **Task 3.2: Hardware proof on all three** `[agent]`
  - Do: On A4D, MBA and the kiosk VM, with short idle timeouts set temporarily (recorded and restored): switch on →
    15 minutes idle, no sleep/blank/lock (`powercfg /requests`, `pmset -g assertions`, `systemd-inhibit --list`,
    `gdbus` inhibitor list, screenshots of the idle screen); switch off → each sleeps or locks. Record in
    `dev/active/keep-screens-awake/proof.md`.
  - Done when: proof.md has the measurements for all three.
  - Depends on: 2.1, 2.2.

- [ ] **Task 3.3: Release 4.1.1** `[agent+human]`
  - Do: Changelog section in both changelogs (the ten fixes since 4.1.0 and this feature, noting default on),
    `sync-versions 4.1.1`, lockfiles follow, security check, PR to dev, tag, CI installers, upload + latest on the
    owner's word (already given for 4.1.1 by "update it to 4.1.1 after you release that"), update A4D, B4A, MBA,
    kiosk.
  - Depends on: 3.1, 3.2.

## Log
### 2026-10-03
- Plan created from the research pass and approved by the owner ("go on keep screens awake for 4.1.1"; default
  on per "keep the screens awake 24/7 regardless of operating system").
- Wave 1 committed (0829e0ab, 97c028ed, 53b8ad62, 9ef93e9d) and 2.2 (4b5ed08a). 2.1 wires the daemon hold into the
  5 s tick and mirrors displayAwake; suite green on Windows and on the Mac with CI's macOS flags. The Mac run also
  caught the gpu backoff test (d721cd8f) reading the import-time macOS flag; pinned in its own commit.
