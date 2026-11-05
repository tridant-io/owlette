# Desktop-app tutorial video harness

Films the **installed** owlette desktop app (`C:\ProgramData\Owlette\app\owlette-desktop.exe`)
for the v2 tutorial series. The video sibling of [`../desktop-screenshots`](../desktop-screenshots/README.md),
exactly as [`../videos`](../videos/README.md) is the video sibling of `../screenshots`:
CDP for driving, `../videos/ffmpeg-recorder.ts` for the pixels.

```bash
cd web
npm run videos:desktop                          # every take (~4 min)
npm run videos:desktop -- --grep "episode 9"    # one episode
```

Output: `dev/video-tutorials/footage/desktop/<scene>.mp4`, 60 fps H.264 yuv420p, bt709.

## What this films, and what it does not

The window is a WebView2, so everything inside it has real selectors and the app's own
testids. The tray icon, its menu, and OS file drops are native and stay with
pywinauto/PowerShell. The split, beat by beat:

| Episode / beat | Here (CDP) | Native or other surface |
|---|---|---|
| 9 b01 the amber eye in the tray | — | tray icon, tooltip, the three icon states |
| 9 b02 the tray menu | — | the right-click menu (`capture-tray-menu.ps1`) |
| 9 b03 the window | titlebar → sidebar → detail → footer | "open owlette" from the tray; closing it back to the tray |
| 9 b04 adding a process | the `+` button | dragging a `.toe` from Explorer; the drop overlay + "add process" card |
| 9 b05 the fields | all of it | — |
| 9 b06 schedules, right here | all of it | — |
| 9 b07 reordering, and the row menu | all of it | — |
| 9 b08 the footer, the menu, the cloud | paired footer, hamburger menu, unpaired footer cut | service-stopped footer (native); dashboard split-screen (web) |
| 3 b05 the pairing phrase | all of it | — |
| 3 b06 opening the pairing page | the dialog half | owlette.app/add in a browser (web) |
| 3 b10 if pairing doesn't go through | menu → join site → fresh phrase | start menu → Owlette (native) |
| 16 b07 when you're still stuck | submit issue, end to end | dashboard help menu → /docs (web) |

Three of those are structural, not laziness:

- **The tray is Win32.** No webview driver reaches the notification area.
  `../desktop-screenshots/capture-tray-menu.ps1` already photographs the menu and carries
  the two rules worth preserving verbatim: do **not** poll UI Automation while the popup
  is opening (one lookup ~1.2 s after the click works every time), and use `PrintWindow`
  with `PW_RENDERFULLCONTENT`, never `CopyFromScreen`.
- **An OS drop is a host event.** `useFileDrop` listens to Tauri's `onDragDropEvent`
  because `dragDropEnabled` routes drops past the webview — `ondrop` never fires, and CDP
  has nothing to synthesize.
- **The service state is not redirectable.** `deriveFooterState` reads the real Windows
  SCM through the host, so filming the "start service" footer means actually stopping the
  service on the capture machine. That is an operator's decision, not a fixture's.

Two beats are also deliberately *not* clicked through, because the click leaves the app:
the join dialog's `open owlette.app/add` button (opens a browser) and the hamburger menu's
config / logs / docs items (open Explorer or a browser). Both are glided to and held.

## Prerequisites

| Requirement | Why |
|---|---|
| An installed owlette agent, service running | The subject is the shipped exe, and the footer reads the real SCM |
| **An interactive, unlocked desktop session** | ddagrab is DXGI Desktop Duplication: a locked screen or a disconnected RDP session produces no frames. Over RDP, `tscon` back to the console first |
| `ffmpeg` on PATH | The recorder shells out to it (`C:\ffmpeg\bin` on the dev workstation) |
| A DXGI + NVENC capable GPU, or the fallback | Primary path is ddagrab + h264_nvenc; without it the recorder falls back to gdigrab + libx264 automatically. Pin with `OWLETTE_VIDEO_CAPTURE_PATH=primary\|fallback` |
| Primary display at **100 % scaling**, ≥ 1600×900 work area | ddagrab captures physical pixels; the harness fails loudly on `devicePixelRatio != 1` |
| Playwright's chromium installed | Already there for the e2e suite. No browser is launched — it attaches to the app's own WebView2 |

No Firebase emulator, no Next.js server, no new dependency. This is a capture-session step,
never CI.

## How it works

`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>` turns the app's
webview into an ordinary CDP endpoint that `chromium.connectOverCDP` drives. Everything the
window shows comes from three files under `%PROGRAMDATA%\Owlette`, and the app resolves that
root from the environment — so the capture instance is launched with `PROGRAMDATA` pointed
at a scratch tree of fixtures. Nothing here opens the real `config.json`, and the running
service never sees the demo processes. `COMPUTERNAME` is redirected the same way, which is
why the footer reads `STUDIO-01`.

All of that state machinery is `../desktop-screenshots/harness.ts`, imported rather than
copied — including the rule that the live tray is killed **by verified pid, never by image
name**, and that `tmp/tray.pid` is claimed for the capture instance so the service stops
racing us for the single-instance lock. Two additive parameters were added there for this
harness: `snapshotLayout(window, sidebarWidth)` (the stills geometry is still the default)
and `startDesktop(root, port, args)`.

**One app launch per take, not per suite.** The launch argv is part of the subject: episode
3 films the dialog that `--pair --server prod` opens at startup, which is the handoff the
installer performs (`owlette_installer.iss:841-857`). So `global-setup` only pins the layout
and builds the scratch tree; each scene calls `startTake([...argv])` and `endTake()`.

### Framing

The shipped window is 1060×640, which is a postage stamp at 1080p. This harness pins
`layout.json` larger for the take — **1600×900** by default, `OWLETTE_DESKTOP_VIDEO_SIZE`
overrides — and films exactly the window's client rect at native resolution, rather than
filming a 1920×1080 desktop with the window centred over it.

- It depends on nothing outside the app. The desktop alternative needs a plain wallpaper and
  a hidden taskbar; neither is this harness's to change on an operator's machine, and both
  are baked into the footage if they are wrong.
- The region is **measured**, not assumed: the client rect is read back over CDP after the
  window is placed, so the frame is right whatever the display did.
- 16:9 lands on a 1080p timeline as one uniform 1.2× scale — no crop, no pillarbox — and
  1600×900 is a window size an operator would really use, so the sidebar/detail proportions
  on camera are honest. Shoot native by setting `OWLETTE_DESKTOP_VIDEO_SIZE=1920x1080` on a
  display with the room for it.

`position-window.ps1` does the placing. It has to be native: the app remembers its size but
never its position (`window_state.rs`), and `center: true` centres the *configured* 1060×640
before the stored layout resizes it, so a larger window keeps the small one's top-left and
can hang off the display. CDP's `Browser` domain does not reach a WebView2 host. Nothing is
restored afterwards — window position is not persisted state.

### Determinism

- **The pairing phrase is a fixture.** The scratch tree carries a stand-in for
  `configure_site.py` speaking the same line protocol with a fixed phrase, so a take costs
  no device code and shows `silver-compass-drift` every time. It answers `--report-issue`
  too, so episode 16's success toast lands without posting anything.
- **Nothing on camera is ever authorized or submitted for real**, and no confirm dialog is
  ever confirmed — the restart/kill wording beats film the dialog and cancel.
- **Relative time is pinned as an offset, not an instant.** The app's clock cannot be frozen
  from an attached page, so the running entries are seeded three hours old: every run renders
  "started 3 hours ago", which is the determinism that matters in frame.
- **Animations are left ON**, unlike the stills harness. There is no byte diff to protect
  here, and the 200 ms launch-mode slide and the dialog fades are part of what the episodes
  are teaching.

### Narration budgets

Every `narrate(page, beat, seconds)` dwell is sized from the **rendered** MP3 at
`dev/video-tutorials/voiceover/out/<NN-slug>/ep<NN>-b<NN>.mp3`, measured with

```bash
ffprobe -v error -show_entries format=duration -of csv=p=0 <mp3>
```

and rounded up ~0.5 s. Each scene file's header carries the table: the beat, its measured
length, the budget, this take's share, and where the rest of the beat is filmed. When a
beat is re-voiced, re-measure and re-time — the numbers in those headers are the contract
with the editor, not decoration.

**The `narrate()` dwells inside a beat's block must sum to that beat's declared share**, and
they are the only thing that counts toward it. `highlight()` looks like it holds the frame
but does not: its outline is a page-side `setTimeout` and the call returns as soon as the
cursor has glided there. A block whose dwells fall short of its share hands the editor
narration with no picture under it.

## Files

| File | What it is |
|---|---|
| `harness.ts` | Take lifecycle: launch, attach, frame, record. Imports state machinery from `../desktop-screenshots/harness` and the recorder from `../videos/ffmpeg-recorder` |
| `video-helpers.ts` | `installFakeCursor` / `narrate` / `clickWithCursor` / `highlight` / `dragRowTo`, ported from `../videos/video-helpers.ts` for an attached page |
| `fixtures.ts` | The demo machine, three scenarios, and the `configure_site.py` stub |
| `position-window.ps1` | Sizes and centres the window (see Framing) |
| `global-setup.ts` / `global-teardown.ts` | Pin the layout + scratch tree; restore everything, including after a crashed take |
| `*.video.ts` | One file per episode, `testMatch` in `playwright.desktop-videos.config.ts` |
