# Tasks: swoop on macOS, 4K at 60 and the keyboard model

Progress: 4/11. Branch `swoop/macos`, worktree `Owlette-swoop-mac-wt`. Standing rules of `../swoop-macos/plan.md`
apply (the four Windows commands, the macOS commands, nothing pushed to dev or main). Mac worktrees
`~/src/owlette-swoop-mac-21` (streamer) and `-23` (desktop) on the rig; `~/src/mac-build-install.sh` builds,
notarizes and installs.

## Wave 1: the encoder

- [x] **Task 1.1: VideoToolbox without low-latency rate control, delivering from its callback** `[agent]`
  - Files: `agent/swoop/src/encode/videotoolbox/mod.rs`, `agent/swoop/src/encode/mod.rs`, `agent/swoop/src/session/mod.rs` (the capture pass only)
  - Do: On macOS open the session without `EnableLowLatencyRateControl` (the fallback order stays for a session that cannot encode). Add `Encoder::set_sink` with a no-op default; the VideoToolbox backend hands each finished frame to the sink from `on_output`, in callback order, Annex-B'd there, and `encode()` only submits (no `CompleteFrames`). The session gives each tier's encoder a sink that sends `FromWorker::Frame`; `force_irap` clears on an accepted submit for a sink backend. The hardware test gains the paced-60 run at the panel's size and prints throughput, submit time and submit-to-callback latency.
  - Done when: the macOS commands are green; the hardware test shows 60.0 fps paced at the panel's size with none dropped and latency under 20 ms p95; the four Windows commands are green and `git diff` touches no Windows backend's behaviour.

## Wave 2: the picture

- [x] **Task 2.1: Capture at the pixel rect again** `[agent]`
  - Files: `agent/swoop/src/capture/sck.rs`, `agent/swoop/src/cursor/mac.rs`, `agent/swoop/src/platform/macos.rs`
  - Do: Revert the point-size capture and picture grid (`adf65040`, `2cfbef4a`) so the stream is the display's pixels, the cursor is drawn at the panel's scale and reported in pixels. Keep `picture_size` only if something still uses it.
  - Done when: the capture hardware test opens at 3420x2214; the cursor hardware test's shapes are 2x again; the macOS commands are green.
  - Depends on: 1.1

- [x] **Task 2.2: 50 Mbps auto for a 4K-class source** `[agent]`
  - Files: `agent/swoop/src/session/quality.rs`, `agent/swoop/src/session/mod.rs`
  - Do: `Ceiling::default()` for a source above 2.5 megapixels starts at the menu's top rate; the governor's floor and descent are untouched. Unit test both sides of the threshold.
  - Done when: the four Windows commands and the macOS commands are green; a 1080p source still defaults to 20 Mbps.
  - Depends on: 1.1

## Wave 3: the clipboard

- [x] **Task 3.1: Never re-push a clip the host already has** `[agent]`
  - Files: `web/lib/swoop/clipboard.ts`, its test
  - Do: Remember the last payload pushed and the last payload received from the host (a hash); on a paste keystroke, skip the push when the PC clipboard matches either, and send the keystroke alone.
  - Done when: vitest covers copy-on-host then paste-on-host (no push), copy-on-PC then paste (push), and a host clip followed by paste (no push); `npm run lint` clean on the file.

- [ ] **Task 3.2: The host says when it cannot read its clipboard** `[agent]`
  - Files: `agent/swoop/src/clipboard/mac.rs`, `agent/swoop/src/clipboard/mod.rs`, `web/components/swoop/SwoopToolbar.tsx` (or where feature status is shown)
  - Do: Log the pasteboard access behaviour at info at session start. The clipboard feature's status carries `reads: false` with a reason; the viewer shows "the mac's clipboard is not shared: allow owlette under paste from other apps" once, lowercase.
  - Done when: a Mac session's service log names the access behaviour; vitest covers the status line.

- [ ] **Task 3.3: The Mac app asks for clipboard sharing the way it asks for Accessibility** `[agent+human]`
  - Files: `agent/swoop/src/selfcheck.rs` (or where `selfcheck --grants` lives), `desktop/src-tauri/src/` (the grants reader), `desktop/src/components/` (the permissions notice)
  - Do: `selfcheck --grants` reports the pasteboard access behaviour (the sidecar is the app bundle's child, so it reads the app's own setting; `null` below macOS 15.4). The app's permissions notice gains a row when it is not *allow*: "clipboard sharing is off for owlette on this mac: allow owlette under paste from other apps", lowercase, with the same "open system settings" button the Accessibility row has, aimed at that pane (find the deep link on the rig; fall back to the Privacy & Security pane). The row clears on its own when the setting changes, as the Accessibility row does. Nothing reads the pasteboard to find out: the behaviour is a property, not a read.
  - Human: one click on the rig to set *allow*, so the row's clearing is measured.
  - Done when: the row shows and clears on the rig without a relaunch; desktop clippy and tests green on both platforms; vitest covers the row.

## Wave 4: the keyboard

- [ ] **Task 4.1: One model, tested in every direction** `[agent]`
  - Files: `web/lib/swoop/keymap.ts`, `web/__tests__/lib/swoop/keymap.test.ts` (or the existing test)
  - Do: Keep the switch's behaviour as plan.md's two tables; make sure `MetaLeft`/`MetaRight` are never remapped by the switch in either direction (today a Mac viewer's Command becomes Ctrl under the switch, which the table keeps; keys-match sends it as the Windows key). One table-driven test over host {windows, macos, linux} × viewer {mac, pc} × switch {on, off} for Control, Meta and Alt.
  - Done when: the test enumerates all twelve cells and passes; lint clean.

- [ ] **Task 4.2: The legend** `[agent]`
  - Files: `web/components/swoop/SwoopSpecialKeys.tsx`, `web/lib/swoop/specialKeys.ts`
  - Do: Under the switch, three rows "you press → the machine gets" for the current host, viewer and switch, from the same function the input capture uses; a note "the windows key reaches the machine in fullscreen" while keyboard lock is not held.
  - Done when: vitest renders the legend for a PC viewer on a Mac host in both switch states; lowercase copy; lint clean.

- [ ] **Task 4.3: A sticky super key for a session outside fullscreen** `[agent]`
  - Files: `web/lib/swoop/specialKeys.ts`, `web/components/swoop/SwoopSpecialKeys.tsx`, `web/lib/swoop/input.ts`, `web/lib/swoop/keyboardLock.ts`
  - Do: A keyboard-menu item, "hold cmd for the next key" on a Mac host and "hold the windows key for the next key" on a Windows or Linux host, that arms `MetaLeft` down until the next key's release goes through the input capture, then releases it; shown only while keyboard lock is not held, since under lock the real key arrives. Correct `keyboardLock.ts`'s header: Brave exposes the API (measured 2026-10-01 on the owner's PC); the feature is absent only in non-Chromium browsers and outside fullscreen.
  - Done when: vitest covers arm, next key, release, and the item hidden under lock; lint clean.

## Wave 5: verification

- [ ] **Task 5.1: The 4K run** `[agent+human]`
  - Files: `dev/active/swoop-mac-4k-keys/spikes/5.1-4k-run.md` (create)
  - Do: Build, install, one session from Chrome in fullscreen and one from Brave: stats overlay (fps, resolution, breakdown), window drags, text sharpness, smear; copy and paste in both directions after Task 3; the Windows key and the switch in both states; the pasteboard setting as found.
  - Human: the clicks at the Mac (pasteboard *allow* if chosen), the viewer side.
  - Done when: the memo has the observed numbers and the owner's word.
  - Depends on: 2.1, 2.2, 3.1, 3.2, 3.3, 4.1, 4.2, 4.3

- [ ] **Task 5.2: Windows unchanged** `[agent+human]`
  - Do: The four Windows commands; one Windows-host session from this box (picture, cursor, copy and paste).
  - Done when: both recorded in the 5.1 memo.
  - Depends on: 5.1

## Log

### 2026-10-01, Wave 1

**Task 1.1: done** (`34c1d9bc`). `Encoder::set_sink`, a no-op by default that only VideoToolbox takes. The
VideoToolbox session opens without `EnableLowLatencyRateControl` first; with a sink `encode` only submits, and
`on_output` assembles the frame and hands it over on VideoToolbox's thread (the Annex-B state moved into
`Shared`); a dropped or refused frame forces the next submit to a keyframe, and a callback failure is answered
by the next `encode`. The session sets the sink on every encoder it opens and clears `force_irap` on the accepted
submit. The settle keyframe moved to the session thread (`on_frame` marks a big move, `tick` requests the IDR a
second later), so it works whichever way frames arrive.
- Hardware test `videotoolbox_holds_60_at_the_panels_size_through_its_sink`, 3420x2214 HEVC at 50 Mbps, 240
  frames paced at 60 Hz: 240 of 240 in 4.00 s = 60.0 fps, submit-to-callback p50 10.7 ms, p95 16.5 ms, callback
  order equal to input order, IRAPs at [0, 90]. The 120-frame test at 1080p without low-latency: hardware HEVC
  3.9 ms p50, hardware H.264 5.3 ms, software H.264 10.9 ms.
- Checks: macOS clippy clean and 421 tests passed; Windows clippy clean and 396 passed; no Windows backend
  touched.
- *Changelog line:* "macOS: swoop encodes at the display's rate, 60 fps at a Retina panel's size, with one frame in
  flight."

### 2026-10-01, Wave 2

**Task 2.1: done** (`d849dbcc`). The point-size capture (`adf65040`) and the picture grid (`2cfbef4a`) reverted
in `capture/sck.rs`, `cursor/mac.rs` and `platform/macos.rs`; the session's side of `adf65040` (the removal of
the earlier points cap) kept. Capture hardware test: display-1 opened at 3420x2214 in 328 ms, rebuilt in 213 ms.
Cursor hardware test: the arrow at 56x80 with the hot spot at (10, 10), 2x again; 553 samples, all visible. Both
needed the display awake (`caffeinate -u -t 5`; an asleep display is not listed). macOS clippy clean, 421
passed; Windows clippy clean, 396 passed.

**Task 2.2: done** (`9b606b71`). `quality::auto_bitrate_bps(size)`: above 2.5 megapixels, the menu's top rate
(50 Mbps); otherwise 20. `Ceiling::from_quality_with_auto` takes it for an unstated rate and
`Viewer::new` for a new viewer's governor, both from the session's captured source size. The session's own
`DEFAULT_BITRATE_BPS` went (unused outside a test). Unit test over 1080p, 1440p, Retina and 4K.
- *Note for the owner:* 2560x1440 is 3.7 megapixels, so a 1440p **Windows** host now starts at 50 Mbps auto
  too. The plan's threshold is the one approved; raise `LARGE_SOURCE_PIXELS` to 4 million if 1440p should stay at
  20.
- Checks: Windows clippy clean, 397 passed; macOS clippy clean, 422 passed.
- *Changelog line:* "swoop starts a 4K-class machine at 50 Mbps; the quality menu still sets any rate."

The Wave 2 build (`9b606b71`) was installed on the rig at 22:13 on 2026-10-01 signed but **not notarized**: the
notary profile had vanished from the Mac's keychain again (`BUILD-EXIT=69`), as it did on 2026-09-28 and
2026-09-30. The owner re-creates it with `xcrun notarytool store-credentials owlette-notary`.

### 2026-10-01, Wave 3

**Task 3.1: done** (`bf9f9547`). `clipboard.ts` remembers the last clip pushed and the last one the host sent;
a paste whose clip matches either (same format, same bytes) sends the keystroke alone. Jest: 16 passed in
`clipboard.test.ts`, three of them new (a host's clip is not pushed back; the same clip is not pushed twice;
a different one is); eslint clean on both files.
- *Changelog line:* "swoop no longer pushes your clipboard to the machine before a paste when the machine already
  has it, so a copy made on a Mac is pasted as copied."
