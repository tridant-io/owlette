# owlette swoop (the viewer app) — Tasks
**Progress**: 18/24 complete

Conventions for every task: lowercase UI copy; no new npm/pip/cargo package without the owner's
ok (1.1 names one); lint the files you touch (`npx eslint <file>` in web/cli, `oxlint` in desktop,
`cargo clippy -- -D warnings` in Rust); update `desktop/README.md` / docs in the same change; no
version bump (4.1.8 is cut elsewhere); changelog lines go under `## [Unreleased]` in BOTH
`docs/changelog.md` and `web/content/docs/changelog.mdx`. Work on a branch off `dev`
(`feat/swoop-viewer`), not on `feat/backup-codes-download`.

Words: **owlette swoop** = the app; **viewer** = the side of a session that watches or controls
(browser tab or owlette swoop window); **swoop window** = one native window. Never "sidecar"
(that is the bundled macOS streamer), never "client".

## Wave 1: the app, the picker, the launchers

- [x] **Task 1.1: viewer crate `desktop/viewer/`**
  - Files: `desktop/viewer/Cargo.toml`, `desktop/viewer/build.rs`, `desktop/viewer/tauri.conf.json`,
    `desktop/viewer/tauri.macos.conf.json`, `desktop/viewer/capabilities/default.json`,
    `desktop/viewer/src/main.rs`, `desktop/viewer/src/lib.rs`, `desktop/viewer/src/origin.rs`,
    `desktop/viewer/src/launch.rs`, `desktop/viewer/src/windows.rs`, `desktop/viewer/dist/index.html`,
    `.github/workflows/rust-build.yml`, `desktop/README.md`, `.gitignore` (target dir).
  - Do: Create a second Tauri 2 crate modelled on `desktop/src-tauri` (same tauri/wry versions as
    `desktop/src-tauri/Cargo.toml:31-41`; plugins: `tauri-plugin-single-instance`, `tauri-plugin-log`,
    and `tauri-plugin-deep-link` — **ask the owner before adding deep-link; it is a new crate**).
    `tauri.conf.json`: `productName: "owlette swoop"`, `mainBinaryName: "owlette-swoop-viewer"`,
    `identifier: "app.owlette.swoop-viewer"`, `frontendDist: "dist"` holding one static
    `index.html` that is never shown (Tauri requires a dist), no `app.windows` entry (windows are
    built in Rust), `bundle.targets: ["nsis","app","deb"]`, `nsis.installMode: "currentUser"`,
    `nsis.webviewInstallMode.type: "downloadBootstrapper"`, icons by relative path to
    `../src-tauri/icons/*`, `plugins.deep-link.desktop.schemes: ["owlette-swoop"]`, macOS
    `minimumSystemVersion: "15.0"`, no externalBin. `capabilities/default.json`: an empty-ish
    capability for window label `main` only with `core:default` — the remote origin gets no IPC.
    `origin.rs`: `allowed_origin(url) -> Option<Url>` accepting `https://owlette.app`,
    `https://dev.owlette.app`, and `http://localhost:<any port>` only under `cfg!(debug_assertions)`;
    `from_deep_link("owlette-swoop://<host>/<path>?<q>")` → `https://<host>/<path>?<q>` through the
    same check; reject everything else (control chars, userinfo, other schemes). `launch.rs`: parse
    `argv` (at most one argument; a URL, an `owlette-swoop://` link, or nothing), remember the origin
    in `app_data_dir()/viewer.json` (`{"origin": "https://dev.owlette.app"}`) only when an argument was
    given, default `https://owlette.app`. `windows.rs`: `open(app, url)`: if the path matches
    `^/swoop/([A-Za-z0-9_-]+)/([A-Za-z0-9_.-]+)$` open or focus a `WebviewWindow` labelled
    `swoop-<site>/<machine>`, dots in the machine id as `:` (1280×800, min 780×540, centered, title `owlette swoop`), else load it in
    `main` (create if missing). Builder: `user_agent(<engine default> + " owlette-swoop-viewer/<pkg version>")`,
    `on_navigation` → allow only `allowed_origin` hosts plus `*.firebaseapp.com` and
    `accounts.google.com` (wave 2 may trim), `on_new_window` → if the target is a session URL on an
    allowed origin, open it as a swoop window and deny; otherwise open in the system browser (copy
    the http(s)-only guard from `desktop/src-tauri/src/shell_open.rs:150-177`) and deny.
    `lib.rs`: single-instance callback forwards the second launch's argv to `launch::handle`;
    deep-link `on_open_url` does the same; `on_window_event` → for `swoop-*` labels on
    `CloseRequested`: first time `prevent_close`, `eval("window.dispatchEvent(new Event('owlette:close'))")`,
    then after 300 ms call `window.close()` with a per-window "ending" flag so the second request
    passes; when the last window closes let the app exit (do NOT copy the `ExitRequested` prevention
    from `desktop/src-tauri/src/lib.rs:252`). Log plugin to the app log dir. No tray. No writes under
    `ProgramData\Owlette` or any agent path. Add the crate to `rust-build.yml` clippy/test matrix
    beside the desktop crate. README section "owlette swoop (the viewer app)": what it is, how to run
    (`cd desktop/viewer && cargo tauri dev -- -- https://dev.owlette.app/swoop`), the one-argument
    rule, and that the frontend is owlette.app.
  - Done when: `cargo test` passes with unit tests for `origin.rs` (accept/reject table incl. deep
    links and localhost-in-debug) and `launch.rs` (argv → action, remembered origin); `cargo clippy
    -- -D warnings` clean; a debug build launched with `https://dev.owlette.app/swoop` shows the login
    page in a native window, `https://dev.owlette.app/swoop/<s>/<m>` opens a `swoop-*` window, a
    second launch focuses the existing window; CI job green; README updated.

- [x] **Task 1.2: web `/swoop` picker page and app detection**
  - Files: `web/lib/swoop/viewerApp.ts` (new), `web/__tests__/lib/swoop/viewerApp.test.ts` (new),
    `web/app/swoop/page.tsx` (new), `web/components/swoop/SwoopPicker.tsx` (new),
    `web/__tests__/components/SwoopPicker.test.tsx` (new), `web/e2e/specs/swoop/picker.spec.ts` (new),
    `web/proxy.ts` (verify `/swoop` exact path is protected and allowed as a login redirect; edit only
    if not).
  - Do: `viewerApp.ts`: `isViewerApp(ua = navigator.userAgent)` → true when it contains
    `owlette-swoop-viewer/`; `viewerAppVersion(ua)`; `viewerAppHasNativeKeys(ua)` → UA contains
    `owlette-swoop-viewer/<ver> (keys)` (wave 3 sets it; implement the parser now);
    `viewerAppLink(siteId, machineId, host = location.host)` → `owlette-swoop://<host>/swoop/<s>/<m>`
    (ids validated with the same regex as the API routes use). Picker page (`'use client'`, follows
    `web/app/dashboard/page.tsx` patterns via hooks only, never Firestore directly): header with the
    owlette mark, a site `Select` from `useSites(user.uid, userSites, isSuperadmin)` restoring the
    last site the same way the dashboard does (`dashboard/page.tsx:722-739`, `owlette_current_site`),
    then machine rows from `useMachines(siteId)`: name, online dot, osFamily, a `swoopViewers` count
    badge, and state — clickable when `online && capabilities.swoop === 1` and the site has swoop on
    (`useSwoopSettings(siteId).enabled`); disabled with inline reason otherwise ("offline", "agent
    can't stream yet", "swoop is off for this site" plus, for site owners/admins, a link to
    `/dashboard?settings=<siteId>` — the same target the #323 fix uses — and for members "ask a site
    owner or admin to turn it on"). Click → `window.open('/swoop/<s>/<m>', '_blank', 'noopener')`
    (identical to `dashboard/page.tsx:768-774`; in the app this becomes a window). In a browser show a
    "dashboard" back link; in the app (`isViewerApp()`) hide it — the picker is the app's home. Reuse
    `MachineSwitcher`-style filtering past 8 machines (`web/components/charts/MetricsDetailPanel.tsx:56+`)
    or a plain filter input; lowercase copy; theme tokens only. E2E: seeded site with one online
    swoop-capable machine and one offline → rows, states, click opens `/swoop/<s>/<m>` in a popup;
    second run with `userAgent` containing `owlette-swoop-viewer/0.0.0` → no dashboard link.
  - Done when: jest for `viewerApp.ts` (UA parsing, link building, id validation) and the picker
    (states, admin vs member copy) pass; e2e picker spec passes locally (`npm run e2e -- picker`);
    `npx eslint` and `tsc` clean on touched files; `/swoop` redirects to login when signed out and
    renders when signed in with MFA.

- [x] **Task 1.3: CLI opens the app when present**
  - Files: `cli/src/lib/viewerApp.ts` (new), `cli/__tests__/lib/viewerApp.test.ts` (new),
    `cli/src/commands/swoop.ts`, `cli/__tests__/commands/swoop-http.test.ts`,
    `web/content/docs/cli/reference/swoop.mdx`, `web/content/docs/cli/readiness.mdx`,
    `cli/__tests__/commands/readiness-docs.test.ts` (if the asserted text changes), `cli/README.md`.
  - Do: `viewerApp.ts`: `findViewerApp(platform = process.platform, env = process.env)` returns the
    first existing of — win32: `%LOCALAPPDATA%\owlette swoop\owlette-swoop-viewer.exe`,
    `%ProgramData%\Owlette\app\owlette-swoop-viewer.exe`; darwin:
    `/Applications/owlette swoop.app/Contents/MacOS/owlette-swoop-viewer`; linux: `owlette-swoop-viewer`
    resolved on PATH; `launchViewerApp(exe, url)` spawns detached + unref'd (on darwin use
    `open -n -a "/Applications/owlette swoop.app" --args <url>` so Launch Services owns it) with the
    https URL as the single argument; the URL must already pass the CLI's own http(s) check. In
    `swoop.ts` after the readiness check: unless `--browser`, try the app, else `openBrowser`;
    `--no-open` unchanged; `--json` adds `viewer: "app" | "browser"` and keeps `opened`. Human output:
    "opened in owlette swoop" / "opened in your browser". Docs: the reference page gains the app
    behaviour and `--browser`; readiness copy says the CLI opens the app when installed.
  - Done when: unit tests cover locate (per platform, missing → null), launch args, fallback order,
    `--browser`, `--json` shape; existing swoop tests still pass; `npm test` in `cli/` green; docs
    test green; lint clean.

- [x] **Task 1.4: tray and hamburger entries in the desktop app**
  - Files: `desktop/src-tauri/src/viewer_launch.rs` (new), `desktop/src-tauri/src/lib.rs` (mod +
    command registration), `desktop/src-tauri/src/commands.rs`, `desktop/src-tauri/src/tray.rs`,
    `desktop/src/lib/ipc.ts`, `desktop/src/components/AppMenu.tsx`,
    `desktop/src/components/AppMenu.test.tsx` (or the existing AppMenu test), `desktop/README.md`.
  - Do: `viewer_launch.rs`: `viewer_exe_path()` = sibling of the running exe
    (`std::env::current_exe()?.parent()/owlette-swoop-viewer[.exe]`) on Windows and Linux; on macOS
    `/Applications/owlette swoop.app` (launch with `open -n -a … --args <url>`); `open_viewer(url)`
    validates the URL with the existing http(s) guard in `shell_open.rs:150-177` and that its host is
    the configured dashboard host, spawns detached, returns `Err("owlette swoop is not installed")`
    when missing. The dashboard origin comes from the same source the app already uses for dev/prod
    (`desktop/src/lib/environment.ts:58-68` on the React side; mirror the Rust lookup used by the
    tray's "open dashboard"-style links if one exists, else read `config.json` `firebase.api_base`
    once). Tray (`tray.rs` menu build at `:1128-1170`): add `MenuItem` `swoop` ("swoop") above "open
    owlette", enabled only when the viewer exe exists; handler at `:1298` opens `<origin>/swoop`.
    Hamburger (`AppMenu.tsx`): add "swoop" with the lucide `MonitorPlay` icon beside docs, calling a
    new `openSwoopViewer()` IPC wrapper in `ipc.ts` → Tauri command `open_swoop_viewer`; hide the item
    when the command reports not installed (expose `swoop_viewer_installed` or return a typed
    result). Toast the error on failure. Tests: Rust unit test for the path builder and URL check;
    vitest for the menu item presence/absence.
  - Done when: on this box after copying a debug `owlette-swoop-viewer.exe` beside
    `C:\ProgramData\Owlette\app\owlette-desktop.exe`, tray → swoop and hamburger → swoop open the app on
    dev; with the exe absent both entries are hidden/disabled; `cargo test`, `cargo clippy`, `npm test`
    in `desktop/` green; README menu list updated.

## Wave 2: measure, then make the web viewer app-aware

- [ ] **Task 2.1: measure WebView2 (this box)** — Depends on: 1.1
  - Files: `dev/active/swoop-viewer/spike-g0.md` (new), optionally `desktop/viewer/src/*` fixes found.
  - Do: Build the viewer (release), run a real session against a dev machine (B4A or A4D; the fleet
    is on dev 4.1.7+). Record with evidence (stats overlay screenshot, `chrome://webrtc-internals`
    is unavailable — use the overlay and the machine's swoop log): (1) codec negotiated and whether
    `decodingInfo` offers HEVC; (2) playout-delay negotiated (session connects at all); (3) element
    fullscreen → native fullscreen, `document.fullscreenElement` truthy, toolbar state correct;
    (4) `navigator.keyboard.lock()` presence and effect on Alt+Tab, Win, Ctrl+W in fullscreen;
    (5) pointer lock; (6) `window.open` from the picker becomes a window (1.1's handler); (7) Google
    `signInWithPopup` outcome and passkey (Windows Hello) outcome on login and step-up;
    (8) `document.visibilityState` when minimised and when covered, and whether the freeze watchdog
    fires; (9) F5 / Ctrl+R / F12 / Ctrl+P behaviour; (10) clipboard paste and copy; (11) audio
    unmute. Note input-to-photon from the overlay vs Chrome on the same box.
  - Done when: `spike-g0.md` has a Windows table with pass/fail/number per item and a one-paragraph
    recommendation for wave 3 scope; any blocker found in 1.1 fixed and tested.

- [ ] **Task 2.2: measure WKWebView (MacBook)** — Depends on: 1.1
  - Files: `dev/active/swoop-viewer/spike-g0.md`.
  - Do: Build on the MacBook (see memory `reference_mba_access`: ssh, push to the `mba` remote,
    `zsh -lc`). Same 11 items as 2.1 plus: Cmd+Tab/Cmd+Q/Cmd+W/Cmd+V behaviour, whether the
    Accessory/Regular activation policy matters, deep-link `open "owlette-swoop://dev.owlette.app/swoop"`
    reaching the running app, Google refusal text, passkey outcome. Batch every manual step the owner
    must do on the Mac into ONE sitting and say so up front (memory: no repeated manual asks).
  - Done when: macOS section filled with the same table; the playout-delay row is decisive (gate G0:
    if it fails, stop and report — macOS waits on a streamer-side decision).

- [ ] **Task 2.3: the web viewer in app mode** — Depends on: 1.2; start after `fix/swoop-disabled-viewer` (#323) merges to dev
  - Files: `web/lib/swoop/input.ts`, `web/hooks/useSwoopSession.ts`,
    `web/components/swoop/SwoopStage.tsx`, `web/components/swoop/SwoopToolbar.tsx`,
    `web/components/swoop/SwoopSpecialKeys.tsx`, `web/app/swoop/[siteId]/[machineId]/page.tsx`,
    `web/__tests__/components/SwoopStage.test.tsx`, `SwoopToolbar.test.tsx`, `SwoopSpecialKeys.test.tsx`,
    `web/__tests__/hooks/useSwoopSession.test.tsx`, `web/e2e/specs/swoop/viewer-app.spec.ts` (new).
  - Do: In app mode (`isViewerApp()`): (a) **hold-esc release** in `input.ts`: on a non-repeat
    Escape keydown while `document.fullscreenElement` is set, start a 2 s timer; keyup clears it;
    firing calls `document.exitFullscreen()` and releases pointer lock (browser mode unchanged: Chrome
    owns hold-esc). (b) **close handshake** in `useSwoopSession.ts`: listen for `owlette:close` on
    `window` and call `end()`; remove on unmount. (c) **copy**: the fullscreen tooltip and failure
    notices (`SwoopToolbar.tsx:192,199,285-294`) and the special-keys menu line
    (`SwoopSpecialKeys.tsx:146-151`) say what the app does — without native keys: "owlette swoop
    captures the keys a browser lets through; the windows key and alt+tab arrive with the native
    capture update"; with `viewerAppHasNativeKeys()`: "every shortcut goes to the machine; hold esc
    for two seconds to come back"; the stage hint (`SwoopStage.tsx:181-183`) shows the hold-esc text
    whenever in app mode, not only `hasKeyboardLock()`. (d) **back target**: the #323 back arrow
    points to `/swoop` in app mode and `/dashboard` in a browser. (e) in `useSwoopSession.ts`, if 2.1
    measured a `visible`-while-minimised webview, gate the stall detector additionally on
    `document.hasFocus()` in app mode only; otherwise leave it. E2E (Playwright `userAgent`
    `… owlette-swoop-viewer/0.0.0`): back link target, hold-esc hint text, special-keys copy;
    dispatching `owlette:close` ends the session (assert the DELETE via the existing session spec's
    harness in `web/e2e/specs/swoop/session.spec.ts`).
  - Done when: all touched jest suites pass with new cases for each branch; e2e `viewer-app` passes
    locally; browser behaviour unchanged (existing `session.spec.ts` green); lint/tsc clean.

- [x] **Task 2.4: machine-menu monitor icon and the download permalink** — Depends on: 1.2; start after `feat/swoop-discoverable` (#324) merges to dev
  - Files: `web/components/MachineContextMenu.tsx`, `web/app/dashboard/page.tsx`,
    `web/lib/swoop/openViewerApp.ts` (new), `web/__tests__/lib/swoop/openViewerApp.test.ts` (new),
    `web/app/download/swoop-viewer/route.ts` (new), `web/__tests__/components/MachineContextMenu.test.tsx`,
    `web/__tests__/components/MachineContextMenu.a11y.test.tsx`, `web/e2e/specs/swoop/viewer-badge.spec.ts`
    or a new `menu-app-icon.spec.ts`.
  - Do: Turn the swoop row (`MachineContextMenu.tsx:357-378`) into the split row used for
    restart/schedule (`:277-316`): left half unchanged ("swoop", opens the browser viewer); hairline;
    right half a `DropdownMenuItem` `w-8 justify-center px-0` with lucide `Monitor` (3.5), tooltip
    "open in the owlette swoop desktop app", `aria-label` the same, `data-testid="machine-context-menu-swoop-app"`,
    same `text-primary` focus treatment, disabled with the row when `onThisMachine`; new prop
    `onSwoopApp`. Hide the icon when already inside the app (`isViewerApp()`), since `window.open`
    already lands in a window there. `openViewerApp.ts`: `openViewerApp(siteId, machineId, { onMissing })`
    sets `window.location.href = viewerAppLink(...)`, then after 1500 ms, if
    `document.visibilityState === 'visible' && document.hasFocus()`, calls `onMissing`; cancel on
    `blur`/`visibilitychange`. Dashboard handler: `onMissing` → `toast` "owlette swoop isn't
    installed on this computer" with action "get it" → `/download/swoop-viewer`. Route: a permalink
    like `web/app/download/route.ts`; until hosted artifacts exist it 302s to
    `/docs/dashboard/swoop#owlette-swoop` with `Cache-Control: no-store`; keep the URL stable so the
    toast never changes (4.3 retargets it). Tests: split row renders, icon click calls `onSwoopApp`,
    keyboard reachability (a11y test), `openViewerApp` timer/focus logic with fake timers, route
    redirect. E2E: the icon exists for an online swoop-capable machine and is absent under the app UA.
  - Done when: jest + a11y suites green with the new cases; e2e green locally; the route returns 302
    to the docs anchor; lint/tsc clean; no colour literals.

## Wave 2b: sign-in handoff (owner ruling 2026-10-09: the app never shows a login form when a signed-in browser is at hand)

Contract shared by 2.5–2.8 (server-side records under an admin-only collection, codes 32 random bytes base64url, stored as sha256, never logged):
- `POST /api/auth/app-link` — needs the login cookie with MFA complete. Body `{}`. Mints an **approved** record for the caller's uid carrying the caller's session `mfaSatisfiedBy`, TTL 60 s. → `201 { code, expiresAt }`. (website → app)
- `POST /api/auth/app-link/start` — public, rate-limited per IP. Mints a **pending** record with a separate `secret` (32 bytes, hashed), TTL 10 min. → `201 { code, secret, approveUrl, expiresAt }` where `approveUrl` is `/app-link/approve?code=<code>`. (cold app start)
- `POST /api/auth/app-link/approve` — login cookie with MFA complete. `{ code }`. Pending → approved for the caller's uid with the caller's `mfaSatisfiedBy`. `404` unknown/expired, `409` not pending.
- `POST /api/auth/app-link/exchange` — public, rate-limited. `{ code, secret? }`. Pending (secret must match) → `202 { status: "pending" }`. Approved and unused → marks used, returns `200 { customToken }` where the custom token carries developer claim `appLinkMfa: <mfaSatisfiedBy of the approver>`. Anything else → `404`/`410`. The uid is never returned.
- `POST /api/auth/session` (existing) — when the verified ID token's `firebase.sign_in_provider` is `custom` and it carries `appLinkMfa`, the new session's MFA state is resolved as if that source had just completed (`challenge`/`passkey-uv` → verified now; `device-trust` → the device-trust branch). Claims on a custom token live only in that sign-in's ID token; nothing is written to the user record.
- Deep link with a code: `owlette-swoop://<host>/app-link?code=<code>&next=/swoop/<s>/<m>`. The app rewrites it to https and labels the window from `next`. The public page `/app-link` exchanges, signs in with the custom token, posts the session, then `router.replace(next)`; if already signed in it just replaces.

- [x] **Task 2.5: app-link routes, server lib, the two pages** — Depends on: nothing (contract above)
  - Files: `web/lib/appLink.server.ts` (new), `web/lib/appLink.ts` (new, client: `mintAppLink()`, `startAppLink()`, `exchangeAppLink(code, secret?)`, `completeAppLinkSignIn(customToken)` = `signInWithCustomToken` + `POST /api/auth/session`), `web/app/api/auth/app-link/route.ts` (new), `web/app/api/auth/app-link/start/route.ts` (new), `web/app/api/auth/app-link/approve/route.ts` (new), `web/app/api/auth/app-link/exchange/route.ts` (new), `web/app/api/auth/session/route.ts` + `web/lib/sessionManager.server.ts` (the `appLinkMfa` claim, minimal), `web/app/app-link/page.tsx` (new, public), `web/app/app-link/approve/page.tsx` (new, protected), `web/proxy.ts` (`/app-link/approve` protected and allowed as a login redirect; `/app-link` itself public), `web/__tests__/api/app-link.test.ts` (new), `web/__tests__/lib/sessionManager-appLink.test.ts` (new or extend the existing session tests), `web/e2e/specs/auth/app-link.spec.ts` (new, flow A), `web/openapi.yaml` only if `/api/auth/session` is documented there (mirror the existing non-public treatment).
  - Do: Model the records and rate limits on `web/app/api/cli/device-code/{route,poll,authorize}` and `web/lib/rateLimit.server.ts`; custom tokens as in `web/app/api/agent/auth/device-code/authorize/route.ts:116`; firebase-admin via `web/lib/firebase-admin.ts`; audit a sign-in through `web/lib/auditLog.server.ts` the same way the session route does (if it does). Expiry by TTL field + a check on read (no scheduler). The approve page (lowercase, shadcn `Card`/`Button`): "sign in owlette swoop on this computer?" + "approve only if you just clicked sign in with your browser in the app" + approve / cancel; on success "done, go back to owlette swoop". The `/app-link` page: spinner, then redirect; on failure a plain message with a link to `/login?redirect=<next>`. Firestore rules untouched (admin only). Lowercase copy, theme tokens. E2E (emulator): a signed-in TOTP user on `/swoop` calls `POST /api/auth/app-link` (via `page.request` with the context's cookies), then a FRESH context opens `/app-link?code=…&next=/swoop` and lands on `/swoop` signed in with no `/verify-2fa` hop; a second use of the code gives the failure message; an expired code (fake timers not available server-side: mint with a test-only `?ttl=1` is NOT allowed — instead assert the 410 branch in the unit test).
  - Done when: unit tests cover mint/start/approve/exchange happy paths, wrong secret, reuse, expiry, pending polling, the session route claim handling (claim honoured only for `sign_in_provider=custom`); e2e flow A green locally; `npx eslint` and `tsc` clean; a short security note at the top of `appLink.server.ts` (actor/mechanism/outcome for a leaked code: single use, 60 s / 10 min, no uid in responses, control still needs the per-machine step-up window).

- [x] **Task 2.6: the app labels an app-link window by its `next` session** — Depends on: nothing
  - Files: `desktop/viewer/src/windows.rs`, `desktop/viewer/src/origin.rs` (if the parser lives there), `desktop/README.md`.
  - Do: `session_label(url)` (or the matcher used by `open`) also accepts path `/app-link` whose `next` query value is a session path `/swoop/<s>/<m>` on the same origin (relative path only; reject absolute URLs and anything with `//`); the window is labelled from `next` exactly as a direct session URL would be, created with the app-link URL. `on_new_window`/`on_navigation` keep working since it is the same origin. Unit tests: `/app-link?code=x&next=%2Fswoop%2Fa%2Fb.c` → `swoop-a/b:c`; `next=https://evil/...` → not a session; missing `next` → main window. Logging stays origin+path (no query), which keeps the code out of the log.
  - Done when: `cargo test --locked` and `cargo clippy --all-targets -- -D warnings` green; debug build opened with the app-link form shows one window whose title is `owlette swoop` and whose label (check via a log line that prints the label at creation) is the session label.

- [x] **Task 2.7: picker rows open the app signed in; `openViewerApp` helper** — Depends on: nothing (contract above; 1.2 files)
  - Files: `web/lib/swoop/viewerApp.ts`, `web/lib/swoop/openViewerApp.ts` (new, moved here from 2.4), `web/components/swoop/SwoopPicker.tsx`, `web/__tests__/lib/swoop/viewerApp.test.ts`, `web/__tests__/lib/swoop/openViewerApp.test.ts` (new), `web/__tests__/components/SwoopPicker.test.tsx`, `web/e2e/specs/swoop/picker.spec.ts`.
  - Do: `viewerAppLink(siteId, machineId, { host?, code })` → `owlette-swoop://<host>/app-link?code=<code>&next=<encoded /swoop/s/m>`; keep a codeless form for callers that have no session. `openViewerApp.ts`: `openViewerApp(siteId, machineId, { mint, onMissing })` → `code = await mint()` (`POST /api/auth/app-link`, via the client lib contract: implement the fetch inline here to stay independent of 2.5, one small function `mintAppLinkCode()` exported from `openViewerApp.ts`; 2.5's `web/lib/appLink.ts` may later re-export it), then `window.location.href = link`, then the 1.5 s focus heuristic (`visibilityState==='visible' && document.hasFocus()` → `onMissing`), cancelled on `blur`/`visibilitychange`. In `SwoopPicker` browser mode, every ready row gets a right-aligned icon button (lucide `Monitor`, `aria-label` "open in the owlette swoop desktop app", `data-testid="swoop-picker-app-<machineId>"`, same split-row look as the machine menu's restart row at `web/components/MachineContextMenu.tsx:277-316`): click → `openViewerApp`; `onMissing` → `toast` "owlette swoop isn't installed on this computer" with action "get it" → `/download/swoop-viewer`. In app mode no icon (the row itself opens a window). Tests: link builder with/without code and encoding; `openViewerApp` with fake timers (mint called once, href set, onMissing after 1.5 s only when still focused, cancelled on blur, mint failure → toast error and no navigation); picker renders the icon in browser mode only and calls the helper. E2E: in the picker spec assert the icon exists in browser mode and is absent under the app UA; intercept `POST /api/auth/app-link` with `page.route` returning a fake code and assert the navigation target (listen for `framenavigated` or stub `location.assign` through `page.addInitScript`) starts with `owlette-swoop://` and carries `code=` and `next=`.
  - Done when: jest green for all three files; picker e2e green locally; lint/tsc clean.

- [x] **Task 2.8: cold app start signs in through the browser** — Depends on: 2.5
  - Files: `web/app/login/page.tsx`, `web/app/verify-2fa/page.tsx` (copy only, if it mentions popups), `web/lib/inAppBrowser.ts` (reuse its remediation copy path if sensible), `web/__tests__/app/login*.test.tsx` (existing or new), `web/e2e/specs/auth/app-link.spec.ts` (extend with flow B).
  - Do: when `isViewerApp()`: the login page shows ONE primary button "sign in with your browser" above the email form, hides Google and passkey buttons (both measured broken in the app), and keeps email+password as the secondary path. Click → `startAppLink()` → `window.open(approveUrl, '_blank', 'noopener')` (the app sends it to the system browser) → poll `exchangeAppLink(code, secret)` every 2 s until `200` (then `completeAppLinkSignIn` → `router.replace(redirect ?? '/swoop')`), `410`/`404` (show "that link expired, try again"), or 10 min. Show "waiting for your browser…" with a cancel. The redirect param keeps working (`/login?redirect=/swoop/s/m`). E2E flow B: context A under the app UA opens `/login?redirect=/swoop`, clicks the button, captures the popup URL; context B (signed-in TOTP user) opens that URL and approves; context A lands on `/swoop` signed in, no `/verify-2fa` hop.
  - Done when: unit tests for the app-mode branch (button present, google/passkey hidden, poll success/expiry paths with fake timers); e2e flows A and B green locally; lint/tsc clean; the browser login page is unchanged for non-app UAs (existing login e2e green).

- [x] **Task 2.9: the viewer's bar is the title bar** (owner ruling 2026-10-09; done the same day)
  - Files: `desktop/viewer/tauri.conf.json` (`withGlobalTauri`), `desktop/viewer/capabilities/owlette-pages.json`, `desktop/viewer/src/{windows,lib}.rs`, `web/components/swoop/SwoopWindowControls.tsx`, `SwoopToolbar.tsx`, `SwoopPicker.tsx`, `web/app/login/page.tsx`, `web/lib/swoop/viewerApp.ts` (`viewerAppPlatform`), tests, `web/e2e/specs/swoop/viewer-app.spec.ts`, `desktop/README.md`.
  - Done: frameless windows (macOS: overlay title bar + hidden title, traffic lights with a 78 px inset); page-drawn min/max/close on Windows/Linux; bar is the drag surface (`data-tauri-drag-region="deep"`); a slim 32 px strip with only the buttons when the bar is on a side; picker header and login strip; capability limited to window minimize / toggle-maximize / internal-toggle-maximize / close / start-dragging / is-maximized + event listen/unlisten for owlette.app and dev.owlette.app (localhost added at run time in debug builds only). Verified on this box over CDP: buttons, double-click maximize, close handshake, refusal of every other command. Real mouse drag not synthesizable here.

- [x] **Task 2.10: the picker is a grid of cards, four columns at most** (owner ruling 2026-10-09; done)
  - Files: `web/components/swoop/SwoopPicker.tsx`, its jest, `web/e2e/specs/swoop/picker.spec.ts`.
  - Do: `grid-cols-1 sm:2 md:3 xl:4`, page container `max-w-6xl`, card = status dot + name + viewers badge, os line, reason line; ready card is one button; browser mode keeps the `Monitor` icon top-right outside the click target; the header's MonitorPlay icon aligned optically with "swoop".
  - Done when: picker jest + e2e green incl. one-column at 390 px and four at 1440 px; screenshots in the real app.

- [x] **Task 2.11: a session opens in the same window by default** (owner ruling 2026-10-09: "default is keep it in this window; right-click to open in a new window; on disconnect it returns to the main window")
  - 2.11a (app, running): routing rule — a session URL from argv/deep link/handoff navigates `main` unless `main` is itself on a session page (then a `swoop-*` window, as today); `window.open` always makes a `swoop-*` window; the close handshake runs on every window; README.
  - 2.11b (web, after 2.10): picker click in the app → same-window navigation (`router.push`); right-click (and a keyboard-reachable equivalent) → menu "open in new window" → `window.open`; browser mode unchanged; the viewer in the app returns to `/swoop` when the session reaches `ended` (refusals/failures keep the notice with the back arrow); jest + e2e under the app UA.

- [x] **Task 3.4b: "verify in your browser" for the step-up in the app** (owner ruling 2026-10-10; done)
  - Why: in the app a passkey prompt reaches only the platform authenticator (no 1Password extension in WebView2, no WebAuthn in WKWebView). The step-up window is server-side per user+machine for 12 h and the app session inherits the browser ceremony, so a step-up passed in the system browser unlocks control in the app.
  - Do: POST/GET `/api/sites/{s}/machines/{m}/swoop/step-up` (proof → openStepUpWindow, reused from the sessions route; GET → window open?), protected page `/swoop/<s>/<m>/verify` with the passkey/code ceremony, app dialog: passkey hidden, primary "verify in your browser" + 3 s poll + retry-without-proof in the hook; browser unchanged; docs paragraph.
  - Done when: route/dialog/hook jest, viewer-app + session e2e green, openapi validate clean.

- [x] **Task 4.4: refresh the agent docs screenshots for 4.1.8** (done at the cut: captured.json records 4.1.8 at 2026-10-10T09:19Z from the installed 4.1.8 exe; the hamburger shot shows no swoop row because no viewer exe sits in the install on this box)
  - Why: the release recipe requires `node scripts/refresh-docs-screens.mjs` after the build; it swaps the built exe into the install (the service must stop: an elevation prompt) and drives the installed app with the tray icon visible on an interactive desktop. Both need the owner present (ADR 0005: no unattended elevation), so the 4.1.8 cut on 2026-10-10 shipped without it.
  - Do: with the 4.1.8 exe built, run `node scripts/refresh-docs-screens.mjs`, then `node scripts/refresh-docs-screens.mjs --check`; commit the `web/public/docs-screens` diff (none is a valid result). Add shots of owlette swoop (picker, session bar, verify page) to the capture harness if the docs reference them.
  - Done when: `--check` passes against VERSION and the docs show the current app.

- Note: 3.4 is now only the leftovers (verify-2fa copy, step-up dialog ordering); 2.4 keeps the machine-menu icon and `/download/swoop-viewer` and reuses `openViewerApp.ts` from 2.7.

## Wave 3: native capture and sign-in (scope fixed by spike-g0.md)

- [ ] **Task 3.1: Windows key capture, accelerators off, release** — Depends on: 2.1
  - Files: `desktop/viewer/src/keys_windows.rs` (new), `desktop/viewer/src/windows.rs`,
    `desktop/viewer/src/lib.rs`, `desktop/viewer/Cargo.toml` (windows crate features
    `Win32_UI_WindowsAndMessaging`, `Win32_UI_Input_KeyboardAndMouse`), `desktop/README.md`.
  - Do: Install a `WH_KEYBOARD_LL` hook from the main thread (`run_on_main_thread`) when a swoop
    window enters fullscreen (track via the window's `on_window_event` Resized + `is_fullscreen()`,
    or the page's `document.fullscreenElement` reported through the UA-less path: poll
    `is_fullscreen()` on focus change) and the window is focused; uninstall on leave/blur/close.
    While active, swallow (return 1) VK_LWIN/VK_RWIN and their chords, Alt+Tab, Alt+Esc, Ctrl+Esc,
    Alt+F4, and deliver each as `eval("window.__owletteNativeKey?.(<code>, <down>)")` with the DOM
    `code` string (map VK → `code` for the modifier/letter/function set; reuse the table shape of
    `web/lib/swoop/keymap.ts`). Never swallow Esc (the page-side hold-esc timer needs it), Win+L or
    Ctrl+Alt+Del (the OS keeps them). Turn WebView2 browser accelerator keys off via
    `with_webview(|w| ICoreWebView2Settings3::SetAreBrowserAcceleratorKeysEnabled(false))`
    (webview2-com is already a transitive dep; name the version in Cargo.toml with a why-comment).
    Append ` (keys)` to the UA token at build time on Windows. Document the captured list.
  - Done when: in a release build, in fullscreen, Alt+Tab, Win, Win+D, Alt+F4 reach the remote
    machine (3.3 landed) and do nothing locally; leaving fullscreen or blurring restores them within
    one keypress; F5/Ctrl+R/F12 do nothing in a swoop window; unit tests for the VK→code table and
    the swallow predicate; clippy clean.

- [ ] **Task 3.2: macOS presentation options, event monitor, menu** — Depends on: 2.2
  - Files: `desktop/viewer/src/keys_macos.rs` (new), `desktop/viewer/src/mac.rs` (new),
    `desktop/viewer/src/lib.rs`, `desktop/viewer/Cargo.toml` (objc2-app-kit features),
    `desktop/viewer/tauri.macos.conf.json`, `desktop/README.md`.
  - Do: Regular activation policy (the app lives in the Dock and Cmd+Tab). Standard Edit menu with
    key equivalents so Cmd+V/C/X/A reach the page; strip File/Window shortcuts that would close or
    hide the app (keep Quit under the app menu but route Cmd+Q to the page while a swoop window is
    fullscreen). On a swoop window entering fullscreen set
    `NSApp.presentationOptions = [.fullScreen, .hideDock, .disableProcessSwitching,
    .disableHideApplication, .autoHideMenuBar]`; restore on leave. Add a local
    `NSEvent.addLocalMonitorForEvents(matching: .keyDown/.keyUp/.flagsChanged)` that, while captured,
    forwards Cmd+Tab/Q/W/H/M to the page via `eval("window.__owletteNativeKey…")` and returns nil.
    Cmd+Space stays with the OS (documented). Set the ` (keys)` UA token on macOS when compiled in.
    Use `objc2`/`objc2-app-kit` as `desktop/src-tauri/src/mac_window.rs` does; cite the pattern.
  - Done when: on the MacBook, in fullscreen, Cmd+Tab and Cmd+Q reach the remote machine and
    do nothing locally; leaving fullscreen restores Dock and switching; Cmd+V pastes into the remote
    machine; one manual sitting, batched; clippy clean on `macos-26` CI.

- [x] **Task 3.3: web native-key seam and capture state** — Depends on: 2.3
  - Files: `web/lib/swoop/input.ts`, `web/lib/swoop/keyboardLock.ts`, `web/lib/swoop/specialKeys.ts`,
    `web/lib/swoop/viewerApp.ts`, `web/__tests__/lib/swoop/input.test.ts` (or the existing input
    tests), `web/__tests__/components/SwoopSpecialKeys.test.tsx`.
  - Do: Add `InputCapture.nativeKey(code: string, down: boolean)` that feeds the same path as a DOM
    keydown/keyup for that `code` (modifier state tracked, repeat suppressed, release-all on blur
    covers it). In app mode with `viewerAppHasNativeKeys()`, attach `window.__owletteNativeKey =
    (code, down) => capture.nativeKey(code, down)` on connect and delete it on teardown; never define
    it in a browser. `keyboardLock.ts`: `hasKeyboardLock()` returns false in app mode (the webview
    lock is unmeasured/ineffective; native capture is the truth) and `lockKeyboard()` is a no-op
    there. `specialKeys.ts`: when native keys are present, drop the combos the app now delivers
    (Win, Alt+Tab, Alt+F4, Win+D on Windows; Cmd+Tab, Cmd+Q on macOS) from the "needs the menu"
    list and keep Win+L, Ctrl+Alt+Del, Cmd+Space, Cmd+Ctrl+Q. Reserved `F11`/`F12` stay reserved in
    browsers; in app mode F11 toggles nothing locally so let it through to the machine.
  - Done when: unit tests cover `nativeKey` ordering/modifier tracking, the global's presence only
    in app mode, `hasKeyboardLock` in app mode, and the special-keys list per capability; existing
    tests green; lint/tsc clean.

- [ ] **Task 3.4: sign-in in app mode** — Depends on: 2.1, 2.2
  - Files: `web/app/login/page.tsx`, `web/app/verify-2fa/page.tsx`, `web/lib/inAppBrowser.ts`,
    `web/components/swoop/SwoopStepUpDialog.tsx`; if G0 says Google fails in either engine:
    `web/app/api/auth/app-link/route.ts` (new), `web/app/app-link/page.tsx` (new),
    `web/lib/appLink.server.ts` (new), `firestore.rules` untouched (use a server-side collection via
    admin), tests, `web/e2e/specs/mfa/` or `auth/` spec (new).
  - Do (always): in app mode hide the sign-in methods G0 proved broken on that engine (detect engine
    from the UA: `Edg/` + token = WebView2, no `Safari/`-style WebKit = WKWebView) and show one line
    "google and passkey sign-in open in your browser" when the browser-assisted flow exists, or "use
    your email and password, then your authenticator code" when it does not; the step-up dialog
    offers TOTP/backup first where passkeys cannot run. Do (only if G0 requires it): browser-assisted
    sign-in — `POST /api/auth/app-link` mints a one-time 8-char code (10 min TTL, hashed at rest,
    bound to a random poll secret); the login page in app mode shows "sign in with your browser",
    opens `https://<origin>/app-link/<code>` in the system browser (a plain link; the app's
    `on_new_window` sends it out) and polls `GET /api/auth/app-link/<code>` with the secret; the
    `/app-link/<code>` page (protected path, full MFA) asks "sign in owlette swoop on this computer?"
    and on confirm the server stores a Firebase custom token for that uid; the app page receives it,
    calls `signInWithCustomToken`, then `POST /api/auth/session` as today. The new session has not
    passed a ceremony, so control still asks for a TOTP/backup step-up once; document that. Rate
    limit mint and poll like `/api/cli/device-code`. OpenAPI untouched (internal auth route; mark it
    non-public like `/api/auth/session`).
  - Done when: e2e covers the app-UA login page variants; if built, the app-link flow has unit
    tests (mint/poll/confirm/expiry/wrong secret) and an e2e that signs in a second context through
    the code; `npm run test:rules` unaffected; lint/tsc clean; security review of the route per the
    review discipline (actor/mechanism/outcome for anything above low).

## Wave 4: packaging, artifacts, docs

- [x] **Task 4.1: ship owlette swoop inside the agent installers** — Depends on: 3.1, 3.2 (or G0 saying wave 3 is deferred)
  - Files: `agent/owlette_installer.iss`, `agent/build_installer_full.bat`, `agent/build_installer_quick.bat`,
    `agent/build/macos/build.sh`, `agent/packaging/macos/distribution.xml`, `agent/build/linux/build.sh`,
    `agent/packaging/linux/owlette-swoop-viewer.desktop` (new), `scripts/vm/*` (a new verify step),
    `.claude/skills/build-system/SKILL.md` (build step list).
  - Do: Read the build-system skill first. Windows: build step for `desktop/viewer` (`npx tauri build
    --no-bundle` equivalent via `cargo tauri build --no-bundle` in the crate) after the desktop app
    step in both .bat files; `[Files]` entry `owlette-swoop-viewer.exe` → `{app}\app`; `[Registry]`
    section (new; the .iss has none today — keep it minimal): `HKCR\owlette-swoop` with
    `URL Protocol` and `shell\open\command "{app}\app\owlette-swoop-viewer.exe" "%1"`, `uninsdeletekey`;
    `[Icons]` `{group}\owlette swoop` with its own AUMID is NOT needed (no toasts) — plain shortcut,
    lowercase; kill `owlette-swoop-viewer` by path in the existing pre-install sweep beside
    `owlette-desktop` (`iss:466`, `:1396`) and in uninstall. Never touch `PrivilegesRequired`,
    firebase config, or the UAC rules (ADR 0005). macOS: build the viewer bundle in `build.sh`
    (`--bundles app`, no externalBin), add it to the app payload beside `owlette.app` so the pkg
    installs `/Applications/owlette swoop.app`; `distribution.xml` lists it; the deep-link plugin
    writes CFBundleURLTypes — verify in the built Info.plist. Linux: `--bundles deb` for the viewer,
    unpack into the payload like the desktop deb (`build.sh:90-116`), ship
    `/usr/share/applications/owlette-swoop-viewer.desktop` with
    `MimeType=x-scheme-handler/owlette-swoop;` and `Exec=owlette-swoop-viewer %u`, merge Depends. Add a
    VM verify script step: after install, `start owlette-swoop://dev.owlette.app/swoop` opens the app;
    after uninstall the key, exe and shortcut are gone.
  - Done when: a full Windows build on this box produces an installer that installs/uninstalls
    cleanly on the Hyper-V VM with the registry key present then absent (log attached in the PR);
    macOS pkg built in CI contains both apps and the URL type; deb lists the binary and .desktop;
    the upgrade path from the oldest fielded version (ADR 0006) still passes the existing VM scripts.

- [ ] **Task 4.2: standalone artifacts in CI** — Depends on: 1.1 (3.x for a useful build)
  - Files: `.github/workflows/build-installer.yml` (new job `build-viewer`), `desktop/README.md`.
  - Do: Matrix job (windows-latest, macos-26, ubuntu-24.04) that builds `desktop/viewer` with
    `cargo tauri build` for `nsis` / `app` / `deb`; macOS reuses the existing signing + notarization
    steps and secrets from `build-macos` (`:255-417`) and zips `owlette swoop.app`; artifact names
    `owlette-swoop-v<version>-windows-x64-setup.exe`, `owlette-swoop-v<version>-macos-arm64.zip`,
    `owlette-swoop-v<version>-linux-x64.deb` (read the version from `desktop/viewer/tauri.conf.json`,
    which `scripts/sync-versions.js` must also bump — add it to the version-file list there, in the
    same PR, without changing the current number). Upload as workflow artifacts and attach to the
    GitHub release the `release` job creates. Do NOT publish through `upload-installer.mjs` or
    `installer_metadata` (agent-only scheme). Record in the README that hosting on download.tridant.io
    needs a new artifact kind from tridant (owner + Davor) and that until then the links are the
    release assets.
  - Done when: the job is green on a `dev` push; a clean Windows VM with no agent installs the
    NSIS artifact per-user, registers `owlette-swoop://`, signs in and runs a session (recorded in
    `spike-g0.md` "clean install" section with the SmartScreen outcome noted); `sync-versions.js`
    test (if any) updated.

- [x] **Task 4.3: docs, glossary, ADR, changelog, permalink target** — Depends on: 2.3, 2.4, 4.2
  - Files: `web/content/docs/dashboard/swoop.mdx`, `web/content/docs/cli/reference/swoop.mdx` (if
    1.3 left anything), `GLOSSARY.md`, `docs/adr/0012-owlette-swoop-hosts-the-web-viewer.md` (new),
    `docs/changelog.md`, `web/content/docs/changelog.mdx`, `desktop/README.md`,
    `web/app/download/swoop-viewer/route.ts`, `docs/roadmap.md` (mark #325 landed).
  - Do: swoop.mdx: a section "owlette swoop, the app" (what it is, where to get it per OS, the three
    ways to open it, hold-esc, what it captures per OS and what stays with the OS, H.264 on Windows,
    sign-in methods per engine, that closing a window ends the session); revise the browser-only
    statements listed in the research (`:7,20,55,59,82,92,97-101,116-153,206`) to say "browser or
    owlette swoop" where true. GLOSSARY: swoop (not only "in a browser tab"), Session ("one viewer's
    connection", tab or window), Viewer (browser tab or owlette swoop window; keep `client` under
    Avoid; add "sidecar" under Avoid for the app), Desktop app (note the operator workstation case),
    new entry **owlette swoop** (the app; binary `owlette-swoop-viewer`; _Avoid_: viewer client,
    native viewer, sidecar). ADR 0012, one paragraph in the 0001 format: the app hosts the web viewer
    as a top-level page and adds only what a browser cannot (window management, OS-shortcut capture,
    the URL scheme), instead of a second viewer with its own decoder; consequences: Windows is H.264
    in the app, auth lives in the webview's cookie jar, the scheme is received-only. Changelog lines
    under `[Unreleased]` in both files. Retarget `/download/swoop-viewer` to the hosted artifact if
    it exists by then, else leave the docs anchor and say so in the section.
  - Done when: docs build (`npm run build` in web) passes; docs search keywords frontmatter updated
    for the new section (memory: keywords frontmatter is the win); glossary terms used consistently
    across the PR (grep for "sidecar" and "client" in the new copy returns nothing); ADR present;
    both changelogs carry the entry.

## Log
### 2026-10-09
- Plan created after three research passes (desktop runtime, web viewer, CLI/launch path).
- Owner rulings folded in: standalone app "owlette swoop", binary `owlette-swoop-viewer`, tray +
  hamburger + website entry (monitor icon split row), no `--swoop` flag.
- Pending owner ok: adding `tauri-plugin-deep-link` (task 1.1).
- Not part of this plan: lowercase Start-menu/installer names (separate fix PR); version bump (4.1.8
  is cut by another session).

### 2026-10-09 (wave 1)
- Worktree `Owlette-swoop-viewer-wt`, branch `feat/swoop-viewer` off dev f67a2f4a (4.1.7; the 4.1.8 bump had not merged yet — rebase later). Plan folder force-added there; the copy in the main checkout is a mirror.
- Owner ok for `tauri-plugin-deep-link`: given 2026-10-09 (the owner ran /execute after being told 1.1 adds it).
- 1.1 done: `desktop/viewer/` crate (tauri 2.12 / wry 0.57 via the desktop lock file, plus `tauri-plugin-deep-link` 2.6.1). 22 unit tests, clippy clean, debug exe built and run on Windows: picker window, deep link to a swoop window, single-instance handoff, close handshake (363 ms), remembered origin, UA token `owlette-swoop-viewer/4.1.7`. Window label is `swoop-<site>/<machine>` with `.` turned into `:` (Tauri rejects dots; `-` in both ids made `<site>-<machine>` ambiguous). macOS/Linux legs unbuilt until CI. The `*.firebaseapp.com` navigation allowance is to be trimmed in wave 2.
- 1.2 done: `web/lib/swoop/viewerApp.ts`, `/swoop` picker (`SwoopPicker.tsx`), 17 jest, e2e `picker.spec.ts` 3/3 locally, screenshots light/dark/phone ok. `/dashboard?settings=` is inert until #323 lands. No `app/swoop/layout.tsx` (it would wrap the viewer route): tab title is the root default for now.
- 1.3 done: CLI `findViewerApp`/`launchViewerApp`, `--browser`, `--json viewer: app|browser|null`; 315 CLI tests green. Pre-existing breaks found: `cli/eslint.config.mjs` imports `typescript-eslint`, which is installed nowhere (linted via web's eslint for now); `readiness-docs.test.ts` was failing at HEAD (assertion updated to the doc's wording). `web/content/docs/cli/overview.mdx:172` still says "in your browser" (task 4.3).
- 1.4 done: `viewer_launch.rs` (sibling exe / `/Applications/owlette swoop.app`, host allowlist, `dashboard_host()` from `config.json` `firebase.api_base` with prod fallback), tray item id `open_swoop` (label "swoop"; id `swoop` was taken by the status row), hamburger "swoop" first with `MonitorPlay`; 525 desktop tests and 151 Rust tests green. The tray item's enabled state refreshes only when the menu is rebuilt.
- NOT verified: tray and hamburger actually launching the viewer (needs a dev desktop run with the viewer exe beside it; procedure: copy `desktop/viewer/target/debug/owlette-swoop-viewer.exe` into `desktop/src-tauri/target/debug/`, close the installed tray app by its `tray.pid`, run `npx tauri dev` in `desktop/`); macOS and Linux builds of the viewer crate.

### 2026-10-09 (wave 2, measurement halves that need no sign-in)
- Worktree fast-forwarded onto dev 9a3a26e9 (4.1.8 bump merged); the viewer crate's own version strings set to 4.1.8 and both files added to `scripts/sync-versions.js`.
- 2.1 (Windows, pre-login half) measured through a debug-only CDP port 9222 (`desktop/viewer/src/windows.rs`, debug builds only; release verified not listening). Script: `node dev/active/swoop-viewer/spike/measure-webview2.mjs --phase pre|post` from the repo root. Results in `spike-g0.md`: H.264 only with a hardware decoder; the receiver offers the playout-delay extension; Tauri IPC from the remote page is refused; Google sign-in fails ("your browser blocked the google sign-in window"); F5 and Ctrl+R reload the page; F12 opens devtools in debug only; a minimised window still reports `visible` and keeps painting (so the `hasFocus()` gating idea is dead, but no false stall expected); a lone Alt tap puts the host window into system-menu mode until Esc (wave 3 must handle it). Bug found in 1.1: `open_in_browser` used `explorer.exe`, which opens File Explorer for any URL with `?` (the CLI's `openBrowser` has the same risk). The `post` phase (needs a session) is the owner sitting.
- 2.2 (macOS, no sign-in) on the MacBook in a fresh `~/src/owlette-swoop-viewer-g0` (the Mac checkout is dev 4.0.5 with older tauri; untouched). Compiles, 22 tests, clippy clean, `.app` built with the `owlette-swoop` URL type. Measured via a debug build pointed at a local probe page: **playout-delay present** (gate G0's fatal item passes), `navigator.keyboard` absent, element→native fullscreen works, `window.open` to a session URL becomes a window, covered window goes `hidden` in 54 ms, pointer lock refused (`WrongDocumentError`) even with focus, HEVC probe fails because `clientCaps.ts` passes a `codecs=` parameter WKWebView throws on (web bug; Safari likely affected; separate fix), cold deep-link start opens two windows, session windows stack at one frame, bundle is ad-hoc signed and has no `NSLocalNetworkUsageDescription`. The built app stays at `~/src/owlette-swoop-viewer-g0/desktop/viewer/target/release/bundle/macos/owlette swoop.app` for the owner sitting; the 3.5 GB staging dir needs the owner's ok to remove.
- Crate fixes queued from these results: ShellExecuteW instead of explorer.exe, one window on a cold session deep link, cascaded session windows, a log line on home launch.
- Owner question raised: first launch asks for a sign-in even on a paired Mac (the desktop app is paired as a machine, not signed in as a user; the webview has its own cookie jar). Proposal pending: pull 3.4 forward as a two-way sign-in handoff (website → app via a one-time code in the deep link; cold app start → "sign in with your browser").
- 2.3 and 2.4 still parked: #323 and #324 are uncommitted in other sessions' worktrees.
### 2026-10-09 (wave 2b added)
- Owner ruling: the first-launch sign-in wall is unacceptable; build the two-way sign-in handoff before native keys. Added wave 2b (tasks 2.5–2.8) with the shared route contract; 3.4 reduced to leftovers; 2.4 reuses 2.7's helper.

### 2026-10-09 (wave 2b, three of four)
- 2.5 done: `web/lib/appLink.server.ts` (+ security note), routes `api/auth/app-link/{,start,approve,exchange}`, client `web/lib/appLink.ts`, pages `/app-link` (public) and `/app-link/approve` (protected), `appLinkMfa` custom-token claim honoured by `/api/auth/session` only for `sign_in_provider=custom` and only within 5 min of `auth_time`; started codes need their secret at every state. 99 unit tests across six suites; e2e flow A green (fresh context lands on `/swoop` with `mfaSatisfiedBy: challenge`, no `/verify-2fa` hop; reuse refused). Outside the plan: the proxy now keeps the query string on login/challenge redirects (every protected path); four app-link routes added to the audit-coverage exemptions beside `auth/session`. Open: `validate-openapi.ts` warns about the four routes (2.8 adds them to `INTERNAL_ROUTES`); `web/.next-e2e-applink/` left on disk (recursive delete needs the owner).
- 2.6 done: `/app-link?next=/swoop/<s>/<m>` labels the window from `next` (strict grammar; 24 crate tests), an already-open session is raised rather than reloaded, `new swoop window <label>` log line, no `code=` in any log.
- 2.7 done: `viewerAppLink(..., { code })` builds the app-link deep link; `openViewerApp.ts` mints, navigates, 1.5 s focus heuristic → toast with "get it"; picker rows get the `Monitor` half in browser mode only. 738 jest green; picker e2e 4/4 (orchestrator ran it after the port clash). `mintAppLinkCode` duplicates `mintAppLink` (2.8 consolidates).
- 2.8 running: login page "sign in with your browser" (3 s poll to stay under the 300/h exchange limit), flow B e2e.

### 2026-10-09 (wave 2b complete; review set up)
- 2.8 done: app-mode login page shows one "sign in with your browser" button (Google and passkeys hidden, no conditional-UI ceremony), opens the approve page in the system browser, polls exchange every 3 s (≤200 calls, under the 300/h limit), lands on the redirect; expiry/cancel/blocked-popup paths handled. 12 new unit tests; e2e flows A and B plus `mfa/setup-verify`, `mobile/auth` and the picker spec: 13 passed. `openViewerApp` now uses `mintAppLink` (duplicate removed). The four app-link routes are listed in `web/scripts/validate-openapi.ts` `INTERNAL_ROUTES`.
- Dev-mode review support in the crate: debug builds register `owlette-swoop://` in HKCU for themselves (not on macOS, where the plugin reports unsupported) and rewrite `owlette-swoop://localhost:<port>/…` to `http://` (26 crate tests, debug and release).
- Review rig on this box: worktree web dev server on `http://localhost:3001` (port 3000 is the main checkout's server); the HKCU scheme points at `desktop/viewer/target/debug/owlette-swoop-viewer.exe`. Tray/hamburger review waits for a dev deploy: they open `https://dev.owlette.app/swoop`, which does not exist on dev until this branch lands.
- Still open from the measurements: the `clientCaps.ts` HEVC probe bug (Safari/WKWebView), pointer lock refused in WKWebView, lone Alt menu mode and F5/Ctrl+R on Windows (wave 3), the session halves of G0 (owner sitting).

### 2026-10-09 (reviews before landing)
- Standards review: nothing above low. Spec review: 1.4's tray/hamburger launch and the close handshake were unverified/half-built. Fixed before landing: login page always shows the "didn't open?" line (the app answers every `window.open` with null); `owlette:close` listener and app-mode hold-esc landed early (the 2.3 pieces; #323 conflict risk checked); `/download/swoop-viewer` 302s to the swoop docs page until 4.3; CLI uses the app only for owlette.app / dev.owlette.app profiles; one `safeNextPath` guard; dead helpers removed from `viewerApp.ts` — **task 3.3 must re-add `viewerAppHasNativeKeys()` (UA token ` (keys)`) when native capture lands; 2.3's remaining copy work references it too.** Kept: the `*.firebaseapp.com` / `accounts.google.com` navigation allowance until the Mac sitting shows email login needs no auth iframe in WKWebView. The browser-wait deadline stays a fixed client-side 10 minutes (a server `expiresAt` compared with the client clock gives up early on a skewed clock); the server's own 410 still ends it sooner when it expires first.
- Debug builds register `owlette-swoop://` in HKCU pointing at the build-tree exe; on a dev box that key shadows the installer's HKCR registration (4.1 should note it; `reg delete HKCU\Software\Classes\owlette-swoop /f` clears it).

### 2026-10-09 (owner review on localhost, preflight)
- Owner review rig: worktree web dev server on `http://localhost:3001` against the dev Firebase project; the owner enrolled an authenticator app on dev so localhost (passkeys are bound to owlette.app; dev-mode RP is `localhost`) accepts a TOTP. Localhost then failed with "Unsupported state or unable to authenticate data": the local `MFA_ENCRYPTION_KEY` differed from railway-dev's. Fixed by linking the main checkout to Railway (`railway link -p owlette -e dev -s owlette-dev`) and copying dev's value into the worktree's `web/.env.local` (the main checkout's `.env.local` still has the stale key). Owner confirmed sign-in works.
- Owner rulings during review: copy is "open in the owlette swoop desktop app" (tooltip/label), "the owlette swoop desktop app isn't installed on this computer", "could not open the owlette swoop desktop app", CLI "opened in the owlette swoop desktop app." Task 2.4's machine-menu icon uses the same wording.
- Owner bug: the machine's cursor in the app looked small and soft. Cause: outside pointer lock the viewer sets the machine's bitmap as a css cursor; the app's webview paints it at bitmap size on a scaled display. Fix in `SwoopCursor.tsx`: in the app (`isViewerApp()`) the cursor is always the drawn overlay (same path as pointer lock), local pointer hidden; unit test added. Owner to confirm on screen.
- Preflight: security CLEAR (1 acked blocker, 34 warnings reported), lint 0 errors (5 pre-existing warnings in untouched files), tsc clean, jest 381 suites / 6958 passed, rules skipped (firestore.rules untouched), e2e 499 passed (19.4 min). The first two e2e attempts died on a Firestore emulator port held by an orphaned emulator from the first attempt; killed by PID. Picker + app-link specs rerun after the copy change.

### 2026-10-09 (owner rulings, late)
- Task 2.9 added and running: the viewer's bar is the title bar (frameless windows; page-drawn min/max/close on Windows/Linux, native traffic lights with a left inset on macOS; a slim top strip with only the buttons when the bar is docked on a side). Decision 6 is narrowed: owlette.app and dev.owlette.app pages get a capability limited to window minimize/toggle-maximize/close/start-dragging/is-maximized and event listen; nothing else.
- Owner: a native viewer is needed on macOS and Linux too, macOS first. Order from here: owner's MacBook sitting (session half of G0) → 3.2 macOS keys + pointer lock → the `clientCaps.ts` HEVC probe fix (separate small PR, also Safari) → macOS packaging in 4.1/4.2 (signing, notarization, `NSLocalNetworkUsageDescription`) → then 3.1 Windows keys → Linux (WebKitGTK WebRTC unverified).
- Cursor fix awaiting the owner's confirmation after a page reload in the app; if still small, suspect the picture-scale overlay rule on a downscaled 4K picture rather than the webview.

### 2026-10-09 (evening: 2.9, rebase, 2.4, picker corner)
- 2.9 done (see the task entry above); decision 6 narrowed accordingly. Screenshots reviewed: top bar, left bar with the strip, picker.
- Rebased the worktree onto dev 92253c21 (#338 swoop-disabled viewer, #339 swoop discoverability, #340, #342 included). Conflicts in `SwoopToolbar.tsx` (dev's provider wrap + back arrow vs the window controls) and the viewer `page.tsx` (my footer spacing vs dev removing the footer line): resolved by hand; full web suite 383/7000 green after.
- In the app the back arrow now leads to `/swoop` ("back to machines"); the picker's mark sits top-left in the app (web page stays centred) with the macOS inset.
- 2.4 done: machine-menu split row with the `Monitor` half (`onSwoopApp` through MachineCardView/MachineListView), dashboard handler, 6 unit + a11y cases, e2e `menu-app-icon.spec.ts` (opens the menu by keyboard: a mouse-opened menu can mis-pick while cards settle; the older specs carry that risk). Follow-ups applied: the icon is hidden on the "you're on this machine" row (it crowded the hint); the not-installed toast lives once, `offerViewerApp()` in `web/lib/swoop/openViewerApp.ts`.
- Still owed on the owner: cursor check in the app after a reload; the go for commit/push/PR.

### 2026-10-09 (late evening rulings)
- Owner: sessions must not spawn new windows by default; same window, right-click for a new window, back to the picker on disconnect → task 2.11 (a: app, b: web). Owner: picker as a grid of cards, 4 columns max → task 2.10; header icon alignment folded in.
- Cross-project unit run on the rebased tree: web 383 suites / 7007, cli 328, desktop vitest 532, desktop crate 151, viewer crate 28; clippy clean on both crates; lint 0 errors. A full e2e run is in progress; picker and viewer-app specs will be rerun after 2.10/2.11b.
- Cursor, second pass: the overlay was right but drawn at the picture scale (a 4k machine in a 1280 px window gave a cursor a third of its size). In the app it now draws at the machine's own cursor size (`SwoopCursor.tsx`, test added). Softness remains by design of the wire format: PROTOCOL §5 has the streamer shrink every cursor bitmap to 32 px. Follow-up for the streamer (agent/swoop, fleet release): send the bitmap at its true size (cap 128 px) with the scale, and let the viewer draw it 1:1. Alternative the owner may choose instead: the local native arrow over the picture (crisp, right size, wrong shape).
- 2.10 done: grid of cards (1/2/3/4 columns), page max-w-6xl, corner app icon as a sibling of the card button, header icon nudged onto the text line; 17 picker jest, picker e2e 5/5 incl. the 1440/390 column checks; real-app screenshots reviewed (default 3 columns, maximized 4).
- Full e2e on the rebased tree: 509 passed, 2 failed: our new menu-icon spec (menu item unstable, then off-viewport, while the dashboard settled; now activates the icon by keyboard) and time-travel/heartbeat-recovery (unrelated to this branch); both rerunning twice each.
- 2.11 done. App: pure routing rule (a session link navigates main unless main is on a session or that session already has its own window; window.open always makes a swoop window; close handshake on every window), 33 crate tests, checked live. Web: in the app a card click navigates in place, right-click / shift+enter open a new window, and 800 ms after a session reaches ended (no countdown; refusals and failures keep their notice) a swoop window closes itself and the main window returns to /swoop; 17 new jest incl. a page-level ended test, picker + viewer-app e2e 12/12. Known: step-up cancel and same_machine also return after 800 ms (their text shows briefly; the picker card still explains).
- One safe window accessor: currentViewerWindow() in web/lib/swoop/viewerWindow.ts, used by the controls too.
- Menu-icon spec activates by keyboard; heartbeat spec reran green twice (environmental). Final lint + unit + full e2e running on the finished tree; then commit/push/PR on the owner's go.
- Final pass on the finished tree: lint 0 errors, jest 385 suites / 7027, e2e 513 passed, 1 failed (time-travel/heartbeat-recovery). Evidence it is load, not this branch: it passed in the first full run; it passes alone (2x), and 2x in one worker right behind the two new specs that seed into its site (16/16); CI runs with retries: 2 and the last dev runs are green. Headers of the picker and the viewer bar pinned to 48 px (owner); the two swoop specs rerun after that.
- Owner polish (late): picker header and viewer bar both 48 px; in the app the picker header wears bg-card and the bar fades in (motion-safe, 300 ms) when a session opens in place, the grid fades in on return; the bottom rule of both headers is an inset shadow instead of a border so the box is exactly 48 px and every icon (measured over CDP: bar 48/centre 24; all icon boxes and glyphs centre 24) sits on the bar's centre line. Note for reviews: the viewer page does not hot-reload the toolbar module; press F5 (continuity keeps the session) before judging a change.
- Owner console error: the viewer layout rendered an inline <script> (bar position pre-paint) that React 19 rebuilds, and warns about, on a client navigation (now the normal way into a session in the app). Fix: the root layout runs a path-guarded BAR_POSITION_BOOT_SCRIPT on hard loads (root never re-renders on client navigation); the nested layout renders SwoopBarMark, a client layout effect calling applyBarPosition() so a client navigation is marked before its first paint; the nested layout no longer reads headers(). 13 barPosition tests incl. the guard; bar-position + session e2e rerunning.
- Dispatched in parallel: macOS build + task 3.2 keys + pointer-lock finding on TEC-MBA; fullscreen hint pill in the stage, auto exit fullscreen on ended/error, bar fade on contents only; the tray-exit console flash regression (in the fielded 4.1.7, predates this branch) and the tray item kill all swoop sessions on this machine.
- Owner: clipboard must work both ways incl. images in the app, with no permission dialog. Measured in the live WebView2 window: clipboard-read denied, read()/readText() NotAllowedError, and WebView2 raised its own prompt ("localhost:3001 wants to see text and images copied to the clipboard"). Fix in flight: a cfg(windows) PermissionRequested handler in the viewer crate that allows clipboard kinds for allowed origins only (new src/permissions_windows.rs), no change on the web side. macOS unmeasured for clipboard (Mac agent running 3.2).
- Fullscreen hint pill (app mode, 4 s), auto exit fullscreen + pointer lock on ended/error (no countdown), bar fade on contents only, and the settled notice's back button → /swoop in the app: done, 60 + 34 jest, viewer-app e2e 6/6.
- Owner: "exit owlette fired a command prompt window". Finding: no regression in the fielded desktop app (its exit path has used ShellExecuteW runas cmd.exe /c net stop with SW_HIDE since the first tauri commit; its log shows no exit today). What was on screen was the DEBUG swoop viewer's own console (debug builds were console-subsystem; a Windows Terminal window hosted it). Fix: the viewer is windows_subsystem = "windows" in every build (logs go to the file; cdp is the debug path). The agent's rework of the exit elevation (elevate our own exe with --service-control instead of cmd.exe) was reverted: it swaps Microsoft's signed UAC prompt for an unsigned "owlette, unknown publisher" one until Authenticode lands; revisit with signing. exit still raises one UAC prompt by design (ADR 0005, a clicked elevation).
- Tray item "kill all swoop sessions on this machine" (Windows): tray writes tmp/swoop_kill.flag; the service's local config watcher consumes it on its 0.5 s tick and calls swoop_manager.kill('local_tray'); shown only while the swoop status row is (capture running). Differences from the dashboard kill: no server-side step-up revocation; any local user can trigger it (same exposure as restart.flag). macOS/Linux follow-up (daemon refuses console-user flags). 4 new Rust tests, pytest 2254 passed. NOT yet live on this box: the deploy hook does not copy from the worktree; needs owlette_service.py copied to ProgramData + a service restart + a session into this machine to try.
- Clipboard on Windows done: cfg(windows) PermissionRequested handler (desktop/viewer/src/permissions_windows.rs, webview2-com 0.39 as a direct dep, already in the lock) allows CLIPBOARD_READ for allowed origins only; measured over CDP in the relaunched debug viewer: writeText/readText round-trip, read() of text and of a 1x1 png, zero new windows during the calls. permissions.query reports denied until the first allowed read (WebView2 saves the grant in the profile); clipboard.ts never queries. tauri's on_permission_request was not used: it lacks the requesting Uri.
- 3.2 done on TEC-MBA: mac.rs (Regular activation policy; presentation options HideDock|AutoHideMenuBar|DisableProcessSwitching|DisableHideApplication set on NSWindowWillEnterFullScreen for a window whose WKWebView is on a session page — set after entry they do not take; restored on exit/close), keys_macos.rs (local key-down monitor forwards Cmd+Q/W/H/M as __owletteNativeKey(code, true); key-up arrives as a DOM keyup), UA token " (keys)" on macOS, 42 crate tests on the Mac / 34 on Windows. Measured: Cmd+Tab no longer switches apps but macOS swallows the Tab itself (only Meta reaches the page) → Cmd+Tab stays on the special-keys menu on macOS; W/H/M/Q forwarded and not acted on locally; frameless overlay title bar verified; WebKit element fullscreen moves the webview to its own window (Tauri sees no fullscreen) so capture follows AppKit notifications. Pointer lock: no public WebKit hook (wry 0.57 UI delegate has none) — documented gap. Rig for the owner sitting: ~/src/owlette-swoop-viewer-g0/rig32/ (measure32.sh). Note: 3.3 must share pressed-key state between nativeKey downs and DOM keyups.
- Final cross-project unit + lint + typecheck + full e2e running on the finished tree.
- Final sweep on the finished tree: web lint 0 errors, tsc clean, jest 385/7040; cli 328; desktop vitest 532; viewer crate 34; desktop crate 152; agent pytest 2254; full e2e 514 passed, 1 failed (time-travel/heartbeat-recovery, third full run in a row). Load evidence that it is the box, not the branch: the time-travel + access-control specs alone at 4 workers x2, with none of this branch's specs, failed a DIFFERENT time-travel spec (apply-ack revert past deadline, repeat 1) the same way (dashboard card not found after a fake-clock advance), 181 passed; heartbeat-recovery passes alone (2x) and in sequence behind our specs (2x); CI runs with retries: 2. Branch judged ready for the PR.
- 3.4b done: web/lib/swoop/stepUp.server.ts (openStepUpFromProof moved out of the sessions route), route GET/POST .../swoop/step-up (POST behind authorizedSiteHandler like sessions; GET read-only, no rate-limit token or audit row per poll, returns open + sessionPassedCeremony), page /swoop/<s>/<m>/verify (AuthShell, passkey primary + code fields; the viewer crate sends it to the system browser since the path is not a session page), app dialog: passkey hidden, "verify in your browser" + 3 s poll + 10 min cap, device-trust sessions told to use a code; hook retries without mfaProof on the window sentinel. 16 route + 9 dialog + 2 hook + 6 helper tests; full web jest 386/7073; viewer-app + session e2e 14/14 incl. the end-to-end handoff; openapi documented (not internal), validate unchanged at 21 warnings. Not seen in the real app yet (reload needed).
- Owner (2026-10-10): an error on connect must stay up, no auto return to the picker (same-machine refusal etc.). The return/close now requires that the session reached connected at least once (a ref set in an effect; the refs-in-render rule forbids the obvious form); refusals before any picture keep the notice and the back button. Test added; 16 page tests green.
### 2026-10-10 (landing)
- 4.1 done: windows installer carries owlette-swoop-viewer.exe (wildcard [Files]), [Registry] HKA owlette-swoop (= HKLM classes), start-menu "owlette swoop", kill sweeps; both bats build/copy the viewer; macOS build.sh builds and lays owlette swoop.app into the pkg payload with a CFBundleURLTypes assertion and both bundles non-relocatable; linux build.sh takes /usr/bin/owlette-swoop-viewer from the viewer deb, our .desktop with x-scheme-handler, postinst update-desktop-database; scripts/vm/18d-verify-swoop-viewer.ps1 14/14 on golden-empty and on golden-3.1.0 (upgrade). macOS/Linux first real build = CI at the tag. Follow-ups applied: viewer Info.plist with NSLocalNetworkUsageDescription, macOS preinstall pkill owlette-swoop-viewer, desktop/viewer in build-installer.yml rust-cache workspaces.
- 4.3 done: changelogs (both, under [Unreleased]), GLOSSARY (swoop/Session/Viewer/Lease/Desktop app/Kill + owlette swoop), ADR 0012, swoop.mdx section #owlette-swoop + browser-only statements revised, /download/swoop-viewer → the anchor, roadmap line. web build passed.
- 3.3 done: InputCapture.nativeKey on the shared key path, window.__owletteNativeKey only with the (keys) token, viewerAppHasNativeKeys back, keyboardLock() null only where native keys exist (the windows app still asks the webview lock), specialKeys drops cmd+q in fullscreen on a mac viewer, copy for the native-keys case; useViewerAppPlatform moved to web/hooks; one openInViewerApp call for dashboard and picker; controls' close uses closeViewerWindow; stale comments fixed; viewerWindow rejection test made falsifiable. Full web jest 387/7093.
- Review (standards): nothing above low; capability description/test renamed to say the grant is the app's windows (tauri window commands take a label), tray write_flag helper, dead tsconfig includes reverted.
- Landing: commit on feat/swoop-viewer → PR to dev → CI → merge → sha to the release session (owlette-3a owns release/4.1.8). #325 comment posted (left open until installers are out).
- Landing notes: a stray  had reformatted the whole desktop crate (cargo fmt formats the package); ten untouched files restored from dev before the PR. The docs screenshots were regenerated for 4.1.8 by the release script during the packaging work and are included.

