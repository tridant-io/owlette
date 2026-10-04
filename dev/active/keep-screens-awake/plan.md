# keep screens awake — Plan
**Created**: 2026-10-03 | **Status**: Active | **Ships in**: 4.1.1

Worktree `C:\Users\admin\Documents\Git-restored\Owlette-swoop-mac-wt`, branch `swoop/macos`; never the main checkout.
Owner, 2026-10-03: "this is a good feature for all of owlette across all OSes … keep the screens awake 24/7
regardless of operating system … it should be a built-in feature, that can be toggled via the manage sites panel.
and the swoop option should be moved into the edit section for this." Then: "go on keep screens awake for 4.1.1".

## Summary

A per-site switch, **on by default**, that keeps every machine's displays awake and unlocked on Windows, macOS
and Linux. The agent (root/SYSTEM) holds the system-level part; the desktop app (in the user session) holds the
session-level part (idle lock, screensaver). Each reports what it holds, and the dashboard shows it. The swoop
switch moves beside it into the site's edit panel.

## Research findings (2026-10-03, file:line in the worktree)

- **Site settings.** `sites/{siteId}/settings/swoop` (`web/lib/swoop/policy.server.ts:48-49,83-88,114-141`), API
  `web/app/api/sites/[siteId]/swoop-settings/route.ts` (GET/PATCH, API keys refused `:47-56`, capability
  `SWOOP_SETTINGS_MANAGE` `:120-128`), action `web/lib/actions/setSwoopSettings.server.ts` (validate `:58-103`,
  merge write `:122-131`, nudge online machines on change `:141-142,170-207`, `emitMutation` `:144-159`), hook
  `web/hooks/useSwoopSettings.ts` (`onSnapshot` `:63-79`). Default-on precedent: `web/hooks/useHootApprovalSetting.ts:24`
  (`snap.data()?.requireTier3Approval !== false` on `settings/cortex`, writer `hoot-settings` with
  `MACHINE_CONFIG_WRITE`). Rules: `firestore.rules:852-858` lets site members read `settings/*`, only the service
  account write; agents cannot read it. **No rule change needed.**
- **Agent learns site settings** only through `GET /api/agent/site` (`web/app/api/agent/site/route.ts:19,73-96`,
  returns `{name, timezone, roostEnabled}`, rate-limited per IP `:101`), read by
  `firebase_client._fetch_site_metadata` (`agent/src/firebase_client.py:428-503`) on connect `:359`, start `:633`,
  every 900 s `:869-874`. Precedent for a per-site boolean the agent acts on: `roostEnabled`
  (`agent/src/roost_kill_switch.py:20-23`). Its test pins exact `toEqual` shapes: `web/__tests__/api/agent/site.test.ts`
  (`:72,99,111,121,…`).
- **Commands.** Fast lane `_FAST_COMMAND_TYPES` (`agent/src/firebase_client.py:1610-1613`), rate-limit exemptions
  `agent/src/owlette_service.py:5330-5332`, router `:5343-5345`, swoop handlers `agent/src/swoop_commands.py:96-160`
  (registered `owlette_service.py:1176-1180`). Web writer for swoop's own commands:
  `web/lib/actions/requestSwoopSession.server.ts:12-37`; generic allow-list `executeMachineCommand.server.ts:25`.
- **5 s loop** `owlette_service.py:9162-9434`, `SLEEP_INTERVAL = 5` (`:74`); counter-gated duties `:9262-9280`;
  the single-flight model to copy is `_check_console_session` (`:2891-2925`). Never block the loop. The cached
  per-site value pattern: `site_timezone` read on the tick (`:9215-9216`).
- **`display_manager.py` is Windows-only by design** and must not grow keep-awake (`test_no_platform_imports.py:35-39`).
- **macOS:** the daemon already ctypes-loads IOKit and CoreFoundation (`agent/src/osadapter/darwin.py:758-777`); an
  `IOPMAssertion` dies with its process. The swoop streamer already holds `PreventUserIdleDisplaySleep` +
  `IOPMAssertionDeclareUserActivity` during capture (`agent/swoop/src/platform/macos.rs:131-220`) — the pattern to port.
- **Linux:** agent unit `KillMode=process` (`agent/packaging/linux/owlette-agent.service:20`): a plain child survives
  `systemctl stop`, so tie it to the agent's pid. GNOME's blank and lock follow gnome-session inhibitors, not
  logind's; the app (user session) must hold `org.gnome.SessionManager.Inhibit` (flag 8 = idle) or
  `org.freedesktop.ScreenSaver.Inhibit`. `zbus` is already in `desktop/src-tauri/Cargo.lock` via `notify-rust`.
- **Daemon → app** state: sections of `tmp/service_status.json` (`owlette_service.py:1306-1342,1449-1465`, the
  write signature `:1485-1488`, throttle `MIN_STATUS_WRITE_INTERVAL = 30` `:98`); the app reads it every second
  (`desktop/src-tauri/src/tray.rs:82,554-563`). **App → daemon** precedent: `desktop/src-tauri/src/tcc.rs` rewrites
  `ipc/tcc.json` every 60 s (`:38-40,207-247`), read with owner/mode/freshness checks (`darwin.py:167-176,939-980`).
- **Reporting** precedents on the machine doc: `capabilities.*` dotted on every heartbeat
  (`firebase_client.py:1570-1576`); `liveView` via `set_machine_flag` on transitions (`owlette_service.py:7905-7932`;
  `firebase_client.py:2364-2376`). Dashboard `Machine` type `web/hooks/useFirestore.ts:254-320`, whitelist mapping
  `:1382-1406`.
- **Manage Sites dialog** `web/components/ManageSitesDialog.tsx`: `SwoopSiteToggle` `:57-101`, mounted in the
  machines panel `:622-627`; edit panel `:565-617` (name, timezone, save), pencil gated by `isSiteAdmin` `:511-533`.
  No unit test exists for the dialog; e2e: `web/e2e/specs/sites/edit-site.spec.ts`, `site-role-boundaries.spec.ts`,
  `mobile/sites-dialogs.spec.ts`. Docs: `web/content/docs/dashboard/swoop.mdx:22` names the switch's place.
- **Windows caveat:** a display power request stops display-off and sleep, but a secure screensaver and the
  `InactivityTimeoutSecs` policy are driven by input idle; the app clears the session's screensaver
  (`SPI_SETSCREENSAVEACTIVE`) and holds `ES_DISPLAY_REQUIRED`; the hardware proof decides whether more is needed.

## Approach

- **Data.** `sites/{siteId}/settings/display` with `keepAwake`, read as `!== false` everywhere (default on).
  `GET/PATCH /api/sites/{siteId}/display-settings` (site admin/owner, `MACHINE_CONFIG_WRITE`, API keys refused,
  `emitMutation`), action `setDisplaySettings.server.ts`, hook `useDisplaySettings`.
- **Push.** `keepAwake` joins the `/api/agent/site` projection; a change sends a fast-lane `site_settings_refresh`
  command to online machines, whose handler re-reads the projection off the loop. Offline machines catch up on
  reconnect; the 900 s refresh is the backstop.
- **Two layers, each released when switched off and when its process exits:**
  - *Daemon* (works with nobody logged in): Windows `PowerCreateRequest` + `PowerSetRequest(DisplayRequired,
    SystemRequired)`; macOS `IOPMAssertionCreateWithName(PreventUserIdleDisplaySleep / PreventUserIdleSystemSleep)`
    in-process; Linux `systemd-inhibit --what=sleep:idle:handle-lid-switch --who=owlette --why=… tail
    --pid=<agent pid> -f /dev/null` as a child.
  - *App* (the session's idle lock): Windows `SetThreadExecutionState(ES_CONTINUOUS|ES_DISPLAY_REQUIRED|ES_SYSTEM_REQUIRED)`
    on a thread that stays alive, plus `SPI_SETSCREENSAVEACTIVE` off (restored on release); macOS a held
    `PreventUserIdleDisplaySleep` assertion plus `IOPMAssertionDeclareUserActivity` every 30 s; Linux
    `org.gnome.SessionManager.Inhibit(app_id, 0, reason, 8)` (fallback `org.freedesktop.ScreenSaver.Inhibit`).
- **Wiring.** The loop reads the cached `site_keep_awake` and hands changes to a single-flight worker; the service
  writes `keep_awake: {wanted}` into `service_status.json` (in the write signature, so a change is written at once);
  the app reports `ipc/keep_awake.json` `{held, how, reason, at}`; the agent mirrors
  `displayAwake: {wanted, held, session, how, reason}` onto the machine doc on each change and adds
  `capabilities.keepAwake: 1` to the heartbeat. A machine with no graphical session reports `reason: 'no_display'`.
- **Dialog.** The edit panel gets a `border-t` section with two immediate switches (not part of save): **swoop**
  and **keep screens awake**; the swoop switch leaves the machines panel. Same `isSiteAdmin` gate as the pencil.
  `SiteMachinesList` shows a small "awake" marker from `displayAwake.held`.

## Decisions

1. Default **on** (owner). Every existing site starts keeping screens awake as its agents reach 4.1.1; the
   changelog says so.
2. Settings document of its own (`settings/display`), not a field on `settings/swoop` or the site doc.
3. `MACHINE_CONFIG_WRITE` gates the write (hoot-settings precedent); swoop keeps `SWOOP_SETTINGS_MANAGE`.
4. Two layers because neither alone covers all three OSes: the daemon holds sleep with nobody logged in; only the
   session can stop the idle lock on GNOME and reliably on Windows.
5. The switches act immediately, not on save: swoop's PATCH already nudges machines, which cancel cannot undo.
6. No new crates beyond direct deps already in the lock (`zbus` on Linux) and the `windows` crate's
   `Win32_System_Power` feature; no new npm or pip packages.

## Risks

- Windows secure screensaver / inactivity policy may still lock; the hardware proof decides whether a
  synthetic-input tick is needed (not planned unless proven).
- GNOME on Wayland vs X11: the session inhibit covers both; `xset` fallback only on bare X11.
- Default-on changes every existing site at once.
- A crash of the app releases its session hold (by design); the daemon layer keeps the display on regardless.

## Success criteria

- With the switch on, A4D (Windows), MBA (macOS) and the kiosk VM (Ubuntu) neither sleep, blank nor lock past a
  short idle timeout for 15 minutes; switched off, each does. Measured on each, not inferred.
- The dashboard shows both switches to a site admin and neither to a member; `displayAwake` on each machine says
  what is held; jest, pytest (all three legs), cargo tests (all three) and the e2e specs pass; the security check
  is clear; docs updated.
