# tri-platform agent — owner questions (RECONSTRUCTED 2026-09-17)

The original was a markdown table with one row per question, in the form `| 24 | … |`. It had a ruling cell that read `pending` until the owner ruled, plus an execution-assumption cell [verbatim: T#269's `rule_q24.py` parses `| 24 |` rows and replaces a `pending` cell; T#80 names the "execution assumption"]. Its other columns and their order are [unknown]. The table below keeps three cells.

Q1–Q22 existed by 2026-09-15 [verbatim: T#2 "`decisions.md` (Q1–Q22; Q19 ruled keep, Q20 ruled hold, Q9 extended; Q22 golden-image cloning)"]. Q23 and Q24 were added on 2026-09-16. Q-M1–Q-M3 were raised from the Mac and recorded in the handoff (H §16.6); whether they were folded into this file before the loss is [unknown].

| # | question | ruling | execution assumption / notes |
|---|---|---|---|
| 1 | [unknown] | [unknown] | Open at 2026-09-16 [verbatim: T#2 "Owner items still open: Q1–Q18"] |
| 2 | Involves "3.4.0". Probably the version the tri-platform agent ships as [inferred: T#2 "Q2 3.4.0"; the commit messages call the target "the 3.4 agent"] | pending [verbatim: T#2] | [unknown] |
| 3 | [unknown] | [unknown] | |
| 4 | Apple Developer Program: entity, team id, and the eight Apple CI secrets | pending: "the owner is enrolling; nothing signed or notarized before it" [verbatim: H §11] | Gates Task 0.6 and the signing half of 5.1; the unsigned build path can start [verbatim: H §9 step 9] |
| 5 | ScreenCaptureKit + the `image` crate, allowed only if spike 0.2's shell path fails | pending [verbatim: H §11] | No new crate without a ruling [verbatim: H §3]. The on-disk Wave 4 `Cargo.toml` in `w4a` adds `gdk = "0.18"` for Linux X11 capture, already in the tree through tauri-runtime-wry. Whether that needs an owner ruling was not settled [inferred: D] |
| 6 | Is `capabilities.screenCapture: 0` on macOS shippable if both capture paths fail? | pending [verbatim: H §11] | |
| 7 | [unknown] | pending [verbatim: T#2] | |
| 8 | [unknown] | pending [verbatim: T#2] | |
| 9 | Concerns the dev hooks in Task 5.6 (the deploy hook mirrors by relative path) | pending; "extended" on 2026-09-15 [verbatim: T#2] | The deploy hook cannot be used on this branch until 5.6: `shared_utils` imports `osadapter`, and the hook flattens subdirectories [verbatim: T#2] |
| 10 | [unknown] | [unknown] | |
| 11 | [unknown] | [unknown] | |
| 12 | The `_owlette` group (macOS) | pending [verbatim: H §11; T#2] | `posix.py` already uses `GROUP = '_owlette'` and `dseditgroup` on darwin [verbatim: H §4] |
| 13 | [unknown] | [unknown] | |
| 14 | Bulk deploy on POSIX. "Device codes are single-use and a golden image clones `machine_id` and the refresh token, so this preseed pairs one machine; bulk deploy is owner Q14" [verbatim: H §15 Task 3.7] | pending [verbatim: T#2] | |
| 15 | The Sequoia monthly Screen Recording re-prompt (spike 0.2 measures it) | pending [verbatim: H §11] | Mac research: the alert still ships on 26, and since 15.1 its date is refreshed by use. MDM PPPC cannot grant ScreenCapture; `forceBypassScreenCaptureAlert` hides the alert (15.1+, MDM only) [verbatim: H §16.3] |
| 16 | MDM enrolment of the target Macs | pending [verbatim: H §11] | Task 5.1 ships a `com.apple.servicemanagement` profile (TeamIdentifier + `LabelPrefix: app.owlette.`) [verbatim: H §15 Task 5.1]. See Q-M3 |
| 17 | [unknown] | pending [verbatim: T#2] | |
| 18 | [unknown] | [unknown] | |
| 19 | Dormant alert types. `_auth_manager` now derives from the Firebase client, which turns on the reboot-pending and connection-failure alerts (inert since 3.0.0). Keep them on? [verbatim: C:6ef1b057] | **RULED 2026-09-15: keep.** Owner: "keep it for Q19 - it should be fixed" [verbatim: T#2] | Owed: a changelog line for these alerts when 3.4 ships [verbatim: T#2] |
| 20 | Retiring `POST /api/agent/screenshot` on the web side (Task 1.3) | **RULED 2026-09-15: hold** until the 3.4 agent is the fleet floor. The web half is lifted into `patches/task-1.3-route-deletion.patch` (5 files, dry-applies cleanly); the route stays [verbatim: T#2; C:6ef1b057] | The patch file is lost with the folder. Recreating it needs the diff of the 5 files [unknown] |
| 21 | [unknown] | [unknown] | |
| 22 | Golden-image cloning: an image cloned after pairing carries `config/machine_id` and the refresh token [inferred: T#2 "Q22 golden-image cloning"; H §15 Task 3.7] | pending [verbatim: T#2] | |
| 23 | **POSIX self-update reporting.** The shipped code reaches the command row: `_self_update_worker` calls `FirebaseClient.finish_command` unconditionally when the handoff resolves, and `finish_command` marks the command failed on the `Error:` prefix (running → downloading → installing → completed/failed). Should a refusal (`update_unsatisfiable` / `update_deferred` / `update_handoff_failed`) get a **typed status of its own**, instead of riding inside the result string plus an `update_failed` site-log event? [verbatim in substance: T#105, the reworded form] | pending [verbatim: H §11] | Keep the reason in the string plus the site-log event; no wire change. Related: on POSIX, `update_owlette` releases the slow-command lane at acceptance (`COMMAND_DEFERRED`), so an install or roost command can run alongside a self-update (Log owner item (i)) [verbatim: T#105, T#103; H §11] |
| 24 | **startx-from-tty kiosks.** Should `osadapter.posix.console_user()` gain the desktop-app `/proc` fallback that `linux._session_type()` has? A startx kiosk (logind types it `tty`) captures and streams, but it launches nothing, hoot never spawns, and every privileged request is refused. The fallback would move the seam's trust from logind to the owner of a pid in the group-writable `tmp/tray.pid`, and it can only be verified on `owlette-kiosk` reconfigured off GDM. The greeter fix (`Class == 'user'`) excludes a tty-class session for the same reason it excludes the greeter. A GNOME logout removes the session within 26.6 ms (X11) / 4.8 ms (Wayland) of the display exiting (0/774 and 0/768 samples), so the teardown window is a `terminate-user` artefact only [verbatim in substance: T#105, T#169, T#202] | **RULED 2026-09-16: keep as is.** "startx-from-tty kiosks stay unsupported until logind (or an equally root-owned signal) can name the seat; the GDM path is proven on real hardware and the alternative would anchor the daemon's trust on a kiosk-writable file. Task 6.4 documents it: a display-manager login session (GDM/LightDM/SDDM) is required; a bare startx session is not a seat." [verbatim: T#269]. Owner's words: "Q24 - keep as is I guess? idk, we should do what makes the most sense here" [verbatim: T#264] | GDM kiosks (`Class=user`, x11) were fully proven on 2026-09-16 [verbatim: T#169]. Do not re-open it for macOS by anchoring on `tmp/tray.pid` [verbatim: H §11] |

## Questions raised from the Mac (H §16.6) [verbatim: H §16.6, HL]

| # | question | ruling |
|---|---|---|
| Q-M1 | How is an application uninstalled on macOS? | **Ruled 2026-09-16** (the owner deferred to the Mac's recommendation): quit the app, then remove its bundle as root. Only a bundle the inventory lists can be removed; pkg-installed extras are left behind. Shipped in `c2415865`. Still unverified: whether App Management lets the root daemon remove another developer's bundle (H §16.4 item 8). |
| Q-M2 | Mac architectures and OS floor | **Ruled 2026-09-16**: Apple silicon only; macOS 15.0 is the floor. |
| Q-M3 | MDM recommendations | **Decided on the Mac 2026-09-16**: Task 6.4's install docs get an optional MDM section (`forceBypassScreenCaptureAlert`, a `TeamIdentifier` managed-login-items rule). owlette never requires MDM. |

## Other owner rulings recorded outside the table

- **2026-09-16, crash alert on operator logout (Log owner item (y))**: "yes on suppress crash alert" [verbatim: T#280]. Shipped as `9fa1e069` [verbatim: C:9fa1e069].
- **2026-09-16, merge the Linux lane**: "yes merge to tri-platform-agent" [verbatim: T#264]. PR #167 merged as `47e5cae0`.
- **2026-09-16, CodeQL waivers**: the five by-design group-bit alerts (359/360/361/363/364) were waived in `.github/security-acks.json` (`dd7b5106`) and expire 2027-03-16. Alerts 354–356 were waived earlier (`62686311`) [verbatim: T#269; C:dd7b5106, C:62686311].
- **2026-09-16, OS on the machine card and list**: the OS string replaces the clock line under the hostname in card view, and the timezone city moves into the clock tooltip [verbatim: T#327]. Shipped as `f56487b8`.
