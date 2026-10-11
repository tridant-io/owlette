# hoot drives a machine through swoop — Tasks
**Progress**: 0/22 complete

Rules every task obeys: glossary words (hoot, viewer, session, step-up, kill; say "hoot drives" or "hoot in control", never "remote control"); lowercase UI copy; no new packages without asking; never touch `firestore.rules` without asking; never log typed text; Windows and macOS only.

## Wave 0: Gate — measure before building

- [ ] **Task 0.1: Streamer still path spike (Windows)**
  - Files: `agent/swoop/src/ipc.rs`, `agent/swoop/src/session/mod.rs`, `agent/swoop/src/capture/mod.rs`, `agent/swoop/src/gpu/mod.rs`, `agent/swoop/src/clipboard/wic.rs`, `dev/active/hoot-drives-swoop/spike-g0.md` (new)
  - Do: Behind a `cfg(feature = "spike")` or a debug-only control line, add `still {"path": "<file>"}` on stdin: copy `Live.copy` (the last captured frame) into a D3D11 staging texture, `Map`, encode with the WIC encoder from `clipboard/wic.rs` as JPEG (quality 80, downscaled to at most 1280 px wide), write to the path, answer `still_result {"ok", "ms", "bytes"}` on stdout. Run it on this box with a real session open and measure: time from control line to file, whether the capture thread stalls (frame interval before/after), file size. Try 10 stills in a row.
  - Done when: `spike-g0.md` records the numbers and names the thread the readback should live on; the spike code is reverted or left behind the flag.

- [ ] **Task 0.2: Hoot-only mode feasibility (no encoder, no room)**
  - Files: `agent/swoop/src/session/mod.rs` (the `drive()` codec gate at ~1238-1250 and the room dial at ~1512-1547), `agent/swoop/src/encode/select.rs`, `dev/active/hoot-drives-swoop/spike-g0.md`
  - Do: Read-only analysis plus a local experiment: force the codec gate and the room dial to be skipped when the bundle carries `hoot` and no human viewer is present; confirm capture can start on demand (`CaptureGate`) without a roster viewer holding it, and that `SharedInput::accept` can be reached by a roster viewer the service added. Note every place that assumes a room or an encoder exists (status, lingering, kill). Do not merge.
  - Done when: `spike-g0.md` lists the exact code sites to change for hoot-only mode and any blocker.

- [ ] **Task 0.3: Verify the `swoopViewers` badge and the `session_started` host event**
  - Files: `web/lib/swoop/sessionStore.server.ts` (~400-410), `web/app/api/agent/swoop/events/route.ts` (~212), `agent/swoop/src/ipc.rs` (`HostEventKind`), `agent/src/swoop_manager.py`
  - Do: Open a real session on this box against dev and read the `swoop_sessions/{sid}` doc and the machine's `swoopViewers` field. If the session never reaches `live` and the badge stays 0, write up the fix (emit `session_started` when the first viewer joins, or compute `live` from `viewer_joined`) as task 1.6's input.
  - Done when: a note in `spike-g0.md` with the measured doc state and the badge value, and task 1.6 either confirmed or struck.

## Wave 1: Grant, policy, session, audit, ADR (web)

- [ ] **Task 1.1: `hootMachineIds` in the site's swoop settings**
  - Files: `web/lib/swoop/policy.server.ts` (`parseSwoopSettings`, `SwoopSettings`), `web/lib/actions/setSwoopSettings.server.ts`, `web/app/api/sites/[siteId]/swoop-settings/route.ts`, `web/hooks/useSwoopSettings.ts`, `web/__tests__/lib/swoop/policy*.test.ts`, `web/__tests__/api/swoop/swoop-settings.test.ts` (or the existing settings test file)
  - Do: Add `hootMachineIds: string[]` (default `[]`) beside `excludedMachineIds`. Parse defensively (array of non-empty strings, deduped). `setSwoopSettings` accepts it under the same capability; when a machine leaves the list, fan out `swoop_kill` to that machine (reuse the `enabled` fan-out). Emit `site_mutated` with `hootMachineIds` changes (ids only). The hook exposes it.
  - Done when: unit tests cover parse defaults, write, removal-triggers-kill; API keys still refused; eslint and tsc clean.

- [ ] **Task 1.2: Policy — the hoot viewer kind and the drive grant**
  - Files: `web/lib/swoop/policy.server.ts`, `web/lib/swoop/sessionStore.server.ts`, `web/__tests__/lib/swoop/policy*.test.ts`, `web/__tests__/lib/swoop/sessionStore*.test.ts`
  - Do: `evaluateSwoopAccess` gains `intent: 'hoot_drive'`: refuses API keys (as today), requires `enabled`, machine not excluded, machine in `hootMachineIds`, `MACHINE_REMOTE_CONTROL`, and an open step-up window for (user, site, machine) — never a fresh ceremony from a proof in the body, never continuity. Session viewers gain `kind: 'human' | 'hoot'` (default human) and `chatId` for hoot. `evaluateLeaseRenewal` re-runs the hoot checks (including the allow-list) on every renewal. A kill, a `revokeSwoopSessionsForUser`, or the allow-list removal ends hoot sessions like any other.
  - Done when: tests for every refusal (member, API key, machine not allowed, no step-up window, machine offline) and for renewal refusing once the machine leaves the list.

- [ ] **Task 1.3: `POST …/swoop/hoot-session` and `DELETE` (release)**
  - Files: `web/app/api/sites/[siteId]/machines/[machineId]/swoop/hoot-session/route.ts` (new), `web/lib/swoop/audit.server.ts`, `web/__tests__/api/swoop/hoot-session.test.ts` (new), `web/app/api/openapi` spec if routes are listed there (`scripts/validate-openapi*` runs in CI)
  - Do: Browser session only (`authorizedSiteHandler`, API keys refused with the same problem code as sessions). Body `{chatId, toolCallId}`. Order: policy (1.2) → machine online → blocking `recordSwoopHootDriveStarted` (actor user, target machine, metadata `{sid, chatId, toolCallId}`) → `createSwoopSession` with the single hoot viewer → ring + queued `swoop_session_requested` command carrying `hoot: {sid, chatId}` (bundle route passes it through) → 201 `{sid}`. `DELETE` with `{sid}` ends the session (`hoot_drive_ended`, reason `released`). Both idempotent per `toolCallId`.
  - Done when: route tests for the happy path, each refusal, idempotency, and that the audit row precedes the session doc (a failing audit write yields 503 and no session).

- [ ] **Task 1.4: Audit events for hoot driving**
  - Files: `web/lib/swoop/audit.server.ts`, `web/content/docs/reference/firestore-data-model.mdx`, `web/__tests__/lib/swoop/audit*.test.ts`
  - Do: Add `hoot_drive_started`, `hoot_action`, `hoot_drive_ended` to `SwoopAuditEvent`. `recordSwoopHootAction` is blocking: actor = the authorizing `UserActor`, capability `MACHINE_REMOTE_CONTROL`, target `swoop_session`, metadata `{sid, chatId, toolCallId, kind: look|click|type|key|scroll|release, x?, y?, button?, keyChord?, textLength?}`; never the text itself. Document the rows.
  - Done when: tests assert shape, blocking behaviour, and that `text` never appears in metadata.

- [ ] **Task 1.5: ADR 0013 and glossary**
  - Files: `docs/adr/0013-hoot-drives-a-machine-as-a-viewer-a-human-authorized.md` (new, one paragraph in the 0001 format), `docs/adr/0009-swoop-is-our-own-webrtc-streamer.md` (one line pointing at 0013), `GLOSSARY.md` (hoot section: **Drive session**, **hoot in control**; swoop Viewer entry gains the hoot kind), `agent/swoop/PROTOCOL.md` §5 (ctl for the `hoot` viewer is set by the service over stdin, argued)
  - Do: State the amendment: swoop stays human-in-the-loop because a human admin enables the machine, passes the step-up, approves each drive in the chat and can stop it from the machine or the dashboard; API keys still never start a session; the stdin pipe is the service's own channel, so a ctl set there is as trusted as the bundle's keys. Name what is still forbidden (local hoot, autonomous, talons, follow-ups, secure desktop).
  - Done when: ADR in the house format, glossary terms added with _Avoid_ lines, PROTOCOL §5 updated, `node scripts/sync-repo-refs.mjs --check` passes if it checks ADR links.

- [ ] **Task 1.6: `session_started` so a drive (and any session) reads `live`**
  - Files: per task 0.3's note; likely `agent/swoop/src/session/mod.rs` (emit on first `viewer_joined`), `agent/swoop/src/ipc.rs`, `agent/src/swoop_manager.py`, `web/app/api/agent/swoop/events/route.ts`, tests on both sides
  - Do: Make the session doc reach `live` when the first viewer (human or hoot) joins, so `swoopViewers` and the dashboard badge are true. If 0.3 found it already works, mark this task done with the evidence.
  - Done when: a real session on this box shows `state: live` and a non-zero badge; unit tests for the event.

## Wave 2: Agent and streamer

- [ ] **Task 2.1: Streamer control lines `hoot_join`, `hoot_leave`, `still`, `input`**
  - Files: `agent/swoop/src/ipc.rs`, `agent/swoop/src/session/mod.rs`, `agent/swoop/src/viewers/roster.rs`, `agent/swoop/src/viewers/input.rs`, `agent/swoop/PROTOCOL.md` §6, streamer unit tests
  - Do: stdin: `hoot_join {"sid","chatId"}` adds roster viewer `hoot` with ctl (a dedicated constructor, not a generic setter; the bundle must carry `hoot.sid` matching, or the line is refused and logged). `hoot_leave` removes it and releases held keys. `input {"id", "action"}` where action is one of the five existing wire shapes (`k`,`m`,`mr`,`b`,`w`) plus `t` (text: per-character mapping to the existing key path, ASCII and common Unicode via the platform's unicode injection where the injector supports it) — routed through `SharedInput::accept` as viewer `hoot`, answered with `input_result {"id","ok","reason"}`. `still {"id","maxWidth"}` → `still_result {"id","ok","path","w","h","ms"}` writing a JPEG into the streamer's tmp dir (the service deletes it after upload). Drop every hoot `input` while the input desktop is not `Default` (reason `secure_desktop`). stdout `status` gains `hoot: {active, chatId, since}`.
  - Done when: unit tests for refusal without a matching sid, secure-desktop drop, held-key release on leave; `cargo clippy` clean; PROTOCOL updated.

- [ ] **Task 2.2: Hoot-only mode and the still readback (Windows + macOS)**
  - Files: per task 0.2's list; `agent/swoop/src/session/mod.rs`, `agent/swoop/src/encode/select.rs`, `agent/swoop/src/capture/mod.rs`, `agent/swoop/src/gpu/mod.rs`, `agent/swoop/src/gpu/vt_transfer.rs`, `agent/swoop/src/clipboard/wic.rs` (extract the encoder into `agent/swoop/src/image/` shared by clipboard and stills), new macOS BGRA transfer + ImageIO JPEG path
  - Do: When the bundle carries `hoot` and no human viewer is present: skip encoder selection and the room dial, keep lingering and kill semantics, run capture on demand per `still` (acquire one frame, release). When a human joins later, start the encoder and dial as today. Readback on the thread task 0.1 named. Downscale to `maxWidth`.
  - Done when: a Windows box without NVIDIA (or NVENC disabled by env) serves stills and input; the Mac serves stills; frame interval for a concurrent human viewer is unchanged within noise (measured, numbers in the task log).

- [ ] **Task 2.3: Service relay — `swoop_hoot_action`, still upload, status, stop flag**
  - Files: `agent/src/swoop_commands.py`, `agent/src/swoop_manager.py`, `agent/src/owlette_service.py` (`_swoop_section`, local-config watcher for `tmp/hoot_stop.flag`), `agent/src/swoop_spawn.py` + `swoop_spawn_posix.py` (pass `hoot` through the bundle unchanged), `agent/src/screenshot_capture.py` (reuse the signed-URL upload as a function taking bytes), `agent/tests/unit/test_swoop_commands*.py`, `test_swoop_manager*.py`
  - Do: Command `swoop_hoot_action {sid, id, action}`: refuse unless the manager's current session sid matches and the streamer reported `hoot.active`; relay as `input` or `still`; on `still_result` upload the JPEG through the screenshot upload path (no history entry, no `lastScreenshot` write), delete the file, return `{url, w, h}`; return `input_result` as the command result. Keep it on the fast lane (`mcp_tool_call` precedent). `hoot_stop.flag` (Windows) and the macOS seam verb `stop_hoot` → `manager.hoot_stop()` → `hoot_leave` + POST a `hoot_stopped_local` host event so the web ends the drive and the turn. `_swoop_section` writes `hoot` into `service_status.json` and its signature.
  - Done when: unit tests for sid mismatch, inactive hoot, still upload path, flag handling; the full agent suite green.

## Wave 3: hoot tools and the approval card (web)

- [ ] **Task 3.1: Tool definitions and executors**
  - Files: `web/lib/mcp-tools.ts`, `web/lib/hoot-utils.server.ts` (`buildExecutableTools`, `toModelOutput` for `screen_look`, the drive-session context per chat), `web/lib/hoot/turnRunner.server.ts` (end the drive when the turn ends unless `keepDriving` was set by `drive_machine`), `web/__tests__/lib/mcp-tools.test.ts`, `web/__tests__/lib/hoot-utils*.test.ts`
  - Do: Tier 3 tools: `drive_machine {machineId, reason}` (opens the drive through 1.3; the approval card handles step-up, see 3.2), `screen_look {maxWidth?}` → image, `screen_click {x, y, button?, double?}` (normalized 0..1 coordinates of the still, as the wire expects), `screen_type {text}`, `screen_key {chord}` (e.g. `ctrl+s`, mapped to `KeyboardEvent.code` sequences), `screen_scroll {x, y, dy}`, `release_machine`. Each action: look up the chat's live drive (sid, authorizing uid), write the blocking `hoot_action` row, dispatch `swoop_hoot_action`, map `input_result.reason` to a model-readable error (`secure_desktop`, `not_driving`, `machine_offline`). Exclude all seven from autonomous (`buildAutonomousTools`), talons (`hootOutput.server.ts` tier cap), follow-ups (`forceTier3Approval` already blocks unattended tier 3; add an explicit exclusion) and local hoot (`cortex_tools.py` never registers them; add a surface test). Tool descriptions must say what they need (an admin's verification) and the limits (no lock screen, no UAC).
  - Done when: `ALL_EXPECTED` / `EXPECTED_TIER3` updated; tests prove each unattended path has no drive tool; a `screen_type` audit row never carries the text.

- [ ] **Task 3.2: Approval card with the swoop step-up**
  - Files: `web/app/hoot/components/ToolCallCard.tsx`, `web/components/swoop/SwoopStepUpDialog.tsx` (reuse; may need a `onVerified` without navigation), `web/hooks/useHoot.ts`, `web/app/api/hoot/route.ts` (the resume path), tests under `web/__tests__/components/hoot/` and `web/__tests__/api/hoot*`
  - Do: For `drive_machine`, the approval banner reads "let hoot drive <machine>? you verify in your browser first" and runs `GET …/swoop/step-up` for the machine; if no window is open it shows the step-up dialog and only then posts the approval response. If the route still answers `step_up_required` (window closed between), the card re-arms instead of consuming the one-shot ledger. The card for each later action shows the action in words ("click at 42%, 61%", "type 12 characters", "press ctrl+s") and never the text.
  - Done when: component tests for both orders (window open, window missing), and the ledger is consumed only on a successful drive start.

- [ ] **Task 3.3: Limits while driving, and the admin stop**
  - Files: `web/lib/hoot-utils.server.ts` (tool gate), `web/app/api/hoot/stop/route.ts`, `web/lib/hoot/turnRunner.server.ts`, `web/lib/capabilities.ts` (comment only: no new system capability), `web/__tests__/api/hoot/stop.test.ts`, `web/__tests__/lib/hoot-utils*.test.ts`
  - Do: While the chat holds a live drive on machine M, refuse `run_command`, `run_powershell`, `run_python`, `execute_script`, `write_file`, `registry_operation`, `deploy_software`, `reboot_machine`, `shutdown_machine` on M with a model-readable reason ("release the machine first"). `/api/hoot/stop` accepts a site admin or owner (not only the chat owner) when the chat has a live drive: it ends the drive (`DELETE` hoot-session, reason `admin_stop`) and cancels the turn, audited with the admin as actor. The swoop kill route already ends the session; make the turn notice (`hoot_drive_ended` host event or the session doc's `endReason`) and finish with "an admin stopped hoot".
  - Done when: tests for the tool gate, the admin stop, and the turn ending on a kill.

## Wave 4: Indicator and stop on the machine and the dashboard

- [ ] **Task 4.1: Tray — "hoot is driving this machine" and "stop hoot"**
  - Files: `desktop/src-tauri/src/tray.rs`, `desktop/src-tauri/src/paths.rs`, `desktop/src-tauri/src/seam.rs` (macOS verb `stop_hoot`), `desktop/README.md`, `agent/tests/unit/test_tray_*`
  - Do: Read `swoop.hoot` from `service_status.json`. Show a row "hoot is driving this machine" and the same in the tooltip, and a toast "owlette — hoot is driving this machine" whenever it turns on, regardless of the site's `indicator` policy. Menu item "stop hoot" (Windows: `tmp/hoot_stop.flag`; macOS: seam verb). Keep "kill all swoop sessions" as is. Fix the comments that call the tray kill "audited".
  - Done when: driven on this box, the row, toast and stop work; `cargo fmt` touches only this crate's changed files (restore anything else); the e2e for the tray is manual, recorded in the task log with a screenshot.

- [ ] **Task 4.2: On-screen banner from the streamer**
  - Files: `agent/swoop/src/banner/mod.rs` (new), `agent/swoop/src/banner/win.rs`, `agent/swoop/src/banner/mac.rs`, `agent/swoop/src/session/mod.rs`
  - Do: While the hoot viewer holds control, show a small always-on-top, click-through banner at the top centre: "hoot is driving this machine · stop in the owlette tray". Windows: a layered topmost window owned by the streamer's thread on the Default desktop only (never created on Winlogon; hidden when the desktop switches). macOS: an `NSPanel` at status-bar level (the streamer is the app's child, so it may draw). Removed on `hoot_leave`, kill or exit. No text input, no buttons (the stop lives in the tray and the dashboard).
  - Done when: visible in a screenshot on both platforms, gone within one second of stop; it never appears for human-only sessions.

- [ ] **Task 4.3: Dashboard — "hoot is driving" badge and stop button**
  - Files: `web/components/MachineContextMenu.tsx`, the machine card component the `swoopViewers` pill renders in (find via `swoopViewers`), `web/lib/swoop/sessionStore.server.ts` (`swoopViewers` gains `hoot: boolean`), `web/hooks/useFirestore.ts` mapping, `web/app/admin/swoop/page.tsx` (show the hoot viewer and its chat), tests
  - Do: When the machine's live session has a hoot viewer: badge "hoot is driving", and for admins a "stop hoot" item in the machine menu that calls `POST …/swoop/kill` (existing route) with a confirm. `/admin/swoop` lists the hoot viewer with the authorizing user and a link to the chat.
  - Done when: component tests; the e2e in 5.2 covers the button.

- [ ] **Task 4.4: Audit reader for drive rows**
  - Files: `web/app/api/sites/[siteId]/swoop/sessions/route.ts` or a new `…/swoop/sessions/[sessionId]/audit/route.ts`, `web/app/admin/swoop/page.tsx`, tests
  - Do: Admins can read the `hoot_drive_started`, `hoot_action`, `hoot_drive_ended` rows for a sid (ordered by `timestamp`), shown under the session on `/admin/swoop`. Smallest possible reader; the chat transcript stays the user-facing record.
  - Done when: route test for admin-only read and the page renders rows.

## Wave 5: Tests, docs, proof

- [ ] **Task 5.1: Unit coverage sweep and the no-unattended-path proof**
  - Files: tests across `web/__tests__/`, `agent/tests/unit/`, `agent/swoop` tests
  - Do: One test file that asserts, from the real tool tables, that no autonomous, talon, follow-up or local-hoot path can see a drive tool, and that `SystemCapabilityMatrix.cortex_autonomous` lacks `MACHINE_REMOTE_CONTROL`. Agent: command refused when `hoot.active` is false; streamer: input dropped off the Default desktop.
  - Done when: full `npx jest`, agent suite and `cargo test` green.

- [ ] **Task 5.2: E2E — grant, approval with step-up, action audit, stops**
  - Files: `web/e2e/specs/hoot/drive.spec.ts` (new), `web/e2e/helpers/stubAgent.ts` (stub `swoop_hoot_action` results), fixtures
  - Do: Seed a site with swoop on and the machine in `hootMachineIds`; as admin, start a chat, trigger `drive_machine`, complete the step-up in the card, see a stubbed still, click, and the audit rows; stop from the dashboard button; as a member, the tool is refused; with the machine removed from the list mid-drive, the next action fails and the drive ends.
  - Done when: green locally on shifted ports and in CI.

- [ ] **Task 5.3: Docs and changelog**
  - Files: `web/content/docs/dashboard/hoot.mdx` (new section "hoot drives a machine"), `web/content/docs/dashboard/swoop.mdx` (the grant and the stop), `web/content/docs/agent/system-tray.mdx` (fix the banner claim at :115; add "stop hoot"), `docs/changelog.md`, `web/content/docs/changelog.mdx` (or wherever the second changelog lives), `docs/roadmap.md` (move the item to done)
  - Do: Plain description of what it does, who can enable it, what hoot can never do, how to stop it, what is logged. Lowercase copy rules.
  - Done when: docs build; the audit says what the rows contain.

- [ ] **Task 5.4: Real-machine proof on this box and the Mac**
  - Files: `dev/active/hoot-drives-swoop/tasks.md` log
  - Do: On this Windows box against dev: enable, drive (open notepad, type, save), stop from the tray, stop from the dashboard, check the audit rows, lock the screen and confirm hoot input is dropped. On the Mac: the same minus the lock test (needs the ssh grants). Record screenshots and the audit row ids.
  - Done when: both logs written; anything unverified is named as such.

## Log
### 2026-10-11
- Research done by three readers (hoot runtime, streamer viewer/input path, permission/indicator/audit precedents); plan written; no code started. Two side findings for issues: the `swoopViewers` badge may always read 0 (task 0.3 verifies), and `system-tray.mdx:115` / `tray.rs:176` claim a banner that does not exist.
