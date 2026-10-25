# Active-hours guard — Tasks
**Progress**: 1/18 complete

Work only in the worktree `C:\Users\admin\Documents\Git-restored\Owlette-active-hours-wt` (branch `feat/active-hours-guard`). Never edit the shared `Owlette` checkout; other sessions work on `dev` there. Read `plan.md` and `context.md` first. Line numbers are from origin/dev 58b08d23.

Repo rules that apply to every task (from `.claude/CLAUDE.md`):
- UI copy is lowercase. Use theme tokens, never hardcoded colours. lucide-react icons only. Style buttons through `button.tsx` variants.
- Components never call Firestore directly; use hooks in `web/hooks/`.
- Never block the agent's 5-second main loop.
- Never log OAuth tokens.
- Run `npx eslint <file>` on every web file you touch.
- Agent tests: `agent/.venv/Scripts/python -m pytest agent/tests/`. Web: `cd web && npm test`.
- Use the `GLOSSARY.md` terms: deployment (a software install), rollout (roost), fleet update (`update_owlette`), tool tier, local hoot, talon, command.

## Wave 0: facts (no code)

- [ ] **Task 0.1: Name the cause of Jeff's reboot**
  - Files: `dev/active/active-hours-guard/context.md` (section "Jeff's reboot")
  - Do:
    - **Blocked on owner inputs:** the hoot chat's share link, the site and machine, dev or prod, roughly when it rebooted, and for prod a read-only key (`site=<siteId>:read`). Keys live in `.claude/.env.local` of the main checkout; use `curl` with header `x-api-key`, never python urllib (Cloudflare blocks it).
    - **1. Read the chat:** `curl -s https://<env>/share/<token>`. Record which tools hoot called with which arguments, and whether it claimed success without a tool call.
    - **2. Read owlette's site log around the time:**
      - Call `GET /api/sites/{siteId}/logs?machineId=<id>&page_size=100`.
      - Look for the crash-loop escalation ("System reboot imminent", `owlette_service.py:4310-4313`), scheduled reboot fires, `command_executed` reboot entries, and process crashes.
      - Check whether `rebootSchedule` is set on the machine's config.
    - **3. Only if 1 and 2 don't settle it, and only with the owner's explicit OK** (it is a remote command):
      - Dispatch one `mcp_tool_call` of `get_event_logs_filtered` on the System log, for events 1074, 1076, 6005, 6006, 6008, 41 and Windows Update client events 19, 20 and 43, across the window.
      - Use `POST /api/sites/{siteId}/machines/{machineId}/commands`, which needs `machine=<id>:write` and an Idempotency-Key.
      - Event 1074 names the process that asked for the restart.
  - Done when: context.md names the cause with quoted evidence (log lines, event records, chat tool calls), or states exactly what is still unknown and why.

- [x] **Task 0.2: Measure and document the Windows restart and active-hours values** (done 2026-10-25; table and recommendations in context.md, owner's choice in decision 11)
  - Files: `dev/active/active-hours-guard/context.md` (section "Windows restart facts")
  - Do: answer each question below.
    - Mark each answer **measured** (on this Windows 11 Pro 22631 box, read-only registry reads via `reg query`) or **documented** (with a learn.microsoft.com URL).
    - No registry writes and no Settings clicks without the owner's OK.
    - Questions:
      1. Which values stop Windows Update restarting on its own on Windows 10 and 11 Pro and Enterprise while a user is signed in (kiosks auto-login)? Consider:
         - `HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU`: `NoAutoRebootWithLoggedOnUsers` and how it interacts with `AUOptions`, `AlwaysAutoRebootAtScheduledTime`
         - the deadline policies (`ConfigureDeadlineForQualityUpdates`, `ConfigureDeadlineForFeatureUpdates`, `ConfigureDeadlineGracePeriod`, `ConfigureDeadlineNoAutoReboot`)
         - `AutoRestartDeadlinePeriodInDays`, which owlette's `set_restart_deadline` writes today
      2. Does any of these stop a restart for an update that is already installed and waiting? How can the agent report that state (the UpdateOrchestrator `Reboot` task, `tools_windows.py:30`, `:510`; `check_pending_reboot`)?
      3. What must `pause` write to really pause on Windows 11 (`PauseUpdatesStartTime`, `PauseUpdatesExpiryTime`, `PauseFeatureUpdatesStartTime`/`EndTime`, `PauseQualityUpdatesStartTime`/`EndTime`)? Today it writes only `PauseUpdatesExpiryTime` (`tools_windows.py:752-766`).
      4. What are the active-hours keys and their precedence?
         - Policy `HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate` (`SetActiveHours`, `ActiveHoursStart`, `ActiveHoursEnd`, `ActiveHoursMaxRange`)
         - MDM `HKLM\SOFTWARE\Microsoft\PolicyManager\current\device\Update`
         - User setting `HKLM\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings` (`ActiveHoursStart`, `ActiveHoursEnd`, `IsActiveHoursEnabled`, `SmartActiveHoursState`)
         - Is the end hour exclusive? What is the maximum length (18)? Is the default 8–17? Is start == end allowed?
         - Measured already: this box has only UX `ActiveHoursStart=8`, `ActiveHoursEnd=2` (wraps past midnight), with no `IsActiveHoursEnabled`, no Smart values, and no policy or MDM keys.
      5. Which key should `set_active_hours` write so the window holds against the auto-adjust setting and existing policy: the policy key, the user setting, or both?
  - Done when: context.md has a table of every value the agent will read or write, with meaning, source and measured/documented, plus a one-line recommendation for `disable_auto_restart`, `pause` and `set_active_hours`.

## Wave 1: reader, server strip, terms

- [ ] **Task 1.1: Agent active-hours reader and maths**
  - Files:
    - `agent/src/osadapter/__init__.py`, `agent/src/osadapter/win.py`, `agent/src/osadapter/linux.py`, `agent/src/osadapter/darwin.py`
    - `agent/src/active_hours.py` (new)
    - `agent/tests/unit/test_osadapter_contract.py`
    - `agent/tests/unit/test_active_hours.py` (new)
  - Do:
    - **The new Protocol operation:**
      - Add `active_hours() -> dict | None` to the `OSAdapter` Protocol (`osadapter/__init__.py:30-104`). Only Protocol methods are reachable as `osadapter.x` (`:107-110`, `:189-193`).
      - win: read the effective window in the precedence task 0.2 recorded (expected: policy, then MDM, then user setting, then default 8–17). Return `{'start': int, 'end': int, 'source': 'policy'|'mdm'|'user'|'default'}`.
      - Skip a source whose values are missing or outside 0–23, or where start == end.
      - A missing `IsActiveHoursEnabled` does not mean disabled.
      - linux and darwin return `None`, following the `pending_reboot` precedent (`win.py:194`, `linux.py:162`, `darwin.py:252`).
      - `winreg` is imported only in `win.py` (`agent/tests/unit/test_no_platform_imports.py:35-49`).
    - **`active_hours.py`, pure and cross-platform:**
      - `is_inside(window, now_local) -> bool`: start inclusive, end exclusive, start > end wraps past midnight.
      - `window_end(window, now_local) -> datetime`: the next end instant in machine local time, DST-safe; follow `shared_utils.compute_scheduled_instant`, `shared_utils.py:2410`.
      - `describe(window) -> 'HH:MM–HH:MM'`.
    - **Tests:**
      - Bump the contract test from 21 to 22 operations (`test_osadapter_contract.py:147-160`) and add a Windows reader test.
      - Fake winreg the way `test_shared_utils.py:511-526` does.
      - Cover each source's precedence, invalid values, wrap, both boundaries and a DST day.
  - Done when: the agent suite is green; the contract test asserts 22 operations; the new tests cover wrap, boundaries, precedence and DST.
  - Depends on: Task 0.2

- [ ] **Task 1.2: Strip the override names at every server funnel**
  - Files:
    - `web/lib/actions/executeMachineCommand.server.ts`
    - `web/lib/hoot-utils.server.ts`
    - `web/lib/hoot/dispatch.server.ts`
    - `web/__tests__/lib/actions/executeMachineCommand.test.ts`, `web/__tests__/lib/hoot-utils.test.ts`, `web/__tests__/api/hoot-autonomous-tools.test.ts`
  - Do:
    - **Reserved names:** `activeHoursOverride`, `active_hours_override`, `override_active_hours`, `override_reason`. Strip them everywhere a param bag becomes a command:
      - `RESERVED_PAYLOAD_KEYS` (`executeMachineCommand.server.ts:111-121`), which covers the commands route and autonomous hoot via `dispatch.server.ts:278-292`.
      - `RESERVED_EXISTING_COMMAND_KEYS` (`hoot-utils.server.ts:91-105`), which covers interactive hoot `executeExistingCommand` (`:806-885`, which spreads params at `:829`).
      - `tool_params` in `executeToolOnAgent` (`:714-727`).
      - `executeDeploySoftware` (`:993-1186`, explicit fields only; confirm none is read from params).
    - Do not reserve `when` (deferral isn't privileged).
    - This task only removes. Tasks 2.3 and 2.4 add the typed, server-set field back.
    - **Tests:** for each funnel, a call carrying each reserved name, including a nested `activeHoursOverride` object, produces a command without it.
  - Done when: jest is green and the new tests fail on origin/dev and pass here. Ships in the same PR as 2.1, never after it.

- [ ] **Task 1.3: Glossary entry and ADR**
  - Files: `GLOSSARY.md`, `docs/adr/0013-agent-refuses-disruptive-commands-inside-active-hours.md` (new)
  - Do:
    - **GLOSSARY:** add **Active hours** under "On the machine": the hours, on the machine's own clock, during which Windows holds back its own update restarts and the agent refuses reboots, shutdowns and deployments unless a person overrides. Read from policy, then MDM, then the user setting, then Windows' default 8–17. Windows only. _Avoid_: quiet hours, show hours, maintenance window, business hours.
    - **ADR 0013:** one paragraph in the `docs/adr/0001-*` format plus Consequences. Cover:
      - the agent refuses at execution time;
      - only the server grants an override, and only for a person's approved call;
      - unattended hoot can never override;
      - rollouts and fleet updates are excluded, and why;
      - Windows always has a window, so daytime API scripts get refused;
      - old agents are unprotected until updated.
  - Done when: both files exist and use the glossary terms.

## Wave 2: guard, tools, routes, hoot wiring

- [ ] **Task 2.1: Agent guard, override log, heartbeat, Error prefix fix**
  - Files:
    - `agent/src/owlette_service.py`, `agent/src/firebase_client.py`
    - `agent/tests/unit/test_service_shutdown.py`, `agent/tests/unit/test_active_hours_guard.py` (new)
  - Do:
    - **The check:** add `_active_hours_block(command_data) -> str | None`.
      - Windows only. `window = osadapter.active_hours()`; compare with `active_hours.is_inside` against machine local time.
      - Inside with no valid `command_data.get('activeHoursOverride')` (a dict with a non-empty `reason` of 500 characters or fewer and a non-empty `approvedBy` string): return `Error: active_hours: inside active hours {describe} (machine time); they end at {HH:MM}`, and log `active_hours_refused` (level info).
      - Inside with a valid override: log `active_hours_override` (level warning) via `firebase_client.log_event(..., extra_fields={'commandType', 'reason', 'approvedBy', 'queuedBy', 'window'})` (`firebase_client.py:2485-2547`), then proceed.
    - **Where it runs:**
      - `_handle_reboot_machine` (`:7807-7852`) and `_handle_shutdown_machine` (`:7854-7891`), before `_shutting_down`, intent or flags are set.
      - `install_software` (`:5888-6030`), before `_terminate_processes_for_install` (`:5917-5924`).
      - Not the weekly schedule, not `sync_pull`, not `update_owlette` (owner decisions).
    - **Crash-loop escalation** (`:4273-4315`): inside active hours, write `reboot_pending` as today but don't open the restart prompt, and log `active_hours_refused`. Task 3.1 adds the deferral.
    - **Bug fix, failing test first:** `"Reboot failed: …"` (`:7852`) and `"Shutdown failed: …"` (`:7891`) become `"Error: reboot failed: …"` / `"Error: shutdown failed: …"`. `finish_command` (`firebase_client.py:1689`) only marks `Error:` results as failed.
    - **mcp_tool_call:** at `:6239`, call `mcp_tools.execute_tool(tool_name, tool_params, config, command_id=cmd_id, active_hours_override=cmd_data.get('activeHoursOverride'))`. That is the interface task 2.2 implements.
    - **Heartbeat** (`firebase_client.py` `_upload_metrics` `:1539-1576`): write `activeHours: {start, end, source}`, or delete it when `None`. On win32, write `capabilities.activeHoursGuard: 1` next to `capabilities.keepAwake` (`:1551-1557`).
    - **Test fake:** `FakeFirebaseClient.log_event` (`test_service_shutdown.py:88-118`) must accept `extra_fields` and `user_id`.
    - The handlers run on the slow command lane; the registry reads are fast. Add nothing to the main loop.
  - Done when: pytest is green, with tests for each case:
    - inside with no override → refused, `osadapter.reboot` not called;
    - a valid override → reboot called and logged with the reason;
    - outside → unchanged;
    - non-Windows → unchanged;
    - install refused before any process is terminated;
    - the prefix fix;
    - the heartbeat fields.
  - Depends on: Task 1.1

- [ ] **Task 2.2: manage_windows_update: honest status, outside-hours restarts, no-auto-install, safe set_active_hours**
  - Files:
    - `agent/src/tools_windows.py` (`manage_windows_update` `:733-858`, `check_pending_reboot` `~:480-535`, `_REBOOT_TASK` `:30`)
    - `agent/src/mcp_tools.py` (`execute_tool`)
    - `web/lib/talons/templates.ts` (the "update guard" template, `:180-208`)
    - agent unit tests for `tools_windows` (find the existing file, or add `agent/tests/unit/test_manage_windows_update.py`)
  - Do:
    - Read context.md "Windows restart facts" and decisions 11–13 first. Shorthand there: `P` = `HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate`, `AU` = `P\AU`, `UX` = `HKLM\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings`, `UPS` = `...\UpdatePolicy\Settings`.
    - **Interface:** `execute_tool(tool_name, params, config, command_id=None, active_hours_override=None)` forwards the override to `manage_windows_update` only.
    - **`get_status`:** keep the existing keys and add:
      - `active_hours` (from `osadapter.active_hours()`, with its source), `inside_active_hours_now`, `machine_local_time`;
      - `AUOptions`, `NoAutoUpdate`, `ScheduledInstall*`, and `NoAutoRebootWithLoggedOnUsers`, warning when it's set because it switches off policy active hours;
      - every deadline value in the table, saying which still forces a restart;
      - MDM conflict flags;
      - pause state (`UPS\Paused*Status`);
      - Windows Update pending restart (the `RebootRequired` key, WUA), separate from file renames.

      Fix the `Defer*` reads to `P`.
    - **New action `limit_auto_restart`** (default for "stop windows restarting on its own"):
      - Optional `start_hour`/`end_hour`, defaulting to the current window. Set the policy window exactly as `set_active_hours` does.
      - Delete the local restart-deadline values: `P\SetAutoRestartDeadline`, `P\AutoRestartDeadlinePeriodInDays*`, owlette's old `AU\AutoRestartDeadlinePeriodInDays`, and the `SetComplianceDeadline*`/`ConfigureDeadline*` values under `P`.
      - Report any deadline that remains (MDM, or a GPO that will re-apply), and that Windows can still restart outside the window.
    - **New actions `disable_auto_install` / `enable_auto_install`:**
      - disable: `AU\NoAutoUpdate=0`, `AU\AUOptions=3`, delete `AU\ScheduledInstall*`.
      - enable: delete `AU\AUOptions`, `AU\NoAutoUpdate` and `AU\ScheduledInstall*`, so Windows' default automatic behaviour returns.
      - The disable result says security updates now wait until someone installs them.
    - **`set_active_hours`:**
      - Validate: 0–23, start ≠ end, wrap-aware length ≤ the effective max (`P`, then `MDM`, else 18).
      - Refuse "managed by MDM" when `MDM\ActiveHoursStart`/`End` are set.
      - Write `P\ActiveHoursStart`, then `P\ActiveHoursEnd`, then `P\SetActiveHours=1` last. Stop writing `UX\IsActiveHoursEnabled`.
      - If now is inside the current window and the new window would put now outside it, refuse with the `active_hours` error unless the override is valid. This stops unattended hoot from shrinking the window and then rebooting.
      - Report the read-back window and that Settings can no longer change it.
    - **`pause` / `resume`:**
      - pause writes all six `UX` values (UTC `%Y-%m-%dT%H:%M:%SZ`) and reports `paused` only when `UPS\Paused{Quality,Feature}Status` reads 1, else "written, not yet confirmed by Windows".
      - If `P\SetDisablePauseUXAccess=1` or a policy pause is present, report it instead of writing.
      - resume deletes all six.
    - **Remove `set_restart_deadline`.** It never worked and only forced restarts. Remove it from the "update guard" template directive too, which then sets active hours via `limit_auto_restart`.
    - **Deferrals:** `set_feature_deferral` / `set_quality_deferral` write to `P`.
    - **`check_pending_reboot`:** don't report `PendingFileRenameOperations` alone as a Windows Update restart. Report it as `file_renames`. Stop reading the non-existent `\UpdateOrchestrator\Reboot` task as a source of truth on Win11 (report null with "unknown on this build").
    - Every action keeps the `[MCP-AUDIT]` log line.
  - Done when: pytest is green with fake winreg asserting each action's writes and deletes, the refusal case, the MDM refusal, the validation errors, the pause read-back, and the `Defer*` key fix; the template test passes.
  - Depends on: Task 0.2, Task 1.1

- [ ] **Task 2.3: Routes accept the override and deferral; audit; openapi; log labels**
  - Files:
    - `web/app/api/sites/[siteId]/machines/[machineId]/commands/route.ts`
    - `web/lib/actions/executeMachineCommand.server.ts`
    - `web/lib/actions/createDeployment.server.ts`
    - `web/app/api/sites/[siteId]/deployments/route.ts`, `web/app/api/sites/[siteId]/deployments/[deploymentId]/retry/route.ts`
    - `web/openapi.yaml`
    - `web/app/logs/page.tsx`
    - tests: `web/__tests__/api/sites-machines-commands.test.ts`, `web/__tests__/lib/actions/executeMachineCommand.test.ts`, the deployments route tests, `web/__tests__/api/openapi.test.ts`
  - Do:
    - **Commands route** (`normalizeCommandBody` `:95-313`; reboot and shutdown take only `delay_seconds` today, `:137-139`):
      - Accept `params.active_hours_override: { reason: string 1–500 }` for `reboot_machine` and `shutdown_machine`, and `params.when: 'now' | 'after_active_hours'` for `reboot_machine`.
      - Pass the override to `executeMachineCommand` as a typed option, never through the payload (1.2 strips it).
      - `executeMachineCommand` writes `activeHoursOverride: { reason, approvedBy: queuedBy }` onto the envelope (`:231-244`), only for `user:` and `apiKey:` actors; refuse it for `system:`.
      - Add `activeHoursOverride: true` and the reason to the `emitMutation` attributes (`:246-257`).
    - **Deployments:** the same `active_hours_override` body field on create and retry flows to every `install_software` command it queues.
    - **openapi:** document both fields, the refusal (`Error: active_hours: …` on the completed entry) and the breaking-change note.
    - **Logs page:** add labels for `active_hours_override` and `active_hours_refused` to the action filter (`web/app/logs/page.tsx:129-184` requires every emitted action).
  - Done when: jest is green, `web/scripts/validate-openapi.ts` passes, and eslint and tsc are clean on the touched files.
  - Depends on: Task 1.2

- [ ] **Task 2.4: hoot tools: override through approval only, deferral, honest descriptions, list_talons tier 1**
  - Files:
    - `web/lib/mcp-tools.ts`, `web/lib/hoot-utils.server.ts`, `web/lib/hoot/turnRunner.server.ts`
    - `web/app/api/hoot/autonomous/route.ts`
    - `web/app/hoot/components/ToolCallCard.tsx`
    - tests: `web/__tests__/lib/mcp-tools.test.ts`, `web/__tests__/lib/hoot/talon-tools.test.ts`, `web/__tests__/lib/hoot-utils.test.ts`, `web/__tests__/api/hoot-autonomous-tools.test.ts`, `web/__tests__/lib/hoot/turnRunner.test.ts`, ToolCallCard tests
  - Do:
    - **Schemas** (`mcp-tools.ts`):
      - `reboot_machine` (`:1305`) gains `when` (`now` | `after_active_hours`), `override_active_hours` (boolean) and `reason` (string). `shutdown_machine` (`:1314`) and `deploy_software` (`:1221`) gain the override and reason.
      - `manage_windows_update` (`:653-695`) gains `limit_auto_restart`, `disable_auto_install`, `enable_auto_install`, and the override and reason for `set_active_hours`. It loses `set_restart_deadline` and `deadline_days` (2.2 removes it).
    - **Honest descriptions:**
      - `set_scheduled_install` turns on scheduled install and Windows then restarts at that time.
      - `limit_auto_restart`: Windows restarts for updates only outside active hours; a nightly restart can still happen.
      - `disable_auto_install`: no automatic installs and so no update restarts, but security updates wait for a person.
      - Active hours hold Windows' own restarts only until a deadline passes, and owlette refuses reboots, shutdowns and deployments inside them.
      - The countdown is 60 s, not 30 (`REBOOT_OS_COUNTDOWN_SECONDS`, `owlette_service.py:200`). Drop "quiet hours".
    - **`list_talons`** (`:1060`) moves to tier 1. Update `EXPECTED_TIER2` (`mcp-tools.test.ts:63`). Rewrite the tier assertion in `talon-tools.test.ts:156-162`: reads tier 1, writes tier 2. Its comment should argue the reversal: members already read talons (`firestore.rules:654-658`, `/talons` via `hooks/useTalons.ts:40`).
    - **Approval** (`buildExecutableTools`, `hoot-utils.server.ts:1842-1932`): `needsApproval` becomes a function: `(def.tier >= 3 && requireTier3Approval !== false) || hasOverride(input)`.
      - ai 7.0.107 honours a `ToolNeedsApprovalFunction` when no streamText-level `toolApproval` is set (`node_modules/ai/dist/index.js:4691-4700`); confirm none is set.
      - Fix `hoot-utils.test.ts:802-823`, which asserts a boolean.
    - **New option** `allowActiveHoursOverride` (default false) on `buildExecutableTools`. `turnRunner` passes true only for dashboard turns whose source is a person's message or an approval resume, never `followup` or `talon`; source is dropped today and must be threaded. The public conversations API leaves it false.
    - **`execute` with an override:**
      - Option false → return a tool error saying overrides need a person in a dashboard chat.
      - Fan-out turn → a tool error saying overrides need a single-machine chat.
      - No reason → a tool error asking for one.
      - Otherwise write the envelope `activeHoursOverride: { reason, approvedBy: 'user:<uid>' }`. Give `executeExistingCommand` an options argument; `executeToolOnAgent` sets it for `manage_windows_update`.
    - **Autonomous** (`autonomous/route.ts:107-156`): remove the override and reason properties from the schemas it exposes, and never set the option. `when: 'after_active_hours'` stays available.
    - **`ToolCallCard`** (`:192-224`): the banner shows "override active hours: <reason>" without expanding.
  - Done when: jest is green, with tests proving:
    - a model-set override without approval never reaches a command, toggle off included;
    - an approved single-machine call carries `approvedBy`;
    - fan-out, follow-up and talon turns are refused;
    - autonomous schemas lack the override;
    - `list_talons` is tier 1.

    Also: eslint and tsc clean, and the hoot e2e approval spec extended if one exists under `web/e2e/specs`.
  - Depends on: Task 1.2, Task 0.2 (action names and descriptions)

## Wave 3: deferral, prompt, dashboard

- [ ] **Task 3.1: Agent deferred reboot and crash-loop deferral**
  - Files:
    - `agent/src/owlette_service.py`, `agent/src/reboot_state.py`
    - `agent/tests/unit/test_deferred_reboot.py` (new)
    - `agent/tests/lifecycle/test_process_lifecycle.py` (stub list `:274-287`)
  - Do:
    - **`reboot_machine` with `when == 'after_active_hours'`:**
      - Outside the window → reboot now as today, and say so in the result.
      - Inside → persist `deferredReboot: {at: <window_end unix>, queuedBy, requestedAt}` via `reboot_state` (`write_state`/`read_state` `:64-79` keep only two keys today; `prune_orphaned_entries` `:82-92` must not drop it).
      - Set the flag `rebootDeferredUntil` via `set_machine_flags` and return `Reboot deferred until HH:MM (machine time)`.
      - Don't store it as `attempt`, which disables the connection watchdog (`connection_manager.py:872-877`).
    - **Firing:**
      - On the `REBOOT_CHECK_ITERATIONS` tick (`:9606-9610`), before `_check_scheduled_reboot`'s early return (`:7254-7259`): if a record exists and now >= at, then if inside the window again (the service was down) move `at` to the next window end.
      - Otherwise clear it and fire through the scheduled-fire path with `rebootSource='deferred'`.
      - That path sleeps on the main loop (`:7429`, `:7444`). Don't add more blocking; move the fire to the slow lane or a thread if needed, and record the choice in context.md.
    - **Startup:** after the unconditional flag clear (`:9445-9462`), re-announce `rebootDeferredUntil` if a record exists.
    - **Cancel and schedule edits:** `_handle_cancel_reboot` (`:7893-7954`) clears the record and the flag. A schedule edit (`:5342-5361`) must not clear it.
    - **Crash loop** (`:4273-4315`, after 2.1): inside the window, also create a deferred reboot at the window end with `queuedBy='system:crash_loop'`, and log it.
  - Done when: pytest is green, with tests for:
    - the record surviving a simulated restart;
    - firing at the window end;
    - re-holding when inside;
    - cancel clearing it;
    - the crash loop deferring;
    - the watchdog being unaffected;
    - the lifecycle stub list updated.
  - Depends on: Task 2.1

- [ ] **Task 3.2: hoot checks first; machine local time in the prompt**
  - Files:
    - `web/lib/llm.ts`, `web/lib/hoot/turnRunner.server.ts`, `web/lib/hoot-utils.server.ts`, `web/lib/hootStream.server.ts`
    - `web/app/api/hoot/autonomous/route.ts`
    - tests: `web/__tests__/lib/llm.test.ts` (`:91`, `:141`), `turnRunner.test.ts`, the `hootStream` tests
  - Do:
    - **Time context:**
      - `buildCoreRules` (`llm.ts:57-74`) takes an optional local-time input threaded through `HootSystemPromptOptions` (`:155`).
      - Single-machine turns: "Machine local time: <time> (<IANA tz>)" from the machine doc's `machine_timezone_iana` (written at `firebase_client.py:1544`). Keep it on `SiteMachineSummary` (`hoot-utils.server.ts:524-541`), so it costs no extra read.
      - Fan-out turns: the site timezone (`getSiteTimezone`, `web/lib/talons/store.server.ts:148`).
      - Validate with `isValidTimezone` (`web/lib/timeUtils.ts:341`); fall back to UTC.
    - **New rule** in the core rules: before `reboot_machine`, `shutdown_machine`, `deploy_software`, or stopping or killing a configured process:
      - call `manage_windows_update get_status` (Windows) and `list_talons`;
      - say whether the machine is inside its active hours and whether a talon will act on it soon;
      - never pass `override_active_hours` unless the operator explicitly asked to act inside active hours and gave a reason;
      - prefer `when: after_active_hours`.

      And: when asked to stop Windows restarting on its own:
      - call `manage_windows_update limit_auto_restart` (asking for the hours if unknown), then `get_status`;
      - report what changed, that a restart can still happen outside active hours, and any deadline that remains;
      - use `disable_auto_install` only when the operator says they want no update restarts at all, after saying security updates will then wait for a person.

      Never claim a setting changed without the tool result showing it.
    - **Autonomous prompt** (`buildAutonomousSystemPrompt` `:315-344`, which has its own rules and no time context): add the time line and the same rule, without the override.
  - Done when: jest is green, prompt tests assert the rule and the time line, and eslint and tsc are clean.
  - Depends on: Task 2.4

- [ ] **Task 3.3: Dashboard reboot and shutdown flow**
  - Files:
    - `web/hooks/useFirestore.ts`, `web/hooks/useCommandResult.ts`
    - `web/components/MachineContextMenu.tsx`
    - `web/app/dashboard/components/MachineCardView.tsx`
    - `web/components/SiteMachinesList.tsx`
    - `web/app/api/sites/[siteId]/machines/route.ts`
    - e2e: `web/e2e/helpers/seed.ts`, `web/e2e/helpers/stubAgent.ts`, `web/e2e/specs/dispatch/reboot.spec.ts`, `web/e2e/specs/dispatch/shutdown.spec.ts`, `web/e2e/specs/dispatch/active-hours.spec.ts` (new)
    - jest: `MachineContextMenu.test.tsx`, `MachineCardView.rebootPending.test.tsx`, the machine-parse hook tests
  - Do:
    - **Machine parsing** (`useFirestore.ts:1415-1441`, type `:268-325`; follow `parseDisplayAwake` `:94`): add `activeHours`, `capabilities.activeHoursGuard` and `rebootDeferredUntil`.
    - **Send functions:** `restartMachine` / `shutdownMachine` (`:1821-1850`) take `{ override?: { reason }, when? }`.
      - Read the outcome: extend `useCommandResult` (`:51` resolves only completed) to failed.
      - Clear the optimistic countdown and show a toast on an `active_hours` refusal, e.g. "restart refused: inside active hours 08:00–17:00".
    - **Dialogs** (`MachineContextMenu.tsx:643-699`): when the machine has the capability, is Windows, and is inside the window, show "inside active hours (08:00–17:00, machine time)" and three actions:
      - cancel;
      - "restart when active hours end" (shutdown has no deferral);
      - "restart now", which needs a reason.

      Compute "inside" on the client from `activeHours` and `machine_timezone_iana`, with the same rules as the agent. Fix "30 seconds" to 60.
    - **Other entry points:**
      - `MachineCardView`'s approve button (`:464-485`) opens the same choice when inside the window.
      - `SiteMachinesList` (`:69-93`, dialog `:213-240`) gets the same behaviour; project `activeHours` and the capability in `GET /api/sites/{siteId}/machines` (`route.ts:81`).
    - **e2e:**
      - `seed.ts` gains options for `activeHours`, `capabilities.activeHoursGuard` and `rebootDeferredUntil`. Add them all now; 4.1 and 4.3 reuse them.
      - Stub refusals with `failCommand(…, 'Error: active_hours: …')` (`stubAgent.ts:66-85`).
  - Done when:
    - jest and the e2e specs are green;
    - eslint and tsc are clean;
    - screenshots of the dialog in light and dark at desktop and phone widths, no cut-off buttons (owner rules), are saved and listed in context.md.
  - Depends on: Task 2.3

## Wave 4: pill, CLI and SDKs, deployments page

- [ ] **Task 4.1: Status pill deferred state**
  - Files: `web/components/MachineStatusPill.tsx`, `web/__tests__/components/MachineStatusPill.theme.test.tsx`, `web/e2e/specs/time-travel/reboot-deferred.spec.ts` (new)
  - Do:
    - `rebootDeferredUntil` shows "restart at HH:MM" (machine time) with a cancel that sends `cancel_reboot`.
    - It never uses the MM:SS countdown (`formatMMSS` `:20-24` would print 360:00 and overflow the 72 px cell) and doesn't dim the list row.
    - Lowercase copy, theme tokens only.
  - Done when: jest and the time-travel e2e are green, and there are light and dark screenshots.
  - Depends on: Task 3.1, Task 3.3

- [ ] **Task 4.2: CLI and SDK flags**
  - Files:
    - `cli/src/commands/machine.ts` (`:289-295`, `:453-470`)
    - `sdks/node/src/resources/machines.ts`, `sdks/python/roost/resources/machines.py`
    - `cli/__tests__/commands/machine-mutations-http.test.ts` and the SDK tests
  - Do:
    - Reboot gains `--after-active-hours` and `--override-active-hours --reason <text>`; shutdown gains the override pair. The SDKs get matching optional params.
    - The CLI prints the agent's `active_hours` refusal plainly.
  - Done when: the CLI and SDK test suites are green.
  - Depends on: Task 2.3

- [ ] **Task 4.3: Deployments page override**
  - Files: `web/app/deployments/page.tsx` and its create/confirm component (find it), the deployments e2e spec under `web/e2e/specs`, jest for the component
  - Do:
    - When any chosen Windows machine reports it is inside its active hours, the confirm lists those machines and offers "deploy anyway" with a required reason, sent as `active_hours_override`.
    - Without it, those targets fail with the refusal text, which the page already shows (`deploymentStatus.ts` → `deployments/page.tsx:304-305`).
    - Reuse the 3.3 seed options.
  - Done when: e2e covers the refusal text and the override path; eslint and tsc are clean; there are screenshots.
  - Depends on: Task 2.3, Task 3.3

## Wave 5: docs

- [ ] **Task 5.1: Docs and changelogs**
  - Files:
    - `web/content/docs/reference/agent-commands.mdx` (`:137-142`, `:258`)
    - `web/content/docs/reference/hoot-tools.mdx` (`:107`, `:117`, `:863`)
    - `web/content/docs/reference/firestore-data-model.mdx` (`:221-223`)
    - `web/content/docs/dashboard/machine-monitoring.mdx` (`:166-169`)
    - `web/content/docs/agent/remote-commands.mdx` (`:97-99`)
    - the CLI machine reference
    - `docs/changelog.md` and `web/content/docs/changelog.mdx` (Unreleased entries)
  - Do: document the following. Lowercase where the docs are lowercase; glossary terms.
    - the guard and what it covers;
    - the override and who can grant it;
    - deferral;
    - the refusal code;
    - the new machine fields and command fields;
    - `disable_auto_restart`;
    - the breaking change for daytime API reboots and deployments;
    - "old agents are unprotected".
  - Done when: every listed page matches the shipped behaviour and both changelogs have the entry.
  - Depends on: Waves 2–4

## Wave 6: checks

- [ ] **Task 6.1: /verify and /preflight**
  - Files: none (fixes go back to the owning task's files)
  - Do: run `/verify` (standards and spec reviewers on the branch diff against `plan.md`) and `/preflight`: security alerts, lint, typecheck, jest, rules tests, local e2e. Run the full agent suite. Fix every red.
  - Done when: all green, reviewer findings resolved or answered in context.md.
  - Depends on: Task 5.1

## Wave 7: proof where the owner looks

- [ ] **Task 7.1: Prove it on a dev Windows machine**
  - Files: `dev/active/active-hours-guard/context.md` (section "Proof")
  - Do: ask the owner first: this reboots a dev machine. Copy `agent/src` to the dev box (deploy hook, or `-DevGrant`; see `.claude/CLAUDE.md` "Agent Dev Testing Workflow"), restart the service in the documented order, and run the web branch locally or on a preview. Then:
    1. Set active hours to include now. The dashboard reboot shows the window. Restart now without a reason is impossible; with a reason it reboots, and the site log has `active_hours_override` with the reason.
    2. Defer with a window ending in 5 minutes: the pill shows "restart at", the reboot fires at the end, and cancel works on a second run.
    3. Autonomous hoot with `maxTier: 3` can't override; a crafted override in its params never reaches the command doc.
    4. A hoot chat on that machine: "stop windows from restarting this machine on its own".
       - The chat shows `manage_windows_update limit_auto_restart` and hoot's explanation of the nightly window.
       - `reg query` shows `P\SetActiveHours=1` with the window and no deadline values.
       - Then "no update restarts at all": hoot explains the trade-off, calls `disable_auto_install`, and `AU\AUOptions=3`.
       - Restore afterwards with `enable_auto_install`.
    5. In the same sitting, the owner checks from context.md: the Settings pause and `reg query`, the "adjust automatically" toggle, and the elevated `schtasks` read.
    6. A crash loop inside the window defers.
  - Done when: context.md has screenshots, log lines and registry output for each step.
  - Depends on: Task 6.1

- [ ] **Task 7.2: Jeff's machine after release**
  - Files: `dev/active/active-hours-guard/context.md`
  - Do: once the release reaches Jeff's machine (owner's release flow, `build-system` skill), with the owner's OK run `manage_windows_update get_status` through hoot and confirm automatic restarts are off and the window is what Jeff's venue needs. Record the 0.1 cause as fixed or not by this work.
  - Done when: context.md records the status read from Jeff's machine.
  - Depends on: Task 7.1, the release

## Log
### 2026-10-25
- Plan created after three research passes (agent, web dispatch, hoot) and the owner's decisions of 2026-10-24/25. Task 0.1 waits on the owner's inputs for Jeff's machine.
