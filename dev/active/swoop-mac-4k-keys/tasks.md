# Tasks: swoop on macOS, 4K at 60 and the keyboard model

Progress: 0/11. Branch `swoop/macos`, worktree `Owlette-swoop-mac-wt`. Standing rules of `../swoop-macos/plan.md`
apply (the four Windows commands, the macOS commands, nothing pushed to dev or main). Mac worktrees
`~/src/owlette-swoop-mac-21` (streamer) and `-23` (desktop) on the rig; `~/src/mac-build-install.sh` builds,
notarizes and installs.

## Wave 1: the encoder

- [ ] **Task 1.1: VideoToolbox without low-latency rate control, delivering from its callback** `[agent]`
  - Files: `agent/swoop/src/encode/videotoolbox/mod.rs`, `agent/swoop/src/encode/mod.rs`, `agent/swoop/src/session/mod.rs` (the capture pass only)
  - Do: On macOS open the session without `EnableLowLatencyRateControl` (the fallback order stays for a session that cannot encode). Add `Encoder::set_sink` with a no-op default; the VideoToolbox backend hands each finished frame to the sink from `on_output`, in callback order, Annex-B'd there, and `encode()` only submits (no `CompleteFrames`). The session gives each tier's encoder a sink that sends `FromWorker::Frame`; `force_irap` clears on an accepted submit for a sink backend. The hardware test gains the paced-60 run at the panel's size and prints throughput, submit time and submit-to-callback latency.
  - Done when: the macOS commands are green; the hardware test shows 60.0 fps paced at the panel's size with none dropped and latency under 20 ms p95; the four Windows commands are green and `git diff` touches no Windows backend's behaviour.

## Wave 2: the picture

- [ ] **Task 2.1: Capture at the pixel rect again** `[agent]`
  - Files: `agent/swoop/src/capture/sck.rs`, `agent/swoop/src/cursor/mac.rs`, `agent/swoop/src/platform/macos.rs`
  - Do: Revert the point-size capture and picture grid (`adf65040`, `2cfbef4a`) so the stream is the display's pixels, the cursor is drawn at the panel's scale and reported in pixels. Keep `picture_size` only if something still uses it.
  - Done when: the capture hardware test opens at 3420x2214; the cursor hardware test's shapes are 2x again; the macOS commands are green.
  - Depends on: 1.1

- [ ] **Task 2.2: 50 Mbps auto for a 4K-class source** `[agent]`
  - Files: `agent/swoop/src/session/quality.rs`, `agent/swoop/src/session/mod.rs`
  - Do: `Ceiling::default()` for a source above 2.5 megapixels starts at the menu's top rate; the governor's floor and descent are untouched. Unit test both sides of the threshold.
  - Done when: the four Windows commands and the macOS commands are green; a 1080p source still defaults to 20 Mbps.
  - Depends on: 1.1

## Wave 3: the clipboard

- [ ] **Task 3.1: Never re-push a clip the host already has** `[agent]`
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
