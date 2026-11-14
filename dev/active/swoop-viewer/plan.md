# owlette swoop (the viewer app) — Plan
**Created**: 2026-10-09 | **Status**: Active | **Issue**: #325 (related #323, #324)

## Summary

Ship **owlette swoop**, a small standalone desktop app (binary `owlette-swoop-viewer`) that hosts
the existing web swoop viewer in native windows: sign in, pick a site and machine on a new `/swoop`
page, run a session with native fullscreen, OS-level shortcut capture and a release hotkey. It is
a second, tiny Tauri crate beside the desktop app, carries no viewer code of its own (it loads
owlette.app or dev.owlette.app as a top-level page), ships inside every agent installer *and* as
a standalone per-user download for operator workstations that have no agent. It is reachable
from the tray menu, the desktop app's hamburger menu, the dashboard's machine menu (a monitor
icon beside "swoop" that opens the app through the `owlette-swoop://` scheme), the Start menu /
Applications, and `owlette swoop` in the CLI.

Owner rulings (2026-10-09): standalone app, not a flag on the desktop app; display name
**owlette swoop**; binary **owlette-swoop-viewer** (`owlette-swoop` is the streamer, `owlette-viewer`
is too generic); accessible from the tray, the hamburger menu and the website; a monitor icon
beside the "swoop" menu entry opens the app directly, split-row style like restart/schedule.

## Research findings that shape the design

- **Top-level load needs no server change.** `X-Frame-Options: DENY` and `frame-ancestors 'none'`
  (`web/next.config.ts:133-137`, `web/proxy.ts:107`) block iframes only. The `__session` cookie is
  first-party in a top-level webview, so login, the 12 h step-up window and reload continuity keep
  working. Bundling the viewer locally (tauri:// origin) would break all three. Never iframe.
- **"sidecar" and "client" are taken.** `desktop/` calls the bundled macOS streamer "the swoop
  sidecar" (`tauri.macos.conf.json:24`, `tcc.rs:26`); GLOSSARY lists `client` under *Avoid* for
  Viewer. Words: **owlette swoop** (the app), **viewer** (the side of a session that watches or
  controls, in a browser tab or an owlette swoop window), **swoop window** (one native window).
- **The desktop app has no mode concept and assumes an agent** (`desktop/src-tauri/src/lib.rs:155-209`:
  `tray.pid`, watchers, keep-awake, the macOS Screen Recording prompt in `tcc.rs:229-247`). That is
  why the viewer is its own crate, not a flag: nothing agent-shaped runs in it.
- **Codec reality.** WebView2 is Edge: no H.265 over WebRTC, so Windows viewers get H.264
  (`web/lib/swoop/clientCaps.ts:10-16`, `dev/active/swoop/context.md:170-172`). Nobody has measured
  whether WKWebView negotiates the playout-delay header extension, and the streamer refuses a
  session without it (`web/lib/swoop/peer.ts:738`). Wave 2 measures before wave 3 builds.
- **Sign-in inside a webview.** Email+password, TOTP and backup codes work. Google uses
  `signInWithPopup` (`web/contexts/AuthContext.tsx:810-848`) and `web/lib/inAppBrowser.ts` already
  records that Google refuses embedded webviews (`disallowed_useragent`); WKWebView's UA lacks the
  Safari token. Passkeys in WKWebView need an associated-domains entitlement the repo does not have.
  wry 0.57 silently swallows `window.open` on Windows unless the host handles it.
- **Keyboard.** Keyboard Lock is Chromium-only and fullscreen-only; the "hold esc 2 s" exit is
  Chrome browser UI, not page code (`web/components/swoop/SwoopStage.tsx:181-183` only shows a hint).
  Outside a browser the app must provide its own release and its own OS-shortcut capture:
  `WH_KEYBOARD_LL` on Windows; on macOS fullscreen presentation options (`disableProcessSwitching`
  + `hideDock`) capture Cmd+Tab without a TCC grant, and a local `NSEvent` monitor forwards Cmd+Q/W/H/M.
  `InputCapture` (`web/lib/swoop/input.ts:98-154`) has no single-key injection seam yet.
- **Fullscreen maps natively already.** Tauri 2.12 turns WebView2 `ContainsFullScreenElementChanged`
  into borderless window fullscreen and wry enables WKWebView element fullscreen, so
  `stage.requestFullscreen()` (`SwoopToolbar.tsx:190`) should keep `document.fullscreenElement` truthy.
  Measured in wave 2.
- **Launch paths.** The dashboard opens the viewer with `window.open(url,'_blank','noopener')`
  (`web/app/dashboard/page.tsx:765-774`). The CLI `swoop <machineId> --site <siteId>` only opens a URL
  (`cli/src/commands/swoop.ts:62`) and `openBrowser` refuses non-http(s). No URL scheme exists
  anywhere today; the desktop app and CLI refuse to *open* non-http(s) URLs by design, which is
  about opening, not receiving. The viewer app receives `owlette-swoop://` and only ever rebuilds an
  https URL on an allowlisted host from it.
- **Distribution is net new.** The desktop app never ships standalone (`desktop/README.md:77`); the
  Windows exe is unsigned; the download host serves only agent-installer names
  (`web/lib/installerStorage.server.ts:57`) and `installer_metadata` cannot hold a second Windows exe
  per version (`web/lib/installerPlatform.ts:9-40`). The standalone viewer needs its own hosting
  (Davor, tridant side) — the pilot runs from CI artifacts.
- **In-flight worktrees overlap.** `Owlette-swoop-disabled-wt` (#323, branch `fix/swoop-disabled-viewer`)
  edits `page.tsx`, `SwoopStage.tsx`, `SwoopToolbar.tsx`, `useSwoopSession.ts`; `Owlette-swoop-discover-wt`
  (#324) edits the dashboard and `MachineContextMenu.tsx`. Tasks 2.3 and 2.4 start after those merge
  to dev, and the #323 back arrow becomes app-aware in 2.3.
- **Release.** 4.1.8 is being cut by another session; do not bump versions here. Changelog entries go
  under `## [Unreleased]` in both changelogs; whether this ships in 4.1.8 or later is the owner's call.

## Approach

### Architecture

```
dashboard machine menu ──(owlette-swoop://host/swoop/s/m)──┐
tray menu / hamburger ──(spawn sibling binary + https url)─┤
Start menu / Applications ─────(no args: remembered origin)─┼──▶ owlette-swoop-viewer (Tauri 2, no frontend of its own)
owlette swoop CLI ─────────(spawn + https url, else browser)┘        │
                                                                     ├─ main window  ──▶ https://<origin>/swoop            (picker, web page)
                                                                     └─ swoop-<s>/<m> ──▶ https://<origin>/swoop/<s>/<m>   (one per machine, via window.open)
                                                  web detects the app by UA token `owlette-swoop-viewer/<ver>`
                                                  → hold-esc release, close handshake, app-aware copy and back links
```

- **One argument, a URL.** The viewer accepts at most one argument: an `https://` URL on an
  allowlisted host (`owlette.app`, `dev.owlette.app`; `http://localhost:<port>` in debug builds only)
  or an `owlette-swoop://<host>/<path>` deep link that it rewrites to `https://<host>/<path>` after the
  same host check. No flags. With no argument it opens `<remembered origin>/swoop`, default
  `https://owlette.app/swoop`. The origin is remembered in `app_data_dir()/viewer.json` only when a
  URL was given.
- **Windows.** The first URL that is not a session opens in the `main` window. A `/swoop/<s>/<m>` URL
  opens (or focuses) a window labelled `swoop-<s>/<m>` (dots in the machine id become `:`, since
  Tauri rejects dots in a label); `window.open` from any viewer-app page for a
  `/swoop/<s>/<m>` URL on the same origin becomes a new swoop window (`on_new_window`); any other
  `window.open` target opens in the system browser and is denied in-app. `on_navigation` allows only
  the allowlisted origins plus the Firebase/Google auth hosts wave 2 proves necessary.
- **No IPC for the remote origin.** The viewer app declares no capability that reaches an owlette
  page. Host→page communication is `eval` only (close handshake, native key delivery). Page→host
  needs nothing.
- **Single instance.** A second launch forwards its argument to the running instance, which opens or
  focuses the right window. On a managed machine the same-machine guard
  (`web/lib/swoop/thisMachine.ts`) still refuses viewing itself; that is expected.
- **Close = end.** `CloseRequested` on a swoop window is intercepted once: the host evals
  `window.dispatchEvent(new Event('owlette:close'))`, the page (app mode only) calls `end()` which
  sends the keepalive DELETE, and the host closes the window 300 ms later. Closing the last window
  exits the process.
- **User agent.** `owlette-swoop-viewer/<version>` is appended to the webview UA, with a `keys`
  token once native capture is compiled in (wave 3). `web/lib/swoop/viewerApp.ts` reads it.
- **Web picker `/swoop`.** Site switcher (`useSites`) + machine rows (`useMachines`: name, online,
  osFamily, `capabilities.swoop`, `swoopViewers`) + site swoop enablement (`useSwoopSettings`). Click
  → `window.open('/swoop/<s>/<m>','_blank','noopener')`, same as the dashboard. In a browser it is a
  useful page too (it also closes part of #324: an admin sees "swoop is off for this site" with a link
  to site settings; a member sees who can enable it).
- **Web → app.** In the machine menu the "swoop" row becomes a split row: the text keeps opening the
  browser viewer; a `Monitor` icon half (lucide, tooltip "open in owlette swoop") sets
  `window.location.href = 'owlette-swoop://<host>/swoop/<s>/<m>'`. If the document still has focus
  after 1.5 s, a toast says the app is not installed and links to `/download/swoop-viewer`, a stable
  permalink that redirects to the docs section until the hosted artifact exists.
- **Native keys (wave 3, gated on wave 2's measurements).** Windows: a `WH_KEYBOARD_LL` hook installed
  on the main thread while a swoop window is focused and "captured" (fullscreen), swallowing Win+*,
  Alt+Tab, Alt+Esc, Ctrl+Esc and Alt+F4 and delivering them to the page via
  `eval("window.__owletteNativeKey(code, down)")`; WebView2 browser accelerator keys (F5, Ctrl+R,
  Ctrl+P, F12) turned off through `with_webview` + `ICoreWebView2Settings3`. macOS: presentation
  options `[.fullScreen, .hideDock, .disableProcessSwitching, .disableHideApplication]` while
  fullscreen; a local event monitor forwards Cmd+Q/W/H/M/Tab to the page instead of the app; Regular
  activation policy and a standard Edit menu so Cmd+V reaches the page. Win+L, Ctrl+Alt+Del and
  Cmd+Space stay with the OS and on the special-keys menu. Release: hold Esc 2 s (page-side timer in
  app mode; works with or without native capture).
- **Sign-in handoff (added 2026-10-09).** The app never shows a password form when a signed-in browser is at hand. Website → app: the dashboard icon and picker rows mint a single-use 60 s code and put it in the deep link; the public `/app-link` page exchanges it for a custom token carrying the browser session's MFA state and signs the app in before landing on the machine. Cold start: the app's login page offers "sign in with your browser", opens the system browser on an approve page, and polls until approved. Wave 2b, tasks 2.5–2.8.
- **CLI.** `owlette swoop <machineId> --site <siteId>` looks for the app
  (Windows: `%LOCALAPPDATA%\owlette swoop\owlette-swoop-viewer.exe`, then
  `C:\ProgramData\Owlette\app\owlette-swoop-viewer.exe`; macOS: `/Applications/owlette swoop.app`;
  Linux: `owlette-swoop-viewer` on PATH), spawns it detached with the https URL, else falls back to
  `openBrowser`. `--browser` forces the browser; `--json` gains `viewer: "app" | "browser"`.
- **Packaging.** One Tauri build of the viewer crate feeds (a) the agent installers: Windows
  `[Files]` entry beside `owlette-desktop.exe`, `owlette-swoop://` registry keys, Start-menu shortcut
  "owlette swoop", uninstall cleanup; macOS pkg gains `owlette swoop.app` (CFBundleURLTypes from the
  deep-link plugin); Linux deb gains the binary and a `.desktop` with `x-scheme-handler/owlette-swoop`;
  and (b) standalone artifacts from CI: Tauri NSIS per-user installer (`installMode: currentUser`,
  WebView2 bootstrapper), notarized macOS app (zip), Linux deb. Hosting on download.tridant.io is a
  new artifact kind on Davor's side; until then the pilot uses CI artifacts and the docs say so.

### Key decisions

1. **Own crate `desktop/viewer/`, not a mode of `desktop/src-tauri`.** Nothing agent-shaped runs; a
   separate identifier (`app.owlette.swoop-viewer`) keeps WebView2 profiles, single-instance locks
   and macOS bundles apart. Shared Rust is tiny (URL allowlist, open-in-browser); duplicate it rather
   than add a workspace, the same ruling as `agent/swoop`.
2. **Remote page, zero local frontend.** The app is a window manager for owlette.app. All product
   behaviour stays in `web/` where it is tested and deployed daily. ADR 0012 records this.
3. **`owlette-swoop://` scheme via `tauri-plugin-deep-link`** (new crate — needs the owner's ok at
   task 1.1; the alternative is hand-written registry/Info.plist/.desktop entries plus an
   `application:openURLs` handler on macOS, which argv cannot replace). The app validates the host
   against the allowlist and never passes the raw scheme URL anywhere.
4. **Detection by user agent, not IPC.** Survives navigation, needs no capability, and Playwright
   can set a UA, so app-mode web behaviour gets e2e coverage without Tauri.
5. **Measure before native work.** Gate G0 (wave 2) records playout-delay negotiation, codec offered,
   `navigator.keyboard.lock` effect, element→native fullscreen, Google popup, Windows Hello passkeys,
   minimised `visibilityState`, and Ctrl+R/F5 behaviour on both engines. Wave 3 scope is set by G0.
6. **No version bump here.** 4.1.8 is in flight elsewhere; changelog under `[Unreleased]`.
7. **Lowercase Start-menu names are a separate fix PR** (`MyAppName "Owlette"` in the .iss; NTFS keeps
   case on a case-only rename so the upgrade must delete `Owlette.lnk` and the group first;
   `C:\ProgramData\Owlette` stays as a path). Not part of this plan.

## Waves

### Wave 1 — the app, the picker, the launchers (parallel, disjoint files)

- **1.1 viewer crate** — `desktop/viewer/` (Cargo.toml, tauri.conf.json, capabilities/, src/main.rs,
  src/lib.rs, src/launch.rs, src/windows.rs, src/origin.rs), `.github/workflows/rust-build.yml`,
  `desktop/README.md`.
- **1.2 web `/swoop` picker + app detection** — `web/lib/swoop/viewerApp.ts`, `web/app/swoop/page.tsx`,
  `web/proxy.ts` (verify only), tests, e2e `web/e2e/specs/swoop/picker.spec.ts`.
- **1.3 CLI launch** — `cli/src/lib/viewerApp.ts`, `cli/src/commands/swoop.ts`, tests,
  `web/content/docs/cli/reference/swoop.mdx`, `web/content/docs/cli/readiness.mdx`.
- **1.4 tray + hamburger entries in the desktop app** — `desktop/src-tauri/src/tray.rs`,
  `desktop/src-tauri/src/commands.rs`, `desktop/src-tauri/src/viewer_launch.rs` (new),
  `desktop/src-tauri/src/lib.rs` (register command), `desktop/src/lib/ipc.ts`,
  `desktop/src/components/AppMenu.tsx`, tests.

### Wave 2 — measure, and the app-aware web viewer

- **2.1 measure on Windows (WebView2)** → `dev/active/swoop-viewer/spike-g0.md`.
- **2.2 measure on macOS (WKWebView)** → same file, macOS section. Needs one sitting on the MacBook.
- **2.3 web viewer in app mode** — `web/lib/swoop/input.ts`, `web/hooks/useSwoopSession.ts`,
  `web/components/swoop/SwoopStage.tsx`, `SwoopToolbar.tsx`, `SwoopSpecialKeys.tsx`,
  `web/app/swoop/[siteId]/[machineId]/page.tsx`, tests, e2e `web/e2e/specs/swoop/viewer-app.spec.ts`.
- **2.4 machine-menu monitor icon + download permalink** — `web/components/MachineContextMenu.tsx`,
  `web/app/dashboard/page.tsx`, `web/app/download/swoop-viewer/route.ts`, tests, e2e.

### Wave 3 — native capture and sign-in (scope fixed by G0)

- **3.1 Windows key hook + accelerators off + release** — `desktop/viewer/src/keys_windows.rs`, Cargo features.
- **3.2 macOS presentation options + event monitor + menu** — `desktop/viewer/src/keys_macos.rs`, `src/mac.rs`.
- **3.3 web native-key seam** — `web/lib/swoop/input.ts`, `web/lib/swoop/keyboardLock.ts`,
  `web/lib/swoop/specialKeys.ts`, `web/lib/swoop/viewerApp.ts`, tests.
- **3.4 sign-in in app mode** — `web/app/login/page.tsx`, `web/app/verify-2fa/page.tsx`,
  `web/lib/inAppBrowser.ts`, and if G0 says Google fails: `web/app/api/auth/app-link/route.ts` +
  `web/app/app-link/page.tsx` (browser-assisted sign-in), tests, e2e.

### Wave 4 — packaging, artifacts, docs

- **4.1 ship inside the agent installers** — `agent/owlette_installer.iss`, `agent/build_installer_full.bat`,
  `agent/build_installer_quick.bat`, `agent/build/macos/build.sh`, `agent/packaging/macos/distribution.xml`,
  `agent/build/linux/build.sh`, `agent/packaging/linux/owlette-swoop-viewer.desktop` (new), VM proof.
- **4.2 standalone artifacts in CI** — `.github/workflows/build-installer.yml` (new job), clean-VM proof.
- **4.3 docs, glossary, ADR, changelog** — `web/content/docs/dashboard/swoop.mdx`, `GLOSSARY.md`,
  `docs/adr/0012-owlette-swoop-hosts-the-web-viewer.md`, `docs/changelog.md`,
  `web/content/docs/changelog.mdx`, `desktop/README.md`, `web/app/download/swoop-viewer/route.ts` (target).

Full task text with Do / Done-when is in `tasks.md`.

## Risks

- **WKWebView may not negotiate playout-delay.** Every macOS session would die with
  `playout_delay_not_negotiated`. G0 decides; if it fails, macOS waits for a streamer-side relaxation
  (a separate decision), and Windows ships alone.
- **Windows is H.264 only in the app** while Chrome on the same box gets HEVC. Document it; the
  quality ladder already handles H.264. Not a blocker.
- **Google and passkeys inside the webview.** Expect Google to refuse WKWebView outright. 3.4 either
  hides what fails with a pointer to email+TOTP, or builds the browser-assisted sign-in. Decide at G0.
- **Unsigned Windows exe.** The standalone NSIS installer will trip SmartScreen until Azure Trusted
  Signing is wired (owner item, already open for the agent). Inside the agent installer it is no
  worse than today.
- **Minimised window false stalls.** If WebView2 reports `visible` while not painting, the freeze
  watchdog (`useSwoopSession.ts:811-823`) spends reconnects. 2.1 measures; 2.3 gates on
  `document.hasFocus()` in app mode only if measured.
- **`/Applications/owlette swoop.app` from a standalone install is overwritten by a later agent pkg**
  that carries the same bundle. Same identifier, same content: acceptable, say so in docs.
- **New crate `tauri-plugin-deep-link`** must be approved before 1.1 adds it.
- **Overlap with #323/#324 worktrees** on the same files (see findings). Sequence, don't race.

## Success criteria

- On a clean Windows VM with no agent: install the standalone owlette swoop, sign in with
  email+TOTP, land on `/swoop`, pick an online machine, get a picture, go fullscreen, Alt+Tab and the
  Windows key reach the remote machine, hold Esc 2 s releases, closing the window ends the session
  within a second on the dashboard's viewer badge.
- On a managed machine: tray → swoop and hamburger → swoop open the app on the right origin; the
  dashboard's monitor icon opens the app for that machine; `owlette swoop` opens the app and falls
  back to the browser when it is absent.
- macOS: the same flow on the MacBook, with Cmd+Tab captured in fullscreen (or a recorded G0
  reason why not yet).
- Tests: Rust unit tests for URL/argv parsing and window labels; Jest for `viewerApp.ts`, the
  picker, the split row, the download permalink; CLI tests for locate/launch/fallback; Playwright for
  the picker, app-mode viewer behaviour under the UA token, the menu split row; `cargo clippy` and
  `cargo test` for the crate in CI; VM proofs recorded for both install paths.
- Docs, glossary, ADR 0012 and both changelogs updated in the same PRs as the code.
