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

**Still "smearing a bit" on fast window moves at a steady 50 Mbps** (the owner, after the gap tolerance). With
57 fps sent and the governor at its ceiling for five minutes, the remaining smear is bits: 50 Mbps over
3420x2214 is 6.6 bits per pixel-second against the 9.7 a 1080p Windows host gets at 20 Mbps, and the path
showed no delay-rise cut at all. So the menu gains 80 and 100 Mbps, and a 4K-class source starts at
`LARGE_SOURCE_AUTO_BPS`, 80 Mbps (the budget test's direct-path top moved with the menu). Windows 398, macOS
423. The owner's next drag test says whether 80 is enough; 100 is one click away in the menu.

**At 80 Mbps (build `6c3a16c8`, installed 09:25): the owner's word is "looks great."** The log: target 80000 kbps
at the ceiling for most of the run, 19 to 54 fps sent (the screen's own rate of change, rung 60fps/native
throughout), up to 12 Mbps on the wire over a ten-second window, a few cuts in the busiest spells (windows with
three or more drops) that climbed back to 80000 within half a minute. That answers 5.1's picture items: full
Retina, 60 fps where the screen moves, no smear the owner could see.

**The menu bar icon was under the notch** (the owner: "I don't see the menubar icon"). Measured over
accessibility, no screenshot: the item at x=927..963 on a 1710-point screen whose notch spans x=763..948
(`NSScreen.auxiliaryTopRightArea`); the bar is full and macOS creates a new item at the far left. On the rig, a
saved position of 1 (`NSStatusItem Preferred Position Item-0`, points from the right edge, in the app's own
defaults) and one app restart put it at x=1591, just left of the system's items. In the product (`6eb1b891`,
`menu_bar_position.rs`): on macOS, before the tray is built, the app saves that position when none is saved, and
never overwrites one. Desktop tests 150 on the Mac (the new one runs `defaults` against a scratch domain and
leaves nothing), 124 on Windows; not yet in an installed build, since an install would drop the owner's live
session for no visible change on the rig.

**Correction, 2026-10-02: Ctrl shortcuts are NOT on dev.** The log first said "ctrl acts as cmd" had been the
default on dev.owlette.app all along, and the owner was told so; the owner then reported that Ctrl+C and Ctrl+V
forward nothing. The ctrl-to-cmd mapping for a Mac host is this branch's own Task 2.4 (`b91adfae`):
`origin/dev`'s `keymap.ts` has no `modifierSwap`, so dev sends Ctrl as the Mac's Control key. The claim was made
from the branch's code without checking what dev serves (`git branch -r --contains b91adfae` answers it in one
line). Win+C outside fullscreen opens Copilot because Windows owns the key until keyboard lock, which rides
fullscreen.

**The pull request could not be merged or checked:** dev had moved 17 changes on, PR #256 was `CONFLICTING`,
and with no merge ref GitHub had run nothing but the Vercel preview on any recent push. `origin/dev` merged into
the branch (`6ef0fde1`): four conflicts, all where dev's escape-twice (`58a562b9`) landed on this branch's
`setModifierMapping`; the input capture and its tests keep both, the swoop page takes both imports, the process
editor keeps the Windows-only wrapper with dev's responsive grid. On the merged tree: tsc and eslint clean, jest
6333, streamer 398, agent 2126. The PR is `MERGEABLE` again and its checks are running.

**The first full check run on the merged branch:** everything green but one Playwright test and the two
alert-gated checks. The test was `e2e/specs/swoop/mac-host.spec.ts`, still reading the old keyboard menu (five
entries and a checkbox); it now reads the new one (six entries outside fullscreen, the two named settings, the
legend, the super-key note) (`c2a6df55`), and the suite passed 438 of 438 on the next run. `CodeQL` and `no live
vulnerability on this branch` were red only for alerts 388, 389 and 390 (`py/overly-permissive-file`).

**CodeQL 388, 389 and 390 dismissed on GitHub, 2026-10-02, on the owner's word ("Okay, yes, dismiss")** after
each was explained in plain terms, with the security review's reasons: 388 as *won't fix*, by design (0660
`root:_owlette` on the launch socket is what lets the console user's app connect; the gate is the daemon's
peer-uid and pinned-process check); 389 and 390 as *used in tests* (`fake_runner.py`, not shipped; 0640 matches
the production runner's mode). The security check was re-run and the PR shows 24 of 24 checks passing. This
closes the dismissal item the swoop-macos plan's Task 7.1 was carrying.

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

### 2026-10-02, the branch is on dev, and the browser's own clipboard question

- **PR #256 is merged into dev** on the owner's word ("can't you merge it?"): merge `a34b35e6`, 24 of 24 checks
  on the head `367d294e`, CodeQL 388/389/390 dismissed first. dev.owlette.app served `a34b35e6` at 18:40 UTC
  (`/api/health`). The viewer half of this plan (shortcuts match, the keyboard menu, the tab title, the stale
  clip guard) was on the branch only until then, which is why ctrl + c did nothing for the owner on dev.
- **The owner met Chromium's clipboard question** ("see text and images copied to the clipboard") in Brave and
  asked whether the docs say so and whether the viewer can speak up when it is not allowed. Neither was true.
  The cause: the viewer writes a copy from the machine the moment it lands, and a write with no user
  activation has Chromium ask for the site's clipboard permission. A block or a closed question left the copy
  waiting for the next gesture with nothing said. Nothing in the web app reads the clipboard
  (`navigator.clipboard.read` has no caller); the question comes from the write.
- **Fix:** the clipboard store reports `held()`, true while the browser refused the newest copy and false once a
  gesture takes it; a browser with no clipboard api is "unsupported", not a refusal. The session bar says "your
  browser held back the machine's copy: click the picture to take it, or allow the clipboard for this site".
  `web/content/docs/dashboard/swoop.mdx` has the paragraph, and its keyboard bullet now describes the two
  settings and the hold key in place of the checkbox that Wave 4 removed.
- Checks: jest 648 on the swoop suites and the toolbar (three new tests), eslint and tsc clean. No e2e: the
  emulator has no streamer, so nothing there can send a copy from a machine.
- *Changelog line:* "swoop says when your browser held back a copy from the machine, and the docs explain the
  browser's clipboard question."

### 2026-10-02, the owner's first session on the merged viewer

- **The owner's word on dev after the reload: "amazing - it works now!"** That is ctrl + c / ctrl + v on the Mac
  and the clipboard both ways, from dev.owlette.app at `a34b35e6`. The Playwright run for the merge on dev
  passed.
- **"hold cmd for the next key" did not work.** The stage gets keys only while it holds focus, and a closing
  menu hands focus to its own button, so the next key went to the button and cmd stayed down on the machine.
  Fix: after a sent key the menu's `onCloseAutoFocus` puts focus on the stage; a menu closed with nothing sent
  still returns to its button. With focus on the stage, the release of the enter that chose the item would
  have ended the hold at once, so the hold now ends only on the release that follows a key pressed after it
  (`armedKeyDown` in `input.ts`). Three tests failed first, then passed: jest 700 on the swoop suites.
- **The Mac app's menu said `TEC-MBA.local`** while the dashboard says `TEC-MBA`: the agent has taken its
  identity without the suffix since 4.0.6 and the app still showed the kernel's name. `tray.rs` `hostname()`
  now applies the same rule (`identity_name`), with a test. It reaches the Mac with the next install.
- *Changelog lines:* "the swoop keyboard menu hands the keyboard back to the picture after it sends a key, so
  'hold for the next key' takes your next key." and "macOS: the owlette app shows the machine's name as the
  dashboard does, without `.local`."
- **The quality menu is two levels** (the owner's idea: "submenus for bandwidth, resolution, etc."). Four
  rows, one per axis, each showing what is set, with the options a level down; "on reconnect" moved into the
  codec submenu. The eight bandwidth steps had made the flat menu twenty rows. Checks: three jsdom tests (new
  file), the swoop Playwright specs 6 of 6 locally with the menu asserted in `session.spec.ts`, and the
  rendered menu read from that run's trace.
- *Changelog line:* "the swoop quality menu shows one row per setting with its current value, and the options
  open beside it."

### 2026-10-02, the owner's second sitting

- Confirmed by the owner on dev (`3216218f`): audio, mute, lock screen, "hold cmd for the next key". Quitting the
  app kept the session up: the streamer outlived its parent, and then could not type (its Accessibility grant
  is the app's). Reopening picked an old app copy out of `~/src/owlette/agent/build/macos/work/` (Spotlight
  finds it), which answers `unsupported_job`, so every new session stayed at "connecting" until five failed
  spawns tripped `SPAWN_CEILING`. Cleared by killing that copy, `launchctl kickstart` of the installed app and
  of `app.owlette.agent`. Owed: a streamer that loses its app must exit.
- The swoop row of the machine menu wears `text-primary` in medium weight, alone in that menu, at the owner's
  ask ("the most visually apparent/attractive color").
- **The rest, at the owner's "please do the rest you're describing"** (2026-10-02 evening): the streamer ends
  its session (`restart`) when its parent is gone, checked once a second on the input thread
  (`platform::process::parent_gone`, false on Windows); the Mac's Command Line Tools are 26.6 and the
  installed app (`03bbac3b`, 21:09) is linked against SDK 26.5 for the macOS 26 corners, with the release's
  Mac job moved to `macos-26`; every "windows only" claim about the product corrected (landing, FAQ, titles,
  AI facts, project notes, the glib ack's reason); `@fastify/busboy` 3.2.2 for GHSA-xjh9-v7x6-24jw, which
  appeared today and blocked the security check. Decisions taken by the owner: version 4.1.0; 80 Mbps auto
  stays for large screens.
