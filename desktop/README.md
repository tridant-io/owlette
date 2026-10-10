# owlette desktop

The owlette desktop app: the local window and the tray icon (a menu bar item on
macOS) on every machine that runs the agent, on Windows, macOS and Linux. It
shows the machine's processes, their launch modes and schedules, and the
service's status, and it joins or leaves a site. Tauri 2: Vite + React 19 +
TypeScript on the frontend, Rust on the host side, wearing the same design
system as the web dashboard.

This package is **not** an npm workspace of the monorepo root: install and run
its commands from inside `desktop/`.

## Prerequisites

Every platform:

- Node.js 22 (`.nvmrc` at the repo root)
- Rust stable + Cargo (`rustup` installs both; on Windows Cargo lands in
  `%USERPROFILE%\.cargo\bin`, which must be on `PATH`)

Then, per platform:

- **Windows**: Visual Studio 2022 C++ build tools (MSVC toolchain + Windows
  SDK), and the WebView2 runtime (preinstalled on Windows 11; the agent
  installer bundles the bootstrapper for images without it).
- **macOS**: the Xcode Command Line Tools. The app targets macOS 15 or later,
  and releases ship for Apple silicon only. `tauri.macos.conf.json` declares
  the swoop streamer as a sidecar, and tauri-build refuses to compile until the
  file exists, so stage it once before the first build (CMake is needed for its
  audio codec):

  ```bash
  cd agent/swoop
  CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo build --release --locked \
    --no-default-features --features encode-videotoolbox,audio-opus
  cp target/release/owlette-swoop \
    ../../desktop/src-tauri/binaries/owlette-swoop-$(rustc -vV | sed -n 's/^host: //p')
  ```

- **Linux** (Ubuntu 24.04): the WebKitGTK and tray libraries Tauri builds
  against:

  ```bash
  sudo apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf
  ```

## Commands

```bash
cd desktop
npm install

npm run tauri dev                  # compile the Rust host + start vite, open the app window
npx tauri build --no-bundle        # Windows release exe at src-tauri/target/release/owlette-desktop.exe

npm run dev            # frontend only, in a browser at :1420 (no Tauri IPC)
npm run build          # typecheck + production frontend bundle into dist/
npm run typecheck      # tsc -b
npm test               # vitest run
npm run test:watch     # vitest
npm run lint           # oxlint
```

The first `tauri dev` compiles several hundred crates and takes several
minutes; later runs are incremental and start in seconds.

The app reads and writes the agent's real data tree, so run it on a machine
with the agent installed, or set `OWLETTE_DATA_ROOT` to a scratch tree; the
agent honours the same override.

To try a Windows build against an installed agent, close the running app, copy
the new `owlette-desktop.exe` into `C:\ProgramData\Owlette\app\`, and start it
with `--tray` (or let the service start it on its next status check).

To pair a machine with dev.owlette.app from the app, open **join site** and
click the "join a site" title five times: the pairing restarts against dev and
the orange `dev` badge appears; a click on the badge goes back to owlette.app.
Nothing advertises it, so customers never see a choice. Unattended installs
still use `/SERVER=dev` on Windows and the pairing preseed on macOS and Linux.

## How the app ships

The app never ships on its own; each platform's agent installer carries it.

| platform | build | installed as | started by |
| --- | --- | --- | --- |
| Windows | `npx tauri build --no-bundle`, run by `agent/build_installer_full.bat`; the quick build re-copies the exe from `target/release/` | `C:\ProgramData\Owlette\app\owlette-desktop.exe`, by the Inno Setup installer | the service, as soon as a user session exists, and the installer's startup shortcut |
| macOS | `npx tauri build --bundles app`, run by `agent/build/macos/build.sh`, which signs the app and its swoop sidecar | `/Applications/owlette.app`, inside `Owlette-Installer-v<version>.pkg` | the `app.owlette.desktop` LaunchAgent, at every login |
| Linux | `npx tauri build --bundles deb`, run by `agent/build/linux/build.sh`, which merges the app's deb into the agent package | `/usr/bin/owlette-desktop`, inside `Owlette-Installer-v<version>.deb` | the `owlette-desktop.service` user unit, for every graphical login by a member of the `owlette` group |

On Windows always pass `--no-bundle`: the Tauri bundler would build its own
NSIS installer, a second one competing with the agent's. The `nsis` entry in
`tauri.conf.json`'s bundle targets is never built.

owlette swoop, the viewer app (`viewer/`, below), ships in the same three
installers, built by the same scripts right after the desktop app (from this
directory's `node_modules`): on Windows `C:\ProgramData\Owlette\app\owlette-swoop-viewer.exe`
(`--no-bundle`), with `owlette-swoop://` registered machine-wide and an
`owlette swoop` Start-menu shortcut, all three removed at uninstall; on macOS
`/Applications/owlette swoop.app` (`--bundles app`, signed like the desktop
app; the build fails if its `Info.plist` lacks the `owlette-swoop` URL type);
on Linux `/usr/bin/owlette-swoop-viewer` from its deb (`--bundles deb`) with
the agent package's own `owlette-swoop-viewer.desktop` as its launcher and
`x-scheme-handler/owlette-swoop` handler. Nothing starts it; the user, a link
or the desktop app's `swoop` entries do. The quick build re-copies
`viewer/target/release/owlette-swoop-viewer.exe` and does not compile it.

## owlette swoop (the viewer app)

`viewer/` is a second Tauri crate, `owlette-swoop-viewer`: **owlette swoop**, a
window manager for owlette.app's swoop viewer. It has no frontend of its own.
Every window loads owlette.app top-level, so the sign-in cookie, the step-up
window and each day's web deploy carry over; `viewer/dist/index.html` is only
the placeholder Tauri requires, and it is never shown.

**One window by default; a new one on request.** The main window holds the
picker (`/swoop`), and a session opens in it by default: a session page
(`/swoop/<site>/<machine>`) arriving as an argument, an `owlette-swoop://` link
or a second launch navigates the main window there and raises it (built on the
session if there is no main window). A session gets a swoop window of its own
instead when the main window is busy with another session (a live session is
never cut off silently; a link to the session main is already on only raises
it), when that session's swoop window is already open (it is raised), or when
the page asks for one with `window.open` (the picker's right-click "open in new
window"), which always opens or raises the session's swoop window. Any other
page goes to the main window as before. An app-link,
`/app-link?code=<code>&next=/swoop/<site>/<machine>` (the page signs the app
in, then replaces itself with `next`), counts as its session in all of this; one
whose `next` is not a relative session path is no session and opens in the main
window. Each new
swoop window opens 32 px right and down from the newest one still open; it is
centred when there is none, when that one is minimised, and again after eight
steps. There is no tray and no agent coupling: the app reads and writes nothing under the
owlette data root, so it runs on a workstation without an agent. It shares the
desktop app's icons and nothing else; the two crates are separate on purpose
(their own identifiers, WebView2 profiles and instance locks).

```bash
cd desktop/viewer
../node_modules/.bin/tauri dev -- -- https://dev.owlette.app/swoop   # debug build, opened on dev
../node_modules/.bin/tauri build --debug --no-bundle                  # target/debug/owlette-swoop-viewer.exe
cargo test
cargo clippy --all-targets -- -D warnings
```

To review against a local web dev server, run `npm run dev` in `web/`, then the
debug exe with `http://localhost:3000/swoop`; a debug build registers
`owlette-swoop://` for itself at every start (on Windows, HKCU pointing at that
exe), so the website's open-in-app click lands in it.

A Windows debug build opens WebView2's DevTools protocol on `127.0.0.1:9222`,
so a script can drive the real webview (`chromium.connectOverCDP`); a release
build never does.

Every agent installer carries it (see "How the app ships" above). On a dev box
the debug build's HKCU registration shadows the installer's machine-wide one,
so links keep opening the debug exe until
`reg delete HKCU\Software\Classes\owlette-swoop /f` clears it. A standalone
download comes later in the plan.

**One argument, no flags.** The app takes at most one argument: an `https://`
URL on `owlette.app` or `dev.owlette.app` (also `http://localhost:<port>` in a
debug build), or an `owlette-swoop://<host>/<path>` link, which it rewrites to
`https://<host>/<path>` (`http://` for `localhost:<port>` in a debug build) and
holds to the same host check. Anything else opens
the picker. The origin of a given URL is remembered in `viewer.json` in the
per-user app data directory (`%APPDATA%\app.owlette.swoop-viewer` on Windows)
as `{"origin":"https://dev.owlette.app"}`, and a launch with no argument opens
`<that origin>/swoop`, or `https://owlette.app/swoop` before anything was
remembered. A second launch never becomes a second process: the
single-instance plugin hands its argument to the running one, which opens or
raises the right window, and a second launch with no argument raises the main
window as it is. macOS delivers `owlette-swoop://` links as an Apple event
rather than an argument; `tauri-plugin-deep-link` covers both. A launch
straight into a session opens only the main window, on that session, no picker. On macOS that
link arrives just after the app starts, so a launch with no argument there
waits 500 ms for one before it opens the picker.

**Navigation.** A window may navigate only to the allowed origins,
`*.firebaseapp.com` and `accounts.google.com` (sign-in). A `window.open` of a
session (`/swoop/<site>/<machine>`) on an allowed origin opens a swoop window,
whatever the main window holds; any other target opens in the system browser, http(s) only (the desktop app's
guard in `shell_open.rs`), through `ShellExecuteW` on Windows as the desktop
app does: `explorer.exe` opens File Explorer for any URL with a query. The
pages get one narrow grant of Tauri IPC, the title bar's window commands (below);
the host-to-page channel is still `eval` only. Every
webview's user agent ends in `owlette-swoop-viewer/<version>`, which is how
owlette.app knows it is inside the app, followed by ` (keys)` where the app
hands OS shortcuts to the page itself (macOS, below).

**No native frame: the page's top bar is the title bar.** Every window, the
main one and each swoop window, is built without a frame (`windows.rs`):
`decorations(false)` on Windows and Linux; on macOS the overlay title bar with a
hidden title, so the traffic lights float over the page's top left (as in the
desktop app, minus its `mac_window.rs` toolbar, which only buys macOS 26's
corner radius). owlette.app draws the rest
(`web/components/swoop/SwoopWindowControls.tsx`): the session bar on top, the
picker's header and a strip on the login page carry minimize, maximize/restore
and close at the right on Windows and Linux, or leave the traffic lights 78 px
on macOS, and are the window's drag surface (`data-tauri-drag-region="deep"`:
a press on anything in them that is not a control drags, a double press
maximizes). When the session bar runs down a side, the controls move to a slim
strip across the top of the window holding nothing else: the controls and a
160 px drag handle beside them at the right (on macOS only the traffic lights'
room), with presses everywhere else going through to the picture. Fullscreen
hides all of it. The login page is the app's own: the whole page is the drag
surface, under an "owlette | swoop" lockup with no tagline, one "sign in with
your browser" button, and the email form behind an "or use your email and
password" link. The site footer (docs, privacy, terms) shows on no page in the
app.

The page reaches its window through `window.__TAURI__` (`app.withGlobalTauri`,
so owlette.app needs no Tauri package), and `capabilities/owlette-pages.json`
grants exactly that: windows `main` and `swoop-*`, remote URLs
`https://owlette.app/*` and `https://dev.owlette.app/*` only (`local: false`),
and permissions for minimize, toggle-maximize, close, start-dragging,
is-maximized, `internal-toggle-maximize` (what Tauri's drag script calls on a
double press) and event listen/unlisten (the resize event that swaps the
maximize and restore icons). Nothing else: no fs, shell, dialog, webview or
deep-link command, no other window command (measured from the page: `setTitle`,
`unminimize`, `plugin:deep-link|get_current` and
`plugin:webview|create_webview_window` come back "not allowed"; fs and shell
are not even in the app). It is narrow because it is the app's own site
working this app's windows, and nothing an owlette.app page could be made to do
with it reaches past that window. A capability file applies to every build, so
the local web dev server (`http://localhost:*`) gets the same grant at run time
in a debug build only (`dev_server_capability` in `lib.rs`, built from the same
file), matching `origin::allowed_origin`, which loads localhost in a debug
build only. A unit test holds `owlette-pages.json` to that list.

**Close = end.** The first close of any window, the main one included, is
held: the app dispatches `owlette:close` on the page, which ends the session in
app mode (the picker and other pages ignore it), and closes the window 300 ms
later. The page's close button asks for the same close, so it goes through the
same handshake. Closing the last window quits the app.

**The clipboard without a prompt (Windows).** WebView2 asks before a page
reads the clipboard ("<origin> wants to see text and images copied to the
clipboard"), a dialog a native app must not show. Every window answers that
request itself (`permissions_windows.rs`, attached as `windows.rs` builds the
window): a clipboard read from an allowed origin (`origin::allowed_origin`, so
the local dev server in a debug build only) is allowed, and WebView2 keeps the
grant in the app's profile, after which `navigator.permissions` reports
`clipboard-read` as granted. Any other origin, and every other permission
(camera, microphone, location and the rest), keeps WebView2's default. Writes
need no grant while the window has focus. Each decision is a debug-level line,
origin only, below the info level the log keeps. Measured over CDP on the
picker: `writeText` then `readText` round-trips, `read()` returns the item, an
image `write` reads back as `image/png`, and no dialog opens. macOS and Linux
are untouched by this.

**Keys on macOS.** While a session page (`/swoop/<site>/<machine>`) is
fullscreen, the app hides the Dock, turns app switching and Hide off and shows
the menu bar only on a mouse-over (`mac.rs`), and a local key monitor
(`keys_macos.rs`) takes the down of Cmd+Q, Cmd+W, Cmd+H and Cmd+M before the
menu sees it and hands it to the page as `window.__owletteNativeKey(code,
true)`, with the DOM `code` of the physical key; the page sees Meta go down and
up as usual, and the key's up arrives as its own DOM `keyup` (a Cmd combo's up
never passes a local monitor, and WebKit delivers it anyway). The match is on
the key's character, as the menu's is, so Cmd+Q is the key labelled Q on
AZERTY too. The app neither quits, closes, hides nor minimizes. Cmd+Tab switches nothing, but with switching off
macOS swallows it, so it does not reach the machine either; Cmd+Space,
Ctrl+arrows, Mission Control and the other system hotkeys never reach an app
and stay with macOS, and the app leaves Ctrl+Cmd+Q (lock screen) to macOS too.
Every other key goes to the page as before, Cmd+V, C, X and A through the
default Edit menu included. Leaving fullscreen puts the Dock and switching
back. The options go on as a window starts entering fullscreen
(`NSWindowWillEnterFullScreenNotification`): set once it is there, they read
back as set and Cmd+Tab still switches apps (measured on macOS 26.6). WebKit's
element fullscreen moves the webview into a window of its own and leaves
Tauri's window offscreen, so capture follows AppKit's window notifications, not
Tauri's, and the green button's fullscreen of a session counts the same. The
app stays a regular one (Dock icon, a place in Cmd+Tab outside a session).

It logs to `owlette-swoop-viewer.log` in the per-user log directory
(`%LOCALAPPDATA%\app.owlette.swoop-viewer\logs` on Windows), with the desktop
app's rotation. Each open is a line `opening <origin><path>`, a launch with no
argument `opening <origin>/swoop (home)`, a `window.open`
`opening <origin><path> (new window)`, the main window taking a page
`navigating main to <origin><path>`, a new swoop window
`new swoop window <label>`, a held close
`closing <label>: its page ends the session first`, and on macOS a session
going fullscreen `capturing keys in fullscreen on <origin><path>` and the last
one leaving `released keys`; no log line carries a URL's query.

**Known gaps.** A lone Alt tap puts the window into its menu mode on Windows
until native key capture lands. There is no pointer lock on macOS:
`requestPointerLock()` is refused with `WrongDocumentError`, because WebKit
asks its UI delegate for pointer lock only through private API; no public
`WKUIDelegate` method exists for it (macOS 26.6 SDK) and wry 0.57's delegate
implements none, and the app uses no private API. Cmd+Tab cannot reach the
machine from macOS (above). Google sign-in needs the browser handoff. Only the
picker, a session and the login page draw window controls: the second-factor
page, `/app-link` and any other owlette.app page a link leads to have none yet.
The frameless Linux windows are unbuilt until CI.

## Layout

```
desktop/
├─ index.html            # <html class="dark"> until the host answers (main.tsx), body font-sans antialiased
├─ components.json       # shadcn config (new-york, neutral, cssVariables)
├─ vite.config.ts        # @ alias, tailwind 4 plugin, tauri dev server, vitest
├─ public/               # icon.svg, owlette-eye.svg
├─ src/
│  ├─ App.tsx
│  ├─ globals.css        # design tokens + unlayered interaction rules
│  ├─ assets/fonts/      # self-hosted Geist / Geist Mono (variable woff2)
│  ├─ components/        # the process list and detail, schedule editor, join/leave site, drop confirm,
│  │                     #   restart countdown, permission banner (macOS), report issue, status footer
│  ├─ components/ui/     # 22 shadcn primitives, verbatim from web/
│  ├─ hooks/             # config, app states, file watch, service health, file drop, launch flags
│  ├─ lib/ipc.ts         # typed wrappers for every host command + event
│  ├─ lib/owletteConfig.ts   # config.json schema + the transforms behind every write
│  ├─ lib/processStatus.ts   # app_states.json + the KILLED / RESTARTING markers
│  ├─ lib/processControl.ts  # kill and restart, marker and all
│  ├─ lib/dropClassifier.ts  # dropped path -> process entry (pure, injected fs)
│  ├─ lib/fsProbe.ts     # the real disk behind it + per-machine search paths
│  ├─ lib/dropQueue.ts   # the confirm-card queue between a drop and a write
│  ├─ lib/launchCopy.ts  # platform-specific wording for the launch target
│  ├─ lib/platform.ts    # which OS the app is on
│  ├─ lib/theme.ts       # the appearance choices (system / dark / light)
│  └─ test/              # vitest setup + design-system smoke test
└─ src-tauri/
   ├─ tauri.conf.json    # window, bundle targets; tauri.macos.conf.json adds the overlay title bar + swoop sidecar
   ├─ binaries/          # the staged swoop sidecar (macOS; gitignored)
   ├─ src/paths.rs       # the data root (%PROGRAMDATA%\Owlette, /Library/Application Support/Owlette,
   │                     #   /var/lib/owlette, or OWLETTE_DATA_ROOT) + path scoping
   ├─ src/json_io.rs     # locked + atomic JSON read/write (named mutex on Windows, flock off it)
   ├─ src/watchers.rs    # directory watchers for the three seam files
   ├─ src/service_ctl.rs # service state / start / stop: the SCM, launchd or systemd
   ├─ src/seam.rs        # macOS / Linux: requests to the root daemon (pair, leave, restart, reboot)
   ├─ src/jobrunner.rs   # macOS / Linux: GUI jobs the daemon asks of the app (captures, notifications)
   ├─ src/agent_cli.rs   # runs the agent's python CLI (pairing, leaving, bug reports) and streams progress
   ├─ src/tcc.rs         # macOS: reports the Screen Recording grant to the daemon
   ├─ src/awake.rs       # keep screens awake: the session's half (idle lock, screensaver)
   ├─ src/process_ctl.rs # WM_CLOSE-then-terminate with an identity check
   ├─ src/pid_file.rs    # tmp/tray.pid + tmp/gui.pid
   ├─ src/tray.rs        # tray / menu bar icon, menu, status monitor
   ├─ src/startup_link.rs # "start on login": {userstartup}\Owlette.lnk; on macOS / Linux this user's
   │                      #   override of the installer's login item (launchctl disable / systemctl --user mask)
   ├─ src/window_state.rs # per-user layout memory (window size, sidebar width, appearance)
   ├─ src/mac_window.rs  # macOS 26 window shape
   ├─ src/menu_bar_position.rs # macOS: where the menu bar item goes on a first run
   ├─ src/shell_open.rs  # hand a path or URL to the OS opener
   ├─ src/viewer_launch.rs # find and start owlette swoop, the viewer app, on this machine's dashboard
   ├─ src/commands.rs    # #[tauri::command] adapters (no logic)
   └─ src/lib.rs         # builder, plugins, watcher wiring, exit cleanup
```

## Tray, window lifetime and launch arguments

This is a tray app: `src-tauri/tauri.conf.json` starts the window hidden and
closing it hides it again, so the tray icon (the menu bar item on macOS, where
there is no Dock icon until the window opens), not a window, is what keeps the
process alive. `src/tray.rs` replaced the old `agent/src/owlette_tray.py` and
carries the porting notes for the status, icon and toast semantics.

The tray menu is the status rows, then `swoop`, `open owlette`, `restart
service`, `start on login` and `exit`. While a swoop session is capturing, its
status row (`swoop: 2 viewers watching`) has `kill all swoop sessions on this
machine` under it, on Windows: the item touches `tmp/swoop_kill.flag`, and the
service's local config watcher ends every session within half a second through
the same kill a dashboard kill without a session id makes, logged with the
reason `local_tray`. No elevation. macOS and Linux do not offer it yet: there
the daemon refuses a flag the console user wrote, and the request seam has no
kill verb. `exit` stops the service and quits; the stop needs administrator
rights, so it raises one UAC prompt (the one elevation a click may cause). The window's menu (`AppMenu`) is `swoop`,
the site action, `config`, `logs`, `docs`, `submit bug report`, `appearance`,
`start on login`, `restart service` and `reload window`. Both `swoop` entries
open owlette swoop, the viewer app, on `<dashboard>/swoop` (`src/viewer_launch.rs`):
the dashboard is the one `config.json`'s `firebase.api_base` names, and the app
is looked for beside this exe on Windows and Linux and at
`/Applications/owlette swoop.app` on macOS. When it is not there the tray item
is greyed out and the window's row is hidden.

| Argument | Meaning |
| --- | --- |
| `--tray` | supply the tray icon, no window. What the service passes when it starts the app (`_try_launch_tray` on Windows), and what the startup shortcut, the macOS LaunchAgent and the Linux user unit pass. |
| `--restart-prompt` | a process exceeded its relaunch budget (`OwletteService.reached_max_relaunch_attempts`): show the reboot countdown (`RestartCountdown`, armed by `useRestartPrompt`). |

A second launch never becomes a second process: the single-instance plugin
forwards its argv on `owlette://second-instance`, and a forwarded launch without
`--tray` shows the window. `launchArgs()` covers the *first* launch only, so a UI
that reacts to either flag handles both; `useLaunchFlag` watches both routes.

Two pid markers tell the service what is open (`src/pid_file.rs`):
`tmp/tray.pid` for the life of the process, `tmp/gui.pid` only while the window
is on screen. The second is what raises the service's metrics cadence to 5 s.

**Windows toasts need an app identity.** Windows silently drops a toast from a
non-packaged app whose `AppUserModelID` is not registered by some shortcut under
the Start menu: `notification().show()` still returns `Ok`, and nothing appears.
`startup_link::enable()` stamps `app.owlette.desktop` onto the shortcut it
writes, but a machine that never turns on "start on login" has no such shortcut,
so the installer ships a Start menu shortcut carrying the same id.

## Logs

`src/lib.rs` registers `tauri_plugin_log` in **both** profiles. It used to be
behind `cfg!(debug_assertions)`, which meant a release build wrote nothing and a
field failure of the tray, a toast or the pairing dialog was undiagnosable. Every
log call in this crate lands here; none exist to record a token or a config
value, and none should be added that do.

| Profile | Level | Where |
| --- | --- | --- |
| debug | Info | stdout (the `tauri dev` terminal) **and** the file below |
| release | Info | the file below only; there is no console (`windows_subsystem = "windows"`) |

The file is `owlette-desktop.log` in Tauri's per-user log directory:

| Platform | Path |
| --- | --- |
| Windows | `%LOCALAPPDATA%\app.owlette.desktop\logs\owlette-desktop.log` |
| macOS | `~/Library/Logs/app.owlette.desktop/owlette-desktop.log` |
| Linux | `~/.local/share/app.owlette.desktop/logs/owlette-desktop.log` |

It belongs to whoever the app runs as (the kiosk's auto-login account), not to
the service, and it is a different tree from the agent's `logs/service.log`
under the data root. A field report wants both, and their timestamps line up
directly because this sink is configured for local time rather than the
plugin's UTC default.

The file rotates at 4 MB and three rotated copies are kept
(`owlette-desktop_<date>.log`), so the ceiling is 16 MB. The plugin's own
default is 40 KB with one file kept, which on a machine that runs for months is
a window of minutes.

## The service seam

The python service and this app share three files under the data root, and the
host reimplements that contract exactly rather than inventing a new one: both
are in the field at once.

| File | Written by | Read for |
| --- | --- | --- |
| `config/config.json` | both | process list, machine settings |
| `tmp/app_states.json` | service | live status per OS pid |
| `tmp/service_status.json` | service | connection + health footer |

Rules the host enforces, all sourced from `agent/src/shared_utils.py`:

- Every read and write takes the cross-process lock with a 2 000 ms budget and
  always releases it, matching `_CrossProcessLock`. On Windows that is the named
  mutex `Global\OwletteJsonFileMutex`; on macOS and Linux it is `flock(2)` on
  `tmp/json.lock`. On timeout it proceeds unlocked and says so in the returned
  `lock` field.
- **On Windows, `CreateMutexW` fails here and that is expected: the
  `OpenMutexW` fallback is the real path.** The service creates the object with
  an explicit security descriptor (`shared_utils._JSON_MUTEX_SDDL`) granting
  Authenticated Users exactly `SYNCHRONIZE | MUTEX_MODIFY_STATE`; `CreateMutexW`
  asks for `MUTEX_ALL_ACCESS`, which that descriptor deliberately withholds, so a
  non-elevated process must open it with the two rights it actually needs. The
  python side has the same fallback. Against an agent older than that fix the
  object still carries LocalSystem's default DACL and both calls fail, so the
  guard reports `lock: "unavailable"` and proceeds; atomicity, not the lock, is
  what makes that safe.
- The descriptor is fixed at creation time, so an in-place agent upgrade only
  takes effect once every handle to the old object is closed (stop the service
  *and* the desktop app, or reboot).
- Writes go to a scratch file in the destination directory and are renamed over
  the target, with `indent=4` formatting and **key order preserved**: the
  `firebase` block must survive a desktop write byte-identical.
- Reads retry three times (100/200 ms) on a locked or half-written file and then
  fail. Python returns `{}` there; we do not, because a UI that writes back an
  empty document would erase the operator's config.
- Frontend paths are resolved inside the data root; `..` and outside paths are
  rejected.
- Because the files are replaced atomically, the watchers are registered on
  `config/` and `tmp/`, not on the files, and coalesce each replace burst into
  one `owlette://file-changed` event.
- `service_status.json` older than 120 s means the service is not writing, no
  matter what the service manager reports (`owlette_tray.read_service_status`);
  the service refreshes it on a 30 s throttle, so anything under two minutes is
  normal.

`src/lib/ipc.ts` is the only place allowed to call `invoke`: one typed function
per command, plus the event subscriptions.

### The request seam (macOS and Linux)

Off Windows this app runs as the console user, who can neither use the token
store nor control the root daemon. Joining a site, leaving it, restarting the
machine and dismissing a pending reboot (and, on macOS, restarting the service)
are requests the daemon carries out (`src-tauri/src/seam.rs`; the daemon half
is "The privileged-request seam" in `agent/src/configure_site.py`). The app
writes `{"verb", "nonce"}` 0600 to `ipc/requests/<id>.json.tmp`, renames it into
place, and reads the daemon's JSON-line answer from `<id>.result` until a
terminal event: the same stream the Windows helper prints, forwarded as the
same `owlette://agent-cli` events. No sudo, no prompt; every request is audited
by the daemon in `logs/privileged_requests.log`. Linux restarts the service with
`systemctl restart` under the packaged polkit rule instead, which also works
when the daemon is down.

The seam runs the other way too. A root daemon has no display, so a screen
capture or a notification is a job it drops into `ipc/jobs/<id>.json` for this
app to carry out in the user's session, answering in
`ipc/results/<id>/result.json` (`src-tauri/src/jobrunner.rs`; the daemon half is
`agent/src/osadapter/posix.py`). On macOS the app also reports its own Screen
Recording grant in `ipc/tcc.json` (`src-tauri/src/tcc.rs`), which is how the
daemon knows whether this Mac can be captured or swooped.

### The two markers this app writes

`tmp/app_states.json` is the service's to write, with two exceptions. Both are
statuses stamped on a pid to describe an exit the service is about to notice
(read in `OwletteService.handle_process`):

| Marker | Written | Meaning to the service |
| --- | --- | --- |
| `KILLED` | *after* the kill | intended exit: no crash alert, no record |
| `RESTARTING` | *before and after* the kill | intended exit, operator-initiated: no crash alert, plus a `process_restarted` audit event |

The order is not incidental, and both halves of the restart write were paid for
in live testing:

- `KILLED` asserts the process is gone, so writing it before the kill would be a
  lie whenever the kill fails.
- `RESTARTING` asserts only an intent, so it goes in *before*: the service
  polls, and an exit it sees before the marker lands is reported as a crash
  (alert, screenshot and hoot event) for a restart the operator asked for.
- It goes in *again after*, because closing a process is not instant (WM_CLOSE,
  a grace period, then a terminate) and every service tick in that window writes
  `RUNNING` over the marker. With only the first write, a live agent overwrote
  it and raised `process_crash` for a restart, screenshot and all.

A restart whose kill then does not happen (the pid had already gone, or refused
to die) puts the row back as it was, so the marker never suppresses a crash that
was real.

Neither marker decides whether the process comes back: that is the launch mode,
read fresh from `config.json` by the service after the exit.

## Drag and drop

Dropping a file, an app or a Unity build folder anywhere on the window
configures it as a process. The flow is four modules deep and each one is
testable on its own:

1. `hooks/useFileDrop.ts`: Tauri's `onDragDropEvent`. Not the html5 events:
   with `dragDropEnabled` the webview hands drops to the host, so `ondrop` never
   fires, and the host event carries absolute paths rather than a `File`. Row
   reordering is a *pointer* drag in the same window, so this ignores everything
   while `lib/rowDrag.ts` says one is in progress.
2. `lib/dropClassifier.ts`: the rule matrix. `.toe` opens in the newest
   installed TouchDesigner, a folder is a process only if it is a Unity player
   build (`<name>.exe` beside `<name>_Data`), `.py` / `.ps1` get an interpreter,
   `.bat` / `.cmd` go in as the executable themselves. Pure, with the disk
   injected as an `FsProbe`.
3. `lib/dropQueue.ts` + `components/DropConfirm.tsx`: one confirm card per
   classified path, worked from the front of the queue. Nothing is written until
   a card is confirmed, and each confirm is its own write.
4. `lib/owletteConfig.ts`: `addProcess` on a document re-read from disk, so the
   `firebase` block and every key this app has never heard of survive.

Two rules the classifier will not bend:

- **`file_path` only ever holds a real file**, never a command-line argument
  string. The service runs that field through `os.path.abspath()`
  (`OwletteService._validate_path`), which turns `-File C:\x.ps1` into a path
  under the service's working directory. That is a known agent-side bug, not a
  classifier limitation, and it is why a `.ps1` travels as a bare quoted path
  and why `.bat` files are launched directly.
- **A dropped process starts with `launch_mode: 'off'`.** Configuring something
  is not the same as starting it, and its numbers come from
  `NEW_PROCESS_DEFAULTS` so that a dropped entry and one added with the `+`
  button are the same entry.

`lib/fsProbe.ts` is the only file that touches `@tauri-apps/plugin-fs`, which is
capability-scoped to `exists`, `readDir` and `stat`: **metadata only**.
Classification never needs a file's contents; keep it that way and a dropped
file can be misread but never read.

## Design system

Everything visual is ported from `web/` and **must stay a verbatim copy** where
it is marked as one. `src/components/ui/*` and `src/lib/utils.ts` are byte-for-byte
the files in `web/components/ui/` and `web/lib/utils.ts`; the `@` alias in
`vite.config.ts` and `tsconfig.app.json` exists specifically so those files
compile here with their `@/lib/utils` imports untouched. When a primitive changes
in `web/`, re-copy it rather than editing this copy. (`.oxlintrc.json` turns
`react/only-export-components` off for that directory for the same reason: the
`buttonVariants`/`badgeVariants` co-exports are shadcn's shape, not ours to fix.)

Three of the primitives are hand-customised in `web/` and easy to clobber by
re-running `npx shadcn add`:

- `button.tsx`: `.btn-sweep` in the cva base, **no** `hover:bg-*` on any variant
  (the sweep supplies hover), `link` variant uses `.hl-link`, plus the extra
  `icon-sm` / `icon-lg` sizes.
- `input.tsx`: `aria-invalid:ring-[3px]` unconditionally, not only when focused.
- `sonner.tsx`: owlette toast palette and lucide icon set.

### globals.css

Ported from `web/app/globals.css`. Tailwind 4 is configured **CSS-first**: there
is no `tailwind.config.*` anywhere in this package, the theme lives in the
`@theme inline` block, and `components.json` carries `"config": ""` to say so.

The rules below `@layer components` (`.hl-link`, `.btn-sweep`, `.form-reveal`,
and the native temporal-input `color-scheme` rules) are **deliberately
unlayered**, so they outrank Tailwind's utilities layer and a stray
`hover:bg-*`/`hover:underline` can't fight them. Their order matters. Don't wrap
them in a layer and don't reorder them.

Blocks dropped during the port because they belong to web-only surfaces:
`.hoot-markdown`, `.machines-grid` / `.site-row-cv` (list virtualisation), and
the `.hero-*` entrance keyframes (plus their now-orphaned
`prefers-reduced-motion` overrides).

### Fonts

The web app gets Geist through `next/font/google`, which generates the
`--font-geist` / `--font-geist-mono` variables. Those variable names are
load-bearing: `@theme inline` maps them to `--font-sans`, `--font-heading` and
`--font-mono`, and ported rules reference `var(--font-geist)` directly.

There is no `next/font` here and a desktop app must not fetch fonts at runtime,
so the two variable-weight woff2 files are vendored in `src/assets/fonts/` and
bound to the same variable names via `@font-face` in `globals.css`. They came
from `geist@1.7.2` (`dist/fonts/geist-sans/Geist-Variable.woff2` and
`dist/fonts/geist-mono/GeistMono-Variable.woff2`), SIL Open Font License 1.1;
see `src/assets/fonts/LICENSE.txt`. To update, install `geist`, copy the two
files across, and delete the dependency again.

## Tests

`npm test` runs vitest over the components and the seams of the port: the `@`
alias, `cn()` + `cva()` + `tailwind-merge`, the `button.tsx` customisations, and
the integrity of `globals.css` (unlayered rules present, font variables bound,
stripped blocks still stripped). CI runs `npm run lint`, `npm test` and
`npm run typecheck` on every change under `desktop/` (`.github/workflows/desktop.yml`).
The Rust crate is `rust-build.yml`'s: clippy and `cargo test` on Windows, macOS
and Linux.

`src/globals.css` is opted into `test.css` in `vite.config.ts`: vitest stubs
CSS imports to an empty string by default, which would silently empty the
`?raw` import those assertions read.

## Window

`src-tauri/tauri.conf.json` sets the window to 1060×640 with a 780×540 minimum,
centred, and `backgroundColor: "#020B16"`, the sRGB value of the dark
`--background` token (`oklch(0.145 0.03 250)`), so the native window paints the
app's background instead of white before setup runs. `dragDropEnabled` is on.
On Windows and Linux the window draws its own title bar (`decorations: false`,
`components/WindowControls.tsx`); `tauri.macos.conf.json` keeps the native
traffic lights over an overlay title bar. Neither config pins a `theme`.

### Appearance

The operator picks system, dark or light from `appearance` in the app menu. It is
stored in `layout.json` in the per-user app data directory
(`%APPDATA%\app.owlette.desktop` on Windows) as `{"appearance": {"theme": "system"}}`
(`system` when absent), and it is the **window** theme, set from Rust; the
webview never picks a theme itself.

- Before the window first shows, `window_state::restore` pins the window theme
  for dark or light (`system` leaves it unpinned) and paints the window and
  webview background to match: `#020B16` dark, `#F4F7FB` light (the light
  `--background`, `oklch(0.975 0.006 250)`). Under `system` the colour follows
  the theme the OS reports, and dark when it reports nothing.
- The page never reads its own `prefers-color-scheme`: WebView2 keeps the colour
  scheme the webview was created with, and tauri changes it only on an OS theme
  change, never when the window is pinned or freed. So the host tells the page.
  `resolved_appearance` returns the theme to draw (the pin, or the OS's answer
  under `system`, dark when it gives none), and the `appearance-resolved` event
  announces each change. `main.tsx` asks before its first render, so the page
  never paints the other theme first, and `HostTheme` forces next-themes to the
  host's answer. `class="dark"` in `index.html` covers the moment before that.
- `set_appearance_theme` re-themes the open window at once, announces the theme
  and then stores the choice. `WindowEvent::ThemeChanged` repaints the background
  and announces the theme when the OS re-themes an unpinned window.
- Linux is the least certain: tao takes the OS theme from GTK's
  `prefer-dark-theme` setting, a portal reporting no preference reads as light,
  and switching back to `system` while running clears the OS dark preference
  until the next launch.
