# swoop on macOS — Plan
**Created**: 2026-09-28 | **Status**: Active

Executes swoop plan Wave 9 (Task 9.1) and tri-platform plan Wave 8 (decision 23) as one plan. Approved by the
owner 2026-09-28. One adversarial review (Opus) is folded in: [research/review-1.md](research/review-1.md).
Line numbers were read at `7293e1bb`; the branch `swoop/macos` is cut from `origin/dev` at `e95e111e` (4.0.6),
which differs from that only in the clipboard listener — re-locate by symbol.

## Summary

Port the swoop streamer to macOS (Apple silicon, macOS 15+) behind platform seams so a Mac running the agent can
host a session: the root daemon asks the resident desktop app to launch `owlette-swoop` as its own child (which
is what makes macOS credit the app's Screen Recording and Accessibility grants), the streamer captures with
ScreenCaptureKit, encodes with VideoToolbox, injects with CGEvent, syncs the pasteboard and system audio, and
speaks the unchanged wire protocol. Windows behaviour does not change. Linux stays a compiling stub and gets its
own plan later. Budget: about 5,000 lines with tests.

## What the research established

- The streamer (`agent/swoop`, 31k lines) gates Win32 **by backend**: the traits `capture::Source`,
  `encode::Encoder`, `input::Injector` and `session::Feature` are portable, and the non-Windows arms of audio,
  clipboard, displays, probe and ICE are honest stubs. The one big gate is `session/mod.rs`'s `mod host`
  (`#[cfg(windows)]`, about 4,400 lines), and it is Windows-bound in **more than its imports**: the capture
  thread's cursor observer is a closure over `&IDXGIOutputDuplication, &DXGI_OUTDUPL_FRAME_INFO`
  (`capture/mod.rs:761`, `session/mod.rs:3625-3645`), `qpc_now()` calls `QueryPerformanceCounter` in its own body
  (`session/mod.rs:895`), and six construction sites name `Duplication`, `DesktopWatcher`, `RebuildSignal`,
  `PointerReader`, `Downscaler` and `SendInputInjector`, plus `capture::enumerate_outputs`,
  `cursor::OutputGeometry::for_output` and `transport::rtc::qpc_hz`.
- The floor re-sends the **last frame's handle** after an empty poll (`session/mod.rs:3690-3706`), and any `Err`
  from the capture call is exit 12 (`:3658`): the Windows source rebuilds internally on `ACCESS_LOST`
  (`capture/mod.rs:761-779`) and reports it through `take_idr_request`. A Mac source must do the same and keep
  its last buffer alive.
- The injector receives **set-1 scancodes plus the extended flag** (`InputEvent::Key`), `KeyVirtual { vk }` for
  Pause, and the wheel in `WHEEL_DELTA` units (`input/mod.rs:147-167`); browser codes are resolved on the host
  before injection. `OutputInfo.desktop_rect` is treated as pixels everywhere (`DisplayEntry::texture` takes its
  size from the rect).
- Timestamps are `hz`-parameterised (`HostClock::new(hz, anchor, epoch)`), so any monotonic tick source works;
  the wire carries microseconds since `streamerEpoch`.
- The agent's `SwoopManager` drives the streamer through one object (`pid`, `write_bundle`, `write_line`,
  `iter_lines`, `wait`, `close`) behind an injectable `spawn_backend`; the whole Win32 spawn is inside
  `swoop_spawn.py`. The bundle is stdin line 1; `kill` / `token` / `sas_result` control lines follow for the
  life of the process; EOF on stdin means the service is gone (PROTOCOL.md §6). Events are json lines keyed by
  `type`, and `exiting` carries `code` and `reason`. A refusal is an agent log event
  (`swoop_spawn_refused reason=…`); the web's `SwoopSessionEndReason` has no refusal vocabulary.
- The desktop app already has the POSIX job seam (`jobrunner.rs`: `capture`, `notify`; `shell` / `launch`
  refused) and the macOS TCC reporter (`tcc.rs` → `ipc/tcc.json {screen_recording, checked_at}`, asked once per
  launch). The daemon's darwin arm already has `streamer_capable()` = a fresh Screen Recording true, while
  `swoop_capability.streamer_capable()` still answers Windows only.
- The MacBook Air rig: macOS 26.6 arm64, SDK 15.5, rustc 1.98.1, `/Applications/owlette.app` signed with the
  Developer ID and the hardened runtime, its LaunchAgent running, **Screen Recording granted**, the data root
  carrying the mode table (`ipc` 0770 root:_owlette, `logs/swoop` 0770). **No cmake, no brew, no sudo over
  ssh.** Spike 0.2 measured TCC child inheritance only for `/usr/sbin/screencapture`, which carries a private
  entitlement — inheritance for a ScreenCaptureKit call from an ordinary child is **unmeasured** and is this
  plan's first gate.
- str0m 0.23.1 features: `wincrypto-dimpl` (Windows today), `rust-crypto`, `apple-crypto`, `openssl`,
  `aws-lc-rs`; with no provider compiled in, str0m panics at runtime.
- Crates on crates.io, 2026-09-28: objc2 0.6.4; objc2-foundation, -core-foundation, -core-graphics,
  -core-media, -core-video, -screen-capture-kit, -video-toolbox, -app-kit 0.3.2; block2 0.6.2; dispatch2 0.3.1;
  str0m-rust-crypto 0.6.0; libc 0.2.189 is what `Cargo.lock` already resolves.
- Tauri's `bundle.externalBin` copies `binaries/<name>-<triple>` into `Contents/MacOS/<name>` and signs it with
  the app's identity and hardened runtime; declared only in `tauri.macos.conf.json` it never touches the
  Windows or Linux builds. `tauri-build` wants the file present at compile time, so a macOS `cargo test` of the
  desktop crate needs it staged.

## Approach

```
python daemon (root, launchd)  --launch job: ipc/jobs/<id>.json (trusted, root-owned)-->  owlette.app (LaunchAgent, console user)
        |                                                                                    | posix_spawn: Contents/MacOS/owlette-swoop run
        | unix socket  ipc/swoop/<id>.sock  (0660 root:_owlette, one connection, peer uid checked)    v
        +<============== the streamer's stdin AND stdout are that socket ==============>  owlette-swoop  (child of the app: the app's TCC identity)
          line 1 = bundle, then control lines in; json event lines out                      stderr -> logs/swoop/owlette-swoop.err.log
                                                                                              exit   -> ipc/swoop/<id>.exit.json (written by the app; fallback only)
```

Host pipeline on macOS: ScreenCaptureKit (one `SCStream` per selected display, NV12 IOSurface at native pixel
size, no cursor) → VTPixelTransferSession only when the rung asks for a downscale → VideoToolbox (HEVC or H.264
hardware; Apple's software H.264 as the floor) → the existing framing, pacer, governor and per-viewer sender,
unchanged → browser. Cursor as today's overlay (`cpos` / `cshape`) from CoreGraphics and
`NSCursor.currentSystem`. Input through CGEvent. Clipboard through NSPasteboard. Audio through a second
SCStream's audio output into the existing Opus path.

### Integration points

| piece | today | this plan |
|---|---|---|
| `agent/swoop/src/platform/` | `win.rs` (DLL search path) | `win.rs`, `macos.rs`, `unsupported.rs` exporting **one set of names**, chosen by `cfg` (context.md, "the seam") |
| `capture/mod.rs` observer | `FnMut(&IDXGIOutputDuplication, &DXGI_OUTDUPL_FRAME_INFO)` | `FnMut(&PointerSample)`: a portable sample the Windows source builds from the frame info and its own `PointerReader` |
| `session/mod.rs` `mod host` | `#[cfg(windows)]`, Win32 imports, `qpc_now` | ungated; imports `crate::platform::*`; the observer reads the sample; the clock is `platform::clock` |
| `encode/` | nvenc (plus stubs) | `encode-videotoolbox` feature, `videotoolbox/mod.rs`, `select::CHAIN` per OS |
| `transport/rtc.rs` `qpc_hz` | `QueryPerformanceFrequency` | `platform::clock::hz` |
| `log.rs` | `%PROGRAMDATA%` | per-OS data root plus `OWLETTE_DATA_ROOT` (the rule `osadapter` and `paths.rs` follow) |
| `agent/src/swoop_spawn.py` | Win32 pipes and a job object | dispatch by OS; `swoop_spawn_posix.py` = socket, launch job, identity-checked kill |
| `agent/src/swoop_capability.py` | local `streamer_capable()` (Windows only) | `osadapter.streamer_capable()`, flipped in Wave 5 once the backends exist |
| `agent/src/shared_utils.py` | `{app}\swoop\owlette-swoop.exe` | per OS: macOS `/Applications/owlette.app/Contents/MacOS/owlette-swoop` |
| `desktop/src-tauri/src/jobrunner.rs` | `launch` refused | the `launch` job: own sidecar only, socket in, stderr file, exit file |
| `desktop/src-tauri/src/tcc.rs` | Screen Recording, asked once per launch | plus Accessibility **checked** every minute, never asked at launch; the ask is the banner's button |
| `desktop/src/components/PermissionBanner.tsx` | one grant | both grants, each with its settings pane |
| `agent/build/macos/build.sh` | app and runtime | builds the streamer first and stages the sidecar; Tauri signs it |
| `.github/workflows/rust-build.yml` | swoop on Windows only | a macOS leg for swoop, an ubuntu check of the stub, the sidecar staged for the desktop macOS leg |
| `web/lib/swoop/keymap.ts` | a mac *viewer's* cmd → ctrl | host-aware: a mac **host** gets ctrl → cmd from a non-mac viewer; special keys per host OS |
| docs | "an agent that ships the streamer" | the macOS requirements, grants and limits; PROTOCOL.md §6 names the POSIX transport |

## Decisions

1. **Static seams by `cfg`, not trait objects.** Each platform module exports the same names; the session loop
   keeps its shape and the Windows types keep their code. No dynamic dispatch on the frame path. The one real
   refactor is the cursor observer (a portable `PointerSample`) and the clock, proved by the Windows suite plus
   the capture, cursor and session hardware tests run on this box.
2. **The bundle rides a unix socket, not a file (cross-plan rule C2 amended).** C2's `stdin_path` file predates
   the `token` / `token_needed` refresh and the sid-aware `kill` the pipe protocol now carries; a one-shot file
   cannot carry them. A socket is what the Windows pipes are: the streamer reads stdin and writes stdout
   unchanged, the bundle never touches disk, daemon death is EOF (§6). The runner still applies C2's path rule,
   now to the socket. `desktop_not_running` is a spawn refusal reason, logged the way `no_console_session` is.
3. **The runner launches only its own sidecar.** `launch` names a program from an allow-list resolved next to
   `current_exe()`, never a path; arguments and environment are allow-lists; trusted only for a root-owned
   request. A TCC-privileged parent must not become a general launcher.
4. **Exit codes come from the `exiting` line first.** `wait()` returns the code of the `exiting` event it
   relayed, else the app-written exit file (absent after an app restart), else `internal_error` once the
   process is gone. `close()` signals only an identity-confirmed process (`psutil`, pinned by create time),
   never a bare pid. The app drops its own copy of the socket after the spawn so the daemon sees EOF.
5. **Crypto off Windows is str0m `rust-crypto`.** One backend for macOS and, later, Linux; DTLS is str0m's
   `dimpl` either way. `apple-crypto` is the measured alternate if SRTP throughput disappoints. *Corrected
   2026-09-29 (Task 1.1):* it is not pure Rust. str0m-rust-crypto turns on dimpl's `rcgen` feature, which in
   dimpl 0.7.3 also turns on `aws-lc-rs`, so aws-lc-sys (C) builds on macOS and Linux; it built cleanly on the
   Mac and on both CI legs, and none of it reaches Windows. The decision stands; only the wording was wrong.
6. **No openh264 on macOS.** VideoToolbox's software H.264 is the no-GPU floor. `encode-openh264` stays for
   Linux.
7. **The cursor stays an overlay.** The viewer has no in-frame mode and the wire is frozen, so SCK captures
   without the cursor and `cpos` / `cshape` come from CoreGraphics and `NSCursor.currentSystem`. That call from
   a child that is not an AppKit app is unverified; the fallback is an in-frame cursor with `cpos.visible =
   false`, so the viewer draws nothing of its own.
8. **Capability is binary present AND a fresh Screen Recording grant**, flipped only when the backends exist
   (Wave 5), so a Mac on the dev fleet never advertises a stub. Missing Accessibility degrades control: events
   are dropped and logged once, and the banner says so.
9. **Apple silicon only, macOS 15.0 floor**, as the pkg enforces. **No login-window control** (Apple). Logout
   and fast user switching end the session, because the app's children die with the Aqua session; the next
   spawn waits for a console user. The lock screen inside a session is a human check.
10. **The dev rig is the installed product.** The installed app and a source-run agent fold into one instance
    and one machine id, so the loop is push to the mirror, the signed build job, then an install. No dev-only
    knobs in the product (`OWLETTE_SWOOP_EXE` and a non-root trust rule were both cut).
11. **Version parity holds through the existing gate** (`owlette-swoop version` equals the agent's version).
12. **Linux stays `platform/unsupported.rs`** (exit 12 with a log line) and is its own plan.
13. **macOS `OutputInfo.desktop_rect` is in pixels**: the display's pixel size at its point origin times its
    scale. `DisplayEntry::texture`, `PointerSpace` and the cursor normalisation stay untouched; the Mac injector
    and pointer sampler convert between pixels and points per display. On a mixed-scale layout those origins
    are not one consistent global space, which only spanning needs, and spanning is deferred on macOS.
14. **The clock is `hz`-parameterised ticks.** macOS ticks are nanoseconds from `CLOCK_UPTIME_RAW`, `hz` is
    1e9; SCK's presentation timestamps are on the same host clock. `HostClock` is untouched.
15. **The extra Apple calls are `extern "C"`, not crates**: `CGPreflightPostEventAccess` /
    `CGRequestPostEventAccess` and `AXIsProcessTrusted`, and CoreAudio's default output device. TIFF to PNG goes
    through `NSBitmapImageRep` in objc2-app-kit. The objc2 framework crates keep their default features.
16. **Gate M0 before the backends.** Wave 3 launches the real sidecar's `selfcheck` through the launch job on
    the installed product. `shareableContent: ok` is go. Anything else stops the plan before Wave 4: the
    fallback is capture inside the app process, which is a re-plan.
17. **The clipboard never raises a paste alert.** macOS pasteboard privacy can alert on a programmatic read; the
    Mac arm reads content only when the pasteboard's access behaviour is always-allow, and otherwise leaves
    host-to-viewer sync off with one log line. Viewer-to-host writes are unaffected. Unverified until M1.

## Waves

Conventions: the swoop plan's standing rules apply (cargo from `agent/swoop`, never `--manifest-path`;
done-when includes clippy with `-D warnings` and `cargo test`; hardware tests are `#[ignore]`d with their
invocation in the module doc; nothing logs a bundle; lowercase copy; no new npm packages). Tasks in one wave
never touch the same file. Labels: **[agent]** runs on this box or on the Mac over ssh; **[human]** needs the
owner's clicks, sudo or eyes. The work lives on branch `swoop/macos` in the worktree
`Owlette-swoop-mac-wt`; this directory is force-added to git.

- **Wave 1 — foundations**: 1.1 Cargo manifest and CI legs · 1.2 Mac rig prep
- **Wave 2 — seams, transport, launch, packaging, web**: 2.1 streamer seams, the capture-thread refactor and
  `selfcheck` · 2.2 agent POSIX spawn · 2.3 desktop launch job and the Accessibility check · 2.4 web host-aware
  keyboard · 2.5 packaging
- **Wave 3 — gate M0**: 3.1 the app's child sees the screen · 3.2 POSIX wiring test
- **Wave 4 — the macOS backends**: 4.1 capture and displays · 4.2 VideoToolbox encoder, transfer and the SPS
  check · 4.3 input injector · 4.4 cursor · 4.5 clipboard · 4.6 audio · 4.7 ICE arms · 4.8 security review of
  the macOS trust boundaries
- **Wave 5 — wiring**: 5.1 `platform/macos.rs` for real, and probe · 5.2 the capability flip
- **Wave 6 — first picture**: 6.1 gate M1, the first session on the Mac · 6.2 docs, changelogs and PROTOCOL.md ·
  6.3 parent plans
- **Wave 7 — release**: 7.1 release and verification

Full task text: [tasks.md](tasks.md).

## Gates

- **M0** (Task 3.1): the sidecar, launched by the installed app, reads the display list through
  ScreenCaptureKit on the app's grant. Owner reads the memo before Wave 4.
- **M1** (Task 6.1): a session from a Windows Chrome viewer shows the Mac's screen and controls it; overlay
  latency recorded.
- **Release** (Task 7.1): every success criterion below carries an observed result.

## Risks

1. **TCC attribution of the app's child for ScreenCaptureKit and CGEvent** is measured only for
   `screencapture`. The responsible-process rule says a posix_spawn child inherits, and gate M0 measures
   exactly that before Wave 4 starts.
2. **VideoToolbox's H.264 SPS may lack `bitstream_restriction_flag` and `max_num_reorder_frames = 0`**, the
   Chrome D3D11 decoder stall (208 ms) from the swoop plan's D5. Task 4.2 parses the SPS, asserts it and carries
   a rewrite.
3. **VideoToolbox latency**: it is asynchronous with its own queue. The low-latency properties are set and each
   frame is forced out in the call that submitted it; M1 is the measurement. `VTCopyVideoEncoderList` does not
   report maximum sizes, so sizes are probed by creating a session.
4. **macOS 15 Local Network permission** is attributed to the app; until someone at the Mac answers "Allow",
   the streamer's LAN candidates go nowhere and a session looks like an ICE failure. Whether a child's send
   raises the prompt for the app is unverified; M0 sends one packet to find out.
5. **`externalBin` makes the desktop crate's macOS CI leg need the sidecar** at compile time; Task 2.5 stages
   it. `tauri build --no-bundle` on Windows is untouched.
6. **Two desktop instances fold into one**, so a source-run rig cannot coexist with the installed app. Hence
   the installed-product loop and the sudo ask.
7. **The 30-day Screen Recording re-authorisation alert** (macOS 15.1+) returns after about 30 days without a
   capture. Documented; there is no code answer outside MDM.
8. **Pasteboard privacy** (decision 17) may leave host-to-viewer clipboard off until the owner allows it in
   System Settings.
9. **The system capture indicator** in the menu bar is Apple's and cannot be suppressed.
10. **Keyboard layouts**: injection is by virtual keycode, so the host's layout decides what a key types, the
    same contract as Windows scancodes. PrintScreen and Pause have no Mac meaning and are dropped.
11. **CGEvent details**: moves while a button is held need the drag event types, synthesised events do not
    inherit modifier flags, and a double click needs the click count. Task 4.3 owns all three.
12. **The refactor touches Windows' hottest loop**, and the tests of that loop are `#[ignore]`d hardware tests
    CI never runs. Task 2.1 runs them on this box; a Windows session on the release build is part of 7.1.
13. **Hardware tests on the Mac need a TCC grant for the ssh session** (Task 1.2's second ask). Without it the
    backends are first exercised at M1, through the installed product.

## Success criteria

- A Mac on the released pkg advertises `capabilities.swoop: 1` within one heartbeat of the app's relaunch after
  the Screen Recording grant, and `0` without it.
- From a Windows Chrome viewer: the Mac's screen at native resolution or the rung the governor picks, the
  cursor overlay, keyboard and mouse control including cmd shortcuts from a Windows keyboard, clipboard text
  and PNG to the Mac, clipboard from the Mac when the pasteboard setting allows it, system audio with mute,
  display selection on a multi-display Mac.
- Sessions survive the 300 s token refresh, an app restart and a viewer's network drop, as on Windows; `kill`
  ends them; no streamer outlives the daemon; the bundle is never on disk; a clean exit is never booked as a
  crash.
- No prompt is raised on a Mac without a click at that Mac, except the two the system owns (Screen Recording
  once per launch as today, and Local Network at the first LAN send).
- Latency on the LAN at the Mac's streaming rung: overlay capture to display p50 at or under 100 ms, recorded
  with n. A target for M1, not a release gate; the Mac's criteria are set after the first measurement.
- Windows: no behaviour change. The Windows suite, the golden vectors, the wiring test and the hardware tests
  are green, and a Windows session on the release build works.
- CI: rust-build's macOS and ubuntu legs green; the tag build produces a notarized pkg whose sidecar carries the
  team's signature; agent-tests' POSIX legs run the new wiring test; the security review's findings are fixed
  or accepted in writing.

## Owner decisions

1. **Approved 2026-09-28**: the plan; the crates (objc2 0.6.4; objc2-foundation, -core-foundation,
   -core-graphics, -core-media, -core-video, -screen-capture-kit, -video-toolbox, -app-kit 0.3.2; block2 0.6.2;
   dispatch2 0.3.1; libc; str0m's `rust-crypto` feature); macOS before Linux.
2. **Open**: `sudo` for the ssh user on the Mac, or an owner install per iteration (Task 1.2).
3. **Open**: Screen Recording and Accessibility for the ssh daemon's wrapper on the Mac while the port runs, so
   hardware tests can run over ssh (Task 1.2). Added while the task text was written; not part of the approval.
4. **Open**: release version, 4.1.0 proposed (Task 7.1).
5. **Deferred**: the Linux codec, to the Linux plan.
