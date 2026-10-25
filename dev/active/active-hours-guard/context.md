# Active-hours guard — Context
**Last updated**: 2026-10-25

## Key files

**Create**
- `agent/src/active_hours.py`: pure window maths
- `agent/tests/unit/test_active_hours.py`, `test_active_hours_guard.py`, `test_deferred_reboot.py`, maybe `test_manage_windows_update.py`
- `docs/adr/0013-agent-refuses-disruptive-commands-inside-active-hours.md`
- `web/e2e/specs/dispatch/active-hours.spec.ts`, `web/e2e/specs/time-travel/reboot-deferred.spec.ts`

**Modify, agent**
- `agent/src/osadapter/{__init__,win,linux,darwin}.py`
- `agent/src/owlette_service.py`: reboot `:7807`, shutdown `:7854`, cancel `:7893`, install `:5888`, crash loop `:4273`, mcp dispatch `:6239`, tick `:9606`, startup clear `:9445`
- `agent/src/firebase_client.py`: heartbeat `:1539`, `log_event` `:2485`, `finish_command` `:1689`
- `agent/src/tools_windows.py`: `manage_windows_update` `:733`
- `agent/src/mcp_tools.py`: `execute_tool`
- `agent/src/reboot_state.py`: `:64-92`

**Modify, web**
- `web/lib/actions/executeMachineCommand.server.ts`: reserved keys `:111`, envelope `:231`, audit `:246`
- `web/lib/hoot-utils.server.ts`: reserved keys `:91`, `executeExistingCommand` `:806`, `executeToolOnAgent` `:714`, `deploy_software` `:993`, `buildExecutableTools` `:1842`, `SiteMachineSummary` `:524`
- `web/lib/hoot/dispatch.server.ts` (`:278`), `web/lib/hoot/turnRunner.server.ts`, `web/lib/llm.ts`, `web/lib/hootStream.server.ts`, `web/lib/mcp-tools.ts`
- `web/app/api/hoot/autonomous/route.ts`, `web/app/hoot/components/ToolCallCard.tsx`
- `web/app/api/sites/[siteId]/machines/[machineId]/commands/route.ts`, `web/app/api/sites/[siteId]/machines/route.ts`
- `web/lib/actions/createDeployment.server.ts`, the deployments routes, `web/app/deployments/page.tsx`
- `web/hooks/useFirestore.ts`, `web/hooks/useCommandResult.ts`
- `web/components/MachineContextMenu.tsx`, `web/components/MachineStatusPill.tsx`, `web/components/SiteMachinesList.tsx`, `web/app/dashboard/components/MachineCardView.tsx`
- `web/app/logs/page.tsx`, `web/openapi.yaml`
- `web/e2e/helpers/{seed,stubAgent}.ts`

**Modify, other**
- `cli/src/commands/machine.ts`, `sdks/node/src/resources/machines.ts`, `sdks/python/roost/resources/machines.py`
- `GLOSSARY.md`, the docs pages listed in task 5.1, both changelogs

## Decisions

1. **Enforce on the agent at execution time**, against the live registry and the machine clock. One check covers the dashboard, API, CLI, hoot and future paths.
2. **The server is the only override gate.** Clients can't write commands (`firestore.rules:303-311`). The envelope field `activeHoursOverride: {reason, approvedBy}` is set only from typed options; every param funnel strips the names (task 1.2).
3. **Override needs a person:**
   - dashboard confirm (`user:`);
   - API key (`apiKey:`, owner's call);
   - a dashboard hoot call that went through the approval card, which is forced for overrides even when the site toggle is off.

   Never: autonomous hoot, talons, follow-ups, the public conversations API, local hoot.
4. **Single machine only** for hoot overrides (owner, 2026-10-25).
5. **Scope is reboot, shutdown and deployments.**
   - Rollouts are excluded: `sync_pull` restarts nothing (`sync_commands.py:177-514`), and a refusal counts toward the >25% canary abort (`functions/src/lib/fanoutLogic.ts:107-131`).
   - Fleet updates are excluded: no machine reboot, and the old agent runs the update into the first guarded release (ADR 0006).
   - The weekly schedule is excluded: a person chose the time.
6. **The crash-loop reboot inside the window defers to the window end.** The dashboard's approve button can still reboot now with an override.
7. **The deferred reboot has its own record and field** (`reboot_state.deferredReboot`, `rebootDeferredUntil`), never `attempt` (it would disable the watchdog) and never `rebooting` with a far-future `rebootScheduledAt` (the pill overflows and the row dims).
8. **The refusal is an `Error: active_hours: …` string**, so the existing failed-status machinery and the deployments page show it with no new result format.
9. **Glossary:** "active hours" gets an entry (Windows' own term). Avoid quiet hours, show hours, maintenance window.
10. **`list_talons` moves to tier 1.** Members already read talons through the rules and the talons page. The test comment that called this a leak is rewritten with that reasoning.

## Owner inputs owed

- Task 0.1, for Jeff's machine:
  - the hoot chat share link
  - the site and machine, and dev or prod
  - roughly when it rebooted
  - a prod read-only key (`site=<siteId>:read`) if on prod
  - an OK for one read-only event-log command if the logs don't settle it
- Task 0.2: an OK for any registry write or Settings click on this box (default: read-only plus docs).
- Task 7.1: an OK to reboot a dev Windows machine.

## Jeff's reboot

_(task 0.1)_ Candidates, from the code:
- Windows Update's own restart. hoot's `set_scheduled_install` turns on install-and-restart (`AUOptions=4`, `tools_windows.py:806`). `set_restart_deadline` forces a restart (`:823`). No tool sets `NoAutoRebootWithLoggedOnUsers`.
- owlette's crash-loop reboot (`owlette_service.py:4273-4315`).
- owlette's weekly reboot schedule.
- A crash or power loss.

## Windows restart facts

_(task 0.2)_

## Proof

_(task 7.1)_

## Next steps

1. Task 0.2 now: read-only, unblocks waves 1–2.
2. Task 0.1 as soon as the owner sends Jeff's details.
3. Then `/execute` wave 1 (1.1, 1.2, 1.3 in parallel) in this worktree. Web tasks need their own `npm ci` in the worktree (Turbopack rejects a node_modules junction).
