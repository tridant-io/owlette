# swoop on macOS — Tasks
**Progress**: 15/23 complete

Every task is executed by a fresh agent with no conversation context. Read [plan.md](plan.md) and
[context.md](context.md) first, then only the files your task names. Line numbers were read at `7293e1bb`;
re-locate by symbol if they have drifted. `dev/active/` is gitignored, so search it with plain `grep -rn` and
add files under it with `git add -f`.

**Standing rules for every task**
- Tasks in one wave never touch the same file and never depend on each other. If you need a crate, a seam name
  or a file that is missing, stop and log it here. Do not add it yourself.
- Rust: every cargo command runs with the working directory `agent/swoop` (never `--manifest-path`).
  **Windows commands**: `cargo clippy --all-targets -- -D warnings`, `cargo test --locked`, then both again with
  `--features audio-opus`. **macOS commands** (on the Mac over ssh, or the CI leg):
  `CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo clippy --all-targets --no-default-features --features encode-videotoolbox,audio-opus -- -D warnings`
  and the same flags on `cargo test --locked`. A task that edits a file Windows compiles runs the Windows
  commands; a task that adds macOS code runs the macOS commands; most run both.
- Hardware tests are `#[ignore]`d, with the manual invocation and what it does to the machine in the module doc.
  On the Mac they need the ssh grant from Task 1.2; without it, say so in the log instead of claiming a pass.
- `agent/swoop/Cargo.toml` and `Cargo.lock` are edited only by Task 1.1.
- Never block the agent's 5-second loop. Never raise a prompt without a click. Never log a token, a key, a
  bundle or clipboard content. Never delete recursively or by glob.
- Web: `npx eslint <file>` clean on every file you touch; all UI copy lowercase; `lucide-react` icons only;
  theme tokens only; Firestore only through `web/hooks/`; no new npm packages.
- Do not edit the changelogs. Leave one line for the changelog in this file's Log; whoever closes the wave
  writes the entries.
- Labels: `[agent]` runs on this dev box or on the Mac over ssh; `[human]` needs the owner's clicks, sudo or
  eyes, and the task says exactly what the human does.
- Gates: **M0** in Task 3.1 (owner reads the memo before Wave 4) · **M1** in Task 6.1 · release in Task 7.1.

## Wave 1: foundations

- [x] **Task 1.1: Cargo manifest and CI legs** `[agent]`
  - Files: `agent/swoop/Cargo.toml`, `agent/swoop/Cargo.lock`, `.github/workflows/rust-build.yml`, and under `agent/swoop/src/` only the `#[cfg]` gates the first macOS compile demands
  - Do: In `Cargo.toml`, move `str0m` out of `[dependencies]` into two target tables: `[target.'cfg(windows)'.dependencies]` keeps `str0m = { version = "=0.23.1", default-features = false, features = ["wincrypto-dimpl"] }` with its existing comment, and a new `[target.'cfg(not(windows))'.dependencies]` gets the same version with `features = ["rust-crypto"]`. Give the new line its reason (one pure-Rust backend for macOS and Linux; DTLS is str0m's `dimpl` on both sides; with no provider str0m panics at runtime) and its exit condition (`apple-crypto` if SRTP throughput measures short at gate M1). Add the feature `encode-videotoolbox = []` beside the other `encode-*` features, with a comment that it needs no crate of its own. Add `[target.'cfg(target_os = "macos")'.dependencies]` with exact pins: `objc2 = "=0.6.4"`, `objc2-foundation`, `objc2-core-foundation`, `objc2-core-graphics`, `objc2-core-media`, `objc2-core-video`, `objc2-screen-capture-kit`, `objc2-video-toolbox`, `objc2-app-kit` all `"=0.3.2"`, `block2 = "=0.6.2"`, `dispatch2 = "=0.3.1"`. Keep their default features, so no later task has to edit this file for a missing header. Add `[target.'cfg(unix)'.dependencies] libc = "=0.2.189"` (the version `Cargo.lock` already resolves; it is a direct dependency now because the clock and the interface walk call it). Every pin carries a reason and an exit condition in the file's existing style. Before pinning, run `cargo search <name> --limit 1` for each: the versions above were read on 2026-09-28, and a newer patch release is pinned instead and noted in the log. Keep `[package] version` the first `version = "X.Y.Z"` line in the file (`scripts/sync-versions.js` rewrites only the first match). `build.rs` already returns early off Windows; confirm it and leave it alone. Then make the crate compile and its tests pass on macOS **with the stubs it has today**: add only `#[cfg]` gates, change no behaviour, and list every gate you added in the log. In `rust-build.yml` add a job `swoop-posix` with a matrix over `macos-latest` and `ubuntu-latest`, copying the pins, `permissions`, `concurrency` and `timeout-minutes` shape of the jobs already in the file: toolchain `1.98.1` with clippy, `Swatinem/rust-cache` with the workspace `agent/swoop`, the environment `CMAKE_POLICY_VERSION_MINIMUM: "3.5"`. On macOS run the macOS commands from the standing rules. On ubuntu run `cargo clippy --all-targets --no-default-features -- -D warnings` and `cargo test --locked --no-default-features`, which is the stub. Correct the header comment that says all three crates are Windows-only. Leave the Windows job exactly as it is.
  - Done when: on this box the four Windows commands pass as they did before; `git diff agent/swoop/Cargo.lock` shows additions and no changed version for any crate the Windows build uses; the `swoop-posix` job is green on both legs for a push of the branch; `zizmor` is clean on the workflow (`.github/workflows/zizmor.yml` names the invocation); the log lists the cfg gates added and the versions pinned.
  - Depends on: nothing.

- [x] **Task 1.2: Mac rig prep** `[agent+human]`
  - Files: `dev/active/swoop-macos/spikes/1.2-mac-rig.md` (create)
  - Do: Over ssh (context.md, "The Mac rig"): install cmake without root through `uv tool install cmake`, and confirm `zsh -lc "cmake --version"` finds it on the login PATH. Push the branch to the mirror and check it out on the Mac. Read `~/Library/LaunchAgents/app.owlette.build-dev.plist` and confirm which checkout and which command it builds; if it names another branch or path, write the corrected plist beside it under a new name rather than editing the one the release flow uses. Do not run a signed build yet if Task 1.1 has not landed: record that instead. Write the memo.
  - Human: two decisions, both reversible, both recorded in the memo with the date. (1) Root for the ssh user on the Mac: a file `/etc/sudoers.d/owlette-dev` holding `<user> ALL=(ALL) NOPASSWD: ALL`, created with `sudo visudo -f`. Without it the owner installs every build and runs every root check by hand. (2) Screen Recording and Accessibility for `/usr/libexec/sshd-keygen-wrapper` in System Settings, Privacy & Security (the plus button, then shift-cmd-G to type the path). It lets a process started over ssh capture the screen and post input, which is what every hardware test in Wave 4 needs. It is a real widening of what an ssh login to that laptop can do, and Task 7.1 removes it. Without it the backends are first exercised at gate M1, through the installed product.
  - Done when: the memo records cmake's version and path, the branch head on the Mac, what the build job builds, and the owner's answer to each of the two asks.
  - Depends on: nothing.

## Wave 2: seams, transport, launch, packaging, web

- [x] **Task 2.1: Streamer seams, the capture-thread refactor, `selfcheck`** `[agent]`
  - Files: `agent/swoop/src/platform/mod.rs`, `agent/swoop/src/platform/win.rs`, `agent/swoop/src/platform/macos.rs` (create), `agent/swoop/src/platform/unsupported.rs` (create), `agent/swoop/src/session/mod.rs`, `agent/swoop/src/capture/mod.rs`, `agent/swoop/src/cursor/mod.rs`, `agent/swoop/src/gpu/scale.rs`, `agent/swoop/src/transport/rtc.rs`, `agent/swoop/src/log.rs`, `agent/swoop/src/main.rs`, `agent/swoop/src/lib.rs`
  - Do: Build the seam context.md describes, with **no change to what Windows does**. (1) `cursor/mod.rs`: add the portable `PointerSample` and `PointerSampler` exactly as context.md spells them, and move `OutputGeometry::for_output` out of `mod win32` into the portable part, taking its dpi from `crate::platform::dpi_for_rect`. (2) `capture/mod.rs`: `Duplication` owns its `PointerReader`. `next_frame_with` and `capture_loop` take an observer `&mut dyn FnMut(&PointerSample)`; `step` builds the sample while the frame is held, from the same three reads the session makes today (`session/mod.rs:3625-3645`): `ts_ticks = info.LastMouseUpdateTime`, `position = cursor::pointer_position(info)`, `shape = reader.shape(dup, info)`, with a failed shape read logged as `swoop: cursor shape read: {e}` and carried as `None`. The observer still runs on every acquired frame, including the ones with no picture, and before the frame is released. Update the hardware tests in `capture` and `cursor` that call the old signature. (3) `session/mod.rs`: remove `#[cfg(windows)]` from `pub use host::run` and `mod host`; replace every Win32 and concrete-type import with the names from `crate::platform`; `qpc_now()`'s body becomes `platform::clock::now_ticks()` and `drive()` reads `platform::clock::hz()`; `capture_pass` opens `CaptureSource`, drops its own `PointerReader`, and its observer closure feeds `tracker.on_position` and `tracker.on_shape` from the sample with `clock.us(sample.ts_ticks)`; `input_thread` builds `InputInjector`. Port the two hardware tests `end_to_end_picture` and `pause_closes_the_duplication_and_the_floor_holds_a_still_desktop` to the platform names so they run on both systems; a test that needs Win32 itself gets `#[cfg(windows)]`. (4) `platform/win.rs` re-exports the existing types under the seam names and holds the clock (QPC and QPF, moved from `session/mod.rs` and `transport/rtc.rs`) and `process::prepare` (today's `pin_dll_search_path`). (5) `gpu/scale.rs`: `ScaleError` is part of the seam; if it can move out of the Windows block without carrying a Win32 type, move it, otherwise each platform module exports its own with the same `exit()` and `Display`. (6) `platform/unsupported.rs` and the first `platform/macos.rs` are stubs with the same method names: `enumerate_outputs()` answers an empty list, so `drive()` exits 12 before it dials anything, and `CaptureSource::open` is an error naming the platform. `platform/macos.rs` also carries the display helpers from context.md (CoreGraphics only, no TCC) and `selfcheck`. (7) `transport/rtc.rs`: `qpc_hz()` goes; `PeerConfig::qpc_hz` keeps its name and its doc says ticks per second of `platform::clock`. (8) `log.rs`: the directory is `OWLETTE_DATA_ROOT` joined with `logs/swoop` when that variable is set, else `%PROGRAMDATA%\Owlette\logs\swoop` on Windows, `/Library/Application Support/Owlette/logs/swoop` on macOS, `/var/lib/owlette/logs/swoop` elsewhere, as one pure function over the two environment values with a unit test (the rule in `desktop/src-tauri/src/paths.rs::data_root_from`). (9) `main.rs`: `platform::process::prepare()` is the first call; `session_exit` is one ungated function; the minidump stays Windows-only; a fourth verb `selfcheck`, macOS only, prints the one json line context.md names and exits 0. It calls `CGPreflightScreenCaptureAccess`, and `SCShareableContent` only when that answered true or `--force` was given, so it never raises a prompt on an unattended Mac; then `CGPreflightPostEventAccess`, `AXIsProcessTrusted`, and one UDP datagram of one byte to `224.0.0.251:5353`. No private API. On every other system `selfcheck` is the usage error.
  - Done when: on this box the four Windows commands pass and `git status agent/swoop/testdata` is clean; these hardware tests pass here, with their output pasted in the log (they capture the real desktop and move the real pointer): `cargo test --lib session::host::tests::end_to_end_picture -- --ignored --nocapture`, `cargo test --lib session::host::tests::pause_closes_the_duplication -- --ignored --nocapture`, `cargo test -- --ignored capture`, `cargo test -- --ignored cursor`; `grep -n "cfg(windows)" agent/swoop/src/session/mod.rs` shows no gate on `mod host` or on `pub use host::run`; `grep -rn "windows::" agent/swoop/src` finds nothing outside a `#[cfg(windows)]` item. On the Mac or the CI leg the macOS commands pass, `owlette-swoop version` prints the version, `owlette-swoop selfcheck` prints one json line from a plain ssh shell, and `owlette-swoop run` exits 12 with the platform named in the log when its stdin is `testdata/protocol/bundle/bundle-valid.json` collapsed to one line with `agentVersion` set to the build's own version (as it stands the vector says 3.4.0, which is exit 11 before capture is ever asked for).
  - Depends on: 1.1

- [x] **Task 2.2: Agent POSIX spawn** `[agent]`
  - Files: `agent/src/swoop_spawn.py`, `agent/src/swoop_spawn_posix.py` (create), `agent/src/shared_utils.py`, `agent/src/swoop_manager.py`, `agent/tests/unit/test_swoop_spawn_posix.py` (create), `agent/tests/unit/test_swoop_paths.py`, `agent/tests/unit/test_swoop_manager.py`, `agent/tests/integration/test_swoop_wiring.py`
  - Do: Give the agent a second way to start the streamer that presents the object `SwoopManager` already drives. `shared_utils.py`: `SWOOP_EXE_NAME` is `owlette-swoop.exe` on Windows and `owlette-swoop` elsewhere; `get_swoop_exe_path()` keeps its Windows rule and answers `/Applications/owlette.app/Contents/MacOS/owlette-swoop` on macOS and `/opt/owlette/swoop/owlette-swoop` on Linux, each only when the file exists (the pattern is `_POSIX_PYTHON_PATHS`, `shared_utils.py:1268`); `get_swoop_dir()` is that file's directory off Windows. `swoop_spawn.py`: `verify_install` and `spawn` hand over to `swoop_spawn_posix` when `os.name != 'nt'`; `spawn(exe_path, log_dir=None, *, sid=None)` takes `sid` keyword-only and the Windows arm ignores it; add `REFUSAL_DESKTOP_NOT_RUNNING = 'desktop_not_running'`. `swoop_manager.py`: `_do_ensure` passes `sid=sid`; the side effects (`_enable_side_effects`, `_disable_side_effects`: a firewall rule and the SAS policy) return at once off Windows; on POSIX the worker's start calls `swoop_spawn_posix.sweep_stale()` once. Update the two spawn doubles (`test_swoop_manager.py:103`, `test_swoop_wiring.py:268`) to the new signature and assert the manager passes the sid. `swoop_spawn_posix.py`, following context.md's launch job contract: `verify_install` refuses `not_installed` when the file is absent, `install_unverified` unless the file, `Contents/MacOS`, `Contents` and the bundle are each owned by root and not writable by group or others, and `version_mismatch` through the shared `read_streamer_version`. `spawn`: generate the id; bind and listen on `ipc/swoop/<id>.sock`, `chmod 0660`, `chown` to the gid of the `ipc/swoop` directory itself; submit the `launch` job through `osadapter.run_job` with the log level from the existing `_configured_log_level`; a `desktop_not_running` result is that refusal, any other error is `spawn_failed` carrying the runner's code; accept one connection within 10 s; read the peer's uid (`SO_PEERCRED` on Linux, `LOCAL_PEERCRED` on macOS) and refuse unless it is the console user's; unlink the socket file; pin the process with `psutil.Process(pid)`. `PosixSwoopProcess` has the six members the manager uses. `write_bundle` appends the newline, sends, and wipes the caller's buffer as the Windows one does. `iter_lines` yields decoded lines and remembers the `code` of a line whose `type` is `exiting`. `wait(timeout)` returns `None` while the pinned process runs; once it is gone or a zombie, the remembered code, else the exit file's code polled for up to 2 s, else `EXIT_INTERNAL`. `close` kills only when the pinned process is still that process, closes the socket, and unlinks the socket path and the exit file by their exact paths. `sweep_stale` unlinks entries of `ipc/swoop` whose names end `.sock` or `.exit.json`, one by one, never following a link. Nothing here logs the bundle or anything read from the socket. Tests run with `OWLETTE_DATA_ROOT` at a short temporary path (a socket path is limited to 104 bytes on macOS) and a fake `run_job` that connects from a thread; they are skipped on Windows with a reason. Cover: the bundle arrives whole and the buffer is wiped; a control line round trip; the `exiting` code wins over a missing exit file; the exit-file fallback; gone with neither is 20; a peer of another uid is refused; `desktop_not_running` maps to its refusal; a group-writable executable is refused; the socket file is gone after the accept; `close` does not signal when the create time differs; the sweep removes only the two suffixes.
  - Done when: `agent/.venv/Scripts/python -m pytest agent/tests/` is green on this box with the POSIX tests reported as skips; the new tests run and pass on the CI macos-15 and ubuntu-24.04 legs of `agent-tests.yml`; `grep -n "log" agent/src/swoop_spawn_posix.py` shows no call that carries the bundle, a token or socket data.
  - Depends on: nothing in this wave. The job it emits is context.md's contract, which Task 2.3 implements from the same text.

- [x] **Task 2.3: Desktop launch job and the Accessibility check** `[agent]`
  - Files: `desktop/src-tauri/src/jobrunner.rs`, `desktop/src-tauri/src/tcc.rs`, `desktop/src-tauri/src/commands.rs`, `desktop/src-tauri/src/lib.rs`, `desktop/src-tauri/src/shell_open.rs`, `desktop/src-tauri/Info.plist` (create), `desktop/src/lib/ipc.ts`, `desktop/src/components/PermissionBanner.tsx`, `desktop/src/App.tsx`
  - Do: Implement context.md's launch job contract in `jobrunner.rs`, which refuses `launch` as `unsupported_job` today. `Job` gains `program`, `args`, `socket`, `stderr`, `exit_file` and `env`, all defaulted; `JobResult` gains `pid: Option<u32>`, left out of the json when absent, so the existing capture assertion still holds. The directory the program is resolved in and the uid a socket must belong to are **parameters** of the launch function: production passes the directory of `std::env::current_exe()` and 0, tests pass a temporary directory holding a script named `owlette-swoop` and their own uid. Nothing but the allow-list ever names a program. Use `std::os::unix::net::UnixStream`, two `OwnedFd`s from the one connection for stdin and stdout, `CommandExt::process_group(0)`, the working directory `/`, and **drop the `Command` right after the spawn**: it holds the two descriptors until then, and the daemon's end of file depends on the app holding none. A thread waits on the child and writes the exit file whole, then renames it into place. No new crate. `tcc.rs`: declare `CGPreflightPostEventAccess` and `CGRequestPostEventAccess` beside the two CoreGraphics functions already there; the minute report gains `"accessibility": <bool>` from the preflight; the request is **never** called at launch. `commands.rs` and `lib.rs`: two commands, `accessibility_granted` and `request_accessibility`; the second calls the request and opens `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` (add the pane beside the one in `shell_open.rs:102`). `PermissionBanner.tsx` shows one notice per missing grant. The new copy: "accessibility is off for owlette on this mac: swoop can show this screen but cannot control it. switch it on in system settings." with the button "open system settings", which calls `request_accessibility`. `App.tsx` reads both answers on the same schedule it reads the first. `Info.plist` holds one key, `NSLocalNetworkUsageDescription`: "owlette connects directly to viewers on your network during a swoop session." Tauri merges a `src-tauri/Info.plist` into the bundle's own.
  - Done when: `cargo clippy --all-targets -- -D warnings` and `cargo test --locked` pass in `desktop/src-tauri` on this box (the runner is `cfg(unix)`, so here the proof is that the crate still builds) and on the macOS and ubuntu legs of `rust-build.yml`, where unit tests cover: each refusal in the contract's table; a path that escapes the tree through a symlink; a launch of the test script that echoes 4 KB back over the socket; the app's copy of the connection closed after the spawn, shown by the test's accept side reading end of file the moment the script exits; the exit file's shape and mode. `cd desktop && npm run build` is clean, and the banner renders each of its three states in the desktop frontend's existing test setup, or in `tauri dev` if there is none (say which in the log).
  - Depends on: nothing in this wave.

- [x] **Task 2.4: Web host-aware keyboard** `[agent]`
  - Files: `web/lib/swoop/keymap.ts`, `web/lib/swoop/input.ts`, `web/lib/swoop/specialKeys.ts`, `web/components/swoop/SwoopSpecialKeys.tsx`, `web/app/swoop/[siteId]/[machineId]/page.tsx`, `web/__tests__/lib/swoop/keymap.test.ts`, `web/__tests__/lib/swoop/input.test.ts`, `web/e2e/specs/swoop/mac-host.spec.ts` (create)
  - Do: Today the viewer converts only a mac viewer's cmd into ctrl (`CmdMapping`, `keymap.ts:108-130`), which is right for a Windows host and wrong for a Mac one. Replace it with one function over the host's system, whether the viewer is a mac, and a two-valued mapping `'swap' | 'passthrough'`, and move `input.ts` and both test files onto it, leaving no second spelling behind. The rule: a Windows or Linux host with a mac viewer is today's behaviour (`swap` turns `MetaLeft/Right` into `ControlLeft/Right`, and is the default); **a macOS host with a viewer that is not a mac** turns `ControlLeft/Right` into `MetaLeft/Right` under `swap`, the default, so ctrl+c on a Windows keyboard copies on the Mac; a macOS host with a mac viewer, and a Windows or Linux host with a viewer that is not a mac, pass everything through. The conversion stays in the browser (PROTOCOL.md §5: the host never guesses). `specialKeys.ts`: the list becomes a function of the host's system. Windows keeps today's list. macOS offers `cmd + tab`, `cmd + space` (hint: spotlight), `cmd + q` (hint: quit app), `cmd + ctrl + q` (hint: lock) and `esc`, and has no ctrl + alt + del. Linux is the Windows list without ctrl + alt + del. Chords from this menu are sent as written and never pass through the mapping. `SwoopSpecialKeys.tsx` takes the host's system as a prop and gains one checkbox item above the list, built on the `DropdownMenuCheckboxItem` already in `web/components/ui/dropdown-menu.tsx`: "ctrl acts as cmd" on a Mac host for a viewer that is not a mac, "cmd acts as ctrl" on a Windows or Linux host for a mac viewer, and no item where there is nothing to map. It drives `setCmdMapping`'s successor on the input capture. `page.tsx` reads the machine's `osFamily` through the narrowest existing hook in `web/hooks/` that yields the machine document (`useMachines(siteId)` if nothing narrower does), treats a missing value as `windows`, and passes it down. No Firestore call outside `web/hooks/`. The e2e spec seeds a machine with `osFamily: 'macos'`, opens its swoop page the way the first test in `session.spec.ts` does, opens the keyboard menu and asserts the Mac chords are listed, ctrl + alt + del is not, and the checkbox reads "ctrl acts as cmd" and is checked.
  - Done when: in `web/`, `npx eslint` is clean on every touched file, `npx tsc --noEmit` is clean, `npm test` passes with the mapping table covered for all four host and viewer combinations, and `npm run e2e` passes locally including the new spec (the `/preflight` skill runs all of it).
  - Depends on: nothing in this wave.

- [x] **Task 2.5: Packaging** `[agent]`
  - Files: `agent/build/macos/build.sh`, `desktop/src-tauri/tauri.macos.conf.json`, `desktop/src-tauri/binaries/.gitignore` (create), `.github/workflows/build-installer.yml`, `.github/workflows/rust-build.yml`
  - Do: Put the streamer inside the app bundle, signed by the same pass that signs the app. `tauri.macos.conf.json` gains `"bundle": { "externalBin": ["binaries/owlette-swoop"] }`; Tauri then copies `binaries/owlette-swoop-<target triple>` into `Contents/MacOS/owlette-swoop` and signs it with the app's identity and the hardened runtime. `binaries/.gitignore` ignores everything but itself. `build.sh` gains a section before "the app": build the streamer with `cargo build --release --locked --no-default-features --features encode-videotoolbox,audio-opus` from `agent/swoop` with `CMAKE_POLICY_VERSION_MINIMUM=3.5`, and copy `target/release/owlette-swoop` to `desktop/src-tauri/binaries/owlette-swoop-aarch64-apple-darwin`. After the Tauri build it checks three things and fails the build on any of them: the sidecar exists in the bundle; `owlette-swoop version` prints the version `build.sh` read from `agent/VERSION`; and, when an identity is set, `codesign --verify --strict` passes on the sidecar, with the hardened runtime flag and the app's own team identifier in `codesign -dv`. Say in the script's header that `--skip-app` reuses the last bundle, sidecar included. `build-installer.yml`'s macOS job adds `agent/swoop` to its rust-cache workspaces and sets `CMAKE_POLICY_VERSION_MINIMUM` on the build step. `rust-build.yml`'s `desktop-posix` job, on macOS only and before its clippy step, builds the streamer the same way and stages it under the triple `rustc -vV` reports, because `tauri-build` wants a declared sidecar present at compile time; add `agent/swoop` to that leg's cache. The Windows and Linux builds are not touched.
  - Done when: the signed build job on the Mac ends `BUILD-EXIT=0` and its pkg, expanded with `pkgutil --expand` into a fresh directory, holds `owlette.app/Contents/MacOS/owlette-swoop`; `codesign --verify --strict` passes on the sidecar and on the app; the `desktop-posix` macOS leg is green with the sidecar declared; on this box `cd desktop && npx tauri build --no-bundle` still succeeds.
  - Depends on: nothing in this wave. It packages whatever `agent/swoop` builds: the stub after 1.1, the stub with `selfcheck` after 2.1.

## Wave 3: gate M0 and the POSIX wiring test

- [x] **Task 3.1: Gate M0 — the app's child sees the screen** `[agent+human]`
  - Files: `dev/active/swoop-macos/spikes/3.1-gate-m0.md` (create), `dev/active/swoop-macos/spikes/m0_selfcheck.py` (create)
  - Do: Measure the one assumption the design rests on, with product code, before any backend is written. Build the signed pkg from the branch head through the build job and install it on the Mac (`sudo installer -pkg <pkg> -target /`, or the owner does). Confirm both halves restarted on the new version and that `ipc/tcc.json` holds a fresh `screen_recording: true`. `m0_selfcheck.py` runs as root under the runtime's own interpreter (`/Library/Application Support/Owlette/runtime/python/bin/python3`) with `agent/src` from the runtime on its path; it uses `swoop_spawn_posix`'s own socket and job code with `args: ["selfcheck", "--force"]`, reads one line and prints it beside the launch result. Run it: once as installed; once after the owner has granted Accessibility from the banner's button; once after quitting and reopening the app. As the control, run `owlette-swoop selfcheck --force` from a plain ssh shell and record that too.
  - Human: is at the Mac for the runs, answers any dialog, and reports for each dialog which application it named.
  - Go / no-go: `shareableContent: ok` with `displays` at least 1, from the launch job, is **go**. `denied`, an error, or a dialog naming `owlette-swoop` instead of owlette is **no-go**: write the finding and stop. The fallback is capture inside the app process, which is a re-plan. Do not start Wave 4.
  - Done when: the memo holds the json of every run, every dialog seen and the application it named, which of `postEventPreflight` and `axTrusted` tracked the Accessibility grant, whether the Local Network prompt appeared and for whom, and the word go or no-go; the owner has read it.
  - Depends on: 2.1, 2.2, 2.3, 2.5

- [x] **Task 3.2: POSIX wiring test** `[agent]`
  - Files: `agent/tests/integration/test_swoop_wiring_posix.py` (create), `agent/tests/integration/fake_runner.py` (create), `.github/workflows/agent-tests.yml`
  - Do: The POSIX twin of `test_swoop_wiring.py`, whose head comment states the rule: nothing here mocks the wiring it is testing. `fake_runner.py` plays the desktop app on a thread: it polls `<data_root>/ipc/jobs`, answers a `launch` by connecting to the job's socket and starting `fake_streamer.py` with its stdin and stdout on that connection, writes `result.json` with the pid, closes its own copy, and writes the exit file when the child ends. The test drives the real `SwoopManager` over the real `swoop_spawn` on POSIX. Three things are replaced and named as such in the module doc: the bundle fetch, `verify_install` (the fake streamer is not root's), and whatever `osadapter` reads to decide the desktop app is running. Assert: a request reaches `ready`; `kill` ends it with `exiting` and the manager books code 0 with the reason the line gave; a streamer that dies without `exiting` is booked from the exit file; with the runner stopped the spawn is refused `desktop_not_running` and the manager is idle; a `token` line reaches the streamer; `ConnectionManager` is never touched. In `agent-tests.yml`, rewrite the comment on the swoop entry of the two ignore lists: the Windows wiring test stays out of the POSIX legs, and the POSIX one runs there.
  - Done when: the new test is green on the CI macos-15 and ubuntu-24.04 legs and skipped on Windows with a clear reason; `agent/.venv/Scripts/python -m pytest agent/tests/` is green on this box.
  - Depends on: 2.2

## Wave 4: the macOS backends

Every task here adds files that compile only on macOS, plus `mod` lines in one existing module each. Each ends
with the Windows commands green on this box (nothing Windows compiles changed in behaviour) and the macOS
commands green on the Mac or the CI leg. Do not start this wave before gate M0 says go.

- [x] **Task 4.1: Capture and displays** `[agent]`
  - Files: `agent/swoop/src/capture/sck.rs` (create), `agent/swoop/src/displays/mac.rs` (create), `agent/swoop/src/capture/mod.rs`, `agent/swoop/src/displays/mod.rs`, `agent/swoop/src/displays/enumerate.rs`
  - Do: `displays/mac.rs`: `outputs()` walks `platform::macos::display_ids()` and builds an `OutputInfo` per display: `device_name` is `display-<id>`, `desktop_rect` is `display_pixel_rect(id)` (decision 13: pixels), `rotation` is `Rotation::Identity` because macOS hands the picture out already rotated (no rotated panel on the rig: say in the module doc that this is untested). `entries()` enriches each into a `DisplayEntry` (name, refresh from the current mode with 0 read as 60, dpi as 96 times the scale, primary from `CGDisplayIsMain`), and `displays/enumerate.rs`'s non-Windows `enumerate()` gets a macOS arm that calls it. Selection is one display at a time; the spanned canvas is deferred. `capture/sck.rs`: `ScreenCapture` with the `CaptureSource` methods from context.md and `impl capture::Source`. Open: `SCShareableContent` (its completion handler answers onto a channel, 5 s bound), the `SCDisplay` whose `displayID` matches, a filter for that display excluding no windows, and a configuration with the display's pixel size, pixel format `420v`, the colour space and matrix set to BT.709, `minimumFrameInterval` 1/60, `queueDepth` 4, `capturesAudio` false and `showsCursor` equal to the `cursor_in_frame` argument. A refusal (TCC's -3801) or a display that is not there is an error from `open_with`, which the session turns into exit 12. The output handler runs on a serial dispatch queue: it reads the frame's status from the sample buffer's attachments, passes on only `complete` frames (count the others at debug level and report which arrive on a static desktop), retains the image buffer and sends it with its presentation time, converted to `platform::clock` ticks, into a bounded channel of 2 where the newest wins. `next_frame_with` first calls the sampler and hands its sample to the observer, then waits up to `timeout_ms` for a frame. **The last delivered buffer stays retained until a newer picture or a rebuild**: the session's floor re-sends that handle after an empty poll (`session/mod.rs:3690-3706`). A stream that stops (`stream:didStopWithError:`) or a bumped `RebuildSignal` is rebuilt **inside** the source on the next call: retry every 50 ms for up to 10 s, re-read the display's size, drop the held buffer, set the IDR request, answer `Ok(None)`. Only a rebuild that never comes back is an `Err`, because the session treats any error as exit 12 (`:3658`). `last_rects()` answers the whole frame.
  - Done when: unit tests cover the rect and scale arithmetic and the newest-wins channel; on the Mac `cargo test … -- --ignored capture` captures a frame from each attached display, prints its size and the gap between its timestamp and `clock::now_ticks()` (under 100 ms), holds the same handle across three empty polls, and survives a rebuild forced through the signal.
  - Depends on: 2.1, 3.1

- [x] **Task 4.2: VideoToolbox encoder, pixel transfer and the SPS check** `[agent]`
  - Files: `agent/swoop/src/encode/videotoolbox/mod.rs` (create), `agent/swoop/src/encode/h264_sps.rs` (create), `agent/swoop/src/gpu/vt_transfer.rs` (create), `agent/swoop/src/encode/mod.rs`, `agent/swoop/src/encode/select.rs`, `agent/swoop/src/gpu/mod.rs`, `agent/swoop/src/ipc.rs`
  - Do: Implement `encode::Encoder` over a `VTCompressionSession`, behind `#[cfg(all(target_os = "macos", feature = "encode-videotoolbox"))]`, exposing `probe()` and `create()` at the module root as every backend does. `probe()`: `VTCopyVideoEncoderList` says which codecs exist and whether hardware backs them, and nothing about sizes, so sizes are found by creating a session at each candidate (4096×2304, 4096×4096, 7680×4320, 8192×8192) and keeping the largest that opens; cache the answer for the life of the process. `accepts_bgra_texture` is true in the sense the selector uses it (no convert pass in front: the capture already hands NV12); `concurrent_sessions` is the list's instance limit when it carries one, else 4; the backend name is `videotoolbox`. `create()`: hardware required first, then Apple's software encoder for H.264 when no hardware answers; the source attributes name `420v`; properties `RealTime` true, `AllowFrameReordering` false, `MaxKeyFrameInterval` at its maximum with `ForceKeyFrame` on the frames the session asks an IDR for, `AverageBitRate` with `DataRateLimits` over one frame interval, `ExpectedFrameRate`, `MaxFrameDelayCount` 0, `PrioritizeEncodingSpeedOverQuality` true, profile H.264 Main or HEVC Main at automatic level, and `EnableLowLatencyRateControl` in the encoder specification where the session accepts it (try it for both codecs and record which refuse). `encode()` submits the frame with its capture ticks as the frame's reference value and forces it out with `VTCompressionSessionCompleteFrames`, so the frame's bits return from the call that submitted it; `encoded` ticks are read in the output callback. The output is length-prefixed; convert it to Annex-B and put the parameter sets (VPS, SPS, PPS from the format description) in front of every IRAP. A frame is an IRAP when its sample attachments do not say `NotSync`. `set_bitrate` moves the two rate properties without a new session. `h264_sps.rs` parses an SPS through its VUI (removing emulation prevention) and can rewrite it to carry `bitstream_restriction_flag = 1` with `max_num_reorder_frames = 0` and `max_dec_frame_buffering` equal to the reference count; `agent/swoop/spikes/bakeoff-host/src/nal.rs` has a parser to read first. The encoder checks its first SPS and rewrites every SPS only if the restriction is missing; without it Chrome's decoder holds a full picture buffer (208 ms against 8 ms, the swoop plan's D5). `select.rs`: `CHAIN` becomes a slice per system (Windows as it is, macOS `["videotoolbox"]`, elsewhere `["openh264"]`), `probe_all` and `create` gain the macOS arm, the tests that pin the Windows chain become `#[cfg(windows)]` and a macOS table test is added. `ipc.rs`: the `encoder` field's doc names `videotoolbox`. `gpu/vt_transfer.rs`: `PixelTransfer` with `open`, `target` and `scale` over a `VTPixelTransferSession` and a pixel buffer pool of `420v` IOSurface buffers at the target size; a scaled frame's handle is valid until the next `scale`. `gpu/mod.rs`: the `mod` line, and `Frame::handle`'s doc says what it is on macOS.
  - Done when: table tests over injected caps pass on both systems; on the Mac `cargo test … -- --ignored videotoolbox` (synthetic NV12 buffers, so it needs no grant) encodes 120 frames at 1920×1080 in H.264 and in HEVC, prints p50 and p95 of `encode()`, asserts the first frame is an IRAP carrying its parameter sets, asserts the H.264 SPS it emits carries the restriction, and a transfer test halves a two-tone pattern with the halves on the right sides.
  - Depends on: 2.1, 3.1

- [ ] **Task 4.3: Input injector** `[agent]`
  - Files: `agent/swoop/src/input/mac.rs` (create), `agent/swoop/testdata/keymap-macos.json` (create), `agent/swoop/src/input/mod.rs`
  - Do: The injector receives what the session already resolved: `InputEvent::Key { scancode, extended, down }` in set-1 scancodes, `KeyVirtual`, moves normalised over the captured surface, buttons, and the wheel in `WHEEL_DELTA` units (`input/mod.rs:147-167`). It never sees a browser code. `keymap-macos.json` maps each browser `code` to a macOS virtual keycode (`kVK_*`), with a `note` where the choice needs one; `CgInjector` joins it at construction with the compiled-in `keymap.json` (code to scancode and extended flag) into a table from (scancode, extended) to keycode. `MetaLeft/Right` are the command keys and `AltLeft/Right` the option keys. Dropped, each with one debug line: the extended-42 half of PrintScreen's sequence and PrintScreen itself, and `KeyVirtual` for Pause; no Mac key means either, and F13 to F15 move the brightness on some Macs. Events are made with a HID-state event source and posted at the HID tap. **Every event carries the modifier flags** of the modifiers the injector believes are held, because a synthesised event inherits none. **A move while a button is held is posted as that button's dragged type.** Button presses carry the click count, from the time and distance since the last press of the same button (500 ms, 4 points). Absolute moves: the display is `platform::macos::display_for_pixel_rect(space.rect)`, and the point is that display's point rect scaled by the normalised position. Relative moves post at the current location plus the delta and set the event's integer delta fields. The wheel posts line-unit scroll events, three lines to a notch, carrying fractions over to the next event. At construction read `CGPreflightPostEventAccess()`: when false, log once that accessibility is not granted to the owlette app, then drop every event and count them. `input/mod.rs` gets the `mod` line and the re-export under `cfg`.
  - Done when: a unit test walks every code in `keymap.json` that has a scancode and finds it in `keymap-macos.json` or in a listed exceptions array with a reason; unit tests cover the modifier flags across press, release and release-all, the click count with an injected clock, the wheel's carried fraction and the dragged types; on the Mac `cargo test … -- --ignored input` moves the real pointer to each corner of the main display and types into a text field the human has focused, and the human confirms a double click selects a word, cmd+a selects all, a drag selects text and the wheel scrolls the way a wheel does.
  - Depends on: 2.1, 3.1

- [ ] **Task 4.4: Cursor** `[agent]`
  - Files: `agent/swoop/src/cursor/mac.rs` (create), `agent/swoop/src/cursor/mod.rs`
  - Do: `CursorSampler` implements `PointerSampler` for one captured display. Position: the location of `CGEventCreate(NULL)` is global points; when it lies on the captured display, convert it to that display's pixels inside `desktop_rect` and report it with `CGCursorIsVisible()`; when it lies on another display, report the position invisible. Every sample carries `clock::now_ticks()`. Shape: at most once every 33 ms read `NSCursor.currentSystem`; take the image's bitmap at the display's scale as 32-bit BGRA with straight alpha (un-premultiply if the representation is premultiplied) and the hot spot in pixels; hash the bytes, since the call is likely to answer a new object each time, and only when the hash changes hand back a `ShapeInfo` of kind `Color` with its pitch, so the existing `CursorTracker::on_shape` and `decode` take it unchanged. `shapes_available()` reads the cursor once at construction and answers whether it got an image. Whether the call works from a child that is not an AppKit app, off the main thread, is unverified: when it does not, the wiring in Task 5.1 captures with the cursor in the frame and this sampler reports every position invisible, so the viewer draws nothing of its own (decision 7).
  - Done when: unit tests cover the point-to-pixel conversion on a 2x display with a negative origin, the premultiplied case and the hash gate; on the Mac `cargo test … -- --ignored cursor` prints `shapes_available`, then each shape change while the human moves over a text field and a link, with fewer distinct shapes than samples.
  - Depends on: 2.1, 3.1

- [x] **Task 4.5: Clipboard** `[agent]`
  - Files: `agent/swoop/src/clipboard/mac.rs` (create), `agent/swoop/src/clipboard/mod.rs`, `agent/swoop/src/clipboard/listener.rs`
  - Do: `listener.rs`: the `Listener`'s thread handle is the platform's (`win::Thread` on Windows, `mac::Thread` on macOS, none elsewhere) and `start()` gains the macOS arm; the Windows arm does not change. `mac.rs`: a thread that polls `NSPasteboard.general`'s `changeCount` every 250 ms and applies queued writes. **Reading content is gated** (decision 17): read the pasteboard's access behaviour; only under always-allow does the thread read content on a change; under any other answer it never reads, logs once that the clipboard from this mac is off until owlette is allowed under "paste from other apps" in system settings, and host-to-viewer sync stays off for the session. When it may read: a string as text; PNG as it is; TIFF converted to PNG through `NSBitmapImageRep`; a pasteboard holding file URLs is left alone entirely, as `CF_HDROP` is on Windows; the existing caps and the existing `Echo` apply, keyed by the change count a write produced. Writing never needs the gate: clear the contents, then set the string, or the PNG with a TIFF made from it beside it, the way Windows puts `CF_DIBV5` beside `"PNG"`. `formats.rs`'s DIB code is not used here and is not touched. Nothing logs content.
  - Done when: unit tests cover the gate's three answers and the echo by change count; on the Mac `cargo test … -- --ignored clipboard` (it overwrites the Mac's clipboard; the module doc says so) round-trips text and a PNG through a write, and through a read when the behaviour allows one, and reports the behaviour it found.
  - Depends on: 2.1, 3.1

- [x] **Task 4.6: Audio** `[agent]`
  - Files: `agent/swoop/src/audio/sck.rs` (create), `agent/swoop/src/audio/mod.rs`
  - Do: `audio/mod.rs`'s capture path is Windows-only today (`Stream` holds a `wasapi::Loopback`; the other arm only waits to be stopped, `:351`). Make the device the platform's: `Loopback` is `wasapi::Loopback` on Windows and `sck::Loopback` on macOS, both with `open()` and `drain(&mut Vec<i16>)`, and the endpoint probe is the platform's `render_endpoint_present()`. `Stream`, the frame clock, `broadcast` and the mute path become common to both; every other system keeps the waiting stub. `sck.rs`: a second `SCStream`, separate from the picture's, with `capturesAudio` true, 48 kHz, two channels, `excludesCurrentProcessAudio` true, the smallest video configuration the API accepts and only the audio output added; the handler converts each buffer (float, expected planar: assert the layout it finds) to interleaved 16-bit and pushes it into a bounded queue that `drain` empties. `render_endpoint_present()` asks CoreAudio for the default output device through one `extern "C"` call (`AudioObjectGetPropertyData` on the system object). The feature never creates a device and never moves the default, as on Windows.
  - Done when: the existing audio unit tests pass on both systems; on the Mac `cargo test … --lib -- --ignored audio::live --nocapture` counts packets for one second while something plays, and again on silence, where the frame clock still produces frames.
  - Depends on: 2.1, 3.1

- [x] **Task 4.7: ICE arms** `[agent]`
  - Files: `agent/swoop/src/transport/ice_policy.rs`
  - Do: Two arms are Windows-only for no reason the code needs. `SystemResolver::resolve` on Windows is already plain `to_socket_addrs` (`:236-246`); make that the one body on every system, since macOS resolves `.local` through the same call. `ifwatch` off Windows is a stub that never reports a change (`:598`): give unix a watcher that walks `getifaddrs` every 2 s on its own thread, hashes the set of interface names and addresses, and answers `take_changed()` when the hash moved. The Windows watcher is not touched.
  - Done when: the existing resolver table tests pass on both systems; a unit test over an injected interface list detects an added and a removed address and ignores a reordering; on the Mac an `#[ignore]`d test prints the interface set.
  - Depends on: 2.1

- [x] **Task 4.8: Security review of the macOS trust boundaries** `[agent]`
  - Files: `dev/active/swoop-macos/research/review-2-security.md` (create; **local and uncommitted** until the release that carries its fixes has shipped), and the files its findings fix: `agent/src/swoop_spawn_posix.py`, `desktop/src-tauri/src/jobrunner.rs`, their tests
  - Do: An adversarial review of what Wave 2 built, by a reviewer that did not write it, under the repo's review discipline (`.claude/CLAUDE.md`: severity is a claim that must be substantiated, with an actor, a mechanism and an outcome; a clean review is a valid result). Scope: a member of the POSIX group, or the console user, against the root daemon through the socket, the job file, the exit file and the sweep; a job the app should refuse; the sidecar rule; what `selfcheck` tells whom; the bundle's path from the daemon to the streamer. Read the last ten commits first. Fix what is confirmed, with a failing test first, and record what is accepted and why.
  - Done when: the memo lists each finding with its severity, its evidence by file and line and its outcome, or states that the review is clean; every fix has a test; both suites are green; `git status` shows the memo untracked.
  - Depends on: 2.2, 2.3

- [ ] **Task 4.9: The app notices its Accessibility grant** `[agent+human]` *(added 2026-09-30 from gate M0's finding, on the owner's yes)*
  - Files: `desktop/src-tauri/src/tcc.rs`, `desktop/src-tauri/src/commands.rs`, `desktop/src/App.tsx`, `desktop/src/components/PermissionBanner.tsx`, `desktop/src/components/PermissionBanner.test.tsx`, `agent/swoop/src/main.rs`, `agent/swoop/src/platform/macos.rs`
  - Do: Gate M0 found that inside the app, `CGPreflightPostEventAccess` answers the same for the life of the process: neither a grant nor a revocation reached it over three minute ticks, while a plain command-line process followed the same toggle within two seconds, and every streamer the app launched read the truth (`spikes/3.1-gate-m0.md`, "Found on the way", 1). So the notice stays after the user grants Accessibility until the app restarts, which is wrong. Measure the cheap fix first, on the installed product: make the minute check and the `accessibility_granted` command call the preflight on the app's main thread (dispatch to main and wait) instead of the timer thread; build through the signed build job, install (`sudo installer -pkg … -target /`), have the owner toggle owlette in the Accessibility list, and watch `ipc/tcc.json`. If the report follows within a minute in both directions, that is the fix. If it does not, the app asks a fresh process: `selfcheck` gains `--grants`, which prints only `screenCapturePreflight`, `postEventPreflight` and `axTrusted`, calls neither ScreenCaptureKit nor the network, installs no logger and exits 0; on macOS the minute report and the command run the sidecar beside `current_exe()` with that flag, with a 2 s timeout, and a failed run reports the grant as unknown (`null`), never as false. Either way, while the notice is showing, `App.tsx` re-reads the answer every 5 s so the notice clears without a focus change, and stops once granted. Screen Recording's own report does not change: it is asked once per launch by design. Measure the result the same way, with the owner toggling.
  - Done when: on the Mac, with the app installed from the signed build job, granting owlette Accessibility clears the notice within 10 s with no relaunch and `ipc/tcc.json` reports true at its next tick, and revoking it brings the notice back; `spikes/3.1-gate-m0.md` records which approach worked, with the ticks; desktop clippy and `cargo test --locked` green on this box and on the Mac; vitest green; if `main.rs` or `platform/macos.rs` changed, the four Windows commands and the macOS commands are green and `owlette-swoop selfcheck --grants` from ssh prints exactly the three keys.
  - Human: toggles owlette in the Accessibility list, off then on, when the agent asks, twice at most (once per approach).
  - Depends on: 3.1. Task 5.1 edits `platform/macos.rs` later, so this task changes only the `selfcheck` half of it.

## Wave 5: wiring

- [ ] **Task 5.1: `platform/macos.rs` for real, and probe** `[agent]`
  - Files: `agent/swoop/src/platform/macos.rs`, `agent/swoop/src/probe.rs`
  - Do: Replace the stub's types with the real ones under the seam names (context.md's two tables). `CaptureSource::open(output, signal)` builds a `CursorSampler` for the output and opens `ScreenCapture` with `cursor_in_frame` set to the negation of `shapes_available()`. `DesktopWatcher` never switches: `follow()` answers false and `name()` answers `default`. `InputInjector` is `CgInjector`, `Downscaler` and `ScaleError` are `PixelTransfer`'s, `enumerate_outputs` is `displays::mac::outputs`, `dpi_for_rect` is 96 times the scale of the display the rect belongs to. The display helpers, the clock and `selfcheck` stay as they are. `probe.rs`: on macOS `sources()` is the display names and `adapters()` is one row (description `apple gpu`, vendor `apple`, vendor id `0x106b`, the display count, not software); the encoders already come from `select::probe_all()`. `probe` needs no grant and must not ask for one.
  - Done when: the macOS commands pass; on the Mac, from a plain ssh shell, `owlette-swoop probe` prints the displays and `videotoolbox` and exits 0; under the ssh grant `cargo test … --lib session::host::tests::end_to_end_picture -- --ignored --nocapture` captures, encodes and reports a cursor stream on the Mac; the Windows commands pass on this box.
  - Depends on: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7

- [ ] **Task 5.2: The capability flip** `[agent]`
  - Files: `agent/src/swoop_capability.py`, `agent/tests/unit/test_swoop_capability.py`
  - Do: `streamer_capable()` is still the local Windows-only answer its docstring calls temporary. Make it `osadapter.streamer_capable()`, inside a `try` that answers False on any exception: this runs on the heartbeat path, where an exception would reach `ConnectionManager` as a Firestore error. `swoop_capability_value()` does not change: the binary present AND that answer. On macOS that is a fresh Screen Recording report from the app (`darwin.py:310`); on Linux nothing ships the binary yet, so the value stays 0.
  - Done when: a table test pins Windows true, macOS over the three states of the report (true, false, none), Linux with no binary, and an adapter that raises; the agent suite is green on this box and on the POSIX legs.
  - Depends on: all of Wave 4. The flip is what makes a Mac advertise swoop, so it lands after the backends and after the security review (4.8), never before.

## Wave 6: first picture, docs, bookkeeping

- [ ] **Task 6.1: Gate M1 — the first session on the Mac** `[agent+human]`
  - Files: `dev/active/swoop-macos/spikes/6.1-first-mac-picture.md` (create)
  - Do: Build the signed pkg from the branch head, install it on the Mac, and confirm within a heartbeat of the app's relaunch that the dev API shows the machine with `capabilities.swoop: 1` (a read-only GET with the dev key; `.claude/CLAUDE.md` says how). Then the owner opens a session from the wired Windows box in Chrome. Record, as observed and not as predicted: the picture and the rung the governor settled on; the cursor overlay's shape changes; typing, ctrl+c and ctrl+v from the Windows keyboard under the default mapping; double click, drag, wheel; clipboard text and an image in each direction, and the pasteboard behaviour the log reported; audio and mute; a display switch if a second display is attached; a session held past five and a half minutes (the token refresh); quitting and reopening the app during a session (the session must survive and end clean, booked as code 0); `kill` from the dashboard; the lock screen inside a session (picture, input, both or neither); the stats overlay's capture to display, decode and present figures with n; the Local Network prompt if it appeared. Attach the streamer's log lines for anything that failed.
  - Human: the clicks at the Mac (Accessibility from the banner, Local Network, the pasteboard setting if wanted) and the viewer side on the Windows box.
  - Done when: the memo has a row per item with the observed result, failures named with their log lines, and the owner's word on whether M1 is met.
  - Depends on: 5.1, 5.2

- [ ] **Task 6.2: Docs, changelogs and PROTOCOL.md** `[agent]`
  - Files: `web/content/docs/dashboard/swoop.mdx`, `web/content/docs/agent/installation.mdx`, `agent/swoop/PROTOCOL.md`, `docs/changelog.md`, `web/content/docs/changelog.mdx`, `.claude/skills/build-system.md`
  - Do: `swoop.mdx` gains a macOS section in the page's own lowercase voice: Apple silicon and macOS 15 or later; someone must be logged in (no login window); the grants and where each is asked (screen recording at the app's launch, accessibility from the app's notice, local network at the first session, "paste from other apps" for the clipboard from the mac); the menu bar's capture indicator; the alert macOS repeats after about thirty days without a capture; what works without accessibility. `installation.mdx`'s macOS part names the same grants once. `PROTOCOL.md` §6: beside the Windows paragraph, the POSIX transport (the daemon's unix socket is the streamer's stdin and stdout; the exit file; still nothing sensitive in a file or on a command line); `status.encoder` gains `videotoolbox`; `status.desktop` is `default` on macOS. No golden vector changes. Both changelogs get their `## [Unreleased]` entries for the whole plan, from the lines the tasks left in the log, including the amendment to how the bundle travels. `build-system.md`: the macOS build now compiles the streamer, needs cmake, and checks the sidecar.
  - Done when: the docs site builds (`cd web && npm run build`); all new copy is lowercase apart from the listed exceptions in `.claude/CLAUDE.md`; both changelogs carry the same entries; `grep -n "videotoolbox" agent/swoop/PROTOCOL.md` finds the field.
  - Depends on: 5.1, 5.2

- [ ] **Task 6.3: Parent plans** `[agent]`
  - Files: `dev/active/swoop/tasks.md`, `dev/active/swoop/context.md`, `dev/active/tri-platform-agent/tasks.md`, `dev/active/tri-platform-agent/plan.md`
  - Do: Point the two parent plans here without renumbering anything they reference. swoop Task 9.1: a status line saying it was executed as `dev/active/swoop-macos/` for macOS, with Linux still to come. swoop `context.md`: the verb `selfcheck`, the backend `videotoolbox` and the feature `encode-videotoolbox` added to its names. tri-platform Wave 8: the same pointer and status. tri-platform `plan.md`, under "Amendments recorded after the decisions were written": cross-plan rule C2 amended 2026-09-28: on POSIX the bundle rides a unix socket the daemon listens on, not a `stdin_path` file; the runner's path rule applies to the socket; `desktop_not_running` is a spawn refusal in the agent's log, not an `endReason`.
  - Done when: `grep -rn "swoop-macos" dev/active/swoop dev/active/tri-platform-agent` finds the pointers, and `grep -rn "^<<<<<<<\|^>>>>>>>" dev/active` finds nothing.
  - Depends on: nothing in this wave.

## Wave 7: release

- [ ] **Task 7.1: Release and verification** `[agent+human]`
  - Files: `docs/changelog.md`, `web/content/docs/changelog.mdx`, `/VERSION`, `agent/VERSION`, `web/package.json` and the crate manifests (only through `node scripts/sync-versions.js X.Y.Z`), `dev/active/swoop-macos/spikes/7.1-mac-ga.md` (create)
  - Do: In this order, and nothing out of it (`.claude/skills/build-system.md`, "Agent Installer Release"). `node scripts/check-security-alerts.mjs`: exit 1 stops the release, and nothing is acked on the agent's own judgment. The changelog section `## [X.Y.Z] - YYYY-MM-DD` in both files. The version bump (4.1.0 is proposed; the owner names the number). Commit. Then the tag build in CI, which produces the exe, the notarized pkg and the deb. Upload to dev and set latest only on the owner's word: those are mutating calls. Update the Mac and one Windows machine through `update_owlette` only on the owner's word. Then the proof, in the memo: the Mac reports `capabilities.swoop: 1` on the released pkg; the M1 list run once more against it; **a Windows session on the released build** (picture, cursor, input), because Task 2.1 changed the loop every Windows session runs; an upgrade of the Mac from 4.0.6 that raised no dialog by itself. Remove the ssh daemon's two grants on the Mac if Task 1.2 added them, and say so in the memo. Work on `dev`; never push to `main`.
  - Human: names the version, authorises the upload and the fleet update, runs the two sessions, removes the grants in System Settings.
  - Done when: the memo records each success criterion in plan.md as met or missed with what was observed; dev's latest carries all three installers; the security review's memo may now be committed, and is.
  - Depends on: 6.1, 6.2, 6.3

## Log
### 2026-09-28
- Plan created and approved by the owner. Branch `swoop/macos` cut from `origin/dev` at `e95e111e` (4.0.6) in the
  worktree `Owlette-swoop-mac-wt`. Research ran inline; one adversarial review (Opus) is in
  `research/review-1.md`. Of its 24 edits, 22 are folded in. Two are decided differently: the
  points-against-pixels question is decision 13 rather than an owner ask, and the sid is never validated as a
  file name because it never is one (the daemon generates the id). Of its scope cuts, the pre-spawn version
  check stays, because the shared code path runs it at no cost.
- Two owner asks are open and block nothing in Wave 1's first task: sudo for the ssh user on the Mac, and the
  ssh daemon's TCC grants (Task 1.2). The second was added while the task text was written and was not part of
  the approval.
- Not pushed. Nothing here has been built or run.

**Task 1.1: done.** Code is in `45718a8e`. The branch is pushed, with draft PR #256 against dev.

*Pins.* Every version is as written. `cargo search` on 2026-09-28 found no newer patch release of any of them:
objc2 0.6.4; the eight framework crates 0.3.2; block2 0.6.2; dispatch2 0.3.1. libc's newest 0.2 release is
0.2.189 (the 1.0 alphas are prereleases). str0m 0.24.0 exists and stays out under its pin's exit condition.

*Finding: `rust-crypto` is not pure Rust* (decision 5 says it is).
- str0m-rust-crypto 0.6.0 turns on dimpl's `rcgen` feature.
- In dimpl 0.7.3, `rcgen` also turns on dimpl's `aws-lc-rs` feature, so aws-lc-sys (C) builds on macOS and Linux.
- None of it reaches Windows. The manifest comment says all of this.
- `apple-crypto` is still the named alternate.

*Lock.*
- 95 crates were added, and none of the 151 existing ones changed version or checksum (a script over both locks).
- The crate's own entry was corrected from 4.0.5 to 4.0.6: `sync-versions.js` leaves that drift behind.
- `cargo tree --target x86_64-pc-windows-msvc -e normal,build,dev,features` is identical before and after, both
  with default features (389 lines) and with `audio-opus` (401 lines).
- `build.rs` returns early off Windows. Confirmed and left alone.

*cfg gates added.* All of them remove code that is dead off Windows, and none changes Windows.
- `audio/mod.rs` (`mod live`): `use std::time::Duration` gets `cfg(any(windows, test))`.
- `capture/mod.rs`:
  - `cfg(windows)`: `use std::time::{Duration, Instant}`, `RECOVERY_GRACE`, `REDUPLICATE_RETRY` and
    `REDUPLICATE_DEADLINE`.
  - `cfg(any(windows, test))`: `MOVE_RECT_WORDS`, `DIRTY_RECT_WORDS`, `split_metadata`, `parse_move_rects`,
    `parse_dirty_rects` and `is_retryable_duplicate_error`. Their unit tests are portable and still run on macOS.
- `probe.rs`: `VENDOR_NVIDIA`, `VENDOR_INTEL`, `VENDOR_AMD` and `vendor_name` get `cfg(windows)`.
- `session/mod.rs`:
  - `cfg(any(windows, test))`: `use crate::transport::rtc::OUT_QUEUE_FEATURE_BYTES`,
    `Outbox::{refill, limit_to, take, take_requests}` and `feature_room`.
  - The field `Outbox::refilled_at` gets `cfg_attr(not(windows), allow(dead_code))`, following the precedent at
    `clipboard/listener.rs:89`.
- `main.rs` (`mod crash`): `KEEP_DUMPS` gets `cfg(windows)`.
- **For Task 2.1:** ungating `mod host` makes the `session/` items live on macOS.
  - The `any(windows, test)` gates then fail to compile, so they cannot be missed.
  - The `cfg_attr` on `refilled_at` compiles either way, so it must be removed by hand.

*Windows, on this box.* The four commands were green before the change and after it, with the same counts:
- Default features: 381 passed and 20 ignored, then 1, 1 and 5.
- `audio-opus`: 390 passed and 21 ignored, then 1, 1 and 5.

*macOS, on the Mac.* rustc 1.98.1, with cmake 4.4.3 from Task 1.2.
- The macOS clippy command is clean.
- `cargo test --locked`: 357 passed and 7 ignored in the lib, `dtls_fingerprint` 1 (the DTLS certificate on
  `rust-crypto`), `protocol_vectors` 5.
- The stub flags on the Mac: clippy clean, 350 passed and 6 ignored.

*CI, PR #256 on `45718a8e`.* rust-build run 36514545699 is green on all five jobs.
- `swoop-posix` macOS: 357 passed and 7 ignored, then 1 and 5.
- `swoop-posix` ubuntu: 350 passed and 6 ignored, then 1 and 5.
- The Windows `crates` job and both `desktop-posix` legs are green.

*zizmor.*
- The new job added one `ref-version-mismatch`: checkout's comment said `v6`, but the SHA is `v7.0.1` (tags `v7`
  and `v7.0.1` on actions/checkout).
- Corrected in `swoop-posix` and `desktop-posix`.
- One finding is left: the same comment on the Windows job's own line (`rust-build.yml:66`), which dev already
  carries. The task says to leave that job exactly as it is, so it waits for the owner's call.

*Unrelated red, since cleared.* agent-tests "unit suite on windows-latest" failed once on
`test_osadapter_contract.py::TestBehaviour::test_a_process_the_agent_never_watched_has_no_exit_code[win]` with
`assert 15 is None`.
- The branch changes no Python, and the rerun of that job is green.
- Likely cause, not proven: `osadapter/win.py` keeps exits in a module-level `_exits`, so a pid Windows reuses
  from an earlier test's watched process returns that process's code.

*Changelog line:* "swoop: the streamer crate builds on macOS and Linux (still a stub there), with CI legs for
both; Windows is unchanged."

**Task 1.2: agent half done, not ticked.** The owner's two answers are part of its done-when, and both are open.
The memo is `spikes/1.2-mac-rig.md`.
- cmake 4.4.3 is at `~/.local/bin/cmake` through `uv tool install`, and it is on the login PATH.
- The branch has its own Mac worktree, `~/src/owlette-swoop-mac`, at `45718a8e`.
- The release job builds `dev` in `~/src/owlette`. `app.owlette.build-swoop-mac.plist` was written beside it:
  `RunAtLoad` false, registered, run by kickstart.
- Its first run (`HEAD=45718a8e`) signed everything and produced the pkg, then ended `BUILD-EXIT=69`: the
  `owlette-notary` keychain profile is gone again, as it was for 4.0.5. The owner re-stores it before Task 2.5.
- The owner's two asks are recorded as open.

*Changelog line:* none. Rig prep ships nothing.

### 2026-09-29

**Task 1.2: done.** The owner answered both asks at the laptop, and each was checked over ssh. The memo has the
detail.
- **sudo for the ssh user: yes.** `/etc/sudoers.d/owlette-dev` exists, and `sudo -k; sudo -n true` succeeds.
- **Screen Recording and Accessibility for the ssh daemon's wrapper: yes to both.** A Swift program that reads
  the grants and captures nothing printed `screen_recording=true accessibility=false post_event=false` after
  the first grant and `screen_recording=true accessibility=true post_event=true` after the second.
  Task 7.1 removes both grants.
- **The notary profile is back.** The owner re-stored `owlette-notary`. The branch's build job, re-run on
  `c0971616`, ended `BUILD-EXIT=0`: `status: Accepted`, stapled, and `stapler validate` passes on the pkg.

**Wave 1 is closed.** The wave's changelog entry is under `## [Unreleased]` in both changelogs, from Task
1.1's line.

*Still open, the owner's call:* the `# v6` comment on the Windows job's checkout line (`rust-build.yml:66`).

**Owner's answers, same day.** The `# v6` comment is fixed (`277e0fa6`). Decision 5 keeps `rust-crypto`, with
its wording corrected in plan.md. Wave 2 was started on the owner's go.

### 2026-09-29, Wave 2

Five agents ran in parallel in this worktree, one per task, each with its own worktree on the Mac. A usage limit
stopped all five mid-task; each was resumed with its context and finished. CI is PR #256 on `b91adfae`: 22 checks
green and one red, CodeQL (below).

**Task 2.1: done** (`4d189960`).
- The seam is `platform/{mod,win,macos,unsupported}.rs`. The capture observer takes a `PointerSample`, `mod host`
  is ungated, and the clock, `process::prepare` and the log directory are per OS.
- Task 1.1's gates in `session/mod.rs` are gone, the `cfg_attr` on `Outbox::refilled_at` included. The gates in
  `capture/mod.rs`, `probe.rs` and `main.rs` (`KEEP_DUMPS`) stay: those items are still Windows-only.
- *Windows, on this box.* The four commands are green, run by the agent and again by the orchestrator on the
  committed tree: 382 passed / 20 ignored, and 391 / 21 with `audio-opus`, then 1, 1 and 5. Each lib count is one
  above Wave 1: the new log-directory test. `git status agent/swoop/testdata` is clean.
- *Hardware tests, on this box.*
  - `end_to_end_picture`: `(1920, 1080) -> (1920, 1080) hevc, 270 frames (1 irap, 3922425 bytes), 92 cpos, 27 cshape`.
  - `pause_closes_the_duplication`: `89 frames still, 0 while paused, 362 after the resume`. The desktop was
    busy, so the floor half passed on live frames and did not prove the floor.
  - `--ignored capture`: DISPLAY1 1920x1080 Identity and DISPLAY2 3840x2160 Rotate270, each `observed=2 pointer_news=1`.
  - `--ignored cursor`: `acquired=699 no_pointer_update=656 cpos=42 shape_updates=6 cshape=6 distinct=4`.
  - The first two `end_to_end_picture` runs failed with 0 cpos, and so did the base commit's build: DXGI had
    dropped DISPLAY2 while the pointer sat on it. Both passed once the display was back.
- *macOS, on the Mac.* Clippy clean; 365 passed / 9 ignored, then 1 and 5 (357 / 7 before: the host's 7 unit
  tests now run there, plus the log test, plus 2 ignored hardware tests). `version` prints 4.0.6.
  - `selfcheck` from a plain ssh shell: `{"screenCapturePreflight":true,"shareableContent":"ok","displays":1,
    "postEventPreflight":true,"axTrusted":true,"localNetworkSend":"ok","pid":24852}`. That is the ssh session's
    own grants, not the app's child: gate M0 is still to run.
  - `run` with the valid bundle at the build's version: exit 12, `exiting` line `code 12`, and the log says
    `swoop: capture is not built for macos yet`.
- *CI.* `swoop-posix` is green on macOS and on ubuntu, which is the first build of the `unsupported` selection.
- Deviations:
  - `gpu/scale.rs` is untouched: `ScaleError::D3d` carries a Win32 error, so each platform exports its own.
  - macOS re-exports its stubs from `unsupported.rs` (one `pub use` line for Task 5.1 to replace). The stubs are
    uninhabited types, so they must be replaced, not filled in.
  - `clock::hz()` stays a `Result`, so `drive()`'s error path is unchanged.
  - On Windows `OWLETTE_DATA_ROOT` now moves the streamer's log, and an unset `PROGRAMDATA` falls back to
    `C:\ProgramData` instead of the temp directory. The task asked for that rule.
- *Changelog line:* "swoop: the streamer's session loop runs on per-OS platform seams (Windows unchanged); on
  macOS `run` exits 12 until capture lands, a new `selfcheck` verb reports Screen Recording, Accessibility and
  local-network state without raising a prompt, and the streamer's log follows `OWLETTE_DATA_ROOT`."

**Task 2.2: done** (`1cb87ab9`, and `f44c9e5c` for two test files the Files list missed).
- `swoop_spawn_posix.py` is the daemon's half of the launch job contract. `swoop_spawn.py` hands over off
  Windows, `shared_utils.py` answers the per-OS streamer path, and the manager passes the sid and sweeps once.
- *Plan gap, closed by the orchestrator.* The task's own changes broke 7 tests on the POSIX legs in
  `test_swoop_spawn.py` and `test_swoop_side_effects.py`, which are not in the Files list. The agent stopped and
  left a patch. It pins the existing `on_windows` fixture on four Windows-arm tests and marks three
  `set_enabled` tests Windows-only. Applied as `f44c9e5c`.
- *This box.* `agent/.venv/Scripts/python -m pytest agent/tests/`: 2122 passed, 362 skipped (2117 / 342 before:
  +17 POSIX spawn tests, +2 `TestOffWindows` and +1 exe-name test as skips, +5 path tests that run everywhere).
- *The Mac.* The macos-15 row: 1817 passed, 250 skipped. The new file passed 17 of 17 in five repeat runs.
  - Two `test_osadapter_contract.py::TestDarwin::test_launchd_reports_how_a_session_job_ended` cases fail on
    that rig before any change and were deselected there. They pass on CI. Not investigated.
- *CI.* The macos-15, ubuntu-24.04 and windows legs of agent-tests are green, so the Linux `SO_PEERCRED` arm ran.
- Deviations:
  - The Windows-only gate sits in `_do_side_effects`, the one caller, not inside the two side-effect functions.
  - Beyond the task text, for Task 4.8: `_pin` refuses a pid that is not the console user's; the exit file is
    opened with `O_NOFOLLOW`, must be a regular file and must carry the pinned pid; a runner error code reaches
    the log only when it matches `[a-z_]{1,64}`.
- *Open, for Tasks 3.2 and 4.8:* `osadapter.run_job` waits up to 120 s, not the job's 10 s. A live but wedged
  app holds the manager's worker thread (never the service loop) for that long. A bounded wait is outside this
  task's files.
- *Seen once, not this task's:* `test_swoop_manager.py::TestSessionEnd::test_a_process_is_finished_once_and_a_late_finish_leaves_the_next_alone`
  failed once under load and passed six reruns. It reads `manager._proc` before the spawn has assigned it.
- *Changelog line:* "swoop: the agent can start the streamer on macOS and Linux through the desktop app, over a
  unix socket the bundle rides (it never touches disk); a Mac still advertises no swoop until the capture
  backends land."

**Task 2.3: done** (`33e03ede`).
- `jobrunner.rs` runs the `launch` job to context.md's table. `tcc.rs` reports `accessibility` every minute and
  never asks at launch; `CGRequestPostEventAccess` is reachable only from the `request_accessibility` command.
  The banner shows one notice per missing grant, and `Info.plist` carries `NSLocalNetworkUsageDescription`.
- *This box.* Desktop clippy clean; `cargo test --locked` 119 passed, 1 ignored (the runner is `cfg(unix)`, so
  this proves only that the crate builds); `npm run build` clean; vitest 494 of 494, the banner's states
  included (vitest, not `tauri dev`).
- *The Mac.* Clippy clean and `cargo test --locked` 128 of 128, at `277e0fa6` and again with Task 2.5's
  `externalBin` in the tree and a placeholder sidecar staged. A mutation that leaked the connection made the
  end-of-file test fail at its 10 s timeout, so that test can fail.
- *CI.* `desktop-posix` is green on ubuntu and on macOS.
- Unverified: the banner in a real app, and Tauri merging `Info.plist` into the bundle (Task 3.1's install shows both).
- Deviations:
  - `PermissionBanner.test.tsx` was edited though it is not in the Files list: the component's props changed.
  - One rule beyond the table: an existing stderr path that is not a regular file is `launch_refused`, because
    a fifo would block the open and the runner with it.
  - An unknown app directory is `launch_failed`, never a lookup on PATH.
  - The child inherits the app's environment plus the job's `OWLETTE_SWOOP_LOG`. That is how
    `OWLETTE_DATA_ROOT` is passed on.
- *For Task 4.8, observations:* macOS has no protected hardlinks, and the stderr file's link count is not
  checked. A failed exit-file write can leave `<exit_file>.<app pid>.tmp`, which the daemon's sweep (two
  suffixes only) does not remove.
- *Found on the way:* `desktop/src-tauri/Cargo.lock` recorded the crate at 4.0.5 against a 4.0.6 manifest, so a
  bare `cargo test --locked` failed. CI missed it because its clippy step, which runs without `--locked`,
  rewrites the lock first. Corrected by the orchestrator in `372f0fed`.
- *Changelog line:* "desktop (macOS): the app launches the swoop sidecar for the daemon through a checked
  `launch` job (its own binary only, allow-listed arguments, socket and log paths pinned to the data tree),
  reports its Accessibility grant beside Screen Recording, and shows a notice whose button asks for it; the app
  declares why it uses the local network."

**Task 2.5: done** (`c224da77`).
- The sidecar is declared only in `tauri.macos.conf.json`. `build.sh` builds the streamer first and stages it,
  then fails the build if the sidecar is missing from the bundle, is the wrong version, or (when signed) fails
  `codesign --verify --strict`, lacks the hardened runtime, or carries another team than the app's.
- *Signed build job, on `c224da77`.* `BUILD-EXIT=0`, notarized and stapled, about 6 minutes. The pkg's Bom lists
  `owlette.app/Contents/MacOS/owlette-swoop`. `codesign --verify --strict` passes on the sidecar and on the app.
- **context.md's unverified row is settled: Tauri signs the sidecar with the hardened runtime and the team
  identity.** `codesign -dv` on the shipped sidecar shows `flags=0x10000(runtime)`, the app's own
  `TeamIdentifier`, a Developer ID Application authority and `Identifier=owlette-swoop`. It has no entitlements.
- *The version check fails the build:* with `agent/VERSION` set to 9.9.9, `build.sh --skip-app` ended
  `BUILD-EXIT=1`. The two signed-path failure branches were not exercised.
- *Risk 5, measured:* without the sidecar staged, `cargo check` of the desktop crate on macOS fails with
  "resource path `binaries/owlette-swoop-aarch64-apple-darwin` doesn't exist".
- *CI.* `desktop-posix` on macOS is green with the sidecar built and staged. zizmor adds no finding.
- *This box.* `cd desktop && npx tauri build --no-bundle` succeeds with Tasks 2.3 and 2.5 both in the tree (run
  by the orchestrator).
- Deviation: `build-installer.yml` sets `CMAKE_POLICY_VERSION_MINIMUM` as the task says, but `build.sh` sets it
  on its own cargo call, so the workflow's copy has no effect.
- *For Task 6.2:* `.claude/skills/build-system.md` has no macOS section yet.
- *Changelog line:* "macOS: the pkg carries the swoop streamer inside owlette.app, signed and notarized with the
  app; the build fails if it is missing, the wrong version or not signed by the app's team."

**Task 2.4: done** (`b91adfae`). **Ticked on 2026-09-30 by the owner's decision, on CI's result:** the done-when asks for
a local full e2e pass, and the best local run is 410 of 411 (the detail is under *e2e* below). CI's full suite
passed twice.
- The viewer's mapping is one function, `applyModifierMapping(code, host, viewerIsMac, 'swap' | 'passthrough')`.
  No `CmdMapping` spelling remains. The capture's setter is `setModifierMapping(hostOs, mapping)`: it takes the
  host too, because the capture is attached before the page knows the host.
- `specialKeysFor(hostOs)` replaces the list. The menu's checkbox sits above the "send keys" label.
- The page reads `osFamily` through `useMachines(siteId)`: no hook in `web/hooks/` subscribes to one machine
  document. So the swoop page now holds the site's machines listeners.
- eslint clean on every touched file; `npx tsc --noEmit` clean; `npm test` 6233 passed, 1 skipped (+13), with
  the mapping table covered for all four host and viewer pairs under both mappings.
- *e2e.* The new spec passed in every run.
  - CI, full suite: 411 passed on `b91adfae`, and green again on `bb3109dd`.
  - Local, full suite, while four other agents were building: 404 passed, 7 failed (timeouts in roosts, api-keys
    and sites specs). Those five files alone: 24 passed.
  - Local, full suite again, with one agent still running tests: 408 passed, 3 failed
    (`dashboard/process-duplicate-names`, `dispatch/retry-deployment`, `time-travel/apply-ack-before-deadline`).
    Those three files alone: 7 passed.
  - Local, third attempt, 2026-09-30: no test ran. Playwright timed out waiting 60 s for the web server to start.
  - Local, fourth attempt, on a quiet box (1% CPU load when sampled): 410 passed, 1 failed,
    `time-travel/apply-ack-before-deadline.spec.ts:68`. It is the same failure as in the second run: a 10 s
    click timeout waiting for `display-recall-button` in the display layout panel.
  - So one display spec fails in full runs on this box, passes alone here, and passes in CI's full runs. That
    spec and the display panel are not touched by this branch. The other failures differed between runs.
    Whether that spec also fails in a full local run on dev was not measured.
- Deviations:
  - `web/__tests__/lib/swoop/specialKeys.test.ts` was edited though it is not in the Files list: it imported the
    removed `SPECIAL_KEYS`.
  - The e2e spec relies on the chromium project's `Desktop Chrome` device, whose user agent says Windows, for
    its "viewer that is not a mac" premise.
- *For Task 6.1:* swap converts one way only, as the task says. From a PC under swap, both ctrl and the Windows
  key send cmd, so the Mac's own control key can only be sent with the box unticked. M1 should judge whether
  swap needs to exchange the two.
- *For Task 6.2:* PROTOCOL.md §5 still says only that a mac client maps cmd to `ControlLeft`. The Linux menu
  keeps the Windows labels, as the task says; that is for the Linux plan.
- *Changelog line:* "swoop: from a PC, ctrl now acts as cmd on a Mac (a checkbox in the keyboard menu turns it
  off; a Mac viewing Windows keeps cmd acting as ctrl), and the keyboard menu lists the machine's own shortcuts:
  cmd chords on a Mac, and no ctrl + alt + del on a Mac or on Linux."

**Wave 2's changelog entries** are under `## [Unreleased]` in both changelogs: the groundwork entry extended,
"the macOS app reports its Accessibility grant" and "the swoop keyboard follows the machine you control".

**CodeQL, red on the PR, open by the owner's decision.** Alert 388, `py/overly-permissive-file`, high, at
`swoop_spawn_posix.py`'s `os.chmod(socket_path, SOCKET_MODE)`. The mode is the contract's `0660 root:<ipc group>`:
the app's user reaches the socket through the group, and the daemon then checks the peer's uid. The owner chose
to leave it open for Task 4.8, which reviews exactly this boundary.
- The same alert is why the "no live vulnerability on this branch" check went red one push later: once GitHub
  registered the alert as open, `check-security-alerts.mjs` counted it (`BLOCKED by 1 item(s)`). It is one
  cause with two red checks, and it has no ack entry: the owner chose to leave it open, not to acknowledge it.

### 2026-09-30, Wave 3

**Task 3.2: done** (`bb3109dd`).
- `test_swoop_wiring_posix.py` drives the real `SwoopManager` over the real `swoop_spawn`, `swoop_spawn_posix`
  and `osadapter.run_job`, a real socket and a real child. `fake_runner.py` plays the desktop app on a thread.
  `agent-tests.yml` changed in its comment only: the new file is on neither ignore list.
- *This box.* `agent/.venv/Scripts/python -m pytest agent/tests/`: 2122 passed, 363 skipped. The one new skip is
  the module, with the reason "the POSIX swoop wiring: a unix socket, the job seam and the desktop runner;
  test_swoop_wiring.py is the Windows twin".
- *The Mac.* The macos-15 row: 1823 passed, 250 skipped, with the rig's known launchd cases deselected. The new
  file: five runs in a row and 20 rounds of two concurrent runs, 6 of 6 every time, about 2 s a run.
- *CI, on `bb3109dd`.* The new file ran 6 of 6 on both POSIX legs: macos-15 1827 passed / 250 skipped,
  ubuntu-24.04 1811 passed / 266 skipped. The Windows leg is green.
- *Mutants, on the Mac.* With the runner never writing the exit file, three tests fail (the crash is booked 20
  instead of 137, the kill 20 instead of 0). With a token line sent without its newline, the token test fails.
- Deviations:
  - **Four things are replaced, not three.** The bundle fetch, `verify_install`, what `osadapter` reads to
    decide the app is running (`osadapter.posix._desktop_pid`), and the console user
    (`osadapter.console_user`). The fourth is needed because the daemon admits only a peer running as the
    console user, and a CI runner may have nobody at the console. The module doc names all four.
  - **"Books code 0 with the reason the line gave" is met from the exit file, not the line.**
    `fake_streamer.py`'s `exiting` line carries no `code` and no `reason`, so the kill's code 0 comes from the
    runner's exit file (the mutant shows it), and the booked reason is the kill's own. The rule that the
    `exiting` code comes first is covered only by the unit test
    `test_the_exiting_code_wins_over_a_missing_exit_file`.
  - **"A `token` line reaches the streamer" is shown indirectly.** `fake_streamer.py` reacts only to `kill`. The
    test sends the token, then a kill, and asserts the kill is still answered: the token crossed the socket as
    a whole line of its own. Its content arriving is not proven.
- *Follow-up, not done (outside the Files list):* make `fake_streamer.py` match PROTOCOL.md §6, with `code` and
  `reason` on `exiting` and an answer to a `token` line. Then this test could prove both rules end to end.
- *Seen, not this task's:* `test_swoop_manager.py::TestHostTokenRefresh::test_a_failed_mint_with_no_time_left_is_logged_not_retried_forever`
  failed once under load on this box and passed every rerun. `agent-tests.yml`'s two checkout lines still say
  `# v6` for the `v7.0.1` SHA, the comment Task 1.1 fixed in `rust-build.yml`.
- *Changelog line:* none. Test only.

**Task 3.1 (gate M0): done, verdict go.** Run 2026-09-30 from 08:39 with the owner at the Mac. The memo is
`spikes/3.1-gate-m0.md` (every run's json, the dialogs, the record of who the Local Network prompt was for) and
the script is `spikes/m0_selfcheck.py`. The owner read the verdict and said go for Wave 4.
- The pkg of `b91adfae` installed in 15 s with no dialog; both halves restarted on the new build, the sidecar is
  in the bundle and signed, `Info.plist` carries the local network text, the runtime carries `swoop_spawn_posix.py`.
- Runs 1, 1b, 2 and 3 through the real launch job all answered `shareableContent: ok` with `displays: 1`, and
  the whole path worked: job, pid, peer uid = console uid, exit file with code 0.
- The Accessibility grant flipped `postEventPreflight` and `axTrusted` together, false to true, in the child.
- The Local Network prompt appeared at the first LAN send and the owner allowed it; the system's record names
  `app.owlette.desktop` and nothing names `owlette-swoop`. No dialog named the streamer.
- *Found, a product bug:* the running app does not see its own Accessibility grant until it restarts
  (`CGPreflightPostEventAccess` answers from launch time), so the notice stays. The streamer is unaffected. The
  owner wants it fixed: the fix is a new task below (4.9).
- *Found, a rig hazard:* Spotlight launched an old build-tree copy of owlette.app when the owner reopened the app.
  Six such copies sit under `~/src` on the Mac. Open the app from Applications there. The stray copy was quit by
  pid and the installed app started through its LaunchAgent before run 3.
- Unverified: the exact text of the Local Network dialog; whether the banner's button raised a dialog of its
  own; the reboot case.
- *Changelog line:* none. A measurement.

### 2026-09-30, Wave 4

Two batches of agents in this worktree, one Mac worktree each: 4.1, 4.2, 4.3, 4.9, then 4.4, 4.5, 4.6, 4.7,
4.8. A usage limit stopped the second batch once; each agent was resumed with its context. The combined head
(`448ff19e`) is green on both systems: Windows 394 passed / 20 ignored (403 / 21 with `audio-opus`), then 1, 1,
5; macOS in the entry after the tasks. Every agent ran its Windows commands on a copy of HEAD plus its own
files, because the shared tree held the others' work in progress; the counts here are the combined head's.

**Task 4.1: done** (`5dd3d4df`). `capture/sck.rs` and `displays/mac.rs`.
- Mac hardware test: display-1 at 3420x2214 (the 2880x1864 panel's scaled-mode backing store, which decision 13
  captures), opened in about 230 ms, first picture after 4 calls, one handle held across 3 empty polls, rebuild
  through the signal in 170-265 ms, timestamps 0-3.5 ms behind delivery over 48 pictures. `--ignored displays`:
  one primary display, 192 dpi, 60 Hz.
- *context.md row, frame statuses:* measured on the lock screen only: over 3 s, `complete` 41-45 and `idle` 78-81;
  blank, suspended, started and stopped 0. An unlocked static desktop is unmeasured. *Rotation row:* untested,
  no rotated panel on the rig.
- *Findings:* (1) **an asleep display is listed by neither CoreGraphics nor ScreenCaptureKit**, so a session on
  a sleeping Mac exits 12 with no attached output; a screen that sleeps mid-session probably ends it after the
  10 s rebuild deadline (unverified). The owner decides whether a session wakes the display and holds it awake
  (`IOPMAssertionDeclareUserActivity`, `PreventUserIdleDisplaySleep`): for Task 5.1. (2) **Raw presentation
  times run ahead of delivery** (min -10.7, p50 -1.1, max +10.7 ms; 27 of 47 in the future: vsync times), so
  each stamp is clamped to its delivery. (3) A stop from the menu bar's capture indicator (-3817) is rebuilt like
  any stop, overriding the person at the Mac: the owner decides, for Task 5.1. (4) A resolution change is
  re-read only on a rebuild; whether SCK stops the stream on one is unverified.
- Deviations: the clamp; a Screen Recording preflight before every SCK call so neither an open nor a rebuild can
  prompt; display names are "built-in display" / "external display" (`NSScreen.localizedName` is main-thread
  only); dpi through `platform::dpi_for_rect`.
- *Changelog line:* "swoop: on macOS the streamer can capture a display through ScreenCaptureKit at its native
  pixel size and lists the Mac's displays in pixels; sessions use it once Task 5.1 wires it."

**Task 4.2: done** (`8a01ba79`, and `d0ac65de` for the probe test gate, a one-line patch outside its files).
`encode/videotoolbox/mod.rs`, `encode/h264_sps.rs`, `gpu/vt_transfer.rs`.
- Mac hardware test, 120 frames at 1920x1080: H.264 hardware p50 8.5-9.2 ms / p95 9.3-10.6 ms; HEVC hardware
  p50 9.3-10.5 / p95 9.9-11.2; software H.264 p50 10.7-10.9 / p95 15.6-16.4. IRAPs at frames 0 and 90 (the
  forced one), each with its parameter sets in front. The transfer test halves a two-tone pattern correctly.
- *context.md rows:* `EnableLowLatencyRateControl` refused by no hardware codec at 1080p (low-latency H.264
  tops out at 4096x2160, HEVC at 8192x4320; only software H.264 refuses it). The H.264 SPS carries the
  restriction from hardware (flag 1, reorder 0, `max_dec_frame_buffering` 4), not from software, whose SPS is
  rewritten (buffering 2). Under low latency both hardware encoders refuse `MaxFrameDelayCount` and
  `PrioritizeEncodingSpeedOverQuality`; software also refuses `DataRateLimits`. No session advertises a
  `MaxKeyFrameInterval` maximum; `i32::MAX` is accepted.
- Deviations: opening a session proves no size (H.264 opens at 8192x8192 and fails its first frame), so every
  session encodes one discarded warm-up frame and the probe tries candidates largest first; software H.264 is
  the floor only on a Mac with no H.264 hardware, never a per-size fallback; `DataRateLimits` is optional;
  `h264_sps` compiles everywhere (+7 Windows tests); `max_fps` is 0.
- *For Task 6.1:* keyframes are about 820 KB against 17-19 KB deltas at 20 Mbps on a noisy pattern (about 330
  ms of link per IDR); the probe costs about 0.5 s and up to 100 MB transient at session start; HEVC at
  8192x4320 under `RealTime` dropped every frame after the first at 60 fps; the rewritten-SPS path reaches
  Chrome only from a Mac without H.264 hardware.
- *Changelog line:* "swoop: on macOS the streamer encodes H.264 and HEVC with VideoToolbox (hardware, with
  Apple's software H.264 as the floor on a Mac without H.264 hardware) and scales with a VideoToolbox pixel
  transfer; every H.264 SPS it sends declares zero reordering, rewritten where the encoder leaves it out."

**Task 4.3: code done** (`20a532a5`), **not ticked: the human half is pending.** `input/mac.rs`,
`testdata/keymap-macos.json` (119 codes mapped, 29 exceptions with reasons).
- The keymap walk runs on both systems and catches a missing exception and a duplicate keycode. Unit tests
  cover the modifier flags, click counts, the wheel's fraction, dragged types and the 2x conversion.
- Mac corner run: the pointer reached each corner of the 1710x1107-point main display exactly, a relative move
  past the edge was clamped, shift posted as a key reached the system's modifier state.
- *context.md rows:* a synthesised event from the HID-state source **does** inherit shift (`0x20020002`), so the
  plan's premise was wrong; the injector sets its own flags on every event regardless. Natural scrolling:
  unmeasured until the human run (the rig has it on; a 3-line event reads back as delta 3, 30 pixels).
- Deviations: relative moves are clamped to the captured display (the window server does not clamp a posted
  location); flags are adjusted, not set from scratch (CoreGraphics adds the numeric-pad, fn and caps-lock bits
  an arrow or caps lock carries); clicks and the wheel post at the injector's last posted position; the display
  for absolute moves is looked up once per space; the human half is a separate test behind
  `SWOOP_INPUT_HUMAN=1`, so a plain `--ignored input` never types into a window; horizontal wheel direction is
  unmeasured. Key choices to review at 6.1: Insert to `kVK_Help`, NumLock to keypad clear, IntlBackslash to
  `kVK_ISO_Section`, the old `kVK_Volume*` codes.
- *Pending, the owner at the Mac with a text field focused and a long page open:* the command is in the module
  doc (`SWOOP_INPUT_HUMAN=1 ... -- --ignored --nocapture a_human`): it types a line, double clicks, presses
  cmd+a, drags, scrolls; the owner confirms each.
- *Changelog line:* "swoop on macos: a viewer's keyboard, mouse, double clicks, drags and wheel reach a mac host
  through CoreGraphics; PrintScreen and Pause, which a mac has no key for, are dropped."

**Task 4.4: code done** (`af0a9f57`), **not ticked: the human half is pending.** `cursor/mac.rs`.
- Unit tests (both systems): the 2x conversion at a negative origin, the premultiplied case, the 33 ms and hash
  gate. Mac, at the lock screen: `shapes_available=true`; the arrow is 28x40 points (drawn at 2x as 56x80, hot
  spot (10,10)); a 10 s watch and a 768-move sweep each saw one distinct shape; `sample()` costs p50 15-24 us
  in a debug build, a shape read 0.14 ms in release.
- *context.md row:* `NSCursor.currentSystemCursor` **works from a non-AppKit process off the main thread**
  (macOS 26.6, screen locked), and drawing it through a `CGBitmapContext` works there too. Not measured: the
  app's child (6.1), and a real shape change, because the lock screen never changes the cursor.
- *Finding:* objc2-app-kit marks `currentSystemCursor` deprecated ("will always be nil in a future version of
  macOS") and `CGCursorIsVisible` "no longer supported" (it answered true on every sample). A macOS that answers
  nil falls into decision 7's fallback through `shapes_available`.
- Deviations: the bitmap is drawn at the display's scale into a BGRA `CGBitmapContext` (any representation
  type works) and always un-premultiplied; the display's rects are re-read on the 33 ms cadence; off the
  captured display the position is reported invisible, not clamped; the test has `SWOOP_CURSOR_SWEEP=1` and
  `SWOOP_CURSOR_SECS` knobs.
- *Pending, the owner at the unlocked Mac with a text field and a link visible:* the 30 s watch (the command is
  in the module doc); expected an I-beam and a pointing hand, `distinct` below `samples`.
- *Changelog line:* "swoop: on macOS the streamer reads the pointer's position and the system cursor's shape for
  the viewer's overlay, and says when it cannot, so the pointer can stay in the picture instead."

**Task 4.5: done** (`bead2ee8`). `clipboard/mac.rs`, `listener.rs` (the thread is the platform's; the Windows
code is unchanged).
- Mac hardware test, twice, the clipboard saved and restored around it: behaviour `always allow (Some(2))`;
  text and PNG written and read back; a TIFF arrives as PNG; file URLs are left alone; the listener's own
  writes never come back as updates.
- *context.md row:* settled for an ssh process (the behaviour is reported; reads under always-allow raise
  nothing visible from ssh); the app's child is for 6.1 (read the streamer log's `pasteboard access:` line).
  `accessBehavior` exists in objc2-app-kit 0.3.2. `NSPasteboard.general` works from a non-main thread in a
  non-app process. Setting data after `clearContents` does not move the change count.
- *Product gap, the owner's call:* Apple lists an app under "Paste from Other Apps" only after it has raised
  the paste alert once, and the streamer never does. On a fresh Mac the owner may have no way to switch owlette
  to always-allow, and Mac-to-viewer clipboard would stay off. A click-driven read in the app (a new task)
  would list it.
- Deviations: on macOS 15.0-15.3 the setting does not exist and there is no alert, so the thread reads
  (`None => true` in `may_read`; the task said always-allow only: the owner accepts or vetoes); the echo is
  keyed by the change count's low 32 bits; `Mailbox` is `pub(super)`; with reads off the change count is not
  polled; the over-cap line leaves out the byte count.
- *Changelog line:* "swoop on macOS syncs the clipboard: text and images from the viewer to the mac always, and
  from the mac to the viewer where macos lets owlette read the pasteboard without asking (privacy & security >
  paste from other apps)."

**Task 4.6: done** (`448ff19e`). `audio/sck.rs`; `audio/mod.rs` shares `Stream`, the clock, `broadcast`, the
mute path and `probe` between Windows and macOS. Task 1.1's `Duration` gate is live.
- Windows hardware run: 197 frames in 2 s on a silent desktop (unchanged). Mac: with `afplay` looping, 169
  frames in 2 s at about 107 kbps (85 packets/s over the window because the stream takes 290-450 ms to open,
  then 100/s); on silence 171 frames, about 2 kbps of filler.
- *context.md row settled:* SCK delivers `lpcm 48000 Hz, 2 channels, 32-bit float, planar`. Nothing arrives
  while nothing plays; an app holding an output stream sends zeros. 1x1 is refused (error 1003); 2x2 is the
  smallest picture the API accepts. First samples 12-26 ms after open; at most 40 ms in one drain.
- Deviations: the CoreAudioTypes values are written into `sck.rs` (the defining crate arrives only through
  objc2-core-media); a wrong layout is refused and logged once, never a panic in the handler; the `[wasapi]` doc
  link is plain code; `starts_and_stops_on_any_machine` opens a real SCK stream on a Mac with the grant.
- *For Task 6.1:* audio starts 0.3-0.5 s after the session opens and runs 10-20 ms later than on Windows plus
  up to 40 ms of SCK batching; listen for clicks and drift over the 5.5-minute hold; mute drops the bitrate to
  0; the capture indicator shows while audio is captured.
- *Changelog line:* "swoop (macOS): the streamer captures the Mac's system audio through ScreenCaptureKit into
  the same Opus track and mute as Windows; it never creates or switches an audio device."

**Task 4.7: done** (`d4dbe42b`). `transport/ice_policy.rs`.
- One `to_socket_addrs` resolver everywhere. The unix watcher walks `getifaddrs` every 2 s on `swoop-ifwatch`
  and hashes a sorted set of (name, address) pairs, both families; the Mac's idle set (12 entries, awdl0, llw0
  and utun0-3 included) held one hash over 90 s. Tested on Windows, the Mac, the Mac stub and the kiosk VM
  (364 / 9 there, tests only: clippy is not on the VM's toolchain; a fresh directory `~/t47-swoop-...` was left).
- *For Task 6.1:* a Wi-Fi change to a new subnet triggers the ICE restart, but the session's socket stays bound
  to the first address (`session/mod.rs` around 1889 and 1963), so the viewer recovers only by its 60 s give-up
  and re-dial. Windows has the same design. `.local` resolution on the Mac goes through mDNSResponder under the
  app's Local Network grant: unverified until a same-LAN viewer.
- Stale wording for 5.1 or 6.2: the "win32 {rc}" warn line and two Windows-only docs in `session/mod.rs`.
- *Changelog line:* "swoop on macOS resolves a viewer's `.local` candidates and restarts ICE when the Mac's
  network interfaces change."

**Task 4.8: done, verdict clean.** Memo `research/review-2-security.md`, gitignored and untracked. No code
changed; both suites green on this box (pytest 2122 / 363; desktop cargo 119 / 1); the Mac was not re-run since
nothing changed.
- Eight boundaries verified within the settled model. Three low notes for a later hardening task: the daemon
  checks the peer's uid, not its pid (a console-user process racing a start could receive the host token,
  inside the console-user boundary); a second `_owlette` member can disrupt a session start; a failed exit-file
  write leaves a `.tmp` the sweep does not remove. The stderr hardlink note is accepted (`O_NOFOLLOW`, the
  console user's own inodes, log text).
- *Rulings:* CodeQL 388 is the correct boundary, dismiss as by design (text in the memo); 389 and 390 are
  test-double noise at the production mode 0640, dismiss (no change to `fake_runner.py`); the 120 s `run_job`
  wait is a robustness backlog item (bound the launch wait in `osadapter.posix`), not a finding.
- *For Task 7.1:* its criterion "the security review's findings are fixed or accepted in writing" is met; the
  branch's security check stays red until the owner dismisses 388.
- *Changelog line:* none.

**Task 4.9: code done** (`b6b0d8ea`), **not ticked: the measurement is pending.** Approach 1 (the preflight read on
the app's main thread; the notice re-reads every 5 s while shown) is committed: desktop clippy and tests green
on both boxes, vitest 496 of 496. The signed build of it ended `BUILD-EXIT=69`: **the notary profile vanished
for the third time.** Nothing installed, nothing measured. The owner chooses: install the signed, un-notarized
pkg of `b6b0d8ea`, or re-store the profile and rebuild. Then two toggles at the Mac. A TCC.db read showed
owlette switched off at 11:41:13 and the old app (pid 29737) still reporting true at 12:04: 23 minutes blind.
- *Changelog line, if approach 1 holds:* "macOS: the owlette app notices an accessibility grant or revocation
  while it runs, and its notice clears within seconds of the grant, with no relaunch."

*Wave 4 open items for the owner:* the display-sleep and menu-bar-stop decisions (4.1), the clipboard listing
gap and the pre-15.4 read (4.5), the 4.9 build, the two human runs (4.3, 4.4), and the three CodeQL dismissals
(4.8).
