# gate G0: owlette swoop in WebView2 and WKWebView

**Date**: 2026-10-09 | wave-1 debug build, viewer 4.1.8, WebView2 154.0.4258.62 (Edge 154), Windows 11 Pro 22631

Measured on this box without a signed-in session. A debug build of `desktop/viewer` opens the
DevTools protocol on `127.0.0.1:9222`; `spike/measure-webview2.mjs` drives the real webview through
it (Playwright `connectOverCDP`) and does the native half (minimise, cover, real keys, screen
captures) through user32 from PowerShell. Every result below was measured unless the row says
"source" or "not measured".

```bash
cd desktop/viewer && ../node_modules/.bin/tauri build --debug --no-bundle
target/debug/owlette-swoop-viewer.exe https://dev.owlette.app/swoop     # detached
node dev/active/swoop-viewer/spike/measure-webview2.mjs --phase pre     # from the repo root
# or from web/: node ../dev/active/swoop-viewer/spike/measure-webview2.mjs --phase pre
```

## Windows (WebView2) — pre-login

| item | result | evidence |
| --- | --- | --- |
| engine | WebView2 154.0.4258.62 | browser command line `...\EdgeWebView\Application\154.0.4258.62\msedgewebview2.exe`; UA brands `Microsoft Edge WebView2 154, Chromium 154` |
| app token in the UA | `... Edg/154.0.0.0 owlette-swoop-viewer/4.1.8` | `navigator.userAgent`; `web/lib/swoop/viewerApp.ts` matches it |
| codec the app would offer | **H.264 only** | `decodingInfo({type:'webrtc'})` at 1080p60 8 Mbps with clientCaps' exact strings: H.264 `avc1.64002A` supported/smooth/powerEfficient **true/true/true**; H.265 `hev1.1.6.L123.B0` **false/false/false**, and `RTCRtpReceiver.getCapabilities('video')` lists no `video/H265`. VP9 true/true/true, AV1 true/true/false (not used). WebCodecs says HEVC true, the same split clientCaps records for Edge 153 |
| playout-delay offered by the receiver | **yes** | `getCapabilities('video').headerExtensions` contains `http://www.webrtc.org/experiments/rtp-hdrext/playout-delay`. Negotiation in a session: next table |
| keyboard lock API | present | `'keyboard' in navigator` true, `typeof navigator.keyboard.lock` `function`. Effect: next table |
| fullscreen API | enabled | `document.fullscreenEnabled` true. Element → native window: next table |
| pointer lock API | present | `'requestPointerLock' in Element.prototype` true |
| clipboard API | all present; read `prompt`, write `granted` | `readText`/`writeText`/`read`/`write` are functions; `permissions.query` |
| passkeys (WebAuthn) | conditional UI starts, offers nothing; no platform authenticator | `PublicKeyCredential` present; `isUserVerifyingPlatformAuthenticatorAvailable()` **false**; `isConditionalMediationAvailable()` true. A real click in the email field started the conditional ceremony (`/api/passkeys/authenticate/options` fetched); the native screen capture shows no autofill dropdown. Not measured: the explicit "continue with passkey" button (it raises the Windows security prompt; needs the owner), and whether Windows Hello is enrolled on this box |
| continue with Google (real click) | **fails: popup blocked, and File Explorer opens** | Firebase calls `window.open('https://owlette-dev-3838a.firebaseapp.com/__/auth/handler?apiKey=…&authType=signInViaPopup&…', …)` (290 chars). `on_new_window` denies it and hands it to `explorer.exe`, which opens **File Explorer at Documents**, not the browser. The page shows "your browser blocked the google sign-in window" (`auth/popup-blocked`, the existing remediation notice) |
| `explorer.exe` with a query string | **opens File Explorer → Documents** | controlled: `explorer.exe https://dev.owlette.app/docs?x=1` (32 chars) → a new Documents window; `https://dev.owlette.app/docs/<120 chars, no ?>` → the browser. So `windows.rs::open_in_browser` sends every URL with a `?` to Documents. The desktop app uses `ShellExecuteW` (`shell_open.rs::open_link`) and does not have this; `cli/src/lib/openBrowser.ts` also uses `explorer.exe` |
| `window.open(other page, '_blank')` | goes to the system browser, not a window | returns `null`, no new CDP target; Brave's title became `owlette - swoop - Brave` |
| `visibilityState` minimised | **`visible`**, `hasFocus()` true | `ShowWindow(hwnd, 6)`, `IsIconic` true, read 1 s later; no `visibilitychange`. Ad hoc 10 s run: still `visible`/`hasFocus` true and `requestAnimationFrame` ran **601 frames in 10 s** while minimised (120 in 2 s restored) |
| `visibilityState` covered | `visible` | a borderless topmost form over the virtual screen for 3 s |
| F5 (real key) | **reloads the page** | `SendKeys('{F5}')` to the foreground viewer; a page marker gone, navigation type `reload` |
| Ctrl+R (real key) | **reloads the page** | same check. Release build: source only — tauri never calls wry's `with_browser_accelerator_keys`, whose default is `true` in both profiles |
| F12 (real key) | debug: DevTools window; **release: nothing** | debug: a `DevTools - dev.owlette.app/login…` window and a `devtools://` CDP target. Release exe: no DevTools window after F12 (wry compiles devtools out of release builds) |
| lone Alt tap | **host enters system-menu mode; WebView2 stops answering** | `keybd_event` Alt down/up with the viewer in front: `GetGUIThreadInfo` flags `GUI_INMENUMODE \| GUI_SYSTEMMENUMODE`; `/json/version` gave no answer for 3 s; the page kept painting (screen hashes 1 s apart differ, control also differs); the page saw the Alt keydown; an Esc tap ends it and CDP answers again. Found by accident: the first raise trick tapped Alt and the CDP session hung |
| Tauri IPC on the remote page | refused | `__TAURI_INTERNALS__` is injected, but `invoke('plugin:app\|version')` and `invoke('plugin:window\|title')` are refused: "allowed on: [windows: "main", URL: local]" |
| CDP port only in debug | yes | debug browser command line ends in `--remote-debugging-port=9222`, `127.0.0.1:9222 LISTENING`. Release exe: command line carries only wry's defaults (`--autoplay-policy=no-user-gesture-required --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`), nothing listens, connect refused |
| Ctrl+P | not measured | the print preview it opens needs closing by hand; left for the sitting |
| theme | light on first load, dark after a reload | screenshots in one run; not investigated |

Screenshots of the last run: `%TEMP%\owlette-g0\passkey-cdp.png`, `passkey-native.png`, `google.png`.

### raw output, `--phase pre` (last run)

### pre — 2026-10-09T17:08:31.789Z — https://dev.owlette.app/login?redirect=%2Fswoop

| item | result | evidence |
| --- | --- | --- |
| user agent | Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0 owlette-swoop-viewer/4.1.8 | brands: Microsoft Edge 154, Not A(Brand 99, Microsoft Edge WebView2 154, Chromium 154 |
| app token in UA | true | what web/lib/swoop/viewerApp.ts matches |
| keyboard lock api | 'keyboard' in navigator: true; typeof lock: function |  |
| document.fullscreenEnabled | true |  |
| 'requestPointerLock' in Element.prototype | true |  |
| navigator.clipboard | readText function, writeText function, read function, write function | permissions.query: read prompt, write granted |
| PublicKeyCredential | function | isUserVerifyingPlatformAuthenticatorAvailable: false; isConditionalMediationAvailable: true |
| decodingInfo webrtc video/H264;codecs=avc1.64002A 1080p60 8 Mbps | supported true / smooth true / powerEfficient true |  |
| decodingInfo webrtc video/H265;codecs=hev1.1.6.L123.B0 1080p60 8 Mbps | supported false / smooth false / powerEfficient false |  |
| decodingInfo webrtc video/H264 1080p60 8 Mbps | supported true / smooth true / powerEfficient true |  |
| decodingInfo webrtc video/H265 1080p60 8 Mbps | supported false / smooth false / powerEfficient false |  |
| decodingInfo webrtc video/VP9 1080p60 8 Mbps | supported true / smooth true / powerEfficient true |  |
| decodingInfo webrtc video/AV1 1080p60 8 Mbps | supported true / smooth true / powerEfficient false |  |
| codec ladder the app would offer | h264 | receiver mimeTypes: video/VP8, video/rtx, video/VP9, video/H264, video/AV1, video/red, video/ulpfec, video/flexfec-03; webcodecs hevc (diagnostic): true |
| receiver offers playout-delay | true | headerExtensions: urn:ietf:params:rtp-hdrext:toffset, http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time, urn:3gpp:video-orientation, http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01, http://www.webrtc.org/experiments/rtp-hdrext/playout-delay, http://www.webrtc.org/experiments/rtp-hdrext/video-content-type, http://www.webrtc.org/experiments/rtp-hdrext/video-timing, http://www.webrtc.org/experiments/rtp-hdrext/color-space, urn:ietf:params:rtp-hdrext:sdes:mid, urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id, urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id |
| window.__TAURI_INTERNALS__ on the remote page | object |  |
| passkey conditional ui (email field focused by a real click) | conditional ceremony started: true | screenshots: C:\Users\admin\AppData\Local\Temp\owlette-g0\passkey-cdp.png, passkey-native.png |
| window.open('https://dev.owlette.app/docs/dashboard/swoop', '_blank') | returned null; new cdp targets: none | windows retitled: brave: owlette - swoop - Brave; viewer log: nothing |
| visibilityState, window in front | visible, hasFocus true |  |
| visibilityState, minimised 1 s | visible, hasFocus true | ShowWindow(hwnd, 6); IsIconic: True; read over cdp |
| visibilityState, restored | visible, hasFocus true | ShowWindow(hwnd, 9) |
| visibilityState, covered by a topmost window | visible, hasFocus true | borderless topmost form over the virtual screen |
| visibilitychange events seen | none |  |
| F5 sent as a real key | reloaded: true; devtools window: none | foreground: True; navigation type after: reload; new cdp targets: none; viewer log: nothing |
| Ctrl+R sent as a real key | reloaded: true; devtools window: none | foreground: True; navigation type after: reload; new cdp targets: none; viewer log: nothing |
| F12 sent as a real key | reloaded: false; devtools window: DevTools - dev.owlette.app/login?redirect=%2Fswoop | foreground: True; navigation type after: reload; new cdp targets: page devtools://devtools/bundled/devtools_app.html?remoteBase=https://msedgedevtools.microsoft.com/serve_file/@49f7c5590dad654f33b924537ccc8be227c5a43a/&targetType=tab&isEdgeWebView=true&msEdgeCSSCopilot=true&enabledExperiments=msEdgeDevToolsNetworkConsole;layersIn3DView;keyboardShortcutEditor;msEdgeVSCodeThemes;msEdgeDevToolsDetachedElements;msEdgeDynamicWelcome;msEdgeAIExplainConsoleError;msEdgeCSSCopilot; viewer log: nothing |
| lone Alt tap (keybd_event), viewer in front | host in system-menu mode: True; cdp meanwhile: no answer in 3 s; page kept painting: True | paint check control (no menu mode): True; after an Esc tap: menu mode False, cdp answers; keydowns the page saw: Alt, hasFocus true |
| continue with google (real click) | your browser blocked the google sign-in window / use your email below, or open owlette.app in your browser. / try google anyway | windows retitled: explorer: Documents - File Explorer; viewer log: nothing; screenshot C:\Users\admin\AppData\Local\Temp\owlette-g0\google.png |

## Windows — needs a session

All pending the owner sitting, done in one go. The debug viewer is left running on
`https://dev.owlette.app/login?redirect=%2Fswoop`. If it is gone, relaunch it with
`desktop\viewer\target\debug\owlette-swoop-viewer.exe https://dev.owlette.app/swoop`.

1. Sign in in that window (email + TOTP; Google does not work, see above).
2. On `/swoop`, click an online machine (B4A or A4D on dev); wait for the picture.
3. From the repo root: `node dev/active/swoop-viewer/spike/measure-webview2.mjs --phase post`
   (about 40 s; it opens the stats overlay, clicks fullscreen, exits it, taps Alt then Esc, which
   reach the machine, and minimises the swoop window for 10 s). Paste its table below.
4. By hand, in the same session: the manual rows.

| item | how | status |
| --- | --- | --- |
| playout-delay negotiated in a real session (the session connects at all) | `--phase post`: the video receiver's negotiated `headerExtensions`, read from the page's private `RTCPeerConnection` found on the heap (`Runtime.queryObjects`) | pending owner sitting |
| codec, size, fps, decoder, route actually negotiated | `--phase post`: `getStats()` inbound-rtp + candidate pair; also the overlay's codec row and the `owlette.swoop.codec/*` sessionStorage key | pending owner sitting |
| element → native fullscreen, `document.fullscreenElement`, toolbar state | `--phase post`: clicks "fullscreen with keyboard and mouse capture" (the toolbar has no `data-testid` for it; found by its `aria-label`), reads `fullscreenElement`, window vs screen size, toolbar text | pending owner sitting |
| `navigator.keyboard.lock()` outcome in fullscreen | `--phase post` | pending owner sitting |
| keyboard lock effect on Alt+Tab, Win, Ctrl+W in fullscreen | by hand: in fullscreen press each; does it reach the machine or the local OS? | pending owner sitting |
| pointer lock after the toolbar button | `--phase post`: `document.pointerLockElement` | pending owner sitting |
| lone Alt inside a session (the page takes keys there) | `--phase post`: the same menu-mode/CDP check as above | pending owner sitting |
| freeze watchdog when minimised | `--phase post`: 10 s minimised, visibility log, session badge after | pending owner sitting |
| clipboard paste and copy | by hand: copy locally, Ctrl+V on the machine; copy on the machine, paste locally | pending owner sitting |
| audio unmute | by hand: unmute in the toolbar, play a sound on the machine | pending owner sitting |
| input-to-photon vs Chrome | `--phase post` prints the overlay; open the same machine in Chrome on this box and read its overlay | pending owner sitting |
| Windows Hello passkey on login and step-up | by hand: "continue with passkey" | pending owner sitting |
| Ctrl+P | by hand: does a print preview open over the session? | pending owner sitting |

## What this already decides

**Codec floor:** the Windows app is H.264 only, with a hardware decoder (`powerEfficient` true);
WebView2's WebRTC decoder has no HEVC, exactly as Edge. Nothing to build, only to document.
**Playout-delay:** the receiver offers the extension, so the streamer's requirement can be met on
Windows; the session row confirms it, but this is the same stack Edge already runs swoop on.
**Google sign-in needs the browser handoff** (task 3.4's app-link path) or an in-app popup window
(untested; it would need `on_new_window` to allow the firebaseapp.com handler): today the popup is
refused, the page shows the existing notice, and the hand-off lands in File Explorer. Since the
popup never navigates the main window, the `*.firebaseapp.com` / `accounts.google.com` navigation
allowance in `windows.rs` is unused and can be trimmed unless 3.4 picks the in-app popup.
**`open_in_browser` must move off `explorer.exe`** to `ShellExecuteW` (the desktop app's
`shell_open.rs`): any URL with a query string opens File Explorer. That is a 1.1 bug, not yet fixed.
**F5 and Ctrl+R must be disabled natively** in swoop windows (browser accelerator keys off); F12
is a debug-build concern only. **A lone Alt puts the host window in system-menu mode** and stalls
the browser thread until Esc or a click (the page keeps painting): wave 3 must keep keyboard-
initiated `SC_KEYMENU` away from swoop windows, unless the session row shows the page's own key
handling already prevents it. **Minimised is not hidden:** WebView2 keeps `visibilityState`
`visible`, `hasFocus()` true and rAF at 60 fps when minimised, so the watchdog's visibility gate
never closes and gating on `document.hasFocus()` (risk in plan.md) would not help either; the
picture keeps moving, so a false stall is not expected (the session row confirms). If saving the
decode matters, the host has to tell the page or hide the webview on minimise.

## macOS (WKWebView)

Measured 2026-10-09 09:33–09:53 (Mac time) on TEC-MBA (Apple silicon, macOS 26.6 25G72, one built-in
1710x1107 pt display with a notch, Stage Manager on, Dock on the left), over ssh, without signing in. To be
moved under this heading in `spike-g0.md` once that file exists (task 2.1 owns it).

**Build.** The crate was copied (no `target/`, no `gen/`) to a fresh `~/src/owlette-swoop-viewer-g0/desktop/viewer`
with the worktree's `desktop/package.json` + `package-lock.json` (`npm ci`: `@tauri-apps/cli` and `api` 2.12.0) and
the five icons it names. Not `~/src/owlette`: that checkout is `dev` at 4.0.5 (`ecab77d1`) with `@tauri-apps/api`
2.11.1 against the crate's tauri 2.12.0, and `npm ci` there would rewrite a shared checkout's `node_modules`.
Rust 1.98.1. No crate change was needed on macOS.

| item | result | evidence |
| --- | --- | --- |
| `cargo clippy --all-targets -- -D warnings` | pass | clean in 40 s cold; re-run clean after the 2.1 agent's debug-only `windows.rs` block landed (snapshot md5 `ce9ef233…`) |
| `cargo test --locked` | pass, 22/22 | same both snapshots; `Cargo.lock` byte-identical to the worktree's after the runs |
| `tauri build --bundles app --ci` | pass | 1m31s, `target/release/bundle/macos/owlette swoop.app`, 10.62 MiB, arm64 thin, `minos 15.0`, `sdk 26.5`; built before the `windows.rs` change, which is `cfg(windows)` only |
| URL scheme in Info.plist | present | `CFBundleURLTypes` → `CFBundleURLSchemes ["owlette-swoop"]`, `CFBundleURLName "app.owlette.swoop-viewer owlette-swoop"`, role Editor (written by the deep-link plugin config) |
| identity keys | as configured | `CFBundleIdentifier app.owlette.swoop-viewer`, `CFBundleName`/`CFBundleDisplayName "owlette swoop"`, `CFBundleExecutable owlette-swoop-viewer`, `LSMinimumSystemVersion 15.0`, version 4.1.8, `LSApplicationCategoryType public.app-category.utilities` |
| `NSLocalNetworkUsageDescription` | **absent** | the desktop app carries one through `desktop/src-tauri/Info.plist`; the viewer has no Info.plist of its own. Effect on a LAN session not measured |
| macOS 26 icon | `icon.icns` only | no `CFBundleIconName` / `Assets.car` (the desktop app ships both) |
| signing | linker-signed ad hoc only | `codesign -dv`: `flags=0x20002(adhoc,linker-signed)`, `Identifier=owlette_swoop_viewer-ca44dea13a5fbf7d`, `Info.plist=not bound`, `Sealed Resources=none`, `TeamIdentifier=not set`; `codesign --verify --strict` fails "code has no resources but signature indicates they must be present". Launches locally; a downloaded copy would not |
| launch with a URL | pass | `open -n "<app>" --args https://dev.owlette.app/swoop`: one process, one 1060x680 window titled "owlette swoop" showing the owlette sign-in page (screenshot 1); log `opening https://dev.owlette.app/swoop`. The page's own URL is not readable from outside (AX `AXURL` exists but returns nothing to AppleScript), so the dev host rests on the log line |
| remembered origin | pass | `~/Library/Application Support/app.owlette.swoop-viewer/viewer.json` = `{"origin":"https://dev.owlette.app"}`; a later no-argument `open` opened one window (which origin is not logged: `open_home` writes no line) |
| deep link, warm | pass | `open "owlette-swoop://dev.owlette.app/swoop/test-site/test.machine"` with the app running: still one pid, a second 1280x800 window on the sign-in page (screenshot 2), log `opening https://dev.owlette.app/swoop/test-site/test.machine`. macOS hands the link to the running process as an Apple event; no second process starts |
| second launch with an argument | pass | `open -n "<app>" --args https://dev.owlette.app/swoop/test-site/second.machine`: the new process was gone within 1 s, the first pid opened a third window (single-instance plugin works on macOS) |
| deep link, cold start | **two windows** | with no process: `open "owlette-swoop://…/swoop/test-site/test.machine"` → one pid, a 1060x680 main window (picker) and a 1280x800 swoop window. The 1.1 prediction holds |
| window placement | note | every swoop window opens centred at the same frame (242,171 1281x801), so two sessions stack exactly and a swoop window fully covers the main window |
| Cmd+W | closes the front window | the default Tauri macOS menu has File → Close Window (Cmd+W) and Close All; 3 → 2 → 1 windows, process alive |
| last window closed | process exits | closing the main window last: process gone within 1.5 s |
| Quit (`tell application "owlette swoop" to quit`) | exits at once | osascript returned in 0.13 s with two windows open; the process was gone at the 1 s check. Whether the close handshake ran is not observable from outside; by code reading it hangs off `WindowEvent::CloseRequested` only (see the owner list) |
| menus | default Tauri menu | app (About, Services, Hide, Hide Others, Quit, Quit and Keep Windows), File (Close Window, Close All), Edit (Undo, Redo, Cut, Copy, Paste, Select All, Writing Tools, AutoFill, Dictation, Emoji), View (Toggle Full Screen), Window, Help. The Edit menu already exists, so Cmd+V/C/X/A have key equivalents (3.2 assumed it had to be added) |
| activation policy | Regular | menu bar present, process frontmost after `open` |
| log location | `~/Library/Logs/app.owlette.swoop-viewer/owlette-swoop-viewer.log` | created on first launch; lines below |
| web data | separate jar | `~/Library/WebKit/app.owlette.swoop-viewer/WebsiteData`: the app's sign-in is its own, not Safari's |
| scheme binding | the build-tree bundle | `lsregister -dump URLSchemeBinding`: `owlette-swoop: app.owlette.swoop-viewer`, i.e. the bundle above until another copy is installed |

Log lines written by the release app (the debug probe below appended its own `localhost` lines to the same file):

```
[2026-10-09][09:38:12][INFO][owlette_swoop_viewer_lib::windows] opening https://dev.owlette.app/swoop
[2026-10-09][09:40:53][INFO][owlette_swoop_viewer_lib::windows] opening https://dev.owlette.app/swoop/test-site/test.machine
[2026-10-09][09:41:40][INFO][owlette_swoop_viewer_lib::windows] opening https://dev.owlette.app/swoop/test-site/second.machine
[2026-10-09][09:42:40][INFO][owlette_swoop_viewer_lib::windows] opening https://dev.owlette.app/swoop/test-site/test.machine
```

### Engine probe (debug build on a local page)

A debug build accepts `http://localhost:<port>`, so the debug binary was pointed at a static page served on
127.0.0.1:8765 that posts its findings back (no permission prompts, no clipboard writes). Buttons were pressed
through accessibility (`AXPress`), which WebKit treats as a user gesture. Same WKWebView as the release app; only
the origin differs, so anything origin-bound (passkeys) is indicative only.

| item | result | evidence |
| --- | --- | --- |
| user agent | as composed | `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) owlette-swoop-viewer/4.1.8`. No `Version/… Safari/…` token, which is what Google's embedded-webview check keys on (refusal itself unmeasured) |
| playout-delay in receiver caps | **yes** | `RTCRtpReceiver.getCapabilities('video').headerExtensions` includes `http://www.webrtc.org/experiments/rtp-hdrext/playout-delay`, so `probeClientCaps().playoutDelay` is true. Necessary, not sufficient: the negotiated SDP still needs a session (owner list) |
| video codecs offered | H.264, H.265, VP8, VP9 | H.264 `profile-level-id` 640c1f / 42e01f, packetization 0 and 1; H.265 with an empty fmtp; audio: opus, red, G722, PCMU, PCMA, CN, telephone-event |
| `decodingInfo({type:'webrtc'})` | **throws for our strings** | `video/H264;codecs=avc1.64002A` and `video/H265;codecs=hev1.1.6.L123.B0` (the two in `web/lib/swoop/clientCaps.ts`) throw `TypeError: Type error`; `video/H264`, `video/H265` and the fmtp form `video/H264;level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f` return supported, smooth, powerEfficient. `clientCaps.ts` swallows the throw, so this webview offers `codecs: ['h264']`, `hardware: []`: **no HEVC on macOS** although the engine decodes it in hardware. A web-side fix (drop `codecs=` for `type: 'webrtc'`), not a viewer one; Safari 26 is the same engine and likely affected too (unmeasured) |
| WebCodecs HEVC | yes | `VideoDecoder.isConfigSupported({codec:'hev1.1.6.L123.B0', hardwareAcceleration:'prefer-hardware'})` → supported |
| `navigator.keyboard` | **absent** | `'keyboard' in navigator` false, so no Keyboard Lock; OS-shortcut capture and the release key fall to the app (3.2) |
| element → native fullscreen | **pass** | `stage.requestFullscreen()` resolved, `fullscreenchange` fired, `document.fullscreenElement` = the stage, the window went native fullscreen (AX `AXFullScreen` true, own Space, 1710x1073 below the notch strip; screenshot 3). The promise resolves before the animation ends: `innerHeight` 1042, then 1073 0.6 s later |
| native exit → element exit | pass | leaving native fullscreen from the window (AX `AXFullScreen` false, the green-button path) fired `fullscreenchange` with `fullscreenElement` null; `document.exitFullscreen()` returned the window to 1061x681 |
| pointer lock | **refused** | `requestPointerLock()` rejected `WrongDocumentError: Pointer lock requires the window to have focus.` windowed and fullscreen, with the app frontmost and `document.hasFocus()` true. Likely wry does not grant WebKit's pointer-lock request; a real click in a session settles it (owner list) |
| `window.open` of a session | pass | `window.open('/swoop/g0-site/g0.machine','_blank','noopener')` returned null and opened a 1280x800 swoop window (log `opening http://localhost:8765/swoop/g0-site/g0.machine`): 1.1's `on_new_window` path works on WKWebView |
| `visibilityState`, covered | `hidden` | the main window fully covered by the new swoop window: `blur`, then `visibilitychange` → `hidden` 54 ms later; raised again → `visible` |
| `visibilityState`, minimised | inconclusive | AX minimise of the main window: `blur` at once, no `visibilitychange` for 41 s, then `hidden` as another app came forward. AX reported both windows `AXMinimized false` afterwards and CG showed both as ~110x140 frames at the right screen edge, where Stage Manager keeps its strip when the Dock is on the left: Stage Manager, not the Dock, took the window |
| passkeys (API) | present, no platform authenticator | `PublicKeyCredential` defined; `isUserVerifyingPlatformAuthenticatorAvailable()` false; conditional mediation false (on localhost) |
| clipboard API | present | `navigator.clipboard.readText`/`writeText` defined; not exercised (would overwrite the owner's clipboard) |
| other | present | `AudioContext`, `requestVideoFrameCallback`, `isSecureContext` true |

Screenshots (window-only captures with `screencapture -l <window id>`, deleted on the Mac afterwards):
`viewer-1.png` (main window, sign-in page), `viewer-2.png` (deep-link swoop window, sign-in page),
`viewer-3-fullscreen.png` (probe stage in native fullscreen), in the session scratchpad
`C:\Users\admin\AppData\Local\Temp\claude\c--Users-admin-Documents-Git-restored-Owlette\470b85b9-9fdc-4dc6-99d3-0960407951c9\scratchpad\`.

The built app stays at `~/src/owlette-swoop-viewer-g0/desktop/viewer/target/release/bundle/macos/owlette swoop.app`
for the sitting. No viewer process is left running.

### Needs a session (owner sitting, one batch)

Start: `open "$HOME/src/owlette-swoop-viewer-g0/desktop/viewer/target/release/bundle/macos/owlette swoop.app" --args https://dev.owlette.app/swoop`,
sign in with email + password + authenticator code, pick an online machine (B4A or A4D). Then, in order:

1. **playout-delay negotiated (gate G0, fatal if absent).** Pass = the picture arrives. Fail = the notice "this
   machine did not agree the low-latency terms swoop requires." Receiver caps already list the extension.
2. **codec negotiated.** Toolbar "latency stats" → the overlay's `codec` row. Expect `H.264` until `clientCaps.ts`
   stops sending `codecs=` to `decodingInfo`; HEVC there would contradict the probe.
3. **element → native fullscreen in a session.** Toolbar "fullscreen with keyboard and mouse capture": the window
   should take its own Space and the button should read "exit fullscreen"; then press the green button or
   Ctrl+Cmd+F and check the toolbar returns to windowed.
4. **`navigator.keyboard` absence.** Already measured absent; confirm the toolbar's fullscreen tooltip and the
   special-keys menu do not promise Keyboard Lock behaviour.
5. **Cmd+Tab / Cmd+Q / Cmd+W in fullscreen.** Expect today (no 3.2 yet): Cmd+Tab switches app locally, Cmd+W closes
   the swoop window, Cmd+Q quits the app; note whether any of them reach the remote machine (they should not).
6. **Quit with a live session.** Cmd+Q (or app menu → Quit) with a session up, then watch the machine's viewer
   badge on the dashboard in a browser: cleared within a second = the handshake ran; lingering until the server
   timeout = Quit skips `CloseRequested` and needs its own path. Compare with closing the swoop window by its red
   button (that path is the handshake).
7. **Esc in fullscreen.** Single Esc: does WebKit leave fullscreen (browser-like) or does the key reach the
   machine? Hold Esc 2 s is not built yet (2.3).
8. **pointer lock.** Click into the picture in fullscreen: does the local cursor vanish and relative mouse movement
   drive the remote one? The probe was refused with `WrongDocumentError`.
9. **Google refusal text.** Sign out, "continue with Google": write down what appears (a popup window, a browser
   tab, Google's `disallowed_useragent` page, or nothing).
10. **passkey outcome.** "continue with passkey" on sign-in, and the step-up dialog when taking control: record the
    exact error or the system sheet. The probe found no platform authenticator.
11. **clipboard.** Copy text on the Mac, paste with Cmd+V into a remote text field; copy on the remote machine and
    paste locally.
12. **audio.** Toolbar "unmute this machine": sound plays, and no autoplay block appears.
13. **minimised and covered window.** Minimise the swoop window for 30 s (Stage Manager off for this one, or use
    Cmd+M), restore: the picture resumes without a reconnect notice. Repeat with the window fully covered.
14. **Local Network prompt.** On the office LAN, does macOS ask for Local Network access (no usage string in the
    bundle), and does the session still connect directly?
