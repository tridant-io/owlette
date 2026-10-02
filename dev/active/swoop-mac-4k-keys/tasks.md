# Tasks: swoop on macOS, 4K at 60 and the keyboard model

Progress: 9/11. Branch `swoop/macos`, worktree `Owlette-swoop-mac-wt`. Standing rules of `../swoop-macos/plan.md`
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

- [x] **Task 3.2: The host says when it cannot read its clipboard** `[agent]`
  - Files: `agent/swoop/src/clipboard/mac.rs`, `agent/swoop/src/clipboard/mod.rs`, `web/components/swoop/SwoopToolbar.tsx` (or where feature status is shown)
  - Do: Log the pasteboard access behaviour at info at session start. The clipboard feature's status carries `reads: false` with a reason; the viewer shows "the mac's clipboard is not shared: allow owlette under paste from other apps" once, lowercase.
  - Done when: a Mac session's service log names the access behaviour; vitest covers the status line.

- [x] **Task 3.3: The Mac app asks for clipboard sharing the way it asks for Accessibility** `[agent+human]`
  - Files: `agent/swoop/src/selfcheck.rs` (or where `selfcheck --grants` lives), `desktop/src-tauri/src/` (the grants reader), `desktop/src/components/` (the permissions notice)
  - Do: `selfcheck --grants` reports the pasteboard access behaviour (the sidecar is the app bundle's child, so it reads the app's own setting; `null` below macOS 15.4). The app's permissions notice gains a row when it is not *allow*: "clipboard sharing is off for owlette on this mac: allow owlette under paste from other apps", lowercase, with the same "open system settings" button the Accessibility row has, aimed at that pane (find the deep link on the rig; fall back to the Privacy & Security pane). The row clears on its own when the setting changes, as the Accessibility row does. Nothing reads the pasteboard to find out: the behaviour is a property, not a read.
  - Human: one click on the rig to set *allow*, so the row's clearing is measured.
  - Done when: the row shows and clears on the rig without a relaunch; desktop clippy and tests green on both platforms; vitest covers the row.

## Wave 4: the keyboard

- [x] **Task 4.1: One model, tested in every direction** `[agent]`
  - Files: `web/lib/swoop/keymap.ts`, `web/__tests__/lib/swoop/keymap.test.ts` (or the existing test)
  - Do: Keep the switch's behaviour as plan.md's two tables; make sure `MetaLeft`/`MetaRight` are never remapped by the switch in either direction (today a Mac viewer's Command becomes Ctrl under the switch, which the table keeps; keys-match sends it as the Windows key). One table-driven test over host {windows, macos, linux} × viewer {mac, pc} × switch {on, off} for Control, Meta and Alt.
  - Done when: the test enumerates all twelve cells and passes; lint clean.

- [x] **Task 4.2: The legend** `[agent]`
  - Files: `web/components/swoop/SwoopSpecialKeys.tsx`, `web/lib/swoop/specialKeys.ts`
  - Do: Under the switch, three rows "you press → the machine gets" for the current host, viewer and switch, from the same function the input capture uses; a note "the windows key reaches the machine in fullscreen" while keyboard lock is not held.
  - Done when: vitest renders the legend for a PC viewer on a Mac host in both switch states; lowercase copy; lint clean.

- [x] **Task 4.3: A sticky super key for a session outside fullscreen** `[agent]`
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

**Task 3.2: done** (`3a40f417`). `hello-host` carries `clipboardReads` (PROTOCOL.md; the golden vector gained
it), from the clipboard feature's new status (`FeatureStatus::clipboard`, `Listener::reads`: Windows always,
macOS `reads_general_pasteboard()`, the stub never); the session gathers feature status for the status line and
for hello alike. The Mac listener logs the access behaviour at info. The viewer's `swoopClipboard(session)`
store reads it off hello (an older host's silence is true) and the toolbar shows "the machine's clipboard is not
shared: on a mac, allow owlette under paste from other apps in system settings" while it is false.
- Checks: Windows clippy clean, 397; macOS clippy clean, 422; jest 94 on the three touched suites and 6239 on
  the whole web suite; eslint and tsc clean. Not covered: a toolbar render test (the store needs a live
  attach); the store itself is. The service-log line is read off the rig once this build is installed.
- *Changelog line:* "swoop tells you when the machine does not share its clipboard."

**Task 3.3: done, agent half** (`f0519394`). `selfcheck --grants` reports `pasteboardAccess` (`allow`, `ask`,
`deny`, `default`, `unknown`, or `null` before macOS 15.4) beside the three grants. The app's `tcc.rs` reads it
(`clipboard_sharing`: true under *allow* and with no setting, false otherwise, unknown when the sidecar predates
the key), two new commands expose it and open the pane, and `PermissionBanner` gains the row "clipboard sharing
is off for owlette on this mac: a swoop viewer gets nothing you copy here. allow owlette under paste from other
apps in system settings", re-read every five seconds while it shows. The pane's anchor is `Privacy_Pasteboard`,
read from `SecurityPrivacyExtension.appex` on the rig (the deep-link check over ssh could not see System
Settings' window, so the pane it lands on is the owner's to confirm).
- Checks: desktop vitest 9 (two new); desktop clippy and tests, Windows 124 and macOS 149; streamer 397 and 422;
  `tsc -b` clean; oxlint's two warnings in `App.tsx` predate this change.
- **Amended 2026-10-02** (`a9ef626c`): opened over ssh, the Paste from Other Apps pane on the rig listed no app
  at all ("applications that have requested access … will appear here"): macOS lists an app there only once it
  has read the pasteboard, and owlette never does under *ask*. So the row's button now runs
  `owlette-swoop selfcheck --paste-once` (one read in the app bundle's identity, which raises the system's paste
  alert at the person who clicked) and then opens the pane; the copy says "allow the paste alert, then set
  owlette to allow under paste from other apps". From ssh the flag answers `{"pasteboardAccess":"allow"}`, since
  an ssh child is exempt; from the app it is the app's own setting. Checks green again on both platforms.
- **Measured on the rig, 2026-10-02 (answers the human half):** with the 3a40f417 build the streamer, started
  by the app for a real session, logged "the pasteboard is read on a change, its access behaviour is always
  allow". So this Mac shares its clipboard already, the row rightly does not show (checked over accessibility:
  the app's window lists no notice), and nothing is owed at the Mac. M1's "ctrl-c-v not working" was Task 3.1's
  stale push alone. The row and its button stay for a Mac whose setting is *ask* or *deny*; they are untested
  against a live alert, since no such Mac is on hand.
- *Changelog line:* "macOS: the owlette app says when clipboard sharing is off and walks you to the setting."

The Wave 3 build (`f0519394`) was installed on the rig at 22:53 on 2026-10-01, notarized: the profile was back.
Everything on the Mac's side of the plan is live there. The viewer's side (Tasks 3.1, 3.2 and Wave 4) is web
code on this branch, which dev.owlette.app does not serve: for the 5.1 run the viewer is this box's own
`cd web && npm run dev` at `http://localhost:3000/swoop/default_site/TEC-MBA`.

### 2026-10-02, the 5.1 run so far (the owner, from dev.owlette.app overnight)

The session held all night without a drop. The owner reports "still smearing a bit on fast window moves" and
"definitely not getting 60fps". Measured on the rig to place the loss: ScreenCaptureKit delivers 57 pictures a
second at 3420x2214 against a 60 Hz animation (a scrolling terminal gave 32, which was the terminal), and the
encoder holds 60 (Task 1.1), so the frames are lost after capture. The prime suspect is the governor
(`transport/governor.rs`): a one-way-delay rise over 50 ms cuts the rate 20 %, and once the rate is pinned at
its floor the ladder drops the frame rate before the resolution; the overnight streamer log shows a 34 s spell
at 2224x1440, which only happens after the frame-rate rung has already gone. A 4K keyframe at 50 Mbps is 2.5 MB,
400 ms of link time, which is itself a delay rise; the settle keyframe makes one per big move. The host logged
nothing about any of this, so the session's rate story now goes to the service log every ten seconds and on
every cut (fps sent, kbps on the wire, target, rung, cuts, gaps, governor state). The next session from
dev.owlette.app, with a minute of fast window drags, is what decides between more rate on a LAN, a governor that
ignores its own keyframes, and dropping the settle keyframe at 4K.

**The rate story, read 2026-10-02 after one minute of fast drags (build `82f75bbe`):** 52 to 58 fps sent the
whole time, rung 60fps/native throughout, so the host's frame rate was there. But 11 cuts in 40 s, each matched
by one frame gap, took the target from 50 Mbps to 20 (and later lower), with the governor holding the whole time.
The gap is the browser's `framesDropped`, which rises by one for a skipped late frame, a slow decode or a
throttled paint as readily as for loss on the path; one every two to four seconds at 60 fps is noise, and every
one cost a 20 % cut, a two-second hold and a 2.5 MB recovery keyframe. That is the stutter the owner saw as "not
60 fps" and the starved target behind the earlier smear. Fixed in `transport/governor.rs`: fewer than three
unexplained dropped frames in a report window are counted and not cut (`GAP_CUT_THRESHOLD`); a delay rise still
cuts on its own. Tests: the window-noise case added, the existing gap tests unchanged; 398 on Windows, 423 on
macOS. The owner reported no smear in this run. The next session from dev.owlette.app, read the same way, shows
whether the target now stays near 50 Mbps.

**Read again after the fix (build `58dc3f6d`, installed 08:50, the owner's drag test):** the first session ran
five minutes at 57 fps sent, target 50000 kbps, 0 cuts, 0 gaps, governor at the ceiling throughout. The owner
ended it and opened a second: 40 s the same, then a 50 s spell at 14-18 fps sent and under 200 kbps (a still
screen sends only what changes), during which the browser's dropped-frame count still rose by a few, then back
to 51-57 fps with one cut in the whole two minutes, against 11 in 40 s before. The gap tolerance holds; the one
remaining cut is a window with three or more drops, which is what the rule still treats as loss. Open note: the
browser drops a frame or two even while the stream is quiet, so `framesDropped` is noisier than a path signal
should be; a delay-rise-only rule stays an option if that ever matters.

The viewer-side changes (Tasks 3.1, 3.2, Wave 4) cannot be run by the owner yet: a passkey is bound to
dev.owlette.app and cannot sign in on localhost, and dev.owlette.app serves `dev`, not this branch. They are
covered by unit tests and wait for the branch on `dev` (the owner's merge of PR #256).

### 2026-10-01, Wave 4

**Tasks 4.1, 4.2 and 4.3: done** (`30a9a95d`). The conversion itself was already the plan's model
(`applyModifierMapping` never touches `MetaLeft`, so the Windows key is Command under both settings); the
matrix test in `keymap.test.ts` gained Alt. The menu's switch is now a radio pair under "modifier keys":
"shortcuts match: ctrl acts as cmd" (the default) and "keys match: ctrl is control" for a PC viewer on a Mac,
"shortcuts match: cmd acts as ctrl" and "keys match: cmd is the windows key" for a Mac viewer on Windows or
Linux. Under it the legend, three rows from `modifierLegend()` (`web/lib/swoop/modifierLegend.ts`), which runs
the capture's own conversion. Outside fullscreen the menu says "the windows key reaches the machine in
fullscreen" (or that the browser keeps it, where there is no keyboard lock api) and offers "hold the windows
key for the next key" (Windows and Linux hosts) or "hold cmd for the next key" (Mac): `InputCapture::holdNextKey`
arms the key down until the next typed key's release, and `releaseAll` lets go of it with everything else.
`keyboardLock.ts`'s header no longer says Brave switches the api off.
- Checks: jest 225 on the five suites (two new files: `modifierLegend.test.ts` and a jsdom render of the menu
  that opens it, reads the legend in both settings and finds the hold item); the whole web suite 6247; eslint
  and tsc clean.
- *Changelog line:* "the swoop keyboard menu names its two modifier settings, shows what each key does on the
  machine, and can hold the windows key or cmd for your next keystroke outside fullscreen."
