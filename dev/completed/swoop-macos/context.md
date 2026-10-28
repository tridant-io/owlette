# swoop on macOS — Context
**Last updated**: 2026-09-28

Everything a fresh agent needs that is not in [plan.md](plan.md). Line numbers were read at `7293e1bb`;
re-locate by symbol if they have drifted. `dev/active/` is gitignored: search it with plain `grep -rn`, and
add new files under it with `git add -f`.

## Guardrails that bind every task

- The swoop plan's guardrails hold (`dev/active/swoop/context.md`): never block the agent's 5-second loop,
  never log a token, key or bundle, never modify `firestore.rules`, no new packages beyond the approved ones.
- **No prompt without a click.** Nothing in the daemon, the app's launch path, the streamer or the installer
  may raise a system dialog on its own. Screen Recording's once-per-launch ask in `tcc.rs` is the existing,
  approved exception. Accessibility is asked only from the banner's button.
- **Windows behaviour does not change.** Any task that edits a file Windows compiles ends with the Windows
  clippy and test commands green on this box.
- Rust: run every cargo command with the working directory `agent/swoop` (never `--manifest-path`). macOS
  commands use `--no-default-features --features encode-videotoolbox,audio-opus` and
  `CMAKE_POLICY_VERSION_MINIMUM=3.5`. Windows commands use the default features, and a second pass with
  `--features audio-opus`.
- `agent/swoop/Cargo.toml` and `Cargo.lock` are edited only by Task 1.1. A task that finds a missing crate
  stops and logs it.
- Changelog entries (`docs/changelog.md` and `web/content/docs/changelog.mdx`, under `## [Unreleased]`) are
  written once per wave by whoever closes the wave, from the lines the tasks leave in the log. Tasks do not
  edit the changelogs themselves, so parallel tasks never meet in those two files.
- Deletes: single files by exact path only. Never a recursive delete, never a glob, in code or in a shell.
- The repo is public. `research/review-2-security.md` (Task 4.8) stays local and uncommitted until the release
  that carries its fixes has shipped.

## The seam (Task 2.1 creates it; Wave 4 codes against it; Task 5.1 fills the macOS side)

`agent/swoop/src/platform/mod.rs` re-exports exactly one of `win`, `macos`, `unsupported`, chosen by `cfg`.
Every one of the three exports these names, and `session/mod.rs` uses no other platform name:

| name | what the session does with it | Windows | macOS (after 5.1) |
|---|---|---|---|
| `CaptureSource` | `open(&OutputInfo, RebuildSignal)`, `output()`, `size()`, `last_rects()`, `take_idr_request()`, `request_rebuild()`, `next_frame_with(timeout_ms, &mut dyn FnMut(&PointerSample))`, and `impl capture::Source` | `capture::Duplication` | a wrapper over `capture::sck::ScreenCapture` |
| `DesktopWatcher` | `new()`, `follow() -> bool`, `name()` | `capture::DesktopWatcher` | a watcher that never switches |
| `InputInjector` | `new(PointerSpace)`, `impl input::Injector` | `input::SendInputInjector` | `input::mac::CgInjector` |
| `Downscaler`, `ScaleError` | `open(&Frame, w, h)`, `target()`, `scale(&Frame)`; the error has `exit()` and `Display` | `gpu::scale::Downscaler` | `gpu::vt_transfer::PixelTransfer` |
| `enumerate_outputs()` | `anyhow::Result<Vec<OutputInfo>>` | `capture::enumerate_outputs` | `displays::mac::outputs` |
| `dpi_for_rect(&Rect)` | `u32` | `cursor::dpi_for_rect` | 96 times the display's scale |
| `clock::now_ticks()`, `clock::hz()` | monotonic ticks and their rate | QPC, QPF | nanoseconds from `CLOCK_UPTIME_RAW`, 1e9 |
| `process::prepare()` | first call in `main` | the DLL search path pin | nothing |

Portable types the refactor adds to `cursor/mod.rs`:

```rust
pub struct PointerSample<'a> {
    pub position: Option<PointerPosition>,        // None: this sample carries no pointer news
    pub ts_ticks: i64,                            // platform::clock ticks
    pub shape: Option<(ShapeInfo, &'a [u8])>,     // Some only when the shape changed
}
pub trait PointerSampler: Send {
    fn sample(&mut self) -> PointerSample<'_>;
}
```

macOS display helpers, in `platform/macos.rs` from Task 2.1 on, shared by 4.1, 4.3 and 4.4 so the pixel rule
(decision 13) has one spelling:

```rust
pub fn display_ids() -> Vec<u32>;                              // CGGetActiveDisplayList
pub fn display_scale(id: u32) -> f64;                          // mode pixel width / mode point width
pub fn display_point_rect(id: u32) -> (f64, f64, f64, f64);    // CGDisplayBounds: x, y, w, h
pub fn display_pixel_rect(id: u32) -> Rect;                    // origin * scale, pixel size
pub fn display_for_pixel_rect(rect: &Rect) -> Option<u32>;
```

What Wave 4 creates, by the names Task 5.1 wires:

| module | public surface |
|---|---|
| `capture::sck` | `ScreenCapture::open_with(&OutputInfo, RebuildSignal, Box<dyn PointerSampler>, cursor_in_frame: bool)` plus the `CaptureSource` methods |
| `displays::mac` | `outputs() -> anyhow::Result<Vec<OutputInfo>>`, `entries() -> anyhow::Result<Vec<DisplayEntry>>` |
| `encode::videotoolbox` | `probe() -> BackendCaps`, `create(&EncoderConfig) -> anyhow::Result<Box<dyn Encoder>>` |
| `gpu::vt_transfer` | `PixelTransfer` with `open`, `target`, `scale`; `ScaleError` |
| `input::mac` | `CgInjector::new(PointerSpace)`, `impl Injector` |
| `cursor::mac` | `CursorSampler::new(&OutputInfo)`, `impl PointerSampler`, `shapes_available() -> bool` |
| `clipboard::mac` | the listener thread behind `clipboard::listener::start()` |
| `audio::sck` | `Loopback::open()`, `drain(&mut Vec<i16>)`, `render_endpoint_present() -> bool` |

## The launch job contract (Task 2.2 writes it, Task 2.3 runs it)

Request, written by the daemon as root into `<data_root>/ipc/jobs/<id>.json`, mode 0640, through the existing
`osadapter.run_job`:

```json
{"id":"<32 hex>","type":"launch","trusted":true,"program":"owlette-swoop","args":["run"],
 "socket":"<data_root>/ipc/swoop/<32 hex>.sock",
 "stderr":"<data_root>/logs/swoop/owlette-swoop.err.log",
 "exit_file":"<data_root>/ipc/swoop/<32 hex>.exit.json",
 "env":{"OWLETTE_SWOOP_LOG":"debug"},"timeout_s":10}
```

The `<32 hex>` in the three paths is one id the daemon generates per spawn. It is never the session's sid.

Runner rules, each refusal a typed error in `result.json`:

| rule | error |
|---|---|
| `trusted` is true and the request file's owner is root | `untrusted_job` |
| `program` is in the allow-list `["owlette-swoop"]`; it is resolved as the directory of `current_exe()` joined with the name, never a path from the job | `launch_refused` |
| `args`: at most 4, each from `run`, `probe`, `version`, `selfcheck`, `--force` | `launch_refused` |
| `env`: only `OWLETTE_SWOOP_LOG`, with the value `debug` or `trace`. `OWLETTE_DATA_ROOT` is passed on from the app's own environment when it is set, never from the job | `launch_refused` |
| `socket`: its canonical parent is `<data_root>/ipc/swoop`, it is a socket, its owner is root, it is not world-writable | `socket_rejected` |
| `stderr`: its canonical parent is `<data_root>/logs/swoop` | `launch_refused` |
| `exit_file`: its canonical parent is `<data_root>/ipc/swoop` and the name ends `.exit.json` | `launch_refused` |
| the connect or the spawn fails | `launch_failed` |

Spawn: connect to the socket; the child's stdin and stdout are both that connection; stderr is the named file,
opened for append and created 0640; the child gets its own process group and the working directory `/`. The
app then **closes its own copy of the connection**. The result is `{"pid": n}`.

Exit: a thread in the app waits on the child and writes `exit_file` as `{"pid": n, "code": c}`, whole then
renamed into place, mode 0640. `c` is the exit status, or 128 plus the signal number.

Daemon side: bind and listen before submitting the job; `chmod 0660` and `chown root:<group>` the socket file;
after the result, accept one connection with a bounded wait; check the peer's uid is the console user's;
unlink the socket file; pin the process with `psutil` by pid and create time.

## Names this plan adds

| kind | name |
|---|---|
| streamer verb | `selfcheck` (macOS only; `--force` also calls ScreenCaptureKit when the preflight says no) |
| `selfcheck` output | one json line: `screenCapturePreflight`, `shareableContent` (`ok` \| `denied` \| `skipped` \| `error:<code>`), `displays`, `postEventPreflight`, `axTrusted`, `localNetworkSend` (`ok` \| `error:<errno>`), `pid` |
| cargo feature | `encode-videotoolbox` |
| encoder backend name | `videotoolbox` (in `BackendCaps::backend`, `select::CHAIN`, `status.encoder`, `probe`) |
| job type | `launch` (reserved by the tri-platform plan; the body is this plan's) |
| job errors | `launch_refused`, `socket_rejected`, `launch_failed` (beside the existing `untrusted_job`) |
| spawn refusal | `desktop_not_running` |
| files | `<data_root>/ipc/swoop/<id>.sock`, `<data_root>/ipc/swoop/<id>.exit.json` |
| install path | `/Applications/owlette.app/Contents/MacOS/owlette-swoop` |
| `ipc/tcc.json` key | `accessibility` (bool), beside `screen_recording` and `checked_at` |
| desktop commands | `accessibility_granted`, `request_accessibility` |
| test data | `agent/swoop/testdata/keymap-macos.json` |

## The Mac rig

- The MacBook Air `TEC-MBA`: Apple silicon, macOS 26.6, SDK 15.5, rustc 1.98.1, uv with CPython 3.11, a
  user-local Node 22 at `~/.local/node22/bin`. The ssh address and user are in the session memory
  `reference_mba_access.md`; they are not written here because the repo is public.
- Non-login shells lack the PATH: wrap every remote command in `zsh -lc "…"`.
- The repo is mirrored by push: remote `mba`, working copy `~/src/owlette` on the Mac.
  `git push mba swoop/macos`, then on the Mac `git fetch origin && git checkout swoop/macos && git pull`.
- The signing keychain is locked in ssh sessions. Anything that signs or notarizes runs as a LaunchAgent job
  in the owner's GUI domain: `~/Library/LaunchAgents/app.owlette.build-dev.plist`, log
  `~/src/signed-build-dev.log`, last line `BUILD-EXIT=<code>`. Re-run with `launchctl bootout` then
  `launchctl bootstrap gui/$(id -u) <plist>`.
- The installed product: daemon `system/app.owlette.agent` (root) from
  `/Library/Application Support/Owlette/runtime`, app `gui/<uid>/app.owlette.desktop` from
  `/Applications/owlette.app`. The machine is paired to dev.
- Without the owner's two grants from Task 1.2, nothing over ssh can install a pkg, and no process started
  over ssh can see the screen or post input.
- The yamon delete guard also fires on a recursive-delete phrase inside an ssh command string. Expand and
  build into fresh directory names instead of clearing old ones.

## Key files

### Create
- Streamer: `agent/swoop/src/platform/macos.rs`, `platform/unsupported.rs`, `capture/sck.rs`,
  `displays/mac.rs`, `encode/videotoolbox/mod.rs`, `encode/h264_sps.rs`, `gpu/vt_transfer.rs`, `input/mac.rs`,
  `cursor/mac.rs`, `clipboard/mac.rs`, `audio/sck.rs`, `agent/swoop/testdata/keymap-macos.json`
- Agent: `agent/src/swoop_spawn_posix.py`, `agent/tests/unit/test_swoop_spawn_posix.py`,
  `agent/tests/integration/test_swoop_wiring_posix.py`, `agent/tests/integration/fake_runner.py`
- Desktop: `desktop/src-tauri/Info.plist`, `desktop/src-tauri/binaries/.gitignore`
- Web: `web/e2e/specs/swoop/mac-host.spec.ts`
- Plan: `dev/active/swoop-macos/spikes/1.2-mac-rig.md`, `3.1-gate-m0.md`, `m0_selfcheck.py`,
  `6.1-first-mac-picture.md`, `7.1-mac-ga.md`; `research/review-2-security.md` (local until release)

### Modify — streamer
- `agent/swoop/Cargo.toml`, `Cargo.lock` (1.1 only)
- `agent/swoop/src/platform/mod.rs`, `platform/win.rs`, `session/mod.rs`, `capture/mod.rs`, `cursor/mod.rs`,
  `transport/rtc.rs`, `log.rs`, `main.rs`, `lib.rs`, `gpu/scale.rs` (2.1)
- `displays/mod.rs`, `displays/enumerate.rs`, `encode/mod.rs`, `encode/select.rs`, `gpu/mod.rs`, `ipc.rs`,
  `input/mod.rs`, `clipboard/mod.rs`, `clipboard/listener.rs`, `audio/mod.rs`, `transport/ice_policy.rs`
  (Wave 4, one task each), `probe.rs` (5.1)
- `agent/swoop/PROTOCOL.md` (6.2)

### Modify — agent, desktop, packaging, CI
- `agent/src/swoop_spawn.py`, `swoop_manager.py`, `shared_utils.py` (2.2), `swoop_capability.py` (5.2)
- `agent/tests/unit/test_swoop_paths.py`, `test_swoop_manager.py`, `test_swoop_capability.py`,
  `agent/tests/integration/test_swoop_wiring.py`
- `desktop/src-tauri/src/jobrunner.rs`, `tcc.rs`, `commands.rs`, `lib.rs`, `shell_open.rs`,
  `desktop/src/lib/ipc.ts`, `desktop/src/components/PermissionBanner.tsx`, `desktop/src/App.tsx` (2.3)
- `agent/build/macos/build.sh`, `desktop/src-tauri/tauri.macos.conf.json` (2.5)
- `.github/workflows/rust-build.yml` (1.1, 2.5), `build-installer.yml` (2.5), `agent-tests.yml` (3.2)

### Modify — web and docs
- `web/lib/swoop/keymap.ts`, `input.ts`, `specialKeys.ts`, `web/components/swoop/SwoopSpecialKeys.tsx`,
  `web/app/swoop/[siteId]/[machineId]/page.tsx`, `web/__tests__/lib/swoop/keymap.test.ts`, `input.test.ts` (2.4)
- `web/content/docs/dashboard/swoop.mdx`, `web/content/docs/agent/installation.mdx`, `docs/changelog.md`,
  `web/content/docs/changelog.mdx`, `.claude/skills/build-system.md` (6.2)
- `dev/active/swoop/tasks.md`, `dev/active/swoop/context.md`, `dev/active/tri-platform-agent/tasks.md`,
  `dev/active/tri-platform-agent/plan.md` (6.3)

## Decisions

The seventeen decisions and their reasons are in [plan.md](plan.md). The ones a task is most likely to get
wrong:

1. The session loop changes as little as the seam allows, and nothing about what Windows does (decision 1).
2. The bundle never touches disk and never appears in a job file (decision 2).
3. The runner resolves the program itself. A path in a job is a refusal, not a convenience (decision 3).
4. A clean exit is never booked as a crash: the `exiting` line's code wins (decision 4).
5. Nothing asks for Accessibility or reads the pasteboard's content on its own (guardrail, decision 17).
6. `desktop_rect` is pixels on every OS (decision 13).
7. `capabilities.swoop` stays 0 on a Mac until Task 5.2, whatever is installed (decision 8).

## macOS facts marked unverified

Each is settled by the task named, on hardware, and the result goes in that task's log line.

| fact | settled by |
|---|---|
| a posix_spawn child of the app is credited with the app's Screen Recording grant for ScreenCaptureKit | 3.1 |
| the same for posting events (`CGPreflightPostEventAccess` against `AXIsProcessTrusted`) | 3.1 |
| a child's LAN send raises the Local Network prompt in the app's name | 3.1 |
| which `SCStreamFrameInfo` statuses arrive on a static desktop; only `complete` carries a picture | 4.1 |
| a rotated display is captured already rotated | 4.1 (no rotated panel on the rig: recorded as untested) |
| VideoToolbox's H.264 SPS carries the bitstream restriction | 4.2 |
| `EnableLowLatencyRateControl` is accepted for HEVC | 4.2 |
| a modifier posted as a key event is honoured, with flags set on the events that follow | 4.3 |
| synthetic scroll events ignore the host's natural-scrolling setting | 4.3 |
| `NSCursor.currentSystem` works from a child that is not an AppKit app, off the main thread | 4.4 |
| the pasteboard's access behaviour is reported for the app's child, and a read under always-allow raises nothing | 4.5 |
| SCK delivers 48 kHz stereo float, planar | 4.6 |
| Tauri signs the sidecar with the hardened runtime and the team identity | 2.5 |

## Next steps

1. The owner answers Task 1.2's two asks (sudo for the ssh user; Screen Recording and Accessibility for the
   ssh daemon's wrapper), or chooses the slower loop.
2. Run Wave 1 from the worktree `Owlette-swoop-mac-wt` (`/execute`, or `/next` for one task at a time).
3. Open the pull request for `swoop/macos` against `dev` when Wave 1 is green. Nothing is pushed until the
   owner says so.
