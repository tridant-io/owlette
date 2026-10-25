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
4. **Single machine only** for hoot overrides (owner, 2026-10-25). The owner was asked about hoot chats ("can one approval cover a hoot chat aimed at several machines?"), so this doesn't cover the deploy page. A deployment's override, given by a person in the dashboard or by an API key, covers every target in that request, and the confirm says so.
5. **Scope is reboot, shutdown and deployments.**
   - Rollouts are excluded: `sync_pull` restarts nothing (`sync_commands.py:177-514`), and a refusal counts toward the >25% canary abort (`functions/src/lib/fanoutLogic.ts:107-131`).
   - Fleet updates are excluded: no machine reboot, and the old agent runs the update into the first guarded release (ADR 0006).
   - The weekly schedule is excluded: a person chose the time.
6. **The crash-loop reboot inside the window defers to the window end.** The dashboard's approve button can still reboot now with an override.
7. **The deferred reboot has its own record and field** (`reboot_state.deferredReboot`, `rebootDeferredUntil`), never `attempt` (it would disable the watchdog) and never `rebooting` with a far-future `rebootScheduledAt` (the pill overflows and the row dims).
8. **The refusal is an `Error: active_hours: …` string**, so the existing failed-status machinery and the deployments page show it with no new result format.
9. **Glossary:** "active hours" gets an entry (Windows' own term). Avoid quiet hours, show hours, maintenance window.
10. **`list_talons` moves to tier 1.** Members already read talons through the rules and the talons page. The test comment that called this a leak is rewritten with that reasoning.
11. **Stopping Windows' own restarts gives the operator a choice** (owner, 2026-10-25, after task 0.2):
    - **`limit_auto_restart` is the default.** It sets active hours by policy (up to 18 h) and removes restart deadlines, so Windows restarts only outside active hours, which is documented. Updates keep installing; hoot says a nightly restart can still happen.
    - **`disable_auto_install` is for when someone explicitly wants zero restarts.** It sets `AUOptions=3` (download, then notify to install), so there's no automatic install and no update restart, but security updates wait for a person. hoot explains that trade-off first. `enable_auto_install` undoes it.
    - **Never `NoAutoRebootWithLoggedOnUsers`.** It's legacy on Win11, reported to be ignored there, and it switches off the policy active hours. `get_status` reports it if someone else set it.
12. **`set_restart_deadline` is removed.** It never worked (wrong key) and only ever forced restarts. The "update guard" talon template stops asking for it.
13. **Deferral writes move to the right key** (`P`, not `AU`). `check_pending_reboot` stops reading `PendingFileRenameOperations` alone as a Windows Update restart.

## Owner inputs owed

- Task 0.1, for Jeff's machine:
  - the hoot chat share link
  - the site and machine, and dev or prod
  - roughly when it rebooted
  - a prod read-only key (`site=<siteId>:read`) if on prod
  - an OK for one read-only event-log command if the logs don't settle it
- Task 7.1, in one sitting:
  - an OK to reboot a dev Windows machine
  - the three Settings and elevation checks from "Owner, to confirm" under "Windows restart facts":
    - pause in Settings, then a `reg query`
    - toggle "adjust automatically" in active hours
    - an elevated `schtasks` read while a restart is pending

## Jeff's reboot

_(task 0.1)_ Candidates, from the code:
- Windows Update's own restart. hoot's `set_scheduled_install` turns on install-and-restart (`AUOptions=4`, `tools_windows.py:806`), which installs on schedule (daily 03:00 by default) and then restarts. `set_restart_deadline` writes under the wrong key and does nothing (task 0.2). No tool sets `NoAutoRebootWithLoggedOnUsers`.
- owlette's crash-loop reboot (`owlette_service.py:4273-4315`).
- owlette's weekly reboot schedule.
- A crash or power loss.

## Windows restart facts

Task 0.2, 2026-10-25. Nothing was written to any machine.
- **Measured** means read on this box: Windows 11 Pro 23H2, 22631.6199, `AutoAdminLogon=1`. Sources were `reg query`, a non-elevated directory listing and the local ADMX/ADML (`C:\Windows\PolicyDefinitions\WindowsUpdate.admx`, 2024-09-12). The ADMX is the GP-to-registry mapping this build ships.
- **Documented** means Microsoft Learn; links are at the end.

Key shorthand:
- `P` = `HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate`; `AU` = `P\AU`
- `MDM` = `HKLM\SOFTWARE\Microsoft\PolicyManager\current\device\Update`
- `MDMdef` = `…\PolicyManager\default\Update`, which holds the shipped defaults, the ranges and the GP value each MDM policy maps to (`GPBlockingRegKeyPath`)
- `UX` = `HKLM\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings`
- `UPS` = `HKLM\SOFTWARE\Microsoft\WindowsUpdate\UpdatePolicy\Settings`

**State on this box:**
- `P`, `AU` and `MDM` don't exist.
- `UX` holds only `ActiveHoursStart=8` and `ActiveHoursEnd=2`.
- `UPS` has `PausedFeatureStatus=0` and `PausedQualityStatus=0`. `UpdatePolicy\PolicyState` has `IsWUfBConfigured=0`.
- Nothing from Windows Update is pending: no `RebootRequired` key, no CBS `RebootPending`, and WUA `RebootRequired=False`. `PendingFileRenameOperations` is set.

| Value | Meaning and effect | Applies to | Source |
| --- | --- | --- | --- |
| **Stop restarts** | | | |
| `AU\NoAutoUpdate` DWORD | 0 = automatic updates on, needed for `AUOptions` to count. 1 = off. | Win10, Win11 | documented [wu-settings]; measured absent |
| `AU\AUOptions` DWORD, with `AU\ScheduledInstallDay` (0 = daily, 1–7 = Sun–Sat) and `AU\ScheduledInstallTime` (0–23, default 3) | 2 = notify; 3 = download and notify; 4 = download and install on a schedule. `NoAutoRebootWithLoggedOnUsers` needs 4. This policy sits under *Manage end user experience*, not legacy. owlette's `set_scheduled_install` writes 4, the day, the hour and `NoAutoUpdate=0`. | Win10, Win11 | documented [restart] [wu-settings]; measured (`MDMdef` maps `AllowAutoUpdate` to `AU\AUOptions`) |
| `AU\NoAutoRebootWithLoggedOnUsers` DWORD | 1 = Windows Update doesn't restart while a user is signed in, at the console or in an *active* RDP session. At the sign-in screen it restarts. Needs `AUOptions=4`. A restart the user scheduled from the notification still fires. Microsoft says it was never a CSP, "doesn't work exactly as per description" and "can result in no quality update reboots". In this box's ADMX it sits under *Legacy Policies*, though Learn tags only its siblings "not applicable for Windows 11". A 25H2 report has a restart inside active hours after an unanswered 15-minute countdown. | Win10: yes. Win11: documented, legacy category, **behaviour unconfirmed** | documented [restart]; measured (ADMX category); report [qa-25h2] |
| `AU\AlwaysAutoRebootAtScheduledTime`, with `…Minutes` (15–180) | Forces a restart after a scheduled install, even with users signed in. Has no effect while `NoAutoRebootWithLoggedOnUsers=1`. | Win10 only ("isn't applicable for Windows 11") | documented [restart] [csp] |
| `P\SetAutoRestartDeadline`, with `P\AutoRestartDeadlinePeriodInDays` (+`…ForFeatureUpdates`) | Forces a restart 2–14 days after the default restart date; "may happen inside active hours". **owlette's `set_restart_deadline` writes `AU\AutoRestartDeadlinePeriodInDays` and no `SetAutoRestartDeadline`. Both the ADMX and the MDM mapping put this policy on `P`, so the write does nothing.** | Win10 only (ADMX supportedOn is Win10 and Server 2016–2022; Learn: legacy) | documented [restart] [csp]; measured (ADMX, `MDMdef` mapping) |
| Win11 22H2+ deadlines: `P\SetComplianceDeadlineForQU`=1, `P\ConfigureDeadlineForQualityUpdates` (0–30 d), `P\ConfigureDeadlineGracePeriod` (0–7 d), `P\ConfigureDeadlineNoAutoRebootForQualityUpdates` (0/1), and the feature twins `…ForFU`, `…ForFeatureUpdates` | Updates install as soon as they're offered. Before the effective deadline, auto-restarts happen only outside active hours, or not at all when NoAutoReboot=1. The effective deadline is the later of discovery + deadline and restart-pending + grace. **After it, Windows forces a restart regardless of active hours.** These policies override Configure Automatic Updates (since Dec 2024 on 22H2+, only once the deadline has passed), `AlwaysAutoReboot` and the legacy deadline. They delay a restart by at most 30 + 7 days; they don't stop it. | Win10 1903+ and Win11; the split NoAutoReboot is Win11 22H2+ | documented [deadlines] [csp]; measured (ADMX names) |
| Win10 form: `P\ConfigureDeadlineNoAutoReboot`, with the same deadline values | One checkbox covers both update types. The enable flag is believed to be `SetComplianceDeadline`. | Win10 22H2 | documented [deadlines] (gone from today's CSP page). Measured: `MDMdef\ConfigureDeadlineNoAutoReboot` exists here. The flag name is unconfirmed (absent from this ADMX). |
| `P\SetAutoRestartNotificationDisable` | Hides restart notifications only; doesn't stop a restart. | Win10 only (legacy) | documented [restart] |
| `MDM\IgnoreWindowsUpdateGroupPolicies`; `…\PolicyManager\current\device\ControlPolicyConflict\MDMWinsOverGP` | When either is 1, MDM ignores or blocks every `P`/`AU` value owlette writes. | Ignore: Win11 24H2 + KB5101684. MDMWinsOverGP: Win10 1803+ | documented [csp] [conflict]; measured absent |
| Maintenance windows (`MaintenanceWindowEnabled`, `…UpdateActions`, …) | Installs and restarts start only inside the window. Microsoft names kiosks as the use case; an expired deadline still wins. | Win11 24H2+ with the January 2026 update; not this box | documented [deadlines]; registry names unconfirmed |
| **Pending restart** | | | |
| `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired` (key) | Present while a Windows Update restart is pending. | all | measured absent; not on Learn |
| WUA `Microsoft.Update.SystemInfo.RebootRequired` (COM, read-only) | True when an update needs a restart to finish. | all | documented [wua]; measured `False` |
| `…\Component Based Servicing\RebootPending`; `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\PendingFileRenameOperations` | A servicing restart or file renames are pending. **PFRO is set here with nothing from Windows Update pending, so `check_pending_reboot` returns `pending: true`. Don't read that as "Windows will restart".** | all | measured |
| Task `\Microsoft\Windows\UpdateOrchestrator\Reboot` (`tools_windows.py:30`) | The Win10 task that carried Windows' own restart time. **It doesn't exist here:** the folder `C:\Windows\System32\Tasks\Microsoft\Windows\UpdateOrchestrator` holds 12 tasks, none named Reboot*. A non-elevated `schtasks` can't see the folder at all. Whether a reboot task appears while a restart is pending is unconfirmed. | Win11 23H2 | measured |
| `HKLM\SOFTWARE\Microsoft\WindowsUpdate\UX\StateVariables\SmartSchedulerPredictedStartTimePoint` / `…EndTimePoint` (QWORD, ms since 1970 UTC), `…Confidence` | Here: today 02:00–05:00 local, confidence 71. The slot starts exactly at `ActiveHoursEnd`, which reads like Windows' predicted restart slot. | Win11 here | measured; meaning inferred, undocumented |
| **Pause** | | | |
| `UX\PauseUpdatesStartTime`, `UX\PauseUpdatesExpiryTime`, `UX\PauseFeatureUpdatesStartTime`, `UX\PauseFeatureUpdatesEndTime`, `UX\PauseQualityUpdatesStartTime`, `UX\PauseQualityUpdatesEndTime`, all REG_SZ `YYYY-MM-DDTHH:MM:SSZ` (UTC) | Reported to be what the Settings "pause updates" button writes; the end is at most 35 days out. owlette writes only `PauseUpdatesExpiryTime` today. | Win10 2004+, Win11 | community only ([qa-pause] shows `PauseUpdatesExpiryTime` alone); measured absent; **unconfirmed** |
| `P\DeferQualityUpdates`=1 + `P\PauseQualityUpdatesStartTime` REG_SZ `YYYY-MM-DD`; `P\DeferFeatureUpdates`=1 + `P\PauseFeatureUpdatesStartTime` | Policy pause: 35 days from the start date; clearing the date resumes. A shorter pause needs a back-dated start, which Learn implies works; untested. **Docs disagree on the type:** Learn's summary table says "REG_DWORD 1", while the ADMX (10-char text) and the CSP (string yyyy-mm-dd) say a date string. 1607 used the DWORDs `PauseQualityUpdates`/`PauseFeatureUpdates`. | Win10 1703+, Win11 | documented [wufb] [csp]; measured (ADMX, `MDMdef`) |
| `UPS\PausedQualityStatus`, `UPS\PausedFeatureStatus` (0 = not paused, 1 = paused, 2 = auto-resumed), `UPS\PausedQualityDate`, `UPS\PausedFeatureDate` | Windows' own pause state, so the read-back that proves a pause took. | Win10 1703+, Win11 | documented [wufb] for the policy pause; measured 0/0; whether a `UX` pause sets them is unconfirmed |
| `P\SetDisablePauseUXAccess` | 1 = the user's pause is removed. A `UX` pause is then presumably ignored (unconfirmed). | Win10 1809+, Win11 | documented [wufb]; measured (ADMX) |
| **Active hours** | | | |
| `P\SetActiveHours`=1 + `P\ActiveHoursStart`, `P\ActiveHoursEnd` DWORD 0–23 | Policy window: no automatic restart inside it, and the user's choice stops counting. **It has no effect while `NoAutoRebootWithLoggedOnUsers` or `AlwaysAutoRebootAtScheduledTime` is on.** | Win10 1607+, Win11 | documented [restart] [csp]; measured (ADMX) |
| `P\SetActiveHoursMaxRange`=1 + `P\ActiveHoursMaxRange` (8–18) | The longest window allowed, counted from the start hour. Default 18 (12 on 1607). | Win10 1703+ | documented [restart] [csp]; measured `MDMdef` default 18, range 8–18 |
| `MDM\ActiveHoursStart`, `MDM\ActiveHoursEnd`, `MDM\ActiveHoursMaxRange` | The same window set by MDM. Defaults are 8, 17 and 18. | Win10 1607+ | documented [csp]; measured `MDMdef` 8/17/18, `MDM` absent (value layout unconfirmed) |
| `UX\ActiveHoursStart`, `UX\ActiveHoursEnd` DWORD | The user's window from Settings, used when no policy is set. | Win10, Win11 | measured 8 and 2: an 18-hour window across midnight, so Settings accepts a wrap at the full 18 h. Not on Learn. |
| `UX\IsActiveHoursEnabled` | `set_active_hours` writes 1. | — | undocumented, absent here |
| `UX\SmartActiveHoursState` | Community: 1 = "adjust automatically" on, which lets Windows rewrite `UX\ActiveHours*`; 0 = off. The feature exists and has to be turned on [1903]. | Win10 1903+ | absent here; name and meaning unconfirmed |

**Active-hours rules:**
- **The end hour is exclusive.** The default 8–17 is "8 AM to 5 PM" [restart], and the predicted restart slot here starts at 02:00, which is `ActiveHoursEnd`.
- The start hour is inclusive, `start > end` wraps past midnight (measured 8→2), and the window can't exceed 18 h, or `ActiveHoursMaxRange` when set.
- The default is 8–17 [restart] [csp], matching `MDMdef`.
- `start == end` is undocumented. It means 0 or 24 hours, and 24 exceeds the 18-hour maximum, so treat it as invalid (inferred).
- "Adjust automatically" is only a user setting; any policy window beats it.

**Reader precedence for 1.1:**
1. `P`, only when `SetActiveHours=1` and both values are valid.
2. `MDM`, with both values set.
3. `UX`.
4. 8–17.

Read `MDM` before `P` when `MDMWinsOverGP=1` or `IgnoreWindowsUpdateGroupPolicies=1`. GP before MDM is inferred: the `MDMdef` nodes name `P` as their blocking path, and `MDMWinsOverGP` defaults to 0. Microsoft calls an unmanaged GP/MDM conflict a race [conflict].

**Does anything stop a restart that is already pending?**
- **Active hours:** yes, until the effective deadline [restart] [deadlines].
- **A pause from Settings:** "any pending restarts are canceled" [wufb]. That is documented for the Settings button; whether a raw `UX` write does the same is unconfirmed. Support.microsoft.com says that on Windows 11 a paused device "won't restart automatically to finish installation of the updates until the pause ends".
- **`NoAutoRebootWithLoggedOnUsers`:** probably, because it is evaluated when the restart would happen. A user-scheduled restart and a passed deadline still fire. Unconfirmed on Win11.
- **Nothing stops a restart once an effective compliance deadline has passed.**

**Other owlette bugs found:**
- `set_feature_deferral`, `set_quality_deferral` and `get_status` write and read `Defer*` under `AU`, but Windows reads them from `P`, so those writes do nothing.
- `check_pending_reboot` treats PFRO as pending, and on 23H2 it reads a reboot task that doesn't exist, so `next_scheduled_update` is always null here.
- The "Jeff's reboot" notes above say `set_restart_deadline` forces a restart. It doesn't: as written, the write has no effect.

**Recommendations:**
- **`disable_auto_restart`:**
  - Write `AU\NoAutoUpdate=0` and `AU\AUOptions=4`, but only when `AUOptions` is absent. Keep an existing 2, 3 or 4, and leave `NoAutoUpdate=1` alone. Then write `AU\NoAutoRebootWithLoggedOnUsers=1`. Never write deadline values.
  - Report back the three values as read back, whether owlette set `AUOptions`, and anything that can still force a restart: a deadline policy, `AlwaysAutoRebootAtScheduledTime`, MDM's `IgnoreWindowsUpdateGroupPolicies`/`MDMWinsOverGP`, or a restart already pending (WUA or `RebootRequired`).
  - Also report that it does nothing at the sign-in screen. On build ≥ 22000, say that Microsoft lists it under legacy policies, that field reports say it gets ignored, and that it switches off the *policy* active hours.
- **`enable_auto_restart`:** delete only `AU\NoAutoRebootWithLoggedOnUsers`. Report the `AUOptions`, `NoAutoUpdate` and `ScheduledInstall*` values that remain, because they may be a person's or `set_scheduled_install`'s, and with `AUOptions=4` the machine stays on scheduled install (daily 03:00 by default).
- **`pause`:**
  - Write all six `UX` values in one open: both start times = now, `PauseUpdatesExpiryTime` and both end times = now + `pause_days`, all in UTC `%Y-%m-%dT%H:%M:%SZ`.
  - Then read `UPS\Paused{Quality,Feature}Status`. Report `paused` only when Windows shows 1, otherwise "written, not yet confirmed by Windows".
  - If `P\SetDisablePauseUXAccess=1` or a policy pause is present, report it rather than writing.
  - `resume` deletes all six.
  - Fall back to the policy pause (back-dated `PauseQualityUpdatesStartTime`/`PauseFeatureUpdatesStartTime` with `DeferQualityUpdates`/`DeferFeatureUpdates=1`) only if the owner's test shows the `UX` write doesn't take.
- **`set_active_hours`:**
  - Validate first: 0–23, start ≠ end, and a wrap-aware length no longer than the effective max (`P`, then `MDM`, else 18).
  - Refuse with "managed by MDM" when `MDM\ActiveHoursStart`/`End` are set.
  - Otherwise write `P\ActiveHoursStart`, then `P\ActiveHoursEnd`, then `P\SetActiveHours=1` last, so the policy is never on with half a window. Stop writing `UX\IsActiveHoursEnabled`.
  - Report the window as read back by `osadapter.active_hours()` (source `policy`). Say that the person can no longer change active hours in Settings, that a domain GPO setting the same values wins at its next refresh, and that Windows ignores this policy while `NoAutoRebootWithLoggedOnUsers=1`; owlette's guard still uses it.
  - The policy is the only write that beats both auto-adjust and the user. The alternative, `UX` plus `SmartActiveHoursState=0`, keeps Settings editable but relies on an undocumented value. Decide in 2.2 whether a reset that deletes the three `P` values is needed.

**Owner, to confirm.** Each item needs a write, a Settings click or elevation on a dev box:
1. Pause: in Settings, pause for 1 week, then `reg query` `UX` and `UPS`, then resume and query again. This confirms the six names, their format and that `UPS` flips to 1.
2. Active hours: open Advanced options > Active hours and note whether it says automatically or manually. Switch to automatically and back, then `reg query` `UX`. This confirms `SmartActiveHoursState`.
3. From an elevated prompt (read-only, but it needs a UAC click), run `schtasks /Query /FO LIST /V` on each `\Microsoft\Windows\UpdateOrchestrator\` task while an update restart is pending. This shows which task now carries Windows' restart time.
4. In task 7.1, on a signed-in Win11 box with a pending update restart, apply `disable_auto_restart` and confirm no restart for 24 h, including outside active hours. Repeat on 24H2/25H2 if the fleet has it. Only a real run can settle the Win11 question.

Sources:
- [restart] https://learn.microsoft.com/en-us/windows/deployment/update/waas-restart
- [csp] https://learn.microsoft.com/en-us/windows/client-management/mdm/policy-csp-update
- [deadlines] https://learn.microsoft.com/en-us/windows/deployment/update/wufb-compliancedeadlines
- [wufb] https://learn.microsoft.com/en-us/windows/deployment/update/waas-configure-wufb
- [wu-settings] https://learn.microsoft.com/en-us/windows/deployment/update/waas-wu-settings
- [conflict] https://learn.microsoft.com/en-us/windows/client-management/mdm/policy-csp-controlpolicyconflict
- [wua] https://learn.microsoft.com/en-us/windows/win32/api/wuapi/nf-wuapi-isysteminformation-get_rebootrequired
- [1903] https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-10/whats-new/whats-new-windows-10-version-1903
- Support page (not Learn): https://support.microsoft.com/en-us/windows/manage-updates-in-windows-643e9ea7-3cf6-7da6-a25c-95d4f7f099fe
- Community, not docs:
  - [qa-25h2] https://learn.microsoft.com/en-in/answers/questions/5916635/windows-11-25h2-forces-automatic-reboot-during-act
  - [qa-pause] https://learn.microsoft.com/en-us/answers/questions/1287073/pausing-windows-update-using-powershell

## Release coordination

- The owner confirmed on 2026-10-25 that 4.1.21 waits for this branch. owlette-1b cuts it from dev only after this guard is verified and merged; message owlette-1b when it lands.
- Rebase onto dev before the PR. owlette-1b's `fix/swoop-mac-traffic-lights` (#428, merged as b84c17ab) and owlette-ac's `fix/security-deps-2026-10-24` (#429) each add Unreleased changelog entries.
- #429 bumps next to 16.4.3 (App Router caching changes), @sentry/nextjs and zod, removes @tailwindcss/typography, updates `smol-toml` in the root lockfile, and moves Pillow to 13.0.0 and setuptools to 84.1.0.
  - After rebasing onto it, run `npm ci` again in the worktree root and in `web/`.
  - This branch changes no package.json or lockfile; confirm before the commit.
  - Run the full e2e suite on the merged tree (`/preflight`), not just this branch's specs.

## Execution notes

- **3.1 fire path:** the deferred reboot fires on its own `deferred-reboot` daemon thread, single-flight like the roost scrub, called after `_check_scheduled_reboot` on the reboot tick.
  - The scheduled-fire path sleeps, so it can't run on the main loop. The slow lane queues behind installs, so it can't run there either.
  - It writes no `attempt`, so the watchdog is unaffected.
  - A boot since `requestedAt` drops it at startup. Dismiss drops only a crash-loop deferral.
- **3.3 screenshots** (reviewed by the orchestrator; for the owner's visual review), in `C:\Users\admin\AppData\Local\Temp\claude\c--Users-admin-Documents-Git-restored-Owlette\f4f5e5a8-1d59-4070-b11a-bc271161fa7f\scratchpad\evidence\3.3\`:
  - States: `restart-choice`, `restart-choice-reason`, `shutdown-choice`, `restart-plain`, `refusal-toast`.
  - Each comes in `-desktop`/`-phone` and `-dark`/`-light` versions, as `.png`.
- **4.1 screenshots** in the same `evidence\4.1\` folder (the amber "restart at" pill):
  - `deferred-card-*` and `deferred-list-*`, each with a `-closeup` version;
  - `-hover` versions showing the cancel swap.
- **4.3 screenshots** in `evidence\4.3\`, one per state: `deploy-confirm`, `deploy-confirm-reason`, `retry-confirm-reason`, `target-refusal`.
- **6.1 review** (2026-10-25):
  - **Standards:** no rule violations. Medium: the window-shrink check could be bypassed with tier-2 `registry_operation`; that's being fixed. Low: the ADR's local-hoot wording; plus DRY items.
  - **Spec:** met, except tool-path overrides weren't site-logged, CLI and SDK deployments had no override, there was no conversations-API test, and the CLI `--json` shape change wasn't in the changelog. All are being fixed. Jeff's cause (0.1) and real-machine proof (7.1) are still owed.
  - Accepted, not changed: crash-loop deferral and re-hold make one flag write and one `log_event` call on the main loop per escalation, like the existing `set_reboot_pending` there.

## Proof

_(task 7.1)_

## Next steps

1. Task 0.2 now: read-only, unblocks waves 1–2.
2. Task 0.1 as soon as the owner sends Jeff's details.
3. Then `/execute` wave 1 (1.1, 1.2, 1.3 in parallel) in this worktree. Web tasks need their own `npm ci` in the worktree (Turbopack rejects a node_modules junction).
