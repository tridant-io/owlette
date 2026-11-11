# machine-scope — Context
**Last updated**: 2026-11-04, revised against owner decisions 13–14, two critiques and release 2's revised plan

## Owner rulings this plan follows (2026-11-04, binding)
The full text is in the session scratchpad: `research/owner-decisions.md`.
- **1.** A member row may carry a machine list. A scoped member sees and acts on only those machines and holds no site-wide capability. Moving a machine between sites is deferred.
- **2.** firestore.rules may change for this, in this release.
- **3.** Scoped admins exist. Their role word stays admin, and their access reads "N machines" instead of "whole site".
- **10.** Alert emails respect machine scope.
- **13.** A per-person swoop mode, `swoop: 'none' | 'view' | 'control'`:
  - It applies to every machine the person can reach, which is their scoped machines once machine scope lands.
  - With no mode set, the role decides.
  - A member set to control gains MACHINE_REMOTE_CONTROL and nothing else.
  - `membersMayWatch` is the default only for members with no explicit mode.
  - Downgrades revoke.
  - Nobody sets their own mode or the owner's.
- **14.** The mode ships in release 2 (capabilities.ts, policy.server.ts, the members API). Release 3 adds the machines picker beside role and mode. Scope × mode covers the owner's case, and there are no per-machine modes.
- **They interact with these:**
  - 6: add-member candidates come only from sites the caller administers;
  - 7: viewer emails go to site admins and owners only;
  - 8: full releases;
  - 9: viewers share a session, and control is per viewer;
  - 11: order 4.1.26, then release 2, then release 3, with parallel building only where files do not collide;
  - 12: no shortcuts. e2e for new behaviour, a bug fix starts with a failing test, and docs change in the same release.

## Key Files

### Create
- `web/lib/machineAccess.ts`, the one reading of a machine scope:
  - `MAX_MACHINE_SCOPE` (30);
  - `parseMachineIds(memberData)`: absent gives null (whole site), and a non-array gives [] (no machines);
  - `scopeCovers(scope, machineId)`;
  - `normalizeMachineIdsInput(raw, {allowNull})`.
- `docs/adr/0016-members-can-be-scoped-to-machines.md`. 0015 is release 2's add-member search rule, and both plans fix these numbers.
- `web/components/admin/sites/MachineAccessField.tsx`: "whole site" | "some machines" (release 2's `SegmentedControl`), then MultiSelect. It exports `isAccessValid`, `accessLabel` and `liveMachineIds`.
- `web/app/dashboard/components/MachinesNotice.tsx`: `machinesNotice()`, `NoMachinesForYou`, `MachinesLoadError`.
- `web/hooks/useSiteMachines.ts`, only if release 2 did not extract it.
- Tests:
  - lib: `web/__tests__/lib/machineAccess.test.ts`, `web/__tests__/lib/pairingPlan.test.ts`;
  - rules: `web/__tests__/rules/siteReadControls.test.ts`, `web/__tests__/rules/machineScope.test.ts`;
  - hooks: `web/__tests__/hooks/useMachines.scope.test.ts`, `useSiteMemberships.scope.test.ts`, `useAgentAlertToasts.test.ts`, `useHoot.autonomous.test.ts`, `useCurrentSite.test.ts`;
  - api: `web/__tests__/api/machineRouteGates.test.ts`;
  - components: `web/__tests__/components/admin/sites/MachineAccessField.test.tsx`, `web/__tests__/components/NoSitesEmptyState.test.tsx`, `RestartScheduleDialog.test.tsx`, `ApplyScheduleToMachinesDialog.test.tsx`;
  - app: `web/__tests__/app/dashboard-machines-notice.test.tsx`;
  - e2e: `web/e2e/specs/sites/machine-scope.spec.ts`, `web/e2e/specs/sites/member-access.spec.ts`, plus a `machine scope` describe in `web/e2e/specs/swoop/session.spec.ts`.

### Modify
- **Rules:** `firestore.rules` (2.12.0). `firestore.indexes.json` is untouched.
- **Decision core**, built on release 2's helpers:
  - `web/lib/capabilities.ts`:
    - `MACHINE_CAPABILITIES`;
    - `MemberStanding.machineIds`;
    - `siteStanding`'s `machineScopes`, and `UserActor.machineScopes`;
    - `machineScopeOf`;
    - `hasCapability(…, machineId?)` in the order role → mode → scope.
  - `web/lib/sitePolicy.server.ts`: `facts.machineIds`, `deriveMachineIds`, `memberStanding`, `standingOf`, and the `listUserStanding` entries.
- **Gates:**
  - `web/lib/authorizedHandler.server.ts`: the standing in 4.1, the scope step in 5.1;
  - `web/app/api/_shared.ts`: `requireSiteAuthAndScope`'s `machineScope` option, `requireSiteMachineAuthAndScope`, and the machine, roost and chat gates;
  - `web/lib/apiAuth.server.ts`.
- **Writer and leaving machines:**
  - `web/lib/membership.server.ts`: `addMember` and release 2's `updateMember` gain machineIds; `pruneMachineFromMembers`;
  - `web/lib/actions/removeMachine.server.ts`;
  - `web/lib/pairingPlan.server.ts`: `stampPairedAt` becomes `recordPairing`;
  - `web/app/api/agent/auth/device-code/poll/route.ts`, `web/app/api/agent/auth/exchange/route.ts`.
- **Routes:**
  - members: `web/app/api/sites/[siteId]/members/route.ts`, `members/[uid]/route.ts`;
  - machines:
    - `machines/route.ts`;
    - `machines/[machineId]/route.ts` (GET), `machines/[machineId]/deployments/route.ts`;
    - `machines/[machineId]/swoop/step-up/route.ts` (GET);
  - logs and the site: `logs/route.ts`, `logs/[logId]/route.ts`, `[siteId]/route.ts` (GET);
  - hoot: `web/app/api/hoot/route.ts`, `hoot/cancel-tool/route.ts`, `hoot/provision-key/route.ts`, `hoot/conversations/route.ts`, `web/app/api/chat/new/route.ts`;
  - account: `web/app/api/users/me/route.ts`;
  - the member-candidates route only if task 6.8's case fails.
- **hoot and talons:**
  - `web/lib/hoot-utils.server.ts`:
    - `SiteAccessLevel.standing`;
    - `listSiteMachines(scope)`, `resolveHootTargets` scope;
    - `SITE_WIDE_SERVER_TOOLS`, `userStanding`, the required `machineScope`;
  - `web/lib/hootStream.server.ts`, `web/lib/hoot/turnRunner.server.ts`, `web/lib/hoot/followupSweep.server.ts`;
  - `web/lib/talons/author.server.ts`, `web/lib/talons/hootOutput.server.ts`, `web/lib/talons/store.server.ts`.
- **swoop:** `web/lib/swoop/policy.server.ts` (the machineId), `web/lib/swoop/revokeViewerSessions.server.ts` (`keepMachineIds`, `scope_changed`).
- **Alerts:**
  - `web/lib/adminUtils.server.ts`:
    - recipients from member rows;
    - `SiteRecipient.machineIds` and `recipientWantsMachine`;
    - three dead helpers deleted;
  - the routes: `web/app/api/agent/alert/route.ts`, `alerts/trigger/route.ts`, `cron/display-alerts/route.ts`, `cron/health-check/route.ts`, `cron/process-alerts/route.ts`;
  - `web/lib/talons/outputs.server.ts`, `web/lib/hoot-escalation.server.ts`.
- **Functions:** `functions/src/telemetry.ts`.
- **Browser data:**
  - `web/hooks/useFirestore.ts`: `scopeMap`, `useMachines(siteId, machineIds?)`;
  - `web/contexts/AuthContext.tsx`: `machineScope`, `isMachineAdmin`, `siteRole`, and whole-site semantics;
  - `web/hooks/useAgentAlertToasts.ts`, `web/hooks/useHoot.ts`, `web/hooks/useCurrentSite.ts`, `web/hooks/useSiteMembers.ts`, `web/lib/logFilters.ts`.
- **UI:**
  - the dashboard and machine views: `web/app/dashboard/page.tsx`, `MachineCardView.tsx`, `MachineListView.tsx`, `web/components/MachineContextMenu.tsx`, `MachineStatusPill.tsx`, `charts/DisplayLayoutPanel.tsx`;
  - the nav and site lists: `web/components/PageHeader.tsx`, `NoSitesEmptyState.tsx`, `web/app/deployments/page.tsx`, `web/app/roosts/RoostsPageClient.tsx`, `web/app/talons/page.tsx`;
  - swoop: `web/components/swoop/SwoopPicker.tsx`, `web/app/swoop/[siteId]/[machineId]/page.tsx`, and `web/hooks/useSwoopSession.ts` (only if its "left the site" logic needs it);
  - hoot and logs: `web/app/hoot/components/HootChatView.tsx`, `web/app/logs/page.tsx`;
  - schedules: `web/components/RestartScheduleDialog.tsx`, `ApplyScheduleToMachinesDialog.tsx`;
  - release 2's `web/components/admin/sites/{SiteMembersSection,MemberAccessFields,AddMemberDialog,ChangeAccessDialog,SiteList,SiteSettings}.tsx`, and `web/lib/talonSuccessors.ts`.
- **Script:** `scripts/check-membership-read-path.mjs`: `--scoped` (with `--uid`), `--list-scoped` with the rollback DELETEs, and the machine-scope section.
- **e2e helper:** `web/e2e/helpers/seed.ts`, where release 2's `extra` gains `machineIds`.
- **Docs and records:**
  - `web/openapi.yaml`, `GLOSSARY.md`, `README.md`, `PRODUCT.md`, `docs/changelog.md`, `web/content/docs/changelog.mdx`;
  - reference: `web/content/docs/reference/{authentication,firestore-data-model,agent-commands,hoot-tools}.mdx`;
  - setup and agent: `setup/{firestore-rules,firebase}.mdx`, `agent/remote-commands.mdx`;
  - api: `api/{authentication,errors,webhooks,versions,chunks}.mdx`;
  - dashboard: `dashboard/{swoop,hoot,activity-logs,talons,process-management,displays,restart-schedules}.mdx`, `dashboard/admin/{index,email-alerts,member-management}.mdx`, `architecture.mdx`;
  - internal: `docs/internal/version-management.md`, `docs/runbooks/dev-to-prod-workflow.md`, `docs/runbooks/hotfix-rollback.md`;
  - skills: `.claude/skills/firebase-integration/SKILL.md`, `.claude/skills/codebase-map/SKILL.md`;
  - `agent/swoop/PROTOCOL.md`, `web/e2e/COVERAGE.md`.
  - Only if open question 4 is "now": the SDK and CLI members code, and their docs pages.
- **Tests extended:**
  - access core: capabilities, sitePolicy, membership, authorizedHandler, `_shared`, apiAuth, scopeEnforcement, authorizationParity, membershipEscalation;
  - routes: sites-members, sites-member-candidates, transferSiteOwnership, sites-machines, swoop/*, site-logs, sites, display-settings, site-audit-log, quota-events, agent device-code and exchange;
  - hoot and talons: hoot-*, chat, hoot-utils, hootStream, turnRunner, followupSweep, talon-tools, talons/{author,store};
  - leaving machines and alerts: removeMachine, adminUtils, cron/health-check;
  - browser:
    - AuthContext, the machine views, MachineContextMenu, DisplayLayoutPanel, MachineStatusPill;
    - PageHeader, SwoopPicker, swoop-viewer, HootChatView, logFilters, useSiteMembers, useSwoopSession;
    - release 2's members components, SiteList, SiteSettings, talonSuccessors;
  - functions: telemetry.

### Not touched
- `firestore.indexes.json`. Agent code (ADR 0001; the agent-side terms in the rules are byte-identical).
- `.claude/hooks`, `.claude/settings.json`.
- The SDKs and the CLI, unless open question 4 says now.

## Decisions
1. **The field is `machineIds`,** on `sites/{siteId}/members/{uid}`.
   - Absent means whole site. Present means only those machines, and nothing site-wide.
   - `[]` or a malformed value means no machines; it fails closed.
   - Writers store 1–30 ids, sorted and unique, each an existing machine of the site.
   - Widening is `FieldValue.delete()` through `PATCH {machineIds:null}`, never `[]` or null.
   - Owners are never scoped, and you cannot change your own row.

   The name matches `excludedMachineIds` and hoot's `target.machineIds`.
2. **Terms.**
   - In GLOSSARY and ADR 0016: "machine scope" for the list, "whole site" for no list, and "scoped member" for anyone with a list, whatever their role. A scoped admin is a scoped member whose role is admin.
   - UI copy: "whole site", "N machines", "no machines" and "limited to some machines".
   - The rules helpers are `memberIsWholeSite`, `memberHoldsMachine`, `canAccessWholeSite` and `canAccessMachine`. The research's `isFullMember` was renamed, because "full member" reads as the site role `member`.
3. **404 or 403.**
   - A machine outside the scope answers 404 'machine not found or no access'. The wrapper audits it as `machine_out_of_scope`; the `_shared` gates audit nothing, as before.
   - A site-wide route, or a site-wide capability on a machine route, answers a scoped caller 403. The wrapper audits it as `machine_scope_site_wide`, with the machineId when the route has one.
   - The 403 takes the capability step's own shape: code `capability_missing` for the bypass-exempt swoop capabilities (release 2, decision 24), plain `forbidden` otherwise. Swoop's viewer ends only on a coded refusal.
   - Why: this matches the existing 404 for an unreachable site and 403 for a missing capability, and it does not reveal whether a machine exists. For a scoped caller, an out-of-scope id and a non-existent one get the same answer.
4. **Capability classes.**
   - Machine-class: MACHINE_VIEW, MACHINE_REMOTE_VIEW, MACHINE_EXEC_COMMAND, MACHINE_REMOTE_CONTROL and MACHINE_CONFIG_WRITE.
   - Everything else site-scoped is site-wide, including MACHINE_REMOVE, UNINSTALL_TRIGGER, MACHINE_ENROLL, AGENT_TOKEN_REVOKE and SWOOP_SETTINGS_MANAGE.
   - A site-level check of a machine-class capability with no machineId refuses a scoped actor. That covers talon authoring's command-output gate and hoot's `create_talon`, and it is intended: talons span the site.
5. **The order: role matrix, then swoop mode, then machine scope** (decisions 3, 13 and 14).
   - In `hasCapability`, release 2's override (an explicit mode decides MACHINE_REMOTE_VIEW and MACHINE_REMOTE_CONTROL, never on an owner row) runs before the scope.
   - In `evaluateSwoopAccess`, `members_may_not_watch` applies only to a member with no explicit mode (release 2).
   - On a machine in scope:
     - a member with no mode watches when the site allows it, and `view` always watches;
     - a member with `control` watches, and controls after a step-up;
     - an admin with no mode or `control` gets commands, config, watching and control;
     - an admin with `view` gets commands, config and watching;
     - `none` gives no swoop.
   - Off the scope, nothing.
6. **The actor's shape follows release 2's seams.**
   - Release 2's `MemberStanding { role, swoopMode }` gains `machineIds`. Its `siteStanding(bySite)` also returns `machineScopes`, with one entry for every site in `siteRoles` (null means whole site).
   - `machineScopeOf` reads a present map that lacks the site as no machines, so it fails closed.
   - Only actor literals with no map (tests) read as whole site.
   - Task 8.1 makes `machineScopes` and `swoopModes` required on `UserActor`, so tsc names any builder that skips `siteStanding`.
   - **Rejected: one combined per-site entry**, which a critique suggested. One builder already writes all three maps, and a missing scope entry denies. Rewriting release 2's `swoopModes` into a combined entry would touch every builder and every actor-building test for no added safety.
7. **Every UserActor is built through `siteStanding`.**
   - From facts: `standingOf(facts)`. Release 2's three builders (the wrapper, `_shared`'s `requireSiteCapability`, `assertUserHasSiteCapability`) switch to it in task 4.1.
   - From a raw row: `memberStanding(row)`. `listUserStanding` (candidates) and the talons store successor use it.
   - hoot's tool actor: `userStanding`, from `verifyUserSiteAccess`'s new `standing`.
   - hoot's routes: cancel-tool and provision-key.
   - users/me: `siteStanding({})`.
   - hoot's offer filter takes a separate, required `machineScope`. The conversations API builds its tool actor without site standing, as it does today, yet must still hide the site-wide tools.
8. **The kill switch never widens a scope.** The wrapper's scope step is part of site access, and runs before `securityConfig`.
9. **`_shared` gates.**
   - `requireSiteAuthAndScope` refuses scoped callers by default. The machines list, logs, logs/{id} and GET site opt in with `{machineScope:'admit'}`, and filter or check.
   - New `requireSiteMachineAuthAndScope` covers machine detail GET, machine deployments GET and step-up GET, keeping their `site=` key contract.
   - `requireMachineAuthAndScope` checks after the agent short-circuit.
   - Roost refuses scoped callers. Chat admits them and returns their machineIds.
10. **What is filtered, and what is denied, for scoped callers.**
    - **Filtered:**
      - the machines list, with its `currentRoosts` (open question 6);
      - logs: a `machineId in scope` query with no unbounded scan, and logs/{id} answers 404 off the scope;
      - hoot: "all machines" means the scope, an out-of-scope id is `unknown_machine` (400), and follow-ups narrow;
      - hoot's site-wide server tools (get_site_logs, deploy_software, create_talon, list_talons, set_talon_enabled) are not offered;
      - alert emails: only their machines, and a machine-less email skips them.
    - **Denied:**
      - swoop: kill, the site swoop sessions list and swoop settings;
      - settings: display and hoot settings, members, presets, agent tokens and alert rules;
      - fleet-wide pages: deployments, roost, chunks, quota, the events stream, webhooks, the audit log and talons;
      - the site itself: PATCH and DELETE;
      - the usage function.
11. **Kill and the site's sessions list are site-wide, following release 2** (its decision 25: SWOOP_SETTINGS_MANAGE).
    - No scoped person can kill or list. A scoped person still leaves their own seat (session DELETE).
    - This replaces the earlier "a scoped admin may kill on an in-scope machine", and with it the "kill closes everyone's step-up windows" leak.
    - If the owner refuses release 2's question 5 and kill stays on MACHINE_REMOTE_CONTROL, kill is machine-class: a scoped person in control may kill on their machines, closing every user's windows there. Tasks 6.6 and 9.2 test that branch, and open question 5 gains the leak.
12. **Viewer emails need SITE_MEMBER_MANAGE** (release 2's gate, its task 4.3). That capability is site-wide, so a scoped admin sees names only. Tasks 6.6 and 7.5 pin it, wherever the gate lives.
13. **No new swoop deny code, and no false "left the site".**
    - Out of scope at create is the wrapper's 404, with no code, which the viewer treats as final.
    - Its copy is the detail 'machine not found or no access', shown with the existing back link.
    - "This machine has left the site" (release 1) fires only on the create 404's `machine_not_found` code or a `machine_removed` end reason, never on a refused read or the wrapper's 404 (task 7.5).
    - The lease's 404 is retried until expiry + 30 s, as for a removed member.
    - The in-handler policy refusal reuses `capability_missing`.
14. **Revocation: one call per PATCH.**
    - `revokeSwoopSessionsForUser` gains `keepMachineIds`. With it, every seat on a machine outside the list ends (audited `scope_changed`), and a seat on a listed machine ends only when `controlOnly` is set and it holds control. Without it, release 1's and 2's rules hold.
    - The PATCH computes:
      - `watchLost` (mode to `none`): every seat ends;
      - `controlLost` (by role or by mode, `grantedSwoopMode` before and after): `controlOnly`;
      - `narrowed`: `keepMachineIds`.

      One call carries both filters.
    - The bound, with release 1's seat removal: about 2 s when the person is alone in the session; within one lease plus 30 s when it is shared.
15. **Rules 2.12.0.**
    - Per-machine blocks move to `canAccessMachine`, and site-wide blocks to `canAccessWholeSite`.
    - `isSiteAdmin` needs whole site.
    - Read exceptions on `canAccessSite`: the site document, `settings/{swoop,display,cortex}`, and the schedule and reboot presets. A denial hides swoop, and the config dialogs read the presets.
    - Site logs use `canAccessMachine(siteId, resource.data.machineId)`.
    - Autonomous chats use `canAccessWholeSite`.
    - No index change. The agent disjuncts are byte-identical (ADR 0001).
    - The invariant comment says `canAccessSite` admits scoped members.
16. **The browser.**
    - **AuthContext** adds `machineScope(siteId)`, `isMachineAdmin(siteId, machineId)`, and `siteRole(siteId)` (for labels only). `isSiteAdmin`, `administersAnySite` and `isSiteOwner` mean whole-site standing. `isMachineAdmin` gates commands, process config and displays, never swoop: the server decides swoop.
    - **No per-machine control check in AuthContext**, which a critique suggested. No dashboard affordance gates on control: the viewer always asks for control and steps down to watching on `capability_missing`. Release 2's decision 26 also keeps the swoop mode out of the dashboard, so a client-side mode × scope check would gate nothing. The one claim that pointed the other way, `isMachineAdmin`'s doc mentioning swoop control, is removed.
    - **Queries:**
      - `useMachines(siteId, machineIds?)` uses `documentId() in` (≤30), and a refused listener stops loading and reports an error;
      - the dashboard skips deployments on scoped sites;
      - alert toasts and logs query by machine;
      - hoot skips autonomous chats on scoped sites;
      - the swoop viewer reads one machine doc;
      - RestartScheduleDialog reads machines only while it is open.
    - **States:**
      - the dashboard shows "no machines here for you yet" and "machines couldn't load: …" (`MachinesNotice.tsx`, unit-tested);
      - talons, roost and deploy say "this page needs whole-site access" to someone with no whole-site site.
    - **Navigation:** the nav hides talons, roost and deploy on a scoped site, and those pages list only whole-site sites.
    - **Machine cards and rows** compute `isMachineAdmin` themselves for commands, processes and displays, and keep `isSiteAdmin` for remove machine, revoke token and "turn on swoop…".
17. **The writer is release 2's `updateMember`, extended.**
    - It changes role, swoop and machineIds in one transaction, and returns `{before, after}` with machineIds.
    - A role or mode change keeps the scope.
    - `addMember` takes machineIds.
    - `transferSiteOwnership`'s successor row drops both the scope and the mode.
18. **When a machine leaves, its id leaves every scope.**
    - `removeMachine` prunes it.
    - Pairing (`recordPairing`, renamed from `stampPairedAt`) prunes it again when the machine doc did not exist. That catches the desktop app's own leave-site, which deletes the doc through the agent's REST client (`agent/src/configure_site.py` `_deregister`, :781-795). It also catches a failed removal prune.
    - A re-pair of a machine still on the site keeps its grants.
    - A row emptied by pruning stays `[]` (shown as "no machines"); it is never widened.
    - Open question 10 asks the owner whether a re-paired machine should keep its old grants.
19. **Alert recipients** are the active member rows, plus the legacy `users.sites[]` array during the transition, plus the owner. Each carries the row's scope. A scoped member therefore still gets their machines' alerts after the legacy strip.
    - `getSiteAdminEmails`, `getSiteProcessAlertEmails` and `getSiteAlertEmailsWithCc` have no callers and ignore scope, so they are deleted.
20. **Talons.**
    - A scoped person cannot author, manage or inherit talons.
    - An existing talon whose author becomes scoped is disabled at its next fire (`creator_access_revoked`).
    - The access dialog warns with the count, singular or plural.
21. **The UI, in release 2's members section.**
    - Release 2's `MemberAccessFields` gains `MachineAccessField`, so "change access..." and "add member" edit role, swoop and machines in one place. The choice is an explicit "whole site" | "some machines".
      - This deviates from "MultiSelect, all machines when empty", because in MultiSelect an empty selection, and its "none" button, both mean all.
      - At least one machine and at most 30; dead ids are dropped on save.
    - The access column sits inline after swoop.
    - A scoped row in the site list reads "admin · 1 machine".
    - SiteSettings tells a scoped admin that its settings need the whole site.
    - Talon successors exclude scoped rows.
22. **e2e, as release 2 does it.**
    - Wave 9 authors three specs in parallel, checked only by eslint and `--list`. Wave 10 builds once and runs them with `public/docs-links.spec.ts`, on both projects.
    - The swoop cases are a describe in `swoop/session.spec.ts`, so they reuse its TOTP sign-in, step-up and FakeSwoopHost helpers instead of copying them.
    - The owner's case is proven twice:
      - in e2e: a scoped member set to control takes control through a host, and is refused another machine before any ceremony, with no step-up window written;
      - on dev: wave 13.
23. **Deploy order:** rules and the function first, then the web. Rollback is the reverse, with scoped members removed first. Railway one-click redeploys and a stale Vercel standby are rollbacks too (see "Rollback").
24. **Releases and where work happens.**
    - Waves 0–2 run beside release 2 and touch none of its files.
    - Wave 3 rebases after release 2 merges, which also means after release 1, and records the shipped names.
    - Everything runs in the worktree `Owlette-machine-scope-wt`.
    - It is a full release (exe, pkg and deb), even though the agent is unchanged (decision 8).
25. **Owner steps are batched.**
    - The answers to open questions 2–4 gate wave 2, and are asked at plan approval in one batch with release 2's questions.
    - Wave 12 is one sitting: the UX review in a headed emulator preview, then the rules and function deploys, the installer upload, and the merge and tag.
    - Wave 13 is the proof sitting.
    - The deploy output proves the rules reached dev; the Firebase console is an optional owner look.
26. **Slawek is not fixed by this release.**
    - His fix is release 2's swoop mode `control` on his elm-gate row. Release 2's question 1 asks about the admin stopgap; answer it once there.
    - The plan's dev read could not confirm his row: the dev key lacks admin on elm-gate.
    - With release 3, TEC-B4A can go back to TEC, and he becomes a member scoped to it with control (open question 9).

## If the owner answers otherwise
- **Question 2 is yes (scoped admins remove machines and uninstall):**
  - MACHINE_REMOVE and UNINSTALL_TRIGGER join `MACHINE_CAPABILITIES` (task 4.1, and its oracle).
  - The machine menu's "remove machine" gates on `isMachineAdmin` (task 7.2).
  - Uninstall lives on /deployments, a whole-site page, so it would need a per-machine entry point. That is a UI decision to make before building.
  - Docs change in tasks 8.3 and 8.4.
- **Question 3 is "show them" (autonomous chats for scoped members):**
  - Task 2.2: the chats, messages and stream autonomous branches take `canAccessMachine(<siteId>, <targetMachineId>)` (the `get(chat)` forms for the subcollections).
  - A new composite index (source, siteId, targetMachineId, updatedAt desc) goes in `firestore.indexes.json`, and task 12.1 deploys `firestore:indexes` with the rules.
  - Task 4.5: `useOwletteChat` queries the autonomous chats with `where('targetMachineId', 'in', scope)` instead of skipping them, and task 7.6 passes the scope.
  - Update the rules tests and hoot.mdx.
- **Question 4 is "now":** task 8.6 runs, with swoop as well if release 2 left it out of the SDKs.
- **Question 10 is "keep the grants":**
  - Task 5.7 drops the pairing prune and keeps the removal prune.
  - Reword decision 18, ADR 0016's consequence, and the plan.
- **Release 2's question 5 is no (kill stays on MACHINE_REMOTE_CONTROL):** see decision 11. Tasks 6.6 and 9.2 test the machine-class branch.

## Rollback (dev or prod)
1. `node scripts/check-membership-read-path.mjs --env=<env> --list-scoped` lists every scoped row, each with its `DELETE /api/sites/{siteId}/members/{uid}`.
2. The owner's call: remove each scoped member. Code from before this release ignores `machineIds`, so any scoped row left behind reads as the whole site after the rollback.
3. Revert the web: a revert PR to dev; prod by its own promotion.
   - While step 1 lists any row, never use Railway's redeploy of an older deployment. It skips step 2 and widens every scoped person at once.
   - At promotion, confirm that `vercel-origin.owlette.app` serves the same commit as Railway before the first scoped row exists on prod. A failover to an older standby is a rollback too.
4. Only then redeploy the 2.11.0 rules (`git show <pre-merge-sha>:firestore.rules`, then `firebase deploy --only firestore:rules`), and the old usage function the same way.

Agents are unaffected at every step. Release 2's own rollback note (rows that carry `swoop`) still applies on top of this.

## Open questions for the owner
1. **Slawek today.** This is the same as release 2's question 1; answer it once.
   - It is unverified why he is view-only: the dev key gets 403 `scope_insufficient` on `GET /api/sites/elm-gate/members`, and second factors are not visible through the API. elm-gate holds only TEC-B4A.
   - The ruled fix is release 2's swoop mode `control` on his row. Promoting him to admin there is a stopgap that also gives him members, settings, remove machine, deployments and pairing, and is mutating, so it needs your go.
   - Either way he needs his own second factor.
2. **Should a scoped admin also remove their machine, or uninstall software on it** (MACHINE_REMOVE, UNINSTALL_TRIGGER)? The plan says no: both are site-wide.
3. **Autonomous hoot chats about a scoped member's machines are hidden in the plan.** Showing them needs a composite index and a browser filter (see above).
4. **Should the Node and Python SDKs and the CLI expose `machineIds` in this release, or later?** One answer covers release 2's question 7 (swoop) too.
5. **Will you accept these small leaks to a scoped member?**
   - other machines' ids in swoop's `excludedMachineIds` (the settings carve-out);
   - uids in `commands/pending` on their own machines;
   - step-up windows that outlive a narrowing: they grant nothing while the machine is out of scope, but a re-grant within 7 days skips the ceremony.
6. **Scoped members see roost names for their own machines** (the machines list's `currentRoosts`, and per-machine deployments). OK?
7. **30 machines per scoped member** (Firestore's `in` limit). Beyond that, use the whole site or split the site. OK?
8. **The version:** the next patch after release 2, so 4.1.28 if release 2 is 4.1.27?
9. **Once release 3 is live,** move TEC-B4A back to TEC (a re-pair) and scope Slawek there with swoop control, or keep elm-gate?
10. **A machine that leaves a site and pairs back starts with no member's grant** (the pairing prune). OK, or should it keep the grants it had?

## Next Steps
1. At plan approval, get the owner's answers to questions 2–4 (and 1, 5–10), in one batch with release 2's questions.
2. Task 0.1 (the worktree, and the answers in its Log), then waves 1–2. Both can run while release 2 is in flight.
3. Hold wave 3 until release 2 merges. Task 3.1 writes the `release names` block that waves 4 on rely on.
4. Run waves 4–11. Between waves, run the orchestrator's build checks in the worktree (`cd C:/Users/admin/Documents/Git-restored/Owlette-machine-scope-wt/web && npx tsc --noEmit`), not in the main checkout.
5. Wave 12's owner sitting (the UX review first), then wave 13's proof sitting.
6. Tell the prod catch-up program (project memory `project_prod_catchup`) that rules 2.12.0 and the usage function deploy to prod before this web reaches main. Task 8.5 writes that into `docs/runbooks/dev-to-prod-workflow.md`.
