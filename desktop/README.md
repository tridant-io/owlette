# Owlette Desktop

Tauri 2 desktop shell for Owlette. Vite + React 19 + TypeScript on the frontend,
Rust on the host side, wearing the same design system as the web portal.

This package is **not** an npm workspace of the monorepo root — install and run
its commands from inside `desktop/`.

## Prerequisites

- Node.js 22 (`.nvmrc` at the repo root)
- Rust stable + Cargo (`rustup` installs both; on Windows Cargo lands in
  `%USERPROFILE%\.cargo\bin`, which must be on `PATH`)
- Visual Studio 2022 C++ build tools (MSVC toolchain + Windows SDK)
- WebView2 runtime — preinstalled on Windows 11

## Commands

```bash
cd desktop
npm install

npm run tauri dev                  # compile the Rust host + start vite, open the app window
npx tauri build --no-bundle        # release exe at src-tauri/target/release/owlette-desktop.exe

npm run dev            # frontend only, in a browser at :1420 (no Tauri IPC)
npm run build          # typecheck + production frontend bundle into dist/
npm run typecheck      # tsc -b
npm test               # vitest run
npm run test:watch     # vitest
npm run lint           # oxlint
```

The first `tauri dev` compiles ~435 crates and takes several minutes; later runs
are incremental and start in seconds.

Always pass `--no-bundle` to `tauri build`. The agent installer (Inno Setup, in
`agent/`) is what ships this app; the Tauri bundler would demand NSIS/WiX and
produce a second, competing installer. The full installer build runs the same
command, and the quick build re-copies the exe from `target/release/`.

## Layout

```
desktop/
├─ index.html            # <html class="dark">, body font-sans antialiased
├─ components.json       # shadcn config (new-york, neutral, cssVariables)
├─ vite.config.ts        # @ alias, tailwind 4 plugin, tauri dev server, vitest
├─ public/               # icon.svg, owlette-eye.svg
├─ src/
│  ├─ globals.css        # design tokens + unlayered interaction rules
│  ├─ assets/fonts/      # self-hosted Geist / Geist Mono (variable woff2)
│  ├─ components/ui/     # 22 shadcn primitives, verbatim from web/
│  ├─ components/landing/OwletteEye.tsx
│  ├─ lib/utils.ts       # cn()
│  ├─ lib/surfaces.ts    # MENU_SURFACE recipe
│  ├─ lib/ipc.ts         # typed wrappers for every host command + event
│  ├─ lib/owletteConfig.ts   # config.json schema + the transforms behind every write
│  ├─ lib/processStatus.ts   # app_states.json + the KILLED / RESTARTING markers
│  ├─ lib/processControl.ts  # kill and restart, marker and all
│  ├─ lib/dropClassifier.ts  # dropped path -> process entry (pure, injected fs)
│  ├─ lib/fsProbe.ts     # the real disk behind it + per-machine search paths
│  ├─ lib/dropQueue.ts   # the confirm-card queue between a drop and a write
│  ├─ lib/sidebarWidth.ts    # the sidebar clamp + drag/keyboard geometry
│  └─ test/              # vitest setup + design-system smoke test
└─ src-tauri/
   ├─ src/paths.rs       # %PROGRAMDATA%\Owlette layout + path scoping
   ├─ src/json_io.rs     # named-mutex + atomic JSON read/write
   ├─ src/watchers.rs    # directory watchers for the three seam files
   ├─ src/service_ctl.rs # OwletteService SCM state / start / stop
   ├─ src/process_ctl.rs # WM_CLOSE-then-terminate with an identity check
   ├─ src/pid_file.rs    # tmp/tray.pid + tmp/gui.pid
   ├─ src/tray.rs        # notification-area icon, menu, status monitor
   ├─ src/startup_link.rs # {userstartup}\Owlette.lnk ("start on login")
   ├─ src/window_state.rs # per-user layout memory (window size, sidebar width)
   ├─ src/commands.rs    # #[tauri::command] adapters (no logic)
   └─ src/lib.rs         # builder, plugins, watcher wiring, exit cleanup
```

## Tray, window lifetime and launch arguments

This is a tray app: `src-tauri/tauri.conf.json` starts the window hidden and
closing it hides it again, so the notification-area icon — not a window — is what
keeps the process alive. `src/tray.rs` replaces `agent/src/owlette_tray.py` and
carries the porting notes for the status, icon and toast semantics.

| Argument | Meaning |
| --- | --- |
| `--tray` | supply the tray icon, no window. What the service passes from `_try_launch_tray`, and what the startup shortcut passes. |
| `--restart-prompt` | a process exceeded its relaunch budget; show the reboot countdown. The window for it is not built yet — the argv is only surfaced to the frontend. |

A second launch never becomes a second process: the single-instance plugin
forwards its argv on `owlette://second-instance`, and a forwarded launch without
`--tray` shows the window. `launchArgs()` covers the *first* launch only, so a UI
that reacts to either flag has to handle both.

Two pid markers tell the service what is open (`src/pid_file.rs`):
`tmp/tray.pid` for the life of the process, `tmp/gui.pid` only while the window
is on screen — the second is what raises the service's metrics cadence to 5 s.

**Toasts need an app identity.** Windows silently drops a toast from a
non-packaged app whose `AppUserModelID` is not registered by some shortcut under
the Start menu — `notification().show()` still returns `Ok`, and nothing appears.
`startup_link::enable()` stamps `app.owlette.desktop` onto the shortcut it
writes, but a machine that never turns on "start on login" has no such shortcut,
so the installer must ship a Start menu shortcut carrying the same id.

## Logs

`src/lib.rs` registers `tauri_plugin_log` in **both** profiles — it used to be
behind `cfg!(debug_assertions)`, which meant a release build wrote nothing and a
field failure of the tray, a toast or the pairing dialog was undiagnosable. Every
log call in this crate lands here; none exist to record a token or a config
value, and none should be added that do.

| Profile | Level | Where |
| --- | --- | --- |
| debug | Info | stdout (the `tauri dev` terminal) **and** the file below |
| release | Info | the file below only — there is no console (`windows_subsystem = "windows"`) |

```
%LOCALAPPDATA%\app.owlette.desktop\logs\owlette-desktop.log
```

That is the plugin's `TargetKind::LogDir`, which resolves to
`{FOLDERID_LocalAppData}\{identifier}\logs` — **per-user**, so it belongs to
whoever the app is running as (the kiosk's auto-login account), not to the
`LocalSystem` service. It is a different tree from
`C:\ProgramData\Owlette\logs\service.log`; a field report wants both, and their
timestamps line up directly because this sink is configured for local time
rather than the plugin's UTC default.

The file rotates at 4 MB and three rotated copies are kept
(`owlette-desktop_<date>.log`), so the ceiling is 16 MB — the plugin's own
default is 40 KB with one file kept, which on a machine that runs for months is
a window of minutes.

## The service seam

The python service and this app share three files under
`%PROGRAMDATA%\Owlette`, and the host reimplements that contract exactly rather
than inventing a new one — both are in the field at once.

| File | Written by | Read for |
| --- | --- | --- |
| `config/config.json` | both | process list, machine settings |
| `tmp/app_states.json` | service | live status per OS pid |
| `tmp/service_status.json` | service | connection + health footer |

Rules the host enforces, all sourced from `agent/src/shared_utils.py`:

- Every read and write takes the named mutex `Global\OwletteJsonFileMutex` with
  a 2 000 ms budget and always releases it, matching `_CrossProcessLock`. On
  timeout it proceeds unlocked and says so in the returned `lock` field.
- **`CreateMutexW` fails here and that is expected — the `OpenMutexW` fallback
  is the real path.** The service creates the object with an explicit security
  descriptor (`shared_utils._JSON_MUTEX_SDDL`) granting Authenticated Users
  exactly `SYNCHRONIZE | MUTEX_MODIFY_STATE`; `CreateMutexW` asks for
  `MUTEX_ALL_ACCESS`, which that descriptor deliberately withholds, so a
  non-elevated process must open it with the two rights it actually needs. The
  python side has the same fallback. Against an agent older than that fix the
  object still carries LocalSystem's default DACL and both calls fail, so the
  guard reports `lock: "unavailable"` and proceeds — atomicity, not the lock, is
  what makes that safe.
- The descriptor is fixed at creation time, so an in-place agent upgrade only
  takes effect once every handle to the old object is closed (stop the service
  *and* the desktop app, or reboot).
- Writes go to a scratch file in the destination directory and are renamed over
  the target, with `indent=4` formatting and **key order preserved** — the
  `firebase` block must survive a desktop write byte-identical.
- Reads retry three times (100/200 ms) on a locked or half-written file and then
  fail. Python returns `{}` there; we do not, because a UI that writes back an
  empty document would erase the operator's config.
- Frontend paths are resolved inside the data root; `..` and outside paths are
  rejected.
- Because the files are replaced atomically, the watchers are registered on
  `config\` and `tmp\`, not on the files, and coalesce each replace burst into
  one `owlette://file-changed` event.
- `service_status.json` older than 120 s means the service is not writing, no
  matter what the SCM reports (`owlette_tray.read_service_status`); the service
  refreshes it on a 30 s throttle, so anything under two minutes is normal.

`src/lib/ipc.ts` is the only place allowed to call `invoke` — one typed function
per command, plus the event subscriptions.

### The two markers this app writes

`tmp/app_states.json` is the service's to write, with two exceptions. Both are
statuses stamped on a pid to describe an exit the service is about to notice
(`owlette_service.py:2598-2630`):

| Marker | Written | Meaning to the service |
| --- | --- | --- |
| `KILLED` | *after* the kill | intended exit — no crash alert, no record |
| `RESTARTING` | *before and after* the kill | intended exit, operator-initiated — no crash alert, plus a `process_restarted` audit event |

The order is not incidental, and both halves of the restart write were paid for
in live testing:

- `KILLED` asserts the process is gone, so writing it before the kill would be a
  lie whenever the kill fails.
- `RESTARTING` asserts only an intent, so it goes in *before*: the service
  polls, and an exit it sees before the marker lands is reported as a crash —
  alert, screenshot and Cortex event — for a restart the operator asked for.
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

1. `hooks/useFileDrop.ts` — Tauri's `onDragDropEvent`. Not the html5 events:
   with `dragDropEnabled` the webview hands drops to the host, so `ondrop` never
   fires, and the host event carries absolute paths rather than a `File`. Row
   reordering is a *pointer* drag in the same window, so this ignores everything
   while `lib/rowDrag.ts` says one is in progress.
2. `lib/dropClassifier.ts` — the rule matrix. `.toe` opens in the newest
   installed TouchDesigner, a folder is a process only if it is a Unity player
   build (`<name>.exe` beside `<name>_Data`), `.py` / `.ps1` get an interpreter,
   `.bat` / `.cmd` go in as the executable themselves. Pure, with the disk
   injected as an `FsProbe`.
3. `lib/dropQueue.ts` + `components/DropConfirm.tsx` — one confirm card per
   classified path, worked from the front of the queue. Nothing is written until
   a card is confirmed, and each confirm is its own write.
4. `lib/owletteConfig.ts` — `addProcess` on a document re-read from disk, so the
   `firebase` block and every key this app has never heard of survive.

Two rules the classifier will not bend:

- **`file_path` only ever holds a real file**, never a command-line argument
  string. The service runs that field through `os.path.abspath()`
  (`owlette_service.py:1902-1910`), which turns `-File C:\x.ps1` into a path
  under the service's working directory. That is a known agent-side bug, not a
  classifier limitation, and it is why a `.ps1` travels as a bare quoted path
  and why `.bat` files are launched directly.
- **A dropped process starts with `launch_mode: 'off'`.** Configuring something
  is not the same as starting it, and its numbers come from
  `NEW_PROCESS_DEFAULTS` so that a dropped entry and one added with the `+`
  button are the same entry.

`lib/fsProbe.ts` is the only file that touches `@tauri-apps/plugin-fs`, which is
capability-scoped to `exists`, `readDir` and `stat` — **metadata only**.
Classification never needs a file's contents; keep it that way and a dropped
file can be misread but never read.

## Design system

Everything visual is ported from `web/` and **must stay a verbatim copy** where
it is marked as one. `src/components/ui/*` and `src/lib/utils.ts` are byte-for-byte
the files in `web/components/ui/` and `web/lib/utils.ts`; the `@` alias in
`vite.config.ts` and `tsconfig.app.json` exists specifically so those files
compile here with their `@/lib/utils` imports untouched. When a primitive changes
in `web/`, re-copy it rather than editing this copy. (`.oxlintrc.json` turns
`react/only-export-components` off for that directory for the same reason — the
`buttonVariants`/`badgeVariants` co-exports are shadcn's shape, not ours to fix.)

Three of the primitives are hand-customised in `web/` and easy to clobber by
re-running `npx shadcn add`:

- `button.tsx` — `.btn-sweep` in the cva base, **no** `hover:bg-*` on any variant
  (the sweep supplies hover), `link` variant uses `.hl-link`, plus the extra
  `icon-sm` / `icon-lg` sizes.
- `input.tsx` — `aria-invalid:ring-[3px]` unconditionally, not only when focused.
- `sonner.tsx` — Owlette toast palette and lucide icon set.

### globals.css

Ported from `web/app/globals.css`. Tailwind 4 is configured **CSS-first**: there
is no `tailwind.config.*` anywhere in this package, the theme lives in the
`@theme inline` block, and `components.json` carries `"config": ""` to say so.

The rules below `@layer components` — `.hl-link`, `.btn-sweep`, `.form-reveal`,
and the native temporal-input `color-scheme` rules — are **deliberately
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
load-bearing — `@theme inline` maps them to `--font-sans`, `--font-heading` and
`--font-mono`, and ported rules reference `var(--font-geist)` directly.

There is no `next/font` here and a desktop app must not fetch fonts at runtime,
so the two variable-weight woff2 files are vendored in `src/assets/fonts/` and
bound to the same variable names via `@font-face` in `globals.css`. They came
from `geist@1.7.2` (`dist/fonts/geist-sans/Geist-Variable.woff2` and
`dist/fonts/geist-mono/GeistMono-Variable.woff2`), SIL Open Font License 1.1 —
see `src/assets/fonts/LICENSE.txt`. To update, install `geist`, copy the two
files across, and delete the dependency again.

## Tests

`npm test` runs a vitest smoke test over the seams of the port: the `@` alias,
`cn()` + `cva()` + `tailwind-merge`, the `button.tsx` customisations, and the
integrity of `globals.css` (unlayered rules present, font variables bound,
stripped blocks still stripped). It is not a component test suite.

`src/globals.css` is opted into `test.css` in `vite.config.ts` — vitest stubs
CSS imports to an empty string by default, which would silently empty the
`?raw` import those assertions read.

## Window

`src-tauri/tauri.conf.json` sets the window to 1280×800 with a 900×600 minimum,
centred, `theme: "Dark"`, and `backgroundColor: "#020B16"` — the sRGB value of
the dark `--background` token (`oklch(0.145 0.03 250)`), so the native window
paints the app's background instead of white before the webview's first frame.
`dragDropEnabled` is on.
