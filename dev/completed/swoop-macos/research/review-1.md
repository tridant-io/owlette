> **Note (2026-09-28).** This review was written against the draft of the plan, and its task numbers are the
> draft's. The plan was renumbered when its edits were folded in: draft 1.2 → 2.1 (seams), 1.3 → 2.2 (agent
> spawn), 1.4 → 2.3 (desktop launch), 1.5 → 2.4 (web), 1.6 → 1.2 (rig), 2.1–2.7 → 4.1–4.7 (backends),
> 2.8 → folded into 5.1 (probe), 3.1 → 5.1, 3.2 → 6.1, 3.3 → 3.2, 4.1 → 2.5 (packaging), 4.2 → 6.2,
> 4.3 → 6.3, 5.1 → 7.1. Of its 24 edits, 22 were taken. Two were decided differently: edit 4 (points
> against pixels) became decision 13 instead of an owner ask, and the second half of edit 14 has nothing
> left to validate, because the sid never names a file (the daemon generates the id). Of its scope cuts,
> the pre-spawn version check stays: the shared code path runs it at no cost.

# review 1 — swoop on macOS plan (plan-draft.md)

Grounded against the tree at 7293e1bb (branch fix/clean-exit-not-crash). Severity ladder: critical / high / medium / low. Nothing here is critical.

## Verdict

The architecture is workable, but three load-bearing claims are wrong: the session seam is not "imports only", the first real test of the TCC premise comes after all of Wave 2 (and needs Wave 4's packaging first), and the POSIX exit-status design books a clean exit as a crash after an app restart. No two tasks in the same wave edit the same file. The wave problems are ordering dependencies, not file conflicts.

## Findings

### H1 (high, wrong): `session/mod.rs` cannot change only its imports
- The capture thread's observer closure is DXGI-typed. `source.next_frame_with(ACQUIRE_TIMEOUT_MS, &mut |dup, info| ...)` (session/mod.rs:3625) reads `info.LastMouseUpdateTime` (3632), calls `cursor::pointer_position(info)` (3633) and `reader.shape(dup, info)` (3638). The observer's type is `&mut dyn FnMut(&IDXGIOutputDuplication, &DXGI_OUTDUPL_FRAME_INFO)` (capture/mod.rs:764). A CGEvent/NSCursor `PointerSource` cannot slot into this closure. The cursor path has to become a platform-neutral pointer sample, and that means editing the session body and Windows' capture/cursor code.
- `qpc_now()` is a function body in session/mod.rs (895) that calls `QueryPerformanceCounter`. It is not an import.
- Names the host module needs that the seam list omits: `capture::enumerate_outputs()` (Windows-only, called from `drive()`), `OutputGeometry::for_output` (defined only inside the `#[cfg(windows)] mod win32`, cursor/mod.rs:702), `pointer_position` and `dpi_for_rect` (cursor/mod.rs:769).
- Impact: 1.2's done-when (`git diff --stat` shows only the import block) cannot be met. The real refactor touches Windows' hottest loop, which runs before `ReleaseFrame` on every acquired frame. The only tests of that loop are `#[ignore]`d hardware tests (session/mod.rs:4187 `end_to_end_picture`, 4307 `pause_closes_the_duplication...`) that CI never runs, so "the Windows suite is the proof" does not cover it.

### H2 (high, wrong): the TCC premise is tested last, and 3.2 depends on Wave 4
- 3.2 (Wave 3) installs "the signed pkg" and expects the streamer to run on the app's grants. That requires the sidecar inside `Contents/MacOS`, signed by the team (C2), which is 4.1's work (`externalBin` + `build.sh`).
- Risk 1's mitigation says "the first thing run on the Mac is `probe` through the launch job (3.1)". But 2.8 makes `probe` TCC-free ("run from a plain shell"), and 3.1's done-when is clippy/test only. The first time a posix_spawn child calls ScreenCaptureKit or CGEvent under the app's identity is therefore 3.2, after every Wave 2 backend is built.
- Spike 0.2's inheritance evidence was for `/usr/sbin/screencapture`, which carries `com.apple.private.tcc.check-allow-on-responsible-process` (macos-tcc.md, "Evidence gathered since"). That result does not generalise to our binary. Unverified.
- 1.4's done-when spawns `/bin/cat` "from the allow-list", which contradicts decision 3 (allow-list resolved next to `current_exe()`). Use the real sidecar with a TCC self-check verb instead. That also answers Risk 1 in Wave 1.

### M1 (medium, wrong): exit status and teardown on POSIX
- **After an app restart the exit file is never written.** The waiter thread dies with the app. The plan's fallback ("gone without a file" means `internal_error`) then feeds `_apply_backoff` (swoop_manager.py:502): any code other than 0 climbs the ladder and keeps the spawn in the ceiling window. So every session that outlives an app restart ends booked as a crash, which contradicts the success criterion. This is the same class of bug 1e8399e0 just fixed for managed processes.
- **Race even without a restart.** The pid is gone as soon as the app reaps the child, before `exit.json` is renamed into place. `wait()` has to keep polling for the file after the pid disappears, or clean exits get misbooked.
- **Simpler source for the code.** The streamer already emits `exiting` with `code` on every orderly exit (session/mod.rs:1038). Capture that in `PosixSwoopProcess.iter_lines()` and return it from `wait()`. The exit file is then only needed for pre-session exits (10/11, which main.rs returns without an event) and for crashes.
- **Kill by pid.** `close()` sends SIGKILL to a pid read back from the app. Once the child has been reaped, that number can belong to another process. Confirm the process's identity before signalling, or ask the app, which owns the child handle, to end it.
- **EOF depends on the app closing its socket.** The app must drop its own copy of the connected socket after spawning. Otherwise the daemon never sees EOF when the streamer exits, and `_reader_loop` hangs. 1.4's done-when should assert that the child exiting produces EOF on the daemon side.

### M2 (medium, wrong): the frame-handle contract in 2.1 breaks the floor
- 2.1 says `Frame.handle` is "a retained CVPixelBuffer valid until the next call". But the floor re-encodes `last_source` across `next_frame_with` calls that return `Ok(None)` (session/mod.rs:3702-3706). Windows is safe only because `Duplication` copies each picture into its own persistent texture (capture/mod.rs:486, 493), which is a stronger guarantee than the trait doc gives (capture/mod.rs:69). The Mac source must keep the last delivered buffer until a newer picture arrives or a rebuild happens.
- "`didStopWithError` → the typed rebuild error": the session treats any `Err` from `next_frame_with` as exit 12 (session/mod.rs:3658). The Mac source has to rebuild internally and report through `take_idr_request()`, as `Duplication` does, or the session changes again.

### M3 (medium, wrong): points vs pixels has no home in the portable types
- `OutputInfo` has only `device_name`, `desktop_rect` and `rotation` (capture/mod.rs:169). The "texture in pixels, `scale`" fields in 2.1 do not exist.
- `DisplayEntry::texture()` derives the pixel size from `desktop_rect` (displays/enumerate.rs:74), under the stated rule that a desktop rect is physical pixels (enumerate.rs:104). `hello_displays` sends it to viewers (displays/mod.rs:365).
- Rect in points means viewers are told half the real size on a 2x panel. Rect in pixels means CGEvent (which works in points) and a mixed-scale multi-display layout do not fit one space. This is a portable-type decision for Wave 1, not a Wave 2 arm.

### M4 (medium, wrong): 2.3 maps at the wrong layer
- `InputEvent::Key` carries set-1 scancodes (input/mod.rs:161). Browser codes are mapped on the session thread (`ViewerInput::key` → `keymap().press`, input/mod.rs:583-595) before any injector sees them. Wheel `mode` is already folded into `WHEEL_DELTA` there too (input/mod.rs:541).
- So the Mac injector needs a table from (scancode, extended) to `kVK_*`. It must also drop PrintScreen's extended-0x2A step (the sequence is pinned at input/mod.rs:1527-1530) and handle `KeyVirtual` (Pause). "Browser `code` → `kVK_*`" cannot be wired without changing the shared path.

### M5 (medium, unverified): the launch-time Accessibility ask reaches every fielded Mac
- 1.4 asks for Accessibility "once per launch", following tcc.rs:79. On upgrade, preinstall boots the app out (preinstall:21) and postinstall bootstraps it again (postinstall:60). Every upgraded Mac, including unattended signage, would get the dialog at the upgrade and at each login until someone grants it.
- I believe `AXIsProcessTrustedWithOptions` with the prompt option re-raises the dialog while the app is untrusted. Not measured.
- This contradicts the guardrail's intent that prompts are only ever the response to a click. Ask only from the banner button, and report the grant passively.

### L1 (low): C2 items and docs the plan drops without saying so
- C2 had the runner accept `stdin_path` only inside `ipc/swoop` and root-owned. 1.4 has no equivalent check on the socket path.
- C2's "`desktop_not_running` recorded as `endReason`" is implemented nowhere, and `SwoopSessionEndReason` (web/lib/swoop/sessionStore.server.ts:36) has no such value.
- PROTOCOL.md §6 (line 344: "inherited anonymous pipes ... no files between the service and the streamer") needs the macOS transport and the exit file. It is not in 4.2's file list.

### L2 (low): wiring details
- `spawn(exe_path, sid)`: the Windows `spawn` takes `log_dir` as its second positional argument (swoop_spawn.py:415), and so do both test doubles (test_swoop_manager.py:103, test_swoop_wiring.py:268). Pass `sid` keyword-only.
- The sid arrives as any non-empty string (swoop_doorbell.py:664-665). Validate it as 32 hex characters before it names a file.
- `select::CHAIN` is `[&str; 5]` (select.rs:36). "`CHAIN` per OS" needs a slice type or a cfg'd length.

### L3 (low): crates and manifest discipline
- 2.6 needs the default output device (CoreAudio HAL), 2.5 needs TIFF→PNG (ImageIO), and 2.3 needs `AXIsProcessTrusted` (ApplicationServices). None of these frameworks is in the approved crate list.
- Say whether they come in as raw `extern "C"` (the tcc.rs:29 precedent) or ask the owner for more crates.
- Also state that the objc2 framework crates keep their default (all-headers) features, so no Wave 2 task edits Cargo.toml in parallel.

### L4 (low): ordering within waves
- 2.1 creates `displays/mac.rs` but lists `enumerate.rs` for the mod line. A sibling file needs `mod mac;` in `displays/mod.rs` (no other Wave 2 task touches it).
- 1.2's Mac clock needs 1.1's `libc`, which is in the same wave.
- 2.8's done-when needs 2.2's encoders. 2.8 also re-reads the CoreGraphics display list that 2.1 builds; reuse 2.1's.

### L5 (low): missing work
- 1.5 is new user-facing behaviour with no Playwright e2e (global testing rule) and no `/preflight` in its done-when.
- No startup sweep of stale `ipc/swoop/*.sock` / `*.exit.json`.
- `_check_console_session` uses `win32ts` only (owlette_service.py:2898), so logout and user switching never reach swoop on a Mac. Either port it or scope it out.
- The success criterion "within one heartbeat of a fresh Screen Recording grant" conflicts with tcc.rs:16: a grant only takes effect after the app relaunches.

## Scope cuts
- Decision 10 makes the dev rig the installed product. Nothing then uses 1.3's `OWLETTE_SWOOP_EXE` override or 1.4's non-root trust extension "(the dev rig)". Drop both; the runner's trust rule stays root-only as it is today (jobrunner.rs:287).
- The pre-spawn `version` exec adds nothing on macOS. The pkg ships the app and the sidecar together, and the streamer already refuses a mismatched `agentVersion` with exit 11. The Windows reason (a delayed-until-reboot binary) does not exist on macOS.
- The exit file shrinks to a fallback once the code comes from `exiting` (M1).

## macOS API facts: wrong vs unverified
- **Believed wrong:** `VTCopyVideoEncoderList` carries codec, encoder id, the hardware flag and an instance limit, not maximum dimensions. Probe sizes by creating a session.
- **Unverified:** `NSCursor.currentSystem` from a non-AppKit child, off the main thread. It probably returns a fresh object per call, so an identity compare will not work; compare image bytes instead.
- **Unverified:** `AXIsProcessTrusted` vs `CGPreflightPostEventAccess` as the gate for `CGEventPost`.
- **Unverified:** TCC inheritance by a posix_spawn child for SCK and CGEvent (see H2).
- **Unverified:** Local Network prompt attribution to the app for its child. Also whether a remote viewer can answer the prompt; assume someone at the machine must, and document it.
- **Unverified:** SCK's default colour space. It is the display's (P3 on Mac panels); set sRGB/709 and tag the VUI to match.
- **Unverified:** SCK idle-status frames carry no image and must be skipped.
- **Unverified:** a pointer move while a button is held must be posted as the matching `*Dragged` event type.
- **Plausible:** Tauri `externalBin` signing with the hardened runtime. 4.1's `codesign --verify` check covers it.
- **Verified:**
  - str0m 0.23.1 has `rust-crypto` (dimpl + RustCrypto) and `apple-crypto`.
  - With no provider compiled in, str0m panics at runtime (src/crypto/mod.rs `from_feature_flags`), so the non-Windows `rust-crypto` table is required.
  - Edition 2021 (resolver 2) keeps target tables apart.
  - `HostClock` is hz-parameterised.

## Not covered here
The new macOS trust boundaries need their own security review before 5.1: the socket, the launch job, and root-side handling of files and values the app writes. That review is not part of this report.

## Concrete edits to the plan
1. Replace 1.2's "imports only" done-when with a budgeted capture-thread refactor (a platform-neutral pointer sample in place of the DXGI observer, `qpc_now` through `platform::clock`). Gate it on the two `#[ignore]`d Windows hardware tests run on the Windows box.
2. Add `enumerate_outputs`, `OutputGeometry::for_output`, `pointer_position` and `dpi_for_rect` to 1.2's list of seam names.
3. Specify the Mac capture contract as "the last delivered buffer stays retained until a newer picture or a rebuild", with internal rebuild reported through `take_idr_request` rather than a typed error.
4. Put the points-vs-pixels decision in Wave 1 (owner) and name the portable types that change (`OutputInfo`, `DisplayEntry::texture`, `PointerSpace`).
5. Rewrite 2.3: the Mac injector maps (set-1 scancode, extended) to `kVK_*`, drops PrintScreen's extended-0x2A step, handles `KeyVirtual`, and takes `WHEEL_DELTA` units.
6. Move 4.1 (externalBin, build.sh, CI) ahead of 3.2.
7. Replace `/bin/cat` in 1.4's done-when with the real sidecar running a TCC self-check through the launch job, and make that the plan's go/no-go.
8. Correct Risk 1's mitigation to point at that Wave 1 check.
9. Have `PosixSwoopProcess` take the exit code from the `exiting` event, keep the exit file as a fallback, and keep polling for it after the pid disappears.
10. Replace `close()`'s SIGKILL-by-pid with an identity-confirmed signal or a request to the app that owns the child.
11. Require the app to close its copy of the connected socket after spawn, and assert daemon-side EOF on child exit in 1.4's done-when.
12. Make the Accessibility ask a banner click, never a launch-time call.
13. Drop `OWLETTE_SWOOP_EXE` (1.3) and the non-root trust extension (1.4); decision 10 already makes the dev rig the installed product.
14. Pass `sid` to `spawn` keyword-only, and validate it as 32 hex characters before it names a file.
15. Add the C2 socket-path check to the runner. Either implement `desktop_not_running` as an `endReason` or record its removal in the C2 amendment (4.3).
16. Add PROTOCOL.md §6 to 4.2's file list.
17. State in 1.1 that the objc2 crates keep default features, and whether CoreAudio, ImageIO and ApplicationServices come in as raw `extern "C"` or new crates (owner ask).
18. Add `displays/mod.rs` (`mod mac;`) to 2.1's files, run 1.1 before 1.2, and let 2.8 reuse 2.1's display list.
19. Add a Playwright e2e and `/preflight` to 1.5's done-when.
20. Add a startup sweep of stale `ipc/swoop` files to 1.3.
21. Reword the capability success criterion to "within one heartbeat of the app's relaunch after the grant".
22. Either port `_check_console_session` to macOS or list logout and user switching as out of scope.
23. Mark `VTCopyVideoEncoderList` sizes and `NSCursor.currentSystem` identity as unverified in 2.2 and 2.4, each with a measured fallback.
24. Schedule a separate security review of the macOS trust boundaries before 5.1.
