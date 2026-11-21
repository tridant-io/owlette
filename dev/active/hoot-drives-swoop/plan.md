# hoot drives a machine through swoop — Plan
**Created**: 2026-10-11 | **Status**: Active (research done, not started)

## Summary

With an admin's explicit authorization, hoot sees a machine's screen and sends it clicks, keys and scroll through the swoop streamer, so it can operate any app on the machine, not only the processes owlette manages. hoot joins a normal swoop session as a viewer, so every gate a human viewer passes (site enablement, control capability, step-up, lease, kill, the streamer's control gate, audit) applies to it unchanged. The owner's four rules (roadmap, 2026-09-30) are the acceptance criteria: off by default and per machine; a visible indicator plus a one-click stop on the machine and in the dashboard; every action logged with the authorizing user; limits hoot cannot lift itself.

## What the research established (2026-10-11)

- **hoot today**: three runtimes. The dashboard chat runs server-side (`web/lib/hoot/turnRunner.server.ts`); each agent-bound tool call is a `commands/pending` doc of type `mcp_tool_call`. Local hoot runs on the agent through the Claude CLI, outside the web approval gate. Autonomous runs and talons use the web runtime with no approval. hoot has `capture_screenshot` (about 55 s, uploads, every platform) and no input path at all. Approval is tier-only (`needsApproval: tier >= 3`, `hoot-utils.server.ts:1876`), per call, one-shot ledger. The kill switch `cortexEnabled` is checked only when a turn starts; only the chat owner can stop a turn (`/api/hoot/stop`). Audit of user-mode tool calls is the deletable site log only.
- **swoop today**: the streamer is SYSTEM in the console session (Windows) or the desktop app's child (macOS). The only seam between service and streamer is stdin/stdout (`agent/swoop/src/ipc.rs`); unknown control lines are ignored; the service refuses a streamer of another version, so the pipe can grow without skew. Input is gated by the roster: only a viewer with `ctl` set by `Roster::verify` from a JWT (`viewers/roster.rs:128-141`). The streamer has no still path (frames are GPU handles) and exits 13 on Windows without NVENC before capture starts. No overlay exists on the machine; the tray shows a row, a tooltip and a toast. The Windows tray kill closes no step-up window and is logged only to the deletable logs feed. The dashboard has no per-machine stop button. Decision audit rows have no reader. A non-relayed local peer is refused (`same_machine`).
- **Settled decisions touched**: ADR 0009 (swoop is a human-in-the-loop surface; an API key can never start a session), PROTOCOL §5 (ctl comes from the verified JWT), ADR 0003 (no listening sockets), ADR 0005 (no unattended UAC). This plan argues an amendment of 0009 and §5, not a reversal: a human admin enables the machine, passes the step-up, approves the drive in the chat, and can stop it at any time; API keys still never start a session.

## Approach

### Data flow

1. **Grant** (once per machine): a site admin adds the machine to `sites/{s}/settings/swoop.hootMachineIds` from the machine menu or the site's swoop settings. Written only by `setSwoopSettings` (`SWOOP_SETTINGS_MANAGE`, bypass-exempt, API keys refused). Removing a machine fans out a kill.
2. **Drive session** (per chat): hoot calls the tier-3 tool `drive_machine`. The approval card in the chat shows the swoop step-up ("verify in your browser", reusing `SwoopStepUpDialog`) when the user has no open step-up window for that machine. The approval response posts to `POST /api/sites/{s}/machines/{m}/swoop/hoot-session` (browser session only, `MACHINE_REMOTE_CONTROL`, machine in `hootMachineIds`, step-up window open, machine online). The route writes a blocking `hoot_drive_started` audit row (actor = the user), creates a `swoop_sessions` doc whose single viewer is `{viewerId: 'hoot', uid, ctl: true, kind: 'hoot', chatId}`, mints no JWT, rings the machine with the sid. The grant is bound to (user, machine, chat); it is renewed like a lease (5 min, authorization re-run server-side by the service's renewal call) and ends on turn end, `release_machine`, kill, revocation or chat deletion.
3. **Agent**: the doorbell ring starts the streamer as today (bundle carries `hoot: {sid, chatId}`); the service sends `hoot_join` on stdin. The streamer adds a roster viewer `hoot` with ctl set from that line (the pipe is the service's own trusted channel; argued in ADR 0013). In **hoot-only mode** (no human viewer) the streamer skips encoder selection and the room dial, so Windows machines without NVENC can be driven; capture runs on demand per still.
4. **Actions**: each hoot tool call (`screen_look`, `screen_click`, `screen_type`, `screen_key`, `screen_scroll`, `release_machine`) is a `commands/pending` doc of type `swoop_hoot_action` carrying `sid` and the action. The agent's `swoop_commands` router relays it as a stdin control line; the streamer validates the viewer and the desktop, injects through `SharedInput::accept` or renders a still (staging readback of `Live.copy`, JPEG at most 1280 px wide), and answers on stdout. Stills go through the existing signed-URL upload; the command result carries the URL, and the web wraps it as an image for the model (`toModelOutput`, like `capture_screenshot`). Before completing each action the web writes a blocking `hoot_action` audit row.
5. **Indicator and stop**: the streamer's `status` line gains `hoot: {active, chatId, since}`; the service writes it into `service_status.json`; the tray shows "hoot is driving this machine" (row, tooltip, toast regardless of the site's indicator policy) and a menu item "stop hoot" (Windows flag file; macOS seam verb). The streamer draws a small always-on-top banner while hoot holds control. The dashboard machine card shows "hoot is driving" with a stop button (`POST …/swoop/kill`, admin), and `/api/hoot/stop` accepts a site admin for a drive turn.
6. **Limits**: drive tools exist only in the dashboard chat runtime (never local hoot, autonomous, talons, follow-ups). While a drive session is live on a machine, tier-3 shell, file and registry tools are refused on that machine (they run as SYSTEM and could kill the indicator). The streamer drops hoot input whenever the input desktop is not `Default` (lock screen, UAC). hoot has no tool that writes settings or opens a step-up; `SystemCapabilityMatrix.cortex_autonomous` keeps no `MACHINE_REMOTE_CONTROL`.

### Key decisions

1. **Through the streamer's stdin pipe, not WebRTC and not a separate capture path.** WebRTC would need a decoder in hoot, a non-human token mint and a same-machine exemption; a separate path would re-implement enablement, step-up, lease, kill and audit. The pipe already carries the bundle and keys and is unforgeable from user space.
2. **The grant lives in the site settings doc, not on the machine doc.** `cortexEnabled` defaults on and the agent can write the machine doc; `settings/swoop` is service-account-only and read by `evaluateSwoopAccess` at every lease renewal.
3. **A human step-up per drive, inside the chat approval card.** hoot can never produce a ceremony; the existing 7-day window and 5-minute fresh-sign-in rule apply, so an admin who just verified for a manual session is not asked twice.
4. **Stills, not video.** JPEG on request keeps the model's context small and needs no encoder, which is also what makes non-NVIDIA Windows machines drivable.
5. **Hoot-only mode skips the room.** A human may still join the same session from the dashboard (the streamer then dials and encodes as usual); hoot's roster entry is unaffected.
6. **Audit rows are blocking.** No row, no action, the same discipline as `recordSwoopSessionStarted`.
7. **Windows and macOS only.** Linux ships no streamer; the plan does not add one.

### Integration points

- Web: `web/lib/swoop/policy.server.ts` (`parseSwoopSettings`, `evaluateSwoopAccess`, lease), `web/lib/actions/setSwoopSettings.server.ts`, `web/lib/swoop/sessionStore.server.ts` (viewer `kind`), `web/lib/swoop/audit.server.ts` (new events), `web/lib/mcp-tools.ts` + `web/lib/hoot-utils.server.ts` (tools, `toModelOutput`, tier cap while driving), `web/app/hoot/components/ToolCallCard.tsx` (approval card with step-up), `web/app/api/hoot/stop/route.ts`, `web/components/MachineContextMenu.tsx`, `web/app/admin/swoop/page.tsx`.
- Agent: `agent/src/swoop_commands.py` (`swoop_hoot_action`), `agent/src/swoop_manager.py` (stdin relay, still upload, status), `agent/src/owlette_service.py` (`_swoop_section`, `hoot_stop.flag`), `agent/src/screenshot_capture.py` (upload reuse).
- Streamer: `agent/swoop/src/ipc.rs`, `session/mod.rs` (hoot-only mode, `Still`, `Inject`), `viewers/roster.rs` (service-set ctl for the hoot viewer), `viewers/input.rs` (desktop check), `capture/mod.rs` + `gpu/` (readback), `clipboard/wic.rs` (PNG/JPEG encode reuse), a new `banner/` module, `PROTOCOL.md`.
- Desktop app: `desktop/src-tauri/src/tray.rs`, `seam.rs` (macOS `stop_hoot` verb), `paths.rs`.
- Docs: ADR 0013, `GLOSSARY.md` (hoot drive, drive session), `web/content/docs/dashboard/hoot.mdx`, `swoop.mdx`, `agent/system-tray.mdx` (fix the banner claim), both changelogs.

## Waves

See `tasks.md`. Wave 0 is a gate: the streamer still path and hoot-only mode measured on this box before anything else is built.

## Risks

- **Still latency on Windows**: a D3D11 staging copy plus Map plus JPEG should be under 100 ms; if the readback stalls the capture thread, stills need their own thread. Wave 0 measures it.
- **macOS readback**: NV12 to BGRA needs a `vt_transfer` conversion or CoreImage; the Mac is only reachable with its ssh grants back on.
- **Approval card + step-up**: the chat's approval response is one-shot (ledger); the step-up dialog must complete before the response posts, or the route answers `step_up_required` and the card must re-arm. The e2e covers both orders.
- **Banner window on Windows from a SYSTEM process in the console session**: a layered topmost window is fine on the default desktop; it must not be created on Winlogon. On macOS the streamer is the app's child, so an `NSPanel` is allowed.
- **`swoopViewers` badge**: research suggests the `session_started` host event that marks a session `live` is never emitted, so the badge may always read 0 (`sessionStore.server.ts:408`, `events/route.ts:212`). Verify live and fix in wave 1, or the dashboard stop button never appears.
- **ADR 0009 amendment**: write it before the code lands; a reviewer applying the review discipline will otherwise file the whole feature as a contradiction.

## Success criteria

- A site admin turns the grant on for one machine, asks hoot in the dashboard chat to open an app and click a button, verifies in the browser once, and watches hoot do it from the machine's screen, with the tray toast, the banner and the dashboard "hoot is driving" badge showing throughout.
- "stop hoot" in the tray, the dashboard stop button and the admin's `/api/hoot/stop` each end the drive within one second, and the turn reports it.
- `sites/{s}/audit_log` holds one `hoot_drive_started`, one row per action with the admin as actor and no typed text, and one `hoot_drive_ended`.
- A member without admin, an API key, local hoot, an autonomous run, a talon and a follow-up each fail to obtain a drive session (unit tests), and a locked machine ignores hoot input (streamer test).
- Works on a Windows machine without NVIDIA (hoot-only mode) and on the Mac; Linux reports `unsupported_on_platform`.
- ADR 0013, glossary, docs and changelog updated; e2e for the grant, the approval with step-up, the stop paths and the audit rows green in CI.
