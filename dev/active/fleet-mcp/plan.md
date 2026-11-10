# fleet mcp — Plan
**Created**: 2026-11-10 | **Status**: Active

"fleet mcp" is a working name. The owner has not named the feature yet (assumption 4), so the name must not reach UI copy or public docs.

## Summary

An AI agent running on a paired machine (Claude Code, or anything else that speaks MCP) launches a small script that ships with the agent and gets owlette's tools for the machines in its site. The machine's pairing is the credential: no API key and no CLI. The web server decides what that machine may do from a per-site grant; the script only lists tools and calls them.

The owner's goal is a comprehensive fleet control system with two front doors to the same tools: the dashboard chat, and this.

## Bad news first

- **36 tasks in 14 waves.** The first release line is after wave 6: Windows, hoot's machine tools, one machine per call.
- **Waves 1 and later wait for machine-scope.** `feat/machine-scope` rewrites the access core (`web/lib/capabilities.ts`, `web/lib/sitePolicy.server.ts`, the actor builders) and was not on dev on 2026-11-10. This plan adds an actor type to the same files and reuses machine-scope's `machineIds` helpers, so it builds on dev with machine-scope merged.
- **macOS and Linux are unmeasured.** On macOS the bundled interpreter sits in a directory a user outside the service group cannot enter. Gate 0.4 measures both platforms before wave 7 builds anything.
- **The name blocks the UI copy, the glossary entry and the docs page** (tasks 3.2, 4.3, 5.2).
- **Any process in the logged-in user's session can use the machine's grant.** Nothing on the machine can tell the script from another process run by the same user. The grant, the tier cap, the audit log and the instant cut bound it (assumption 2, ADR 0014).

## Approach

### Principal
- A new actor type, `{ type: 'machine', siteId, machineId, maxTier, targets }`, exists only on new routes under `/api/agent/fleet/`. The existing site routes are untouched: `authorizedSiteHandler` assumes a user throughout (`ctx.actor.userId` is read across the action cores), so the fleet routes get their own wrapper.
- A machine actor holds two capabilities, `MACHINE_VIEW` and `MACHINE_EXEC_COMMAND`, on its own site only. It never holds a site-wide capability and never carries an active-hours override (ADR 0013).

### Credential
- The script never sees the agent token. It needs fleet access and nothing else, and on macOS and Linux the token store is the service's alone.
- The service asks the server for a **fleet session**: an opaque token valid for 15 minutes and accepted only by the fleet routes. The service writes it to `ipc/fleet/session.json`, readable by the logged-in user, and renews it every 10 minutes off the 5-second loop.
- The server stores only the token's SHA-256, in the top-level collection `fleet_sessions`. Removing a grant, switching the site off, revoking a machine's agent token or removing the machine deletes its sessions, which cuts a live client on its next call.

### Grant
- One document per site, `sites/{siteId}/settings/fleet`: `{ enabled, senders: { [machineId]: { maxTier, targets } } }`. Off by default.
- `maxTier` is hoot's tool tier (1 reads, 2 bounded changes, 3 privileged), default 2. `targets` is a machine-scope `machineIds` list; absent means the whole site.
- A target with hoot switched off (`cortexEnabled: false`) refuses fleet calls, so the existing per-machine switch is also the per-target switch.
- A new site-wide capability, `FLEET_SETTINGS_MANAGE` (owner and site admin), gates the settings route. API keys cannot change the grant.

### Catalog and calls
- The server serves the catalog. It is built from hoot's tool definitions (`allTools` in `web/lib/mcp-tools.ts`): the machine tools, each with a required `machine` argument, filtered by the caller's tier, without the active-hours override pair. One fleet-native tool, `list_machines`, is added.
- One machine per call. An agent that wants several machines makes several calls.
- A call starts and is then polled: `POST /api/agent/fleet/call` returns a `callId`, `GET /api/agent/fleet/calls/{callId}` returns status and result. A request through Cloudflare ends at about 100 seconds and a script tool can run for 55 minutes.
- Every machine tool is queued through `executeMachineCommand`, so it is audited, plan-gated and refused on an offline machine like any other command. The audit actor is `machine:<machineId>`.
- The script is generic. It maps the server's catalog to MCP tools and the server's result envelope (`{ content: [...] }`) to MCP content, so new tools and new result kinds need no agent release.

### On the machine
- `agent/src/fleet_session.py`: the keeper that fetches and writes the session, started by the service on a daemon thread.
- `agent/src/fleet_mcp.py`: the stdio MCP server, run by the user with the bundled interpreter. It imports `mcp`, `requests` and `shared_utils`, and never `auth_manager`.
- No listening socket (ADR 0003), no `firestore.rules` change, no `owlette_installer.iss` change (a new file in `agent/src` ships as is), no new packages (`mcp==2.2.0` is already in all three payloads).

### Later waves
- **macOS and Linux** (waves 7–8): the session file's ownership and mode, and interpreter access, as gate 0.4 measures them.
- **Tasks to hoot** (waves 9–10): `ask_hoot` starts a server-side hoot turn aimed at chosen machines, in the shape talons use, and returns the final answer. The site owner's LLM key pays (assumption 3). The turn is capped at tier 2 because nobody is there to approve tier 3. A per-sender budget stops two machines from calling each other without end.
- **Wider surface** (waves 11–13): hoot's server-side tools, then roost, deployments and updates, reboot schedules, displays, the read-only areas (logs, metrics history, audit log, alert rules) and screenshots returned as images. Operations only (assumption 5).

## Waves

| wave | what | tasks |
|---|---|---|
| 0 | gates: machine-scope on dev, `mcp` stdio spike, rules tests, macOS and Linux access | 4 |
| 1 | server base: machine actor, grant parser, session store, catalog, ADR 0014 | 5 |
| 2 | grant write path, fleet request handler, session route, dispatch | 4 |
| 3 | tools, call and poll routes; grant UI with e2e; session cleanup | 3 |
| 4 | agent on Windows: session keeper, the stdio script; docs | 3 |
| 5 | two-machine proof on dev; desktop app setup snippet | 2 |
| 6 | release (first release line) | 1 |
| 7 | macOS and Linux: session file and script launch | 2 |
| 8 | macOS and Linux proof and packages | 1 |
| 9 | hoot turn: audit actor passthrough, turn reader | 2 |
| 10 | `ask_hoot` | 1 |
| 11 | tool registry and hoot's server-side tools | 1 |
| 12 | areas: roost, deployments and updates, schedules, displays, reads, screenshots | 6 |
| 13 | catalog docs with a drift test, proof, release | 1 |

Task detail is in `tasks.md`.

## Risks

- **machine-scope lands late or changes shape.** Gate 0.1 records its merged signatures; task 1.1 and 1.2 are written against them.
- **A granted machine is compromised.** It reaches its targets up to its tier until an admin removes the grant. Tier 3 means shell on the targets with nobody approving. Off by default, tier 2 by default, every call audited under the machine's name, and removal cuts within one call.
- **The shared result document.** Every command result for a machine lands in one `commands/completed` document capped at 1 MiB. A busy agent can fill it. The call read deletes each entry once it is terminal; task 2.4 tests that.
- **Latency.** A machine picks up a command in 2–5 seconds, so each call takes at least that long. Fine for control, slow for chatty use.
- **The session file on macOS and Linux** widens what a user-session process holds there (today the token store is root-only). The session is fleet-only and 15 minutes, and is written only for a machine with a grant.
- **The dev deploy hook** restarts the service and raises a UAC prompt on every `agent/src/*.py` edit. Agent tasks batch their edits.
- **Rules.** The plan assumes `fleet_sessions` is unreadable by any client and `settings/fleet` is readable by site members under the existing rules. Gate 0.3 proves both with rules tests. If either fails, the plan stops for the owner: `firestore.rules` is not edited without an explicit request.

## Success Criteria

- On dev, Claude Code on the dev box lists the tools, lists the machines, reads from another machine and restarts a process on it, all through the script.
- A machine with no grant gets no tools beyond `fleet_status`, which says why.
- A call above the sender's tier, to a machine outside its targets, or to a machine with hoot off is refused with a reason.
- Removing the grant in the dashboard refuses a live client's next call within 10 seconds.
- Every call appears in the site's audit log with actor `machine:<id>`, the tool and the target.
- The agent suite, the web unit tests, the rules tests and the e2e suite pass.
- After wave 8 the same holds on the MacBook and the kiosk VM. After wave 13 the catalog covers the operational surface and its docs page cannot drift from it.

## Assumptions (owner decisions still open)

The plan is built on these defaults. Each is the owner's to overrule.

1. **Tier 3 with nobody approving is allowed per sender.** The default cap is tier 2; an admin raises a sender to 3 knowingly.
2. **Local trust.** Any process in the logged-in user's session may use the session file. Grants bound it.
3. **The site owner's LLM key pays** for `ask_hoot`, as it does for autonomous runs.
4. **The name.** "fleet mcp" is a working name. "relay" is taken: it means swoop's TURN relay. "local hoot" is taken too.
5. **Comprehensive means operations.** Members, API keys, agent tokens, webhooks, pairing, machine removal and billing stay out of a machine's reach.
6. **No new plan flag.** Fleet calls ride `owlette.hoot`, as hoot's tool calls do.
