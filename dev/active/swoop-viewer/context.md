# owlette swoop (the viewer app) — Context
**Last updated**: 2026-10-09

## Key Files

### Create
- `desktop/viewer/` — the app crate: `Cargo.toml`, `build.rs`, `tauri.conf.json`, `tauri.macos.conf.json`,
  `capabilities/default.json`, `dist/index.html` (placeholder, never shown), `src/main.rs`, `src/lib.rs`,
  `src/origin.rs` (allowlist + deep-link rewrite), `src/launch.rs` (argv → action, remembered origin),
  `src/windows.rs` (main + `swoop-<s>/<m>` windows, dots in the machine id as `:`, on_new_window, on_navigation, close handshake),
  wave 3: `src/keys_windows.rs`, `src/keys_macos.rs`, `src/mac.rs`
- `desktop/src-tauri/src/viewer_launch.rs` — the desktop app spawning the sibling binary
- `web/lib/swoop/viewerApp.ts` — UA detection, `owlette-swoop://` link builder
- `web/lib/swoop/openViewerApp.ts` — navigate to the scheme, "not installed" fallback
- `web/app/swoop/page.tsx`, `web/components/swoop/SwoopPicker.tsx` — the picker
- `web/app/download/swoop-viewer/route.ts` — stable permalink
- `cli/src/lib/viewerApp.ts` — locate + spawn the app
- `agent/packaging/linux/owlette-swoop-viewer.desktop`
- `docs/adr/0012-owlette-swoop-hosts-the-web-viewer.md`
- `dev/active/swoop-viewer/spike-g0.md` — wave 2 measurements (gate G0)
- wave 3 (conditional): `web/app/api/auth/app-link/route.ts`, `web/app/app-link/page.tsx`, `web/lib/appLink.server.ts`
- tests: `web/__tests__/lib/swoop/viewerApp.test.ts`, `openViewerApp.test.ts`, `web/__tests__/components/SwoopPicker.test.tsx`,
  `web/e2e/specs/swoop/picker.spec.ts`, `viewer-app.spec.ts`, `cli/__tests__/lib/viewerApp.test.ts`

### Modify
- desktop app: `desktop/src-tauri/src/tray.rs` (menu `:1128-1170`, handler `:1298`), `commands.rs`, `lib.rs`,
  `desktop/src/lib/ipc.ts`, `desktop/src/components/AppMenu.tsx`, `desktop/README.md`
- web viewer: `web/lib/swoop/input.ts`, `keyboardLock.ts`, `specialKeys.ts`, `web/hooks/useSwoopSession.ts`,
  `web/components/swoop/SwoopStage.tsx`, `SwoopToolbar.tsx`, `SwoopSpecialKeys.tsx`,
  `web/app/swoop/[siteId]/[machineId]/page.tsx`
- web dashboard: `web/components/MachineContextMenu.tsx` (swoop row `:357-378`, split-row pattern `:277-316`),
  `web/app/dashboard/page.tsx` (`openSwoop` `:765-774`)
- web auth (wave 3): `web/app/login/page.tsx`, `web/app/verify-2fa/page.tsx`, `web/lib/inAppBrowser.ts`,
  `web/components/swoop/SwoopStepUpDialog.tsx`
- cli: `cli/src/commands/swoop.ts`, `cli/__tests__/commands/swoop-http.test.ts`, `readiness-docs.test.ts`,
  `web/content/docs/cli/reference/swoop.mdx`, `web/content/docs/cli/readiness.mdx`
- packaging: `agent/owlette_installer.iss`, `agent/build_installer_full.bat`, `agent/build_installer_quick.bat`,
  `agent/build/macos/build.sh`, `agent/packaging/macos/distribution.xml`, `agent/build/linux/build.sh`,
  `.github/workflows/build-installer.yml`, `.github/workflows/rust-build.yml`, `scripts/sync-versions.js`
- docs: `web/content/docs/dashboard/swoop.mdx`, `GLOSSARY.md`, `docs/changelog.md`,
  `web/content/docs/changelog.mdx`, `docs/roadmap.md`

### Read first (patterns to copy)
- `desktop/src-tauri/src/lib.rs:66-88` plugin order and single-instance callback; `:213-252` window events
- `desktop/src-tauri/src/shell_open.rs:150-177` the http(s)-only open guard
- `desktop/src-tauri/src/agent_cli.rs:80-104,201-208` argv allowlist style
- `desktop/src-tauri/src/mac_window.rs` objc2 usage
- `web/components/MachineContextMenu.tsx:277-316` split row with tooltip gear
- `web/app/dashboard/page.tsx:722-739` last-site restore; `:765-774` viewer launch
- `web/lib/swoop/input.ts:98-154,314-357,480-548` key handling, fullscreen/pointer lock
- `web/components/swoop/SwoopToolbar.tsx:162-208,285-294` fullscreen flow and copy
- `web/hooks/useSwoopSession.ts:375-380` `end()`; `:451-465` keepalive DELETE; `:811-823` stall gate
- `web/proxy.ts:19-34,168,180-227,267-272` protected paths, login redirects
- `web/lib/inAppBrowser.ts` the existing embedded-webview note
- `cli/src/commands/swoop.ts`, `cli/src/lib/openBrowser.ts`
- `agent/owlette_installer.iss:133-136` desktop exe files; `:399,415` shortcuts; `:466,1396` kill sweeps
- `agent/build/macos/build.sh:143-191`, `agent/build/linux/build.sh:90-116`
- `.github/workflows/build-installer.yml:94,250,437,576` jobs
- `docs/adr/0001-*.md` ADR format; `docs/adr/0009-*.md` swoop decision; `GLOSSARY.md:59-61,160-196`
- `dev/active/swoop/context.md:166-173` codec/keyboard-lock notes; `web/lib/swoop/clientCaps.ts:10-16`

## Decisions

1. **Standalone app "owlette swoop", binary `owlette-swoop-viewer`, identifier `app.owlette.swoop-viewer`.**
   Owner ruling 2026-10-09. `owlette-swoop` is the streamer (the agent installer kills it by name);
   `owlette-viewer` was judged too generic. Display name lowercase everywhere.
2. **Own crate `desktop/viewer/`, no flag on the desktop app.** The desktop app's startup is
   agent-shaped end to end (tray.pid, watchers, keep-awake, macOS Screen Recording prompt); a mode
   would have to skip all of it. Separate identifier = separate WebView2 profile, single-instance
   lock and macOS bundle. Shared Rust is tiny; duplicate, no workspace (same ruling as `agent/swoop`).
3. **The app loads owlette.app top-level and has no frontend of its own.** iframes are blocked by
   XFO + `frame-ancestors`; a bundled copy would lose the cookie session, the 12 h step-up reuse and
   daily web deploys. ADR 0012 records it.
4. **One argument, a URL; no flags.** `https://<allowed host>/…` or `owlette-swoop://<host>/<path>`
   rewritten to https after the same host check. Origin remembered only when given. Default prod.
5. **`owlette-swoop://` via `tauri-plugin-deep-link`** — new crate, owner ok given 2026-10-09.
   The scheme is received-only; the app never opens non-http(s) URLs (keeps the stance in
   `shell_open.rs` and the CLI's `openBrowser`).
6. **Remote origin gets no Tauri IPC.** Host→page is `eval` only (`owlette:close`,
   `__owletteNativeKey`). The desktop app's `fs:scope **` capability is never extended.
7. **App detection by UA token `owlette-swoop-viewer/<ver>[ (keys)]`.** No IPC, survives navigation,
   Playwright can set it → app-mode web behaviour is e2e-testable without Tauri.
8. **Close = end.** Intercept `CloseRequested` once, dispatch `owlette:close`, page calls `end()`
   (keepalive DELETE), close 300 ms later. Last window closing exits the process.
9. **Measure before native work (gate G0).** WKWebView playout-delay negotiation is unmeasured and
   fatal if absent; WebView2 is H.264 only; Google/passkeys in webviews are suspect; keyboard-lock
   effect in WebView2 unknown. Wave 3 scope is set from `spike-g0.md`.
10. **Native capture design.** Windows `WH_KEYBOARD_LL` while fullscreen+focused, accelerators off
    via `ICoreWebView2Settings3`; macOS presentation options (`disableProcessSwitching` + `hideDock`)
    and a local NSEvent monitor — no TCC grant needed. Win+L, Ctrl+Alt+Del, Cmd+Space stay with the OS.
    Release = hold Esc 2 s, implemented page-side in app mode.
11. **Web entry point = split row in the machine menu** (owner ruling): text opens the browser
    viewer, a `Monitor` icon opens the app via the scheme; 1.5 s focus heuristic → toast with
    `/download/swoop-viewer`. Hidden inside the app.
12. **Picker is a web page `/swoop`**, useful in browsers too, and carries the #324 "swoop is off for
    this site" copy with the admin link.
13. **Packaging: one build, two channels.** Inside every agent installer (Windows `{app}\app`,
    `/Applications/owlette swoop.app`, `/usr/bin/owlette-swoop-viewer`) and standalone CI artifacts
    (NSIS per-user, notarized app zip, deb). Not through `installer_metadata`/`upload-installer.mjs`
    (agent-only scheme, cannot hold a second Windows exe per version). Hosting on
    download.tridant.io needs a new artifact kind (owner + Davor); pilot uses release assets.
14. **No version bump in this plan.** 4.1.8 is being cut by another session; changelog under
    `[Unreleased]` in both files. 4.1.8 vs later is the owner's call.
15. **Sequence behind the in-flight worktrees.** `fix/swoop-disabled-viewer` (#323) and
    `feat/swoop-discoverable` (#324) edit the same viewer/dashboard files as 2.3 and 2.4.
16. **Lowercase Start-menu names are a separate fix PR**, not part of this plan (`MyAppName "Owlette"`;
    NTFS case-only rename trap; `C:\ProgramData\Owlette` stays).

17. **Sign-in handoff, two directions (owner ruling 2026-10-09).** The app's webview has its own cookie jar and the desktop app is paired as a machine, not signed in as a user, so a first launch asked for a password. Website → app: the signed-in page mints a single-use 60 s code into the deep link (`owlette-swoop://host/app-link?code=&next=`), the app exchanges it for a custom token whose `appLinkMfa` claim lets `/api/auth/session` inherit the browser session's MFA state. Cold app start: "sign in with your browser" opens the system browser on `/app-link/approve?code=`, the app polls with a secret. Control still needs the per-machine step-up window; the machine token is never involved. Routes: `web/app/api/auth/app-link/{,start,approve,exchange}`.

## Owed by the owner
- Ok for `tauri-plugin-deep-link` (task 1.1): given 2026-10-09 (the owner ran /execute after being told).
- One sitting on the MacBook for task 2.2 (and 3.2 later) — batched, asked once.
- Hosting decision for the standalone artifacts with Davor (download.tridant.io artifact kind).
- Azure Trusted Signing status (SmartScreen on the standalone Windows installer).
- Whether this targets 4.1.8 or the release after.

## Next Steps
1. Force-add this folder to git (`git add -f dev/active/swoop-viewer`) on the feature branch —
   `dev/active` is gitignored and the first swoop plan was lost that way.
2. Create a worktree off `dev` (`git worktree add ../Owlette-swoop-viewer-wt -b feat/swoop-viewer dev`)
   after the 4.1.8 bump merges; do not work on `feat/backup-codes-download`.
3. Get the deep-link crate ok, then `/execute` wave 1 (1.1–1.4 are file-disjoint).
4. Wave 2 needs a real machine on dev (B4A/A4D) and the MacBook; write `spike-g0.md` before any wave-3 task.
