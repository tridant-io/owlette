# hoot mcp setup — Plan
**Created**: 2026-11-14 | **Status**: Active
**Branch**: `feat/hoot-mcp-setup` in worktree `Owlette-hoot-setup-wt` (cut from origin/dev 8ebed729, after 4.2.1)
**Agreed design**: https://claude.ai/artifact/SxcJK2qtqtm6aw1iwvdCrL (owner: "looks good, proceed", 2026-11-14)

## Summary
Setting up hoot mcp today means copying a command into each AI tool and asking an admin to grant the machine in four steps. This change makes the admin panel's machine row the only on/off: the machine follows it, and the desktop app adds hoot to (or removes it from) every AI tool it finds for the signed-in user. A new settings window replaces three menu rows and holds a hoot mcp switch that asks an admin (on) or drops the machine's own grant (off). The Windows installer gets one optional question that carries the ask into pairing.

## Approach

**One rule: the admin panel decides, the machine follows.**
1. Server. `POST /api/agent/fleet/session` also returns the grant (`grant: {maxTier, wholeSite, machineIds}`). A new `DELETE /api/agent/fleet/grant` lets a machine drop its own sender row: lowering only, audited as `machine:<id>`, revokes its fleet sessions, sends itself `site_settings_refresh`. The device code carries `wantsHoot` from the agent's request to `/add`. Admin → hoot takes `?site=&machine=` and shows an allow card that turns the site switch on and adds the row in one PATCH.
2. Agent. The session keeper writes `ipc/fleet/state.json` (no secret: granted, tier, reach, adminUrl) only on a definite server answer: 200 or refusal, never a network failure, 429 or malformed body. Unpair writes `granted:false`; a service stop leaves it alone. `configure_site.py --hoot-off` (Windows, run as the console user like `--dismiss-reboot`) and the seam verb `hoot_off` (macOS) call the drop route. `--wants-hoot` threads into the device-code request.
3. Desktop host (Rust). `ai_tools.rs` knows each tool's user-level config: Claude Code via its CLI (`claude mcp add/remove -s user`, it rewrites `~/.claude.json` constantly), JSON `mcpServers` for Claude Desktop (both the `%APPDATA%` and the MSIX `Packages\Claude_*\LocalCache\Roaming` locations), Cursor, Windsurf and Gemini CLI, JSON `servers` for VS Code, and a text-edited `[mcp_servers.hoot]` table for Codex (no new crates). It touches only an entry named `hoot` whose args point at `fleet_mcp.py`, and never rewrites a file it cannot parse. `hoot_sync.rs` polls `state.json` every 10 s and reconciles the found, ticked tools when the grant changes (and every 5 minutes, to heal tools that rewrite their own config). A missing state file changes nothing.
4. Desktop UI. A settings dialog with pages general (appearance, start on login), hoot mcp (switch, grant summary, tool tickboxes, copy command; hidden where `hootMcpCommand()` is null, i.e. Linux) and permissions (macOS). The menu loses appearance, start on login and connect an ai agent; ConnectAgentDialog goes. Switch on: confirm, then open `adminUrl` and show "waiting for a site admin". Switch off: confirm, run `hoot-off`, remove hoot from the tools at once and hold `granted:false` locally until `state.json` agrees.
5. Installer (Windows). A page "AI tools" with one unticked checkbox, skipped when silent, with `/ADD=`, or when no pairing will follow (`not ShouldConfigureSite()`). Ticked appends `--hoot` to the desktop handoff and `--wants-hoot` to the console fallback; whether and how pairing runs does not change.

**Decisions (owner, 2026-11-14):** all seven tools, each untickable; switch off also drops the admin's row; a mac permissions page; no mac installer question.

## Waves
See `tasks.md`. W1: server, agent and the Rust tool table, in parallel. W2: desktop host sync and `/add`. W3: settings dialog and installer. W4: wiring and removal. W5: docs.

## Risks
- **Claude Desktop rewrites its config while running** and the MSIX build reads a virtualised path. We write both locations when present and the 5-minute reconcile re-applies; the copy tells people to restart the tool.
- **VS Code's mcp.json allows comments.** serde_json refuses them, so we report "could not edit" and leave the file alone rather than strip a person's comments.
- **Stale grant after hoot off.** The keeper only learns on its next ask (≤60 s after the server's refresh), so the host holds a local off until `state.json` says false, otherwise the reconcile would put hoot back.
- **Upgrade path (ADR 0006).** On self-update the old service and old app run; the page is skipped (silent). A machine already granted gets hoot added to its tools by the new app after upgrade; that is the rule, not a regression.
- **deploy-agent hook.** Any Edit/Write on an `agent/src/*.py` path, even in this worktree, copies into the installed agent and restarts the service with UAC. Agent edits are scripted.
- **Merge timing.** #420 promotes dev to prod as is; this does not merge into dev before #420 unless the owner rules it rides. The agent half needs an installer release, cut by owlette-f8.

## Success criteria
- Admin allows a machine (deep link or editor) → within ~1 minute its found AI tools list hoot's tools for the signed-in user; admin turns it off → gone.
- Switch off in the app → the admin panel row is gone, the tools lose hoot at once, the state agrees within a minute.
- Windows installer: box ticked → pairing's `/add` success offers "allow it to use hoot" → the allow card; silent and `/ADD=` installs and upgrades never show the page.
- Unit tests (web Jest, agent pytest, desktop vitest + cargo test), lint and typecheck green; Playwright covers the allow card and the `/add` offer.
- Owed after merge to dev: proof on TEC-A4D (install ticked → pair → allow → a fresh Claude Code session lists hoot's tools → admin off → gone) and on the Mac (switch on and off).
