# Active-hours guard — Plan
**Created**: 2026-10-25 | **Status**: Active | **Branch**: `feat/active-hours-guard` (worktree `Owlette-active-hours-wt`, cut from origin/dev at 58b08d23)

## Summary

On Windows, the agent refuses reboot, shutdown and deployments while the machine is inside its active hours, unless the command carries an override a person approved. A refused reboot can instead wait for the window to end. hoot gets working ways to stop Windows restarting on its own (restarts only outside active hours by default; no automatic installs when the operator wants zero restarts), an honest `set_active_hours`, and a rule to check active hours and talons before acting. It started from two reports: hoot had no awareness of either, and Jeff's machine rebooted itself after hoot agreed to stop that.

## Owner decisions (2026-10-24/25)

1. Hard block with an override, enforced on the agent at execution time.
2. Blocked: `reboot_machine`, `shutdown_machine`, deployments (`install_software`). Not blocked: roost rollouts (no process restart; a refusal counts toward the canary abort) and fleet updates (no machine reboot; ADR 0006 means the first guarded release can't guard its own install).
3. The window is Windows active hours (policy → MDM → user setting → Windows default 8–17). No new owlette setting. Windows only; macOS and Linux unchanged.
4. An override is honoured only when a person approved that exact call: the dashboard confirm, an API key caller, or a hoot call that went through the approval card. Autonomous hoot, talons, follow-ups and the public conversations API can never override. Every override is logged with who and why.
5. Overrides are single-machine only; a multi-machine or site-wide hoot turn refuses them.
6. A blocked reboot can be deferred to the window end ("restart when active hours end").
7. owlette's crash-loop reboot inside active hours waits for the window to end; the dashboard's existing approve button can still reboot now (with an override).
8. The weekly reboot schedule is left alone: a person chose that time.
9. hoot checks active hours and talons before disruptive actions; `list_talons` moves to tier 1; hoot's time context gains the machine's local time.
10. hoot can set active hours (it already can; the writer gets fixed).
11. Stopping Windows' own restarts (after task 0.2 showed nothing on Win11 Pro stops them outright): `limit_auto_restart` is the default (policy active hours plus no restart deadline: Windows restarts only outside the window). `disable_auto_install` (`AUOptions=3`) is for when the operator explicitly wants zero update restarts and accepts that security updates wait for a person. Never `NoAutoRebootWithLoggedOnUsers`.

## Approach

**One reader.** `osadapter.active_hours()` (new Protocol operation, contract count 21 → 22) returns the window in force on Windows and `None` elsewhere. Pure maths for "inside now" and "window end" lives in a new cross-platform `agent/src/active_hours.py`. The guard, `manage_windows_update get_status` and the heartbeat all use it.

**Override is server-granted only.** Clients can't write commands (`firestore.rules:303-311`), so the server is the single gate. Every funnel strips the override names from model- and client-supplied params (today `executeExistingCommand` spreads model params onto the command, `hoot-utils.server.ts:829`, and the autonomous path does too, `dispatch.server.ts:291`). The envelope field `activeHoursOverride: { reason, approvedBy }` is then set only from a typed option:
- the commands route and the deployments route, for `user:` and `apiKey:` actors, from an explicit `active_hours_override: { reason }` body field;
- a dashboard hoot turn whose tool call carried `override_active_hours`, which forces the approval card through a `needsApproval` function even when the site turned tier-3 approval off, on a single machine only.

**The agent refuses visibly.** `Error: active_hours: inside active hours 08:00–17:00 (machine time); they end at 17:00`. The `Error:` prefix makes `finish_command` record it as failed (`firebase_client.py:1689`). The same change fixes `Reboot failed:` / `Shutdown failed:`, which are recorded as completed today.

**The dashboard knows first.** The heartbeat writes `activeHours: { start, end, source }` and `capabilities.activeHoursGuard: 1`. The reboot and shutdown confirm says "inside active hours (08:00–17:00)" and offers cancel / restart when active hours end / restart now with a reason. Machines without the capability keep today's dialog. The dashboard also stops faking a countdown when the agent refuses: it reads the command's outcome, which no reboot path does today.

**Deferred reboot.** `reboot_machine` with `when: 'after_active_hours'` persists its own record in `reboot_state.json` (not `attempt`, which would disable the connection watchdog, `connection_manager.py:872-877`) and sets `rebootDeferredUntil`. The agent re-announces it after the startup flag clear (`owlette_service.py:9445-9462`), fires it through the scheduled-reboot path at the window end, re-holds it if the machine is inside the window again, and `cancel_reboot` clears it. Deferral isn't an override, so any caller, autonomous hoot included, can use it.

**hoot.**
- Honest tool descriptions: `set_scheduled_install` turns on scheduled install-and-restart.
- New `limit_auto_restart`, `disable_auto_install` and `enable_auto_install` actions, plus a fixed `pause`, all built on task 0.2's values.
- `set_restart_deadline` is removed: it never worked (wrong key) and only forced restarts.
- `set_active_hours` validates the window (start ≠ end, at most 18 hours), writes the policy value Windows honours over the auto-adjust setting, and won't move "now" out of the window without an override.
- A prompt rule tells hoot to check active hours and talons before acting, to offer the outside-hours option first, and to explain the trade-off before turning off automatic installs.
- The time context gains the machine's local time.

## Waves (detail in tasks.md)

- **Wave 0, facts:** 0.1 Jeff's reboot cause · 0.2 Windows restart and active-hours values, measured and documented.
- **Wave 1:** 1.1 agent reader and maths · 1.2 server strips override names everywhere · 1.3 glossary entry and ADR 0013.
- **Wave 2:** 2.1 agent guard, override log, heartbeat, `Error:` prefix fix · 2.2 `manage_windows_update` fixes, `limit_auto_restart`, `disable_auto_install`, deferral key fix, `set_restart_deadline` removed · 2.3 commands and deployments routes, audit, openapi, logs labels · 2.4 hoot tools, approval and override wiring, `list_talons` tier 1.
- **Wave 3:** 3.1 agent deferred reboot and crash-loop deferral · 3.2 hoot prompt rule and machine local time · 3.3 dashboard reboot and shutdown flow.
- **Wave 4:** 4.1 status pill deferred state · 4.2 CLI and SDK flags · 4.3 deployments page override.
- **Wave 5:** 5.1 docs and both changelogs.
- **Wave 6:** 6.1 `/verify` and `/preflight`.
- **Wave 7:** 7.1 proof on a dev Windows machine · 7.2 Jeff's machine after release.

## Risks

- **Shell tools get around it.** hoot's `execute_script` and `run_powershell`, and local hoot (`cortex_tools.py:333-341`), can run `shutdown /r` or an installer directly. The guard covers the dedicated tools only; the prompt rule is the only check on the shell route.
- **Windows always has active hours.** It's 8–17 when nobody set one. From day one, daytime API and CLI scripts that reboot or deploy get refused until they pass the override. That's a breaking change for API users, so it needs a changelog and docs callout.
- **Approval is client-mediated.** The approved input comes back from the browser (`app/api/hoot/route.ts:271-281`). The approver is the authenticated chat owner, so a tampered input is still that person's choice. ai 7's `experimental_toolApprovalSecret` would bind the input; out of scope unless 2.4 finds it cheap.
- **Overlap.** `dev/active/hoot-drives-swoop` edits `mcp-tools.ts`, `hoot-utils.server.ts` and `ToolCallCard.tsx`. Rebase whichever lands second.
- **Old agents ignore it all.** Machines are protected only after updating. The dashboard gates its wording on `capabilities.activeHoursGuard`.
- **Deferred-fire blocking.** The scheduled-fire path sleeps on the main loop (`owlette_service.py:7429`, `:7444`). Reusing it must not add more blocking; 3.1 decides whether the fire moves off the loop.
- **Long lane.** Installs and reboots share one serial slow lane (`firebase_client.py:1592-1627`), so a `cancel_reboot` can wait behind a 40-minute install. That's existing behaviour; note it, don't fix it here.

## Success criteria

- Inside active hours on a guarded Windows agent, reboot, shutdown and deployment from every path (dashboard, API, CLI, hoot chat, autonomous hoot) are refused with the window named.
- The only exception is an override a person approved on a single machine; it is logged with `approvedBy` and the reason.
- Autonomous hoot, talons, follow-ups and the public conversations API can't override, proven by tests that feed the override through each funnel.
- "Restart when active hours end" fires at the window end, survives a service restart, and can be cancelled. A crash loop inside the window defers instead of rebooting.
- In a hoot chat on a real Windows machine, "stop windows from restarting this machine on its own" calls `limit_auto_restart` and explains the nightly window. "No update restarts at all" calls `disable_auto_install` after the security trade-off. The registry shows the expected values each time.
- Jeff's reboot has a named cause with evidence.
- Agent pytest, web jest, lint, typecheck, the rules tests and the e2e suite are green. UI changes have screenshot review in light and dark at desktop and phone widths.
