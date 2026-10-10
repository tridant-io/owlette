# owlette swoop hosts the web viewer instead of being a second viewer

swoop in a browser tab cannot take the OS shortcuts a remote desktop needs outside Chromium's keyboard lock, cannot be opened from a machine's tray, and shares its window with the browser. A native viewer with its own WebRTC stack and decoder would fix that at the price of a second viewer to keep level with the web one, with its own sign-in and step-up and a release train far slower than the web's daily deploys. So owlette swoop (`desktop/viewer`, binary `owlette-swoop-viewer`) is a second small Tauri app, apart from the desktop app because nothing agent-shaped may run in it, that loads owlette.app's own viewer as a top-level page and adds only what a browser cannot: window management (a session in the picker's window, or one of its own on request; the bar as the title bar), OS-shortcut capture in fullscreen, the `owlette-swoop://` scheme, and a clipboard grant that raises no prompt. Top-level, never an iframe or a bundled copy: `X-Frame-Options` and `frame-ancestors` refuse the frame, and a copy served from the app's own origin would lose the `__session` cookie, the 12-hour step-up window and every web deploy.

## Consequences

- Windows gets H.264 only in the app: WebView2, like Edge, cannot decode HEVC over WebRTC, while Chrome on the same box can.
- Auth lives in the webview's own cookie jar, not the browser's, so sign-in and the step-up hand off to the system browser (a single-use code in the deep link, "sign in with your browser", "verify in your browser"); Google and passkeys do not run inside the webview.
- owlette.app pages get one Tauri capability, limited to their own window (minimize, maximize, close, drag, is-maximized, its resize event); host to page is `eval` only. Widening it widens what any owlette.app page can do on an operator's computer.
- The scheme is received-only: the app rebuilds an https URL on an allowlisted host from it, and itself opens nothing but http(s).
- macOS cannot forward Cmd+Tab: with app switching off, macOS swallows the key, so it stays on the special-keys menu.
- No pointer lock on macOS: WebKit grants it only through a private UI-delegate hook that wry does not implement and the app will not call.
