# hoot drives a machine through swoop — Context
**Last updated**: 2026-10-11

## Key Files

### Create
- `web/app/api/sites/[siteId]/machines/[machineId]/swoop/hoot-session/route.ts`
- `docs/adr/0013-hoot-drives-a-machine-as-a-viewer-a-human-authorized.md`
- `agent/swoop/src/banner/{mod,win,mac}.rs`, `agent/swoop/src/image/` (encoder shared with clipboard)
- `web/e2e/specs/hoot/drive.spec.ts`
- `dev/active/hoot-drives-swoop/spike-g0.md`

### Modify
- Web policy and session: `web/lib/swoop/policy.server.ts`, `web/lib/swoop/sessionStore.server.ts`, `web/lib/actions/setSwoopSettings.server.ts`, `web/hooks/useSwoopSettings.ts`, `web/lib/swoop/audit.server.ts`
- hoot: `web/lib/mcp-tools.ts`, `web/lib/hoot-utils.server.ts`, `web/lib/hoot/turnRunner.server.ts`, `web/app/api/hoot/stop/route.ts`, `web/app/api/hoot/autonomous/route.ts`, `web/lib/talons/hootOutput.server.ts`, `web/app/hoot/components/ToolCallCard.tsx`, `web/hooks/useHoot.ts`
- Dashboard: `web/components/MachineContextMenu.tsx`, machine card, `web/app/admin/swoop/page.tsx`, `web/hooks/useFirestore.ts`
- Agent: `agent/src/swoop_commands.py`, `agent/src/swoop_manager.py`, `agent/src/owlette_service.py`, `agent/src/swoop_spawn.py`, `agent/src/swoop_spawn_posix.py`, `agent/src/screenshot_capture.py`
- Streamer: `agent/swoop/src/ipc.rs`, `session/mod.rs`, `viewers/roster.rs`, `viewers/input.rs`, `capture/mod.rs`, `gpu/mod.rs`, `gpu/vt_transfer.rs`, `encode/select.rs`, `clipboard/wic.rs`, `PROTOCOL.md`
- Desktop app: `desktop/src-tauri/src/tray.rs`, `seam.rs`, `paths.rs`
- Docs: `GLOSSARY.md`, `docs/adr/0009-*.md` (pointer), `web/content/docs/dashboard/{hoot,swoop}.mdx`, `web/content/docs/agent/system-tray.mdx`, `web/content/docs/reference/firestore-data-model.mdx`, both changelogs, `docs/roadmap.md`

## Decisions

1. **hoot is a viewer in a normal swoop session, joined over the service→streamer stdin pipe.** Not WebRTC (decoder, non-human token, same-machine exemption) and not a separate capture/input path (re-implements every gate). The pipe already carries the bundle and keys and cannot be written from user space.
2. **Grant = `sites/{s}/settings/swoop.hootMachineIds`**, default empty, written only by `setSwoopSettings` under `SWOOP_SETTINGS_MANAGE` (bypass-exempt, API keys refused). Not `cortexEnabled` (defaults on; the agent can write the machine doc). Removal fans out a kill; renewal re-checks the list.
3. **A human step-up per drive, in the chat approval card**, through the existing step-up window (7 days, 5-minute fresh-sign-in rule). hoot never produces a ceremony; the route never accepts a proof in the body for a hoot drive.
4. **Stills on request, not video.** JPEG at most 1280 px wide, through the existing signed-URL upload, wrapped as an image for the model like `capture_screenshot`.
5. **Hoot-only mode** skips encoder selection and the room dial when no human is present, so non-NVIDIA Windows machines can be driven; a human joining later starts both.
6. **Blocking audit per action**, actor = the authorizing admin, never the typed text (length only). Start and end rows bracket it. Admins get a reader on `/admin/swoop`.
7. **Limits hoot cannot lift**: drive tools only in the dashboard chat runtime (never local hoot, autonomous, talons, follow-ups); tier-3 shell/file/registry/reboot tools refused on a machine hoot is driving; hoot input dropped off the Default desktop (lock screen, UAC); no tool writes settings; `cortex_autonomous` keeps no `MACHINE_REMOTE_CONTROL`.
8. **Stops**: tray "stop hoot" (Windows flag file, macOS seam verb), the streamer banner points at it, dashboard stop button on the machine card (`POST …/swoop/kill`), and `/api/hoot/stop` opened to site admins for a drive turn.
9. **ADR 0013 amends 0009 and PROTOCOL §5**, written in wave 1 before code lands: a human enables, verifies, approves and can stop; API keys still never start a session.
10. **Windows and macOS only.** Linux ships no streamer.

## Open questions for the owner

- Should a drive outlive the chat turn (hoot keeps control across several turns in one chat until `release_machine` or stop), or end with every turn? Plan assumes: ends with the turn unless `drive_machine` was called with `keepDriving`, capped by the lease.
- Banner wording and whether it should also show who authorized ("authorized by rosco").
- Whether the tier-3 shell refusal while driving is too strict for real use.

## Next Steps

1. Wave 0 on this box: the still spike (0.1), the hoot-only analysis (0.2) and the `swoopViewers` verification (0.3). Numbers decide the readback thread and whether task 1.6 is real.
2. Then wave 1 (all web) can run in parallel with the streamer work of wave 2, since they share no files.
3. The Mac needs its ssh grants back before 2.2's macOS half and 5.4.
