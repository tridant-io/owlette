# hoot mcp setup — Context
**Last updated**: 2026-11-14

## Key files
**Create**
- `web/app/api/agent/fleet/grant/route.ts` — DELETE: a machine drops its own sender row
- `web/components/admin/AllowMachineCard.tsx`, `web/hooks/useFleetSettingsWrite.ts`
- `desktop/src-tauri/src/ai_tools.rs` — per-tool MCP config table, detect, ensure/remove
- `desktop/src-tauri/src/hoot_sync.rs` — polls `ipc/fleet/state.json`, reconciles tools, local hold
- `desktop/src/components/settings/*` — SettingsDialog, GeneralPage, HootMcpPage, PermissionsPage

**Modify**
- web: `app/api/agent/fleet/session/route.ts`, `app/api/agent/auth/device-code/route.ts`, `.../authorize/route.ts`, `hooks/useDeviceCodeAuthorize.ts`, `app/add/page.tsx`, `app/admin/hoot/page.tsx`, `components/admin/HootSiteSettings.tsx`, `components/FleetSendersEditor.tsx`
- agent: `src/fleet_session.py`, `src/owlette_service.py` (unpair → `withdraw(forget=True)`), `src/configure_site.py`, `src/auth_manager.py`, `owlette_installer.iss`
- desktop: `src-tauri/src/{commands,lib,agent_cli,seam}.rs`, `src/lib/ipc.ts`, `src/lib/hootMcp.ts`, `src/components/{AppMenu,JoinSiteDialog}.tsx`, `src/App.tsx`, `README.md`
- docs: `web/content/docs/agent/hoot-mcp.mdx`, `web/content/docs/dashboard/hoot.mdx`, `GLOSSARY.md`, ADR 0017, `docs/changelog.md`, `.claude/skills/build-system/installer-build-system.md`

**Delete**
- `desktop/src/components/ConnectAgentDialog.tsx` and its test

## Contracts
- Session 200: `{token, expiresAt, ttlSeconds, grant: {maxTier: 1|2|3, wholeSite: bool, machineIds: string[]}}`
- `DELETE /api/agent/fleet/grant` (agent token) → 200 `{dropped: bool}`; 401 / 429 as the session route
- Device code request body gains `wantsHoot: true`; authorize preview and success return `wantsHoot`
- `ipc/fleet/state.json`: `{granted, maxTier, wholeSite, machineIds, adminUrl}`; written only on a definite answer; unpair writes `granted:false`; service stop leaves it
- Agent CLI: `configure_site.py --hoot-off` (Windows, console user), seam verb `hoot_off` (macOS), `--wants-hoot` on `--json-progress` and the console pairing path
- Desktop launch: `owlette-desktop.exe --pair --server <env> --hoot`
- Host events: `hoot://tools-synced {granted, added, removed, failed}`; per-user choices `<app_data_dir>/hoot_tools.json {"off": [ids]}`
- Admin deep link: `/admin/hoot?site=<siteId>&machine=<machineId>`

## AI tool configs (researched 2026-11-14; re-verify a path on a real machine before calling it done)
| id | label | user config | shape |
| --- | --- | --- | --- |
| claude-code | claude code | via CLI: `claude mcp add -s user hoot -- <py> <script>`, `claude mcp remove -s user hoot`; status read-only from `~/.claude.json` `mcpServers.hoot` | CLI |
| claude-desktop | claude desktop | Win `%APPDATA%\Claude\claude_desktop_config.json` and MSIX `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude_desktop_config.json`; mac `~/Library/Application Support/Claude/claude_desktop_config.json`; Linux `~/.config/Claude/claude_desktop_config.json` | `mcpServers` |
| cursor | cursor | `~/.cursor/mcp.json` | `mcpServers`, `"type":"stdio"` |
| vscode | vs code | Win `%APPDATA%\Code\User\mcp.json`; mac `~/Library/Application Support/Code/User/mcp.json`; Linux `~/.config/Code/User/mcp.json` | `servers`, `"type":"stdio"` (JSONC possible) |
| windsurf | windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` |
| gemini | gemini cli | `~/.gemini/settings.json` (merge; holds other settings) | `mcpServers` |
| codex | codex | `$CODEX_HOME/config.toml` else `~/.codex/config.toml` | TOML `[mcp_servers.hoot]` command/args |

Detected on TEC-A4D (this box): claude code (`~/.local/bin/claude.exe`), vs code (`Code\User\mcp.json` exists), codex (`~/.codex`, no config.toml yet), Claude Desktop MSIX package present but no `LocalCache\Roaming\Claude` yet.

## Decisions
1. The admin panel's row is the only on/off; the machine follows. A machine can ask (switch on, installer box) but never grant itself (ADR 0017: grants are an owner/admin save; raising needs a second factor). It may drop its own row.
2. The desktop app writes AI tool configs, not the installer: the installer runs elevated or as SYSTEM, configs are per user, tools may be installed later.
3. Claude Code goes through its CLI because it rewrites `~/.claude.json` constantly; every other tool is a file edit. No new crates: serde_json is there, Codex's TOML is a text edit of one table.
4. Only an entry named `hoot` whose args end in `fleet_mcp.py` is ours; a different `hoot` is reported, never overwritten. A file that does not parse is never rewritten.
5. `state.json` changes only on a definite server answer; a missing file changes nothing in the tools. The keeper already wakes on `site_settings_refresh`, so admin changes land within ~1 minute.
6. Hoot off runs as a CLI mode (Windows) / seam verb (macOS), like dismiss reboot, not a service flag: the console user already holds the agent token on Windows, and the server's refresh tells the keeper. The host holds a local off until the state agrees.
7. Installer page skipped when silent, with `/ADD=`, or when no pairing follows; `ShouldConfigureSite` and the silent path are unchanged; ticked only appends a flag to the handoff.
8. No change to `firestore.rules`: the settings doc and device codes are written only by Admin SDK routes.
9. Linux: no hoot mcp page (no `hootMcpCommand`), no state file (keeper unsupported), no installer question.

## Coordination
- owlette-f8 carries hoot mcp release talk and cuts the installer release (4.2.2 or 4.3.0) after #420. Don't merge into dev before #420 merges unless the owner rules it rides along; ask at push time. Tell f8 when ready; this touches no rules.
- owlette-58: 4.2.1 is released; no overlap.

## Next steps
Run wave 1 (`/execute`), then waves 2–5, then `/verify`, then the owner's go for push and PR.
