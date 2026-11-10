# fleet mcp — Context
**Last updated**: 2026-11-10

Line numbers are from dev at 293f5d08 and drift; treat them as "about here".

## Key Files

### Create (web)
- `web/lib/fleet/policy.server.ts` — grant parser and loader (`sites/{siteId}/settings/fleet`)
- `web/lib/fleet/session.server.ts` — mint, verify and revoke fleet sessions (`fleet_sessions/{sha256}`)
- `web/lib/fleet/catalog.server.ts` — the tool catalog a machine caller sees
- `web/lib/fleet/handler.server.ts` — the request wrapper for the fleet routes
- `web/lib/fleet/dispatch.server.ts` — start a call, read a call, `list_machines`
- `web/lib/commandStatus.server.ts` — the pending/completed lookup, extracted from the public poll route
- `web/lib/actions/setFleetSettings.server.ts`
- `web/app/api/sites/[siteId]/fleet-settings/route.ts`
- `web/app/api/agent/fleet/session/route.ts`
- `web/app/api/agent/fleet/tools/route.ts`
- `web/app/api/agent/fleet/call/route.ts`
- `web/app/api/agent/fleet/calls/[callId]/route.ts`
- `web/hooks/useFleetSettings.ts`
- `web/components/FleetSendersEditor.tsx`
- `web/__tests__/rules/fleet.test.ts`, `web/__tests__/lib/fleet/*.test.ts`, `web/__tests__/api/fleet/*.test.ts`, `web/e2e/specs/fleet-settings.spec.ts`

### Create (agent, desktop, docs)
- `agent/src/fleet_session.py` — the keeper
- `agent/src/fleet_mcp.py` — the stdio MCP server (never name a file `mcp.py`: it shadows the package; `mcp_tools.py` already exists and is hoot's tool table)
- `agent/tests/unit/test_fleet_session.py`, `test_fleet_mcp.py`, `test_mcp_surface.py`
- `desktop/src/components/ConnectAgentDialog.tsx`
- `docs/adr/0017-a-granted-machine-acts-on-its-site-through-the-server.md`
- a docs page under `web/content/docs/agent/` (file name follows the feature's final name)

### Modify
- `web/lib/capabilities.ts` — `Actor` union (types ~97-124), `hasCapability` (~233-275), a new capability
- `web/lib/auditLog.server.ts` — the separate `AuditActor` union (~42-54), `redactActorForLog` (~292), `actorRoleLabel` (~304)
- `web/lib/rateLimit.server.ts` — `Bucket` (~110), limits (~40, ~80), `bucketForActor` (~128), `actorIdentifier` (~133), `rateLimitSubjectKey` (~139), `rateLimitedReasonForActor` (~149)
- `web/lib/actions/auditActor.server.ts` (~12), `web/app/api/_shared.ts` (~291) — audit-string builders
- other places that switch on `actor.type`, touched only if `tsc` demands a branch: `web/lib/authorizedHandler.server.ts` (`authToActor` ~250, `auditActorRoleLabel` ~428), `web/lib/systemInvoker.server.ts` (`validateActor` ~181), `web/lib/talons/store.server.ts` (~283, ~303), `web/lib/talons/engine.server.ts` (~239), `web/lib/swoop/policy.server.ts` (~181), `web/lib/actions/deleteSite.server.ts` (~103)
- `web/app/api/sites/[siteId]/machines/[machineId]/commands/[commandId]/route.ts` — its lookup moves to `commandStatus.server.ts`
- `web/app/api/sites/[siteId]/agent-tokens/revoke/route.ts`, the machine-removal action, `web/lib/actions/deleteSite.server.ts` — session cleanup
- `web/components/ManageSitesDialog.tsx` (`SiteSettingSwitch` ~70, `SiteSettingsSwitches` ~117)
- `web/scripts/validate-openapi.ts` (`INTERNAL_ROUTES`), `web/__tests__/api/auditMutationCoverage.test.ts`
- `agent/src/owlette_service.py` — start and trigger the keeper (off-loop worker pattern ~2677-2778)
- `agent/src/acl_hardening.py` — a spec row for `ipc\fleet` (`_build_specs` ~123-188)
- `agent/src/osadapter/posix.py` — the session file's ownership and mode (wave 7)
- `desktop/src/components/AppMenu.tsx` (~165-247), `desktop/src-tauri/src/commands.rs`, `desktop/src-tauri/src/lib.rs`, `desktop/src/lib/ipc.ts`
- `GLOSSARY.md`, `README.md`, `docs/changelog.md`, `web/content/docs/reference/firestore-data-model.mdx`

### Never touch
`firestore.rules`, `agent/owlette_installer.iss`, `.claude/hooks/`, `.claude/settings.json`, `.tokens.enc`.

## Decisions

1. **The machine principal lives only on `/api/agent/fleet/*`.** `authorizedSiteHandler` (`web/lib/authorizedHandler.server.ts` ~485) resolves a user (`resolveSiteAccess` ~591, `authToActor` ~612) and its context types the actor as `UserActor` (~140). An agent ID token passes `requireSessionOrIdToken` (`web/lib/apiAuth.server.ts` ~114) but dies at `resolveSiteAccess` with `user_inactive`. Widening that wrapper would touch every action core; a separate wrapper touches none.
2. **A fleet session, not the agent token.** The script needs fleet access only, so it gets a credential that is good for nothing else: opaque, fleet-only, 15 minutes, stored hashed, deleted on any grant change. This is about scope and revocation, not a refresh race: two processes rotating one agent token both keep a working token (checked against the refresh route on 2026-11-10). A process that holds the agent token without the service's unpair hook does clear the token store when a refresh is refused (`agent/src/auth_manager.py` ~450-455), which is right for a revoke and one more reason the script holds no agent token.
3. **One mechanism on three platforms.** On Windows the logged-in user could read the token store; on macOS and Linux it cannot (`agent/src/secure_storage.py` ~51, mode 0600). A file the service writes for the user works the same everywhere.
4. **The grant is one settings document.** `sites/{siteId}/settings/{settingId}` is already readable by site members and writable only by the server (`firestore.rules` ~852-857), so the dashboard can listen to it with no rules change. Pattern to copy: swoop settings (`web/lib/swoop/policy.server.ts` ~138-170, `web/lib/actions/setSwoopSettings.server.ts` ~105, `web/app/api/sites/[siteId]/swoop-settings/route.ts`, `web/hooks/useSwoopSettings.ts`).
5. **Targets reuse machine-scope.** `web/lib/machineAccess.ts` (`parseMachineIds`, `scopeCovers`, `normalizeMachineIdsInput`, `MAX_MACHINE_SCOPE`) comes from `feat/machine-scope`. For a member, an absent list means the whole site, to keep old rows working. A granted machine is a new principal with no such history, so its grant is explicit: a `machineIds` list, or `wholeSite: true`. A missing or malformed list is nothing. `scopeCovers(null, id)` is true, so the parser hands it null only for `wholeSite: true`.
6. **Every machine tool goes through `executeMachineCommand`** (`web/lib/actions/executeMachineCommand.server.ts`), never the chat path's direct write (`executeToolOnAgent`, `web/lib/hoot-utils.server.ts` ~784). That gives the allowlist, the plan gate, the offline check and the audit emission. Its override check accepts only `user:` and `apiKey:` actors (~183), so `machine:` is refused an active-hours override with no new code.
7. **The fleet handler checks the target's hoot switch itself** (`isHootEnabled`, `web/lib/hoot-utils.server.ts` ~503-518) and the tier against the grant, before queuing.
8. **Start, then poll.** The status lookup in the public poll route (`.../commands/[commandId]/route.ts`) is extracted and shared. `callId` is `cmd:<target>:<commandId>` for a command and `task:<chatId>:<turnId>` for a hoot task; the client treats it as opaque and the server re-checks the grant on every read.
9. **One machine per call.** Hoot's fan-out sends identical parameters to every target (`web/lib/hoot-utils.server.ts` ~2197-2216) and no tool takes a machine argument. A required `machine` argument per call is simpler than a call document that tracks several commands.
10. **The script is generic.** Tool definitions and the result envelope come from the server, so the surface grows without an agent release. The result envelope is `{ content: [{ type: 'text', text } | { type: 'image_url', url }] }` from day one.
11. **`ask_hoot` uses the talon shape**, not the conversations API: create the chat doc, `acquireTurnLock`, `startTurn`, cancel the stream (`web/lib/talons/hootOutput.server.ts` ~267-439). The key comes from `resolveSiteKeyOwner` (~325). The tier is capped by `unattendedToolTier` (max 2): with the site's tier-3 approval on, a tier-3 call would wait for an approval nobody can give.
12. **Rate limits are per machine.** The system bucket's key has no site in it (`web/lib/rateLimit.server.ts` ~139-141), so a system actor would share one bucket across every site. The machine bucket's key carries site and machine.

## Facts from research (2026-11-10)

- Hoot's catalog: 52 tools, tiers 17/24/11 (`web/lib/mcp-tools.ts` ~63-1388, `allTools` ~1390). 11 run on the server (`SERVER_SIDE_TOOLS`, `web/lib/hoot-utils.server.ts` ~53); 41 go to a machine, 7 of them as existing command types (`EXISTING_COMMAND_MAPPINGS`, `mcp-tools.ts` ~1423). 13 are Windows-only (`agent/src/mcp_tools.py` ~217).
- The target picks up `commands/pending` every 2 s, backing off to 5 s when idle (`agent/src/firebase_client.py` ~961-981). `mcp_tool_call` runs on its own thread (~1613). Results merge into the one `commands/completed` document (~1901-1942). Output is capped at 50,000 characters per stream (`mcp_tools.py` ~62). `MAX_SCRIPT_TIMEOUT` is 3300 s.
- Agent ID tokens carry `role: 'agent'`, `site_id`, `machine_id`; uid is `agent_<site>_<machine>`. The strictest existing check is `agentClaims` (`web/app/api/agent/swoop/_shared.ts` ~42-54).
- The `mcp` package ships in all three payloads. Windows ships both `python.exe` and `pythonw.exe`; a stdio server needs `python.exe`. The Windows build wipes and reinstalls site-packages on every install.
- Installed layout: Windows `C:\ProgramData\Owlette\python\python.exe` and `C:\ProgramData\Owlette\agent\src\`; macOS `/Library/Application Support/Owlette/runtime/python/bin/python3` and `.../runtime/agent/src/`; Linux `/opt/owlette/python/bin/python3` and `/opt/owlette/agent/src/`. No wrapper or PATH entry exists.
- On macOS the runtime is inside the data root, mode 750 `root:_owlette`; on Linux `/var/lib/owlette` is 750 `root:owlette`.
- Measured on the kiosk VM (Linux, agent 4.1.27) on 2026-11-10, which answers part of gate 0.4: the service runs as root; the console user is in the service group `owlette`; that user can run `/opt/owlette/python/bin/python3` and import the agent's modules; the data root is 750 `root:owlette`, `ipc/` and `tmp/` are 770, `logs/` is 750, `.tokens.enc` is 600 root. macOS is not measured.
- Precedent for the session file: the local hoot fix on branch `fix/local-hoot-posix-auth` has the service publish its access token to `ipc/cortex_token.json`, mode 0640 `root:<service group>`, written with `shared_utils.open_new_file` and `shared_utils.grant_data_group` and refreshed from the 5-second tick when it changes. Task 7.1 should write the session file the same way.
- The POSIX request seam (`agent/src/configure_site.py` ~1445-1900, `desktop/src-tauri/src/seam.rs`) is not used by this plan. Its one-shot nonce is shared with the desktop app and an unknown verb falls through to a leave (~1865); do not add verbs to it for this feature.
- Desktop app: no settings screen. The menu is `desktop/src/components/AppMenu.tsx`; dialogs to copy are `ReportIssueDialog.tsx` and `JoinSiteDialog.tsx`; `copyText` is in `desktop/src/lib/clipboard.ts`. The frontend only knows the data root (`commands.rs` ~32); the install root (`paths.rs` ~95-107) and `PYTHON_REL` (`agent_cli.rs` ~53) need a new command.
- A turn's status is at `chats/{chatId}/stream/current` (`running | complete | error | superseded | cancelled`, `web/lib/hoot/turnStore.server.ts` ~35). A running turn older than 45 s is dead. `complete` is written before the messages are saved (`web/lib/hoot/turnRunner.server.ts` ~764 then ~774), so a reader waits for the assistant message whose `metadata.hoot.turnId` matches.
- `startTurn` has no audit-actor passthrough (~621): server-side tools in a machine-started turn would be attributed to the key owner. Task 9.1 adds it.
- A chat is readable by its `userId` only (or `source == 'autonomous'`), so a machine-started chat shows in the key owner's dashboard and nobody else's.
- Three places enforce who may import `invokeAsSystem` and must change together if a fleet module ever needs it: `web/eslint.config.mjs` (~97-136), `scripts/check-system-invoker-callers.mjs`, `ALLOWED_CALLER_PATTERNS` (`web/lib/systemInvoker.server.ts` ~114). This plan does not use `invokeAsSystem`.
- `web/__tests__/api/auditMutationCoverage.test.ts` fails a mutating route that uses no known wrapper, no `emitMutation`, and is not exempt.
- `web/scripts/validate-openapi.ts` only warns for an undocumented route; agent-facing routes go in `INTERNAL_ROUTES`.
- The dev deploy hook (`.claude/hooks/deploy-agent.mjs`) copies an edited `agent/src/*.py` to the installed tree by basename, raises a UAC prompt and restarts the service each time.

## Session file contract (tasks 4.1 and 4.2 must agree)

`<data root>/ipc/fleet/session.json`, written atomically (`.tmp` then `os.replace`):

```json
{ "token": "owf_…", "expiresAt": 1731250000, "apiBase": "https://dev.owlette.app/api", "siteId": "…", "machineId": "…" }
```

`expiresAt` is epoch seconds. No file means no grant, no pairing, or a service too old to write one.

## Fleet API contract (tasks 3.1 and 4.2 must agree)

The session route is the one the agent calls, with its own ID token:

- `POST /api/agent/fleet/session` → `200 { "token": "owf_…", "expiresAt": <epoch seconds>, "ttlSeconds": 900 }`, or `403 fleet_not_granted`

The other three take `Authorization: Bearer <fleet session token>`.

- `GET /api/agent/fleet/tools` → `{ "tools": [{ "name", "description", "inputSchema" }], "site": { "id" }, "machine": { "id" } }`
- `POST /api/agent/fleet/call` with `Idempotency-Key`, body `{ "tool": "…", "params": { "machine": "…", … } }` → `200 { "status": "completed", "content": [...] }` for a tool the server answers itself, or `202 { "callId": "…", "timeoutSeconds": <number> }`
- `GET /api/agent/fleet/calls/{callId}` → `{ "status": "pending" | "in_progress" | "completed" | "failed", "content"?: [...], "error"?: "…" }`

Rules the script relies on, so that new tools and new result kinds never need an agent release:

- **How long to wait is the server's to say.** `timeoutSeconds` in the 202 is how long this call may run. The script polls for that long plus 30 seconds (capped at an hour plus 30), or 90 seconds when the field is absent. It never infers a bound from a tool's arguments.
- **Every content item may carry `text`.** Known kinds are `text` and `image_url` (`{ "type": "image_url", "url": "https://…", "text": "…" }`). A script that does not know an item's `type` shows its `text`, so a new kind degrades to words, not to nothing.
- **A terminal read is the last one.** The server deletes the result when it hands over a `completed` or `failed` status, to keep the machine's one results document small. A repeat of that read answers 404, which the script reports as a result it could not collect. A 429 or a 5xx on a poll is a dropped poll: the script keeps polling.
- **`callId` is opaque and arrives percent-encoded** in the poll path, colons included (`cmd%3Amachine-2%3Aabc`). The route decodes it.
- **A refusal on any fleet route is remembered** by the script and shown by `fleet_status`, so an assistant can see why it has no tools.

Errors are RFC 7807 problems with a `code`: `fleet_session_invalid` (401), `fleet_not_granted`, `tool_not_allowed`, `machine_not_granted` (403), `hoot_disabled`, `machine_offline` (409), `plan_required` (402).

## Next Steps

1. Run gate 0.1. If machine-scope is not on dev, gates 0.2–0.4 can still run; wave 1 waits.
2. Get the owner's ruling on the name before task 3.2 (UI copy), 4.3 (docs, glossary) and 5.2 (desktop copy).
3. Wave 1 in a worktree off dev, with its own `npm ci` (a node_modules junction breaks Turbopack).
4. Nothing is pushed without the owner's word. Web waves must be on dev before task 4.1's on-device check and wave 5.
