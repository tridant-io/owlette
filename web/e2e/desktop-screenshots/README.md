# Agent docs screenshots (desktop app)

The `agent*.png` files in `web/public/docs-screens/`, captured from the **installed**
owlette desktop app rather than a dev build — so `web/content/docs/agent/*.mdx` shows the
UI that actually ships.

```bash
cd web
npm run screenshots:desktop     # ~50 s, both themes
```

## When to run it

At **release time, after `build_installer_full.bat`** — the step is in
`.claude/skills/build-system/SKILL.md` → "Agent Installer Release". Not at version-bump time: a
bump happens before the build, so there is no release binary to photograph, and
`sync-versions.js` deliberately does nothing but edit version files.

If the release changed the desktop UI, install the freshly built installer on this machine
first (or copy `agent/build/installer_package/app/owlette-desktop.exe` over
`C:\ProgramData\Owlette\app\owlette-desktop.exe`). The pipeline drives the *installed* app;
it does not build one.

`git diff --stat web/public/docs-screens` is the review. No diff is a valid result.

## Themes

Every shot is taken twice, once per Playwright project, against the same window. The
capture opens dark: `snapshotLayout` pins `appearance.theme` to `dark` in the layout file,
because with nothing stored the window follows the os and a machine in light mode would
otherwise photograph the dark set light. The `light` project then switches the live window
the way the app menu does, through the `set_appearance_theme` command, waits for `<html>`
to carry `light`, and writes `agent-*-light.png` beside each dark file.

- **The binary must know the command.** An app built before light mode has no
  `set_appearance_theme`, so the `light` project fails at its first step and says so. The
  `dark` project asks nothing of the binary and still runs. Light desktop shots therefore
  come from the first release build that ships light mode.
- **The tray menu is dark only.** It is a native popup, and Windows draws it in the os
  theme, never the app's, so a light run would photograph the same menu again. The `light`
  project skips it, and `--check` expects no light pair for `agent-right-click.png`.
- `scripts/refresh-docs-screens.mjs` records `"themes": ["dark", "light"]` in
  `captured.json` once a full refresh has taken both. Until then `--check` reports the
  desktop light shots as pending a release build rather than failing; after it, a missing
  one fails.

## Prerequisites

| Requirement | Why |
|---|---|
| An installed, paired owlette agent | The subject is `C:\ProgramData\Owlette\app\owlette-desktop.exe` |
| An interactive desktop session | The tray-menu shot drives the real notification area |
| The owlette tray icon **visible on the taskbar** | UI Automation cannot reach the hidden-icons overflow without opening it; the run fails with a message saying so |
| Playwright's chromium | Already installed for the e2e suite. No browser is launched — it connects to the app's own WebView2 |

No Firebase emulator, no Next.js server, no new dependency.

## How it works

`owlette-desktop.exe` is a Tauri 2 WebView2 shell. Launching it with
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>` turns its webview
into an ordinary CDP endpoint that `chromium.connectOverCDP` drives.

Everything the window shows comes from three files under `%PROGRAMDATA%\Owlette`, and the
app resolves that root from the environment variable — so the capture instance is launched
with `PROGRAMDATA` pointed at a scratch tree full of fixture data (`fixtures.ts`). Nothing
here opens, let alone rewrites, the real `config.json`, and the running service never sees
the demo processes. `COMPUTERNAME` is redirected the same way, which is why the footer and
the tray menu show `STUDIO-01` and not the machine that built the release.

Stubbing `invoke` from inside the page is not an option: `window.__TAURI_INTERNALS__` and
every function on it are non-configurable and non-writable, so an init script cannot wrap
them. Redirecting the root is the seam.

Two things cannot be redirected and are therefore snapshotted and restored by the global
setup/teardown:

- `%APPDATA%\app.owlette.desktop\layout.json` — the window size, read through the Windows
  known-folder API. Pinned to 1060×640 with a 288 px sidebar for the capture, then put back
  byte-for-byte *after* the app exits (it rewrites the file on its way out).
- The tray icon itself. The app is single-instance, so the running tray **is** the app and
  has to be killed — by verified pid, never by image name — before a capture instance can
  take its place. The service re-spawns one within its 30-second cooldown after teardown.
- `C:\ProgramData\Owlette\tmp\tray.pid`, claimed for the capture instance so the service
  stops launching trays at it mid-run (that race costs a retry and leaves a dead icon in
  the notification area). Restored verbatim at teardown.

Two Windows gotchas are worth knowing before touching `capture-tray-menu.ps1`:

- **Do not poll UI Automation tightly while a popup menu is opening.** Looking for the
  menu window every 150 ms stops it appearing at all; a single lookup 1.2 s after the same
  click finds it every time. Wait first, then look, slowly.
- **Do not read the menu off the screen.** `CopyFromScreen` captured the menu ghosted over
  an offset copy of itself in one run of six. `PrintWindow` with `PW_RENDERFULLCONTENT`
  asks the window to draw itself and returned identical bytes every time.

## The shots

| File | What it shows | Referenced by |
|---|---|---|
| `agent.png` | The window: process list, status dots, and the selected process's settings | `agent/configuration.mdx` |
| `agent-empty.png` | An enrolled machine with nothing configured yet, and the drop hint | `agent/configuration.mdx` |
| `agent-menu.png` | The overflow menu, open, on a machine that belongs to a site | `agent/configuration.mdx` |
| `agent-join-site.png` | The join-a-site dialog showing a pairing phrase | `agent/configuration.mdx` |
| `agent-leave-site.png` | The leave-site dialog, confirm phase — before anything is stopped or deleted | `agent/configuration.mdx` *(pending)* |
| `agent-report-issue.png` | The bug-report dialog, empty | `agent/configuration.mdx` *(pending)* |
| `agent-launch-mode.png` | The settings panel for a scheduled process (segmented control + schedule summary) | `agent/configuration.mdx` |
| `agent-schedule-editor.png` | The schedule editor dialog | `agent/configuration.mdx` |
| `agent-how-to-run.png` | The `how to run` section opened: attempts, priority, visibility | `agent/configuration.mdx` *(pending)* |
| `agent-run-controls.png` | The detail header of a process that is not running — restart and kill both greyed out | `agent/process-monitoring.mdx` *(pending)* |
| `agent-process-states.png` | The process list with a running, a stalled and an inactive entry (`paired-stalled`) | `agent/process-monitoring.mdx` *(pending)* |
| `agent-right-click.png` | The native tray right-click menu | `agent/system-tray.mdx` |

*(pending)* = the shot is captured but the page does not reference it yet; the column names
where it belongs.

The pairing phrase is a fixture. The scratch tree carries a stand-in for
`configure_site.py` that speaks the same line protocol with a fixed phrase, so a release
build never burns a real device code.

`how to run` is closed on first launch (`DETAIL_SECTION_DEFAULTS`), so its shot has to open
the section and fold it back: the state is written to the per-user layout file the moment it
is toggled, and every later detail shot would otherwise inherit it.

### Not captured, deliberately

The drop-confirm review card (`DropConfirm`) has no route to it that isn't a real OS drag —
the webview hands drops to the host (`dragDropEnabled`), so CDP's drag primitives reach
nothing, and the only alternative is to have the page ask the backend to broadcast a
`tauri://drag-drop` nobody performed. The card's fields are also derived from the capture
machine's own disk, so even a driven one would not be reproducible. The long version is a
comment in `agent-app.spec.ts`; do not fake it.

## Determinism

Output is byte-identical across runs — all twelve dark files, the native tray menu
included. The light set has not had its first run yet (see Themes).
Nothing in this UI is time-relative, so unlike the landing-page pipeline there is no clock
to pin; what has to be controlled is:

- animation and transition durations, zeroed with an injected stylesheet (the launch-mode
  indicator slides for 200 ms);
- leftover focus and hover from the previous test, cleared before every shot (a focus ring
  on the menu button is a one-pixel diff that reappears every run);
- the schedule fixture, kept to one block so the segmented control's labels do not wrap at
  the capture width;
- the `how to run` disclosure, folded again after its own shot — it is a stored preference,
  not per-shot state, so an open one would carry into every later detail capture.

If a file starts diffing every run, look for a new focus ring, a new transition, or a
fixture that has grown long enough to change how something wraps.
