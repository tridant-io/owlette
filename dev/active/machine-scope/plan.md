# machine-scope — Plan
**Created**: 2026-11-04 | **Revised**: 2026-11-04, against owner decisions 13–14, two critiques and release 2's revised plan | **Status**: Active (release 3 of the 2026-11-04 owner plan)

## Summary

A member row on `sites/{siteId}/members/{uid}` may carry `machineIds: string[]` (1–30 ids). Someone whose row carries it is a scoped member. They see and act on only those machines, at their site role, and their swoop mode (release 2) applies only there. They reach nothing that spans machines. A row without the field is whole site, so every existing row keeps working unchanged.

This is the lasting fix for the TEC-B4A case. TEC-B4A can stay on TEC's site, and Slawek can be a member scoped to it with swoop mode `control` (owner decisions 1, 2, 3, 10, 13, 14). Machine scope is enforced in firestore.rules, in every server gate, in the dashboard's queries, and in hoot, swoop and alert emails. It is edited in release 2's members section, beside role and swoop mode.

## Bad news first

- **This release does not fix Slawek, and why he is view-only is unconfirmed.** A read-only check on dev on 2026-11-04 found that `elm-gate` ("LIVE NATION") holds only TEC-B4A. But `GET /api/sites/elm-gate/members` answers 403 `scope_insufficient` ("requires admin on site:elm-gate") with the dev key, so his site role is unverified. The API does not show second factors at all.
  - If he is a `member`, the fix is release 2's swoop mode `control` on his elm-gate row: control of TEC-B4A and nothing else.
  - Control also needs his own enrolled second factor and a step-up.
  - Promoting him to admin works today, but only as a stopgap the owner accepts, because it also hands him members, settings, remove machine, deployments and pairing. That is release 2's question 1; answer it once there.
- **Release 3 cannot be built beside release 2 past wave 2.** Release 2 now carries the swoop mode. It rewrites the files release 3 must change: the access core (`capabilities.ts`, `sitePolicy.server.ts`), the three actor builders, swoop policy and revocation, the membership writer, both members routes, the seed helper, the escalation suite and the members components.
  - Waves 0–2 touch none of those: the rules, the rules tests, the shared parser, the read-path script and the usage function.
  - Wave 3 rebases onto dev with release 2 merged, and every later wave builds on release 2's helpers rather than writing its own.
- **The rules change proves itself only against deployed rules.** The emulator shows that lists filtered by `documentId() in` and by `machineId in` can be proven. Dev must show it again (tasks 12.1 and 13.1).
- **In a shared swoop session, narrowing someone's access is not instant.** Release 1 takes their seat out instead of ending the session, so they keep the picture, and control if they had it, until their lease lapses: up to 5 min + 30 s. In a session they are alone in, it ends within about 2 s.
- **Once a scoped row exists, any web rollback widens access.** Code from before this release ignores `machineIds`, so it gives every scoped person the whole site.
  - Railway's one-click redeploy of an older deployment does that to all of them at once.
  - So does a Vercel standby that still serves old code.
  - A rollback therefore starts by removing the scoped members (context.md, "Rollback").

## Approach

### Data model
- **`machineIds` on the member row.** The name matches `excludedMachineIds` (swoop settings) and hoot's `target.machineIds`.
  - Absent means whole site. Present means only those machines.
  - `[]` or a malformed value means no machines: it fails closed.
  - Writers store the list sorted and de-duplicated, never as `[]` or `null`. Widening is `FieldValue.delete()`, reached by `PATCH {machineIds: null}`.
  - Owners are never scoped, and nobody changes their own row.
  - The cap is 30 ids. The dashboard lists a scope with one `documentId() in` query, and Firestore allows at most 30 values in `in`.
- **`swoop: 'none' | 'view' | 'control'` on the row** belongs to release 2 (`web/lib/swoopMode.ts`).
  - Absent means the role decides: a member watches, and an admin or owner controls.
  - `membersMayWatch` is the default only for members with no mode set.
  - Release 3 does not change the mode. It decides which machines the mode covers, and scope × mode is the owner's case.
- **One parse for every layer.** `web/lib/machineAccess.ts` holds `parseMachineIds`, `scopeCovers`, `normalizeMachineIdsInput` and `MAX_MACHINE_SCOPE`. The server, the browser and the read-path script then read a row exactly as the rules do.

### The decision core: role, then swoop mode, then machine scope
Release 3 extends release 2's helpers; it does not write new ones.
- **`MemberStanding` and `siteStanding`.**
  - Release 2's `MemberStanding { role, swoopMode }` gains `machineIds`.
  - Release 2's `siteStanding(bySite)` already returns `siteRoles` and `swoopModes`. It also returns `machineScopes`, with one entry for every site it puts in `siteRoles` (null means whole site).
- **A missing entry fails closed.** `machineScopeOf(actor, siteId)` reads a present map with no entry for the site as no machines. Only actor literals with no `machineScopes` key at all (tests) read as whole site.
- **Task 8.1 makes `machineScopes` and `swoopModes` required on `UserActor`**, so tsc names any builder that skips `siteStanding`.
- **Builders take the standing from one of two places,** both beside release 2's `deriveSwoopMode` in `sitePolicy.server.ts`:
  - `standingOf(facts)`, from `resolveSiteAccess`;
  - `memberStanding(row)`, from a raw member row.
- **`hasCapability(actor, cap, siteId, machineId?)` applies three checks in order:**
  1. the role matrix;
  2. release 2's swoop-mode override for MACHINE_REMOTE_VIEW and MACHINE_REMOTE_CONTROL;
  3. the machine scope. A scoped actor holds only machine-class capabilities, and only for a machine in scope; a call with no machineId denies.
- **The machine-class capabilities** are MACHINE_VIEW, MACHINE_REMOTE_VIEW, MACHINE_EXEC_COMMAND, MACHINE_REMOTE_CONTROL and MACHINE_CONFIG_WRITE. Every other site-scoped capability is site-wide, including MACHINE_REMOVE, UNINSTALL_TRIGGER, MACHINE_ENROLL, AGENT_TOKEN_REVOKE and SWOOP_SETTINGS_MANAGE.

What scope × mode gives on a machine in the person's scope. Anywhere else they get nothing.

| member row | on a machine in scope |
|---|---|
| member, no mode set | watches, unless the site turned `membersMayWatch` off |
| member, `view` | watches, whatever `membersMayWatch` says |
| member, `control` | watches; controls after a step-up |
| admin, no mode or `control` | commands and machine config; watches; controls after a step-up |
| admin, `view` | commands and machine config; watches; no control |
| member or admin, `none` | no swoop; an admin keeps commands and machine config |

- **Kill and the site's swoop sessions list are site-wide.** Release 2 moves both to SWOOP_SETTINGS_MANAGE (its decision 25 and question 5), so no scoped person can kill or list sessions. A scoped person can still end their own seat. If the owner keeps kill on MACHINE_REMOTE_CONTROL instead, kill becomes machine-class: someone in control may kill on their in-scope machines, which closes everyone's step-up windows there. Task 6.6 tests whichever shipped.
- **Viewer emails on the session GET need SITE_MEMBER_MANAGE** (release 2's pill gate). A scoped admin holds no site-wide capability, so they see names only.

### Enforcement, layer by layer
- **firestore.rules 2.12.0** (the owner's explicit go, decision 2):
  - New helpers `memberIsWholeSite`, `memberHoldsMachine`, `canAccessWholeSite` and `canAccessMachine` read the member document `isActiveMember` already reads, so access cost is unchanged.
  - Ten per-machine rules (nine reads and the installed_software delete) move to `canAccessMachine`. The site-wide blocks move to `canAccessWholeSite`.
  - `isSiteAdmin` needs a whole-site row, so a scoped admin reads neither the audit log nor webhooks.
  - The site document, `settings/{swoop,display,cortex}` and the schedule and reboot presets stay on `canAccessSite` on purpose. A denial would hide swoop, and the machine-config dialogs read the presets.
  - Site logs are filtered by `resource.data.machineId`. Autonomous hoot chats stay whole site.
  - No index changes, and the agent terms stay byte-identical (ADR 0001).
  - An invariant comment says `canAccessSite` admits scoped members.
- **The wrapper.** `authorizedSiteHandler` gains a step right after the actor is built and before the `capability_enforcement` read, so break-glass never widens a scope. It reads `params.machineId`:
  - a machine out of scope gets an audited 404 'machine not found or no access';
  - a route with no machineId, or a site-wide capability on a machine route, gets an audited 403, in the shape the capability step uses: code `capability_missing` for the bypass-exempt swoop capabilities (release 2), plain otherwise.
- **The `_shared` gates.**
  - `requireSiteAuthAndScope` refuses scoped callers by default. The machines list, logs, logs/{id} and GET site opt in and filter.
  - New `requireSiteMachineAuthAndScope` covers three single-machine routes that keep their `site=` key scope.
  - `requireMachineAuthAndScope` checks the machine after the agent short-circuit.
  - The roost gate refuses scoped callers. The chat gate admits them and returns their scope.
  - The builders in `requireSiteCapability` and `assertUserHasSiteCapability` carry the scope, so pairing, webhooks and roost refuse scoped callers.
- **Lists and fan-outs.**
  - The machines list filters to the caller's machines.
  - The logs API queries `machineId in scope`, with no unbounded scan.
  - hoot:
    - "all machines" means all machines in scope, and an out-of-scope id is `unknown_machine`;
    - follow-ups narrow;
    - the site-wide server tools are not offered: get_site_logs, deploy_software and the three talon tools;
    - machine mode refuses an out-of-scope id.
  - Talons: a scoped author's talons are disabled at their next fire (`creator_access_revoked`).
  - Alert emails (decision 10): recipients come from active member rows as well as the legacy `users.sites[]` array, each carrying its scope. An email that names no machine skips scoped recipients.
  - The per-site usage function needs whole-site standing.
- **When a machine leaves.** `removeMachine` prunes the id from every member row. Pairing prunes it again when the machine document did not exist. That covers the desktop app's own leave-site, which deletes the machine document without calling `removeMachine`. Machine ids start as hostnames and get reused, and a re-paired id must not inherit an old grant.
- **The membership writer and the API.**
  - Release 2's `updateMember` (role and/or swoop, one transaction, returning before and after) gains `machineIds`. `addMember` takes it too. A role change keeps the scope, since scoped admins exist, and an ownership transfer drops it.
  - The members API:
    - GET returns `machineIds` beside `swoop`.
    - POST and PATCH validate it: 1–30 existing machines, never on the owner's row or your own. `null` gives the whole site back.
    - PATCH takes `{role?, swoop?, machineIds?}`, and with none of them answers 400 "role, swoop or machineIds is required".
    - One PATCH fires one revocation. Control seats end when control is lost, by role or by mode (release 2). Every seat on a machine dropped from the scope ends, with reason `scope_changed`. A mode of `none` ends every seat.
- **The browser.**
  - AuthContext adds `machineScope(siteId)`, `isMachineAdmin(siteId, machineId)` and `siteRole(siteId)`. `isSiteAdmin`, `administersAnySite` and `isSiteOwner` mean whole-site standing.
  - `useMachines(siteId, machineIds?)` queries `documentId() in` for a scope, and a refused listener stops loading.
  - The dashboard can show "no machines here for you yet" and a load-error box.
  - On a scoped site, the nav hides talons, roost and deploy. Those three pages tell someone with no whole-site site "this page needs whole-site access".
  - The swoop viewer reads one machine document. "This machine has left the site" fires only on release 1's explicit signals, never on a refused read or the wrapper's 404.
  - Machine cards and rows gate commands, processes and displays on `isMachineAdmin`.
- **The UI**, in release 2's members section:
  - release 2's `MemberAccessFields`, which "change access…" and "add member" both render, gains a machines field. It is an explicit "whole site" | "some machines" choice before the picker, so an empty MultiSelect never means the whole site;
  - an inline "access" column ("whole site", "N machines", "no machines") sits beside swoop;
  - talon successors exclude scoped rows;
  - the site list labels a scoped row "admin · 1 machine";
  - site settings tells a scoped admin why it shows nothing.

### With releases 1 and 2
- **Release 1 (4.1.26: swoop join, leave, "this machine has left the site", viewer pills).** This plan builds on four of its pieces:
  - its seat-removing `revokeSwoopSessionsForUser`;
  - the `machine_not_found` 404 code at session create;
  - the `machine_removed` end reason;
  - the session GET's viewer names.

  Task 3.1 records what it actually shipped.
- **Release 2 (4.1.27, with the swoop mode).** The table lists every file both releases touch, with the release 3 task that edits it. Nothing in it is edited before task 3.1 rebases onto dev with release 2 merged, and waves 0–2 touch none of it.

| file (release 2's change) | release 3 task |
|---|---|
| `capabilities.ts` (`MemberStanding`, `siteStanding`, `swoopModes`, `explicitSwoopMode`, the override) | 4.1 adds machineIds, `machineScopes`, `machineScopeOf` and the order; 8.1 makes both maps required |
| `sitePolicy.server.ts` (`facts.swoopMode`, `deriveSwoopMode`, `listUserStanding`, `deriveMembership` exported) | 4.1 adds `facts.machineIds`, `deriveMachineIds`, `memberStanding`, `standingOf` |
| the builders in `authorizedHandler.server.ts`, `_shared.ts`, `apiAuth.server.ts` | 4.1 (the standing they pass), 5.1 and 5.2 (the gates) |
| `membership.server.ts` (`updateMember`, `MemberAccess`, `addMember` swoop) | 4.2 |
| `lib/swoop/policy.server.ts`, `revokeViewerSessions.server.ts` (`members_may_not_watch` vs mode, `swoop_changed`) | 5.4 |
| kill and site-session routes (SWOOP_SETTINGS_MANAGE) | 6.6 tests them under scope |
| both members routes (`swoop` on GET/POST/PATCH, the in-handler re-checks) | 6.3 |
| member-candidates route (`siteStanding(listUserStanding(uid))`) | 6.8: a test; no route edit |
| `useFirestore.ts` (`createSite` lifted) | 4.3, in other functions |
| `useSiteMembers.ts`, `SiteMembersSection.tsx`, `MemberAccessFields.tsx`, `AddMemberDialog.tsx`, `ChangeAccessDialog.tsx` | 7.9 |
| `talonSuccessors.ts`, `SiteList.tsx`, `SiteSettings.tsx` | 7.10 |
| `PageHeader.tsx`, `useCurrentSite.ts`, the dashboard, swoop, hoot, logs, deployments, roosts and talons pages | 7.1–7.7 |
| `e2e/helpers/seed.ts` (`extra: { swoop }`) | 4.6 adds `machineIds` to `extra` |
| `membershipEscalation.test.ts` (blocks 13–18), `rules/membership.test.ts`, `sitePolicy.test.ts` | 7.11 (block 19 on), 4.1 |
| `GLOSSARY.md` (Site settings, swoop mode, Viewer), ADR 0015 | 4.7; release 3's ADR is 0016 |
| `web/openapi.yaml`, docs, README, both changelogs, both skills | 8.2–8.5 |

- **Decision 11 allows parallel building only where files do not collide.** These collide, and maintainability comes first (decision 12). So release 3 builds on release 2's merged code instead of reconciling two rewrites during a rebase.
- **A choice the critique raised: the scope sits in its own `machineScopes` map, beside release 2's `swoopModes`, not in a shared per-site entry.** Release 2's seams list asks for this. One helper writes both maps, a missing scope entry fails closed, and task 8.1's required keys make tsc name any builder that bypasses the helper. Folding the two maps together would rewrite release 2's field and every test that builds an actor, for no added safety.

### Rollout and rollback
- **Deploy order on dev** (wave 12, with the owner's go):
  1. Rules 2.12.0 and the usage function. This is safe for every existing row: none carries `machineIds`, and absent means whole site.
  2. The read-path script.
  3. The full release (decision 8).
  4. One real scoped row, proved in wave 13.
- **On prod, the rules and the function deploy before this web reaches `main`.** Task 8.5 writes that step into the promotion runbook.
- **Rollback is the reverse, with scoped members first:**
  1. `check-membership-read-path.mjs --list-scoped` prints each scoped row and the DELETE that removes it. Remove each person.
  2. Revert the web.
  3. Redeploy the 2.11.0 rules.

  While any scoped row exists, never roll the web back by redeploying an older Railway deployment, and never fail over to a Vercel standby that serves older code. Agents are unaffected throughout.

## Waves (overview)
| wave | what | tasks |
|---|---|---|
| 0 | worktree, branch, tracked plan copy, release states, the owner's answers to questions 2–4 | 1 |
| 1 | whole-site rules controls on 2.11.0 | 1 |
| 2 | beside release 2: `machineAccess.ts`, rules 2.12.0 + tests, read-path script, usage function | 4 |
| 3 | rebase onto dev with release 2 merged; record releases 1 and 2's names | 1 |
| 4 | decision core (role → mode → scope) and its builders, membership writer, `useFirestore`, alert emails, browser hooks, e2e seed helper, ADR 0016 + GLOSSARY, MachineAccessField | 8 |
| 5 | wrapper scope step, `_shared`/apiAuth gates, hoot core, swoop policy and revocation, talons and users/me builders, AuthContext, machine ids leaving scopes | 7 |
| 6 | machine routes + inventory, logs + site doc, members API, hoot routes, talon authors, swoop route suites, parity, member candidates | 8 |
| 7 | dashboard page, machine views, DisplayLayoutPanel, nav + site lists, swoop picker/viewer, hoot page, logs page, schedule dialogs, members section, site list + settings + successors, escalation blocks | 11 |
| 8 | both actor maps required; openapi; docs ×2; records and runbooks; SDK/CLI only if the owner says now | 6 |
| 9 | e2e authored in parallel (eslint and `--list` only): scoped journeys, swoop under scope × mode, editing access | 3 |
| 10 | one rig run: the three specs, then `public/docs-links.spec.ts`, on chromium and mobile-chromium | 1 |
| 11 | local verification: security gate, lint, tsc, jest, rules, openapi, functions, agent, full `npm run e2e`, /verify, tracked plan copy | 1 |
| 12 | owner sitting: UX review in a headed emulator preview, then rules + function to dev, read path, full release, merge, tag | 1 |
| 13 | proof on dev.owlette.app (owner sitting): one real scoped row with swoop control, read-path `--scoped`, as-that-person checks | 1 |

Only wave 10 and wave 11 run the e2e rig. A rig run owns ports :9099, :8080, :9199 and :3100, the `.next-e2e` build and the shared storageState fixtures, so two runs at once collide. Release 2 runs its e2e the same way.

## Risks
- **Deployed rules versus the emulator.** List provability and the logs `in` indexes are proven in the emulator only. The read-path script must show them on dev, the alert-toast query shape included. If production refuses the `documentId() in` proof, the fallback is one document listener per id (research client-reads §4).
- **New web on old rules.** The server is right, but the SDK still reads every machine. Deploy the rules first.
- **Old web on new data.** An old web ignores `machineIds` and widens the person. Remove scoped members before any rollback. That includes Railway redeploys of older deployments and a stale Vercel standby.
- **The kill switch.** If the scope check sat in the bypassable capability step, `capability_enforcement=false` would turn machine scope off. Task 5.1 places it with site access and tests it with the switch off.
- **Actor builders.** A builder that skips `siteStanding` fails closed for scope, since a present map without the site denies. Task 8.1's required keys make tsc name it.
- **Release overlap.** Waves 4 on start only after release 2 merges (task 3.1). If release 2 ships without the swoop mode, or under other names, task 3.1 stops or records the real names.
- **Shared sessions.** Narrowing takes effect within one lease plus 30 s, not 2 s, when someone else is in the session. The lease's 404 is retried until expiry: the path a removed member takes.
- **"Left the site" on a refused read.** If release 1 inferred "left" from a missing machine document or a bare 404, a scoped person would be told a machine left when it is still there. Task 7.5 ties the message to the explicit signals.
- **Auth mocks.** 53 test files mock `useAuth`. Every UI task adds `machineScope`, `isMachineAdmin` and `siteRole` to the mocks of the components it changes.
- **MultiSelect's empty selection means all.** The access field never maps an empty selection to the whole site; the whole site is its own choice.
- **Rows over 30 ids.** A hand-edited row with more than 30 ids would crash an `in` query. The hook slices to 30 and warns, and the server never writes more than 30.
- **Talons stop at narrowing.** Narrowing someone's access disables their talons at the next fire. The dialog warns with the count.
- **Logs disjunctions.** Firestore caps a query at 30 disjunctions in total, so beside `machineId in scope`, an action filter gets floor(30 / machines) values. The query and the in-memory narrowing must agree (task 7.7).
- **Accepted leaks** (open question 5):
  - the swoop settings carve-out shows other machines' ids in `excludedMachineIds`;
  - `commands/pending` shows uids on in-scope machines;
  - step-up windows outlive a narrowing: they grant nothing while the machine is out of scope, and a re-grant within 7 days skips the ceremony.
- **Local e2e** can exhaust this box's ephemeral ports. Late `ERR_ADDRESS_IN_USE` failures are environmental: rerun after TIME_WAIT drains.
  - The rules tests and e2e both use :8080, so never run them together.
  - Beside another session's emulator, use shifted ports (`web/e2e/README.md`).

## Success Criteria
- On dev, a scoped member and a scoped admin reach only their machines in each of these:
  - the dashboard: card, list and machine menu;
  - swoop: the picker and the viewer, plus control after a step-up for a scoped member set to `control` and for a scoped admin;
  - hoot targets and tools;
  - /logs;
  - alert emails;
  - the API, with a session and with their own key;
  - direct Firestore reads under the deployed rules.

  `check-membership-read-path.mjs --env=dev --scoped` passes.
- Nothing that spans machines reaches them:
  - the site's settings, members and presets pages and APIs;
  - the admin panel;
  - deployments, roost, talons, webhooks, the audit log and usage;
  - kill, the site's swoop sessions list, and viewer emails.

  The rules still let them read the site document, `settings/{swoop,display,cortex}` and the schedule and reboot presets, on purpose.
- Whole-site members, admins, owners, superadmins and agents are unchanged, and release 2's swoop modes behave as release 2 shipped them:
  - every pre-existing suite is green;
  - the wave 1 rules controls pass on 2.11.0 and on 2.12.0;
  - the full local e2e is green.
- A site admin sets and clears access in the members section, beside role and swoop mode, and when adding someone. The API validates it, and a PATCH that both narrows and downgrades ends exactly the right seats.
- Removing a machine, or pairing a machine whose document had gone, leaves no member row holding its id.
- These are written or updated: ADR 0016, GLOSSARY, `web/openapi.yaml`, `web/content/docs`, README, both changelogs, the firebase-integration and codebase-map skills, PROTOCOL §10, COVERAGE.md, and the promotion and rollback runbooks.
- It ships as a full release (exe, pkg and deb uploaded to dev and verified) after the owner's UX review, and before the merge and tag.

## Open questions for the owner
The full list, with what each answer changes, is in context.md. Answers to 2–4 are needed before wave 2.
1. Slawek today. This is the same as release 2's question 1; answer it once.
2. Should scoped admins remove machines and uninstall software?
3. Should scoped members see autonomous chats?
4. Should the SDK and CLI gain `machineIds` now? This rides with release 2's question 7.
5. Are the listed leaks accepted?
6. May scoped members see roost names?
7. Is the 30-machine cap acceptable?
8. Which version number?
9. Should B4A move back to TEC?
10. Should a re-paired machine start with no grants?
