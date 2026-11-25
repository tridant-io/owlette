# Admin sites page and swoop mode (release 2) — Plan
**Created**: 2026-11-04 | **Revised**: 2026-11-04, against two critiques; the swoop mode was folded in | **Status**: Active (not started; builds on dev after 4.1.26 merges)

Owner rulings this plan follows: `owner-decisions.md` items 4, 5, 6, 8, 11, 12, 13 and 14 (copied into context.md).

Research it rests on: the scratchpad maps `ui.md` §0-3, `user-search.md` §4, `tests.md` §5, `docs-openapi.md` §C, `swoop.md` §1-6 and `routes-site.md` §A.

Line anchors are origin/dev @ ab4689bb (4.1.25). 4.1.26 lands first, so find code by the quoted text when a line has moved.

## Summary

This release does two things.

**Each member row gets an optional swoop mode**, `swoop: none | view | control`, which the site's owners and admins set. This is the fix for Slawek:
- He stays a member of elm-gate, and his swoop mode is set to control.
- After a step-up he controls TEC-B4A.
- He gets no commands, no configuration and nothing site-wide (owner rulings 13-14).

**The header's manage sites dialog and `/admin/members` become two admin pages:**
- `/admin/sites` lists your sites, with a gear on each one you run.
- `/admin/sites/{siteId}` has five sections: general, members, machines, swoop & screens, and danger zone.

The members section adds people through a search. It knows only people already on sites you administer, or you type a full email. It changes a person's role and swoop mode in one dialog.

This is a full release, 4.1.27: version bump, changelog, and the exe, pkg and deb uploaded to dev and verified before any push.

## Approach

**Swoop mode: the server** (Tasks 1.1, 2.9, 3.5)
- **The field.** It lives on `sites/{siteId}/members/{uid}` as `swoop`: `none`, `view` or `control`.
  - Absent means the role decides, exactly as today: members watch where `membersMayWatch` allows, and admins and owners control. So no existing row changes behaviour.
  - It is never stored as null and never on the owner's row. "By role" in the UI deletes the field.
  - A malformed value reads as `none` (fails closed).
- **One pure module.** `web/lib/swoopMode.ts` holds the labels, the parse, the granted mode and the effective mode. The server and the dashboard both use it.
- **Reading and carrying it.**
  - `resolveSiteAccess` reads the mode off the member row it already fetches, as `facts.swoopMode`, at no extra read.
  - Every builder of a UserActor from a member row goes through one helper, `siteStanding` (capabilities.ts): the wrapper, `_shared`'s capability gate, `assertUserHasSiteCapability`, and the candidates listing. A held-back admin cannot regain control through a path that dropped the field.
- **Where it applies.**
  - `hasCapability` applies an explicit mode to MACHINE_REMOTE_VIEW and MACHINE_REMOTE_CONTROL only. Both stay exempt from the `capability_enforcement` kill switch, so the mode holds during the break-glass.
  - `evaluateSwoopAccess` applies `membersMayWatch` only to members with no mode of their own.
- **Refusals the viewer understands.** The wrapper's refusal of a swoop capability now carries `code: capability_missing`, which the viewer already treats as final.
  - Without the code, a person set to none would retry every 30 s for the life of the tab.
  - The viewer says "you can't use swoop on this site".
- **Kill and the site's session list** move from MACHINE_REMOTE_CONTROL to SWOOP_SETTINGS_MANAGE (site owner or admin, bypass-exempt). Both administer the site's swoop, and the list carries every viewer's email (ruling 7).
  - A member set to control can use neither.
  - An admin held to watch keeps both.
- **The members API.**
  - GET returns `swoop` (null means by role).
  - POST takes an optional `swoop`.
  - PATCH takes `role` and/or `swoop`; `null` returns to the role's default.
  - A change that loses control ends the person's control seats (`controlOnly`). One that loses swoop altogether ends all their seats.
  - A role change keeps an explicit mode.
  - Never on your own row (403) or the owner's (409).
- **No `firestore.rules` change.** Member rows are server-written only, and a rules test now pins that a client cannot set `swoop`.

**Routes and shell**
- **The two pages.**
  - `web/app/admin/sites/page.tsx` renders `SiteList`.
  - `web/app/admin/sites/[siteId]/page.tsx` renders `SiteSettings` and reads the section from `?section=` (`general|members|machines|swoop|danger`).
  - Each has a title-only `layout.tsx`, the pattern used by `/admin/issues` and `/admin/issues/[number]`.
- **`SiteSettings` stays route-agnostic.** Section changes and "deleted" are callbacks, so the same component could later be mounted in a dialog (owner ruling 4).
- **Nav and redirect.**
  - The nav item `sites` (`/admin/sites`, minRole `admin`, group `people`) replaces `members`, and subpaths inherit its gate through `requiredRoleForPath`.
  - `/admin/members` redirects to `/admin/sites` as a 307 until the release reaches prod (see Rollback).
  - `proxy.ts` already protects `/admin`.
- **Route guard fix.** `RequireAdminAccess` decides only after memberships have loaded (`userSites !== undefined`).
  - Today a site admin who hard-loads any `/admin` page can be bounced with "access denied" before their admin row arrives, and the new deep links make hard loads common.
  - It ships under a failing test first, and the live smoke proves it on dev with hard loads.
- **Shared admin pieces** replace the copies the issue pages keep privately: `Panel`, `SegmentedControl` (with a button `xs` size), `BackLink` and `DetailSkeleton`.

**Data: one new route**
- **`GET /api/sites/{siteId}/member-candidates`**, shape B from user-search.md §4.
  - It runs under `authorizedSiteHandler(SITE_MEMBER_MANAGE)` and refuses API keys (403 `api_key_not_permitted`).
  - It re-checks the capability in the handler, because the kill switch skips the wrapper's check.
- **Who it offers.**
  - For a site admin: the active members of every site where the caller holds SITE_MEMBER_MANAGE, minus the target site's members. Those sites come from `hasCapability` over the same row reading every gate uses (`listUserStanding` + `siteStanding`).
  - For a superadmin: every user, minus the site's members.
  - Soft-deleted accounts and superadmin accounts are always left out (question 3).
- **What it returns:** `{ candidates: [{ uid, email, displayName }] }` and nothing more. It never resolves an email; a full email still goes through `POST /members {email}`.
- **The browser filters.** It fetches the list once per dialog open and filters it locally: prefix matches first, then substring, 6 rows.

**Security: in-handler re-checks**
- With `capability_enforcement` off, the wrapper skips SITE_MEMBER_MANAGE and SITE_DELETE.
- Members POST re-checks in its handler. PATCH and DELETE `members/{uid}` and DELETE site do not, on dev and on prod.
- The swoop mode makes PATCH a second way to hand out control. So Task 3.5 adds the same in-handler re-check to all three, before the body read and `withIdempotency`, with escalation blocks that each have a positive control.
- The repo is public and the gap is live on prod, so the push waits for the owner's call (question 2).
- Commit, PR and changelog wording stays neutral either way.

**Members UI**
- **`useSiteMembers` changes:**
  - members carry `swoop`;
  - `addMember` takes `{uid}` or `{email}`, plus an optional `swoop`;
  - new `updateMember(uid, { role?, swoop? })`;
  - errors carry the problem `code`;
  - new `useMemberCandidates(siteId)`.
- **The pieces:** `MemberSearchInput`, `MemberAccessFields`, `AddMemberDialog`, `SiteMembersSection` and `ChangeAccessDialog`.
  - `MemberAccessFields` (role and swoop, each with a help line) is shared by the add dialog and the change access dialog.
  - The search follows the hoot `@` mention list: a Popover anchored on the input, a named listbox, `aria-activedescendant`. The input stays a textbox, because the axe gate rejects a combobox role in a form row.
  - The members table gains a swoop column: the effective mode, marked "by role" when no mode is set.
- **Defects from `/admin/members` that are not ported:**
  - Access change ("change access...") is offered on every row except your own and the owner's, seeded from the site role and the mode. The copy says it applies to this site only.
  - The add toast respects `roleHonored`, and the "admin is an account-level role" hint is gone.
  - Talon successor candidates come from site role, not global role.
  - The owner refusal is detected by error code, not by matching the word "owner".

**Header and links**
- **`PageHeader` owns the three site entries** and drops the `onManageSites` and `onSiteSettings` props:
  - "site settings" opens `/admin/sites/{current}`, for that site's admins.
  - "manage sites" opens `/admin/sites`, for anyone who administers a site, and superadmins.
  - "new site" opens `CreateSiteDialog` for people who administer nothing (owner ruling 5).
  - All three are hidden in demo mode (`disableNav`).
- **The admin panel entry.** The user menu's admin panel sends site admins to `/admin/sites`.
- **One link builder.** `siteSettingsPath(siteId, section?)` serves every link: the dashboard's "turn on swoop…", `SwoopPicker`, the swoop viewer, the header and the gear. Swoop links open `?section=swoop`.
- **No `?settings=` handler.** The dashboard's handler is deleted: grep finds no producer outside those two components.

**Deletions** (wave 6, after the site settings page exists)
- `ManageSitesDialog` and its test, `app/admin/members/*`, and the dialog wiring on dashboard, talons, roosts, deployments and logs.
- The no-op `onManageSites` on hoot and demo.
- `useCurrentSite`'s dead pass-throughs, `useSites().checkSiteIdAvailability`, `SiteMachinesList.onCountLoaded`, and the unused `createSite` user-id parameter.
- Every comment and line of copy that still names the dialog or the members page.

**Tests and docs**
- Jest for every new module.
- **e2e** is authored in wave 7 and run once, serially, in wave 8 against one build. Fixed ports and one `.next-e2e` folder rule out parallel runs. It covers:
  - the 13 re-homed specs from tests.md §5;
  - two new specs: the site list with its header entries, and the members section with role and swoop changes;
  - a swoop mode describe in `swoop/session.spec.ts`: a member set to control takes control after a step-up, an admin held to watch gets "view only", and a member with no swoop is refused for good;
  - the rewritten phone spec, a11y and theme-review entries;
  - the live-dev smoke, with hard loads;
  - the three tutorial scenes.
- **Docs:**
  - a new `dashboard/admin/sites.mdx`;
  - a rewritten `member-management.mdx` with a `swoop mode` section;
  - `swoop.mdx`'s watching versus control and refusal codes;
  - the reference/authentication capability table;
  - the members fields in firestore-data-model;
  - the errors and rate-limits rows;
  - every page in docs-openapi.md §C that says manage sites, site settings or the members page.
- **Records:** openapi (the new route, the members fields, the swoop capability notes), GLOSSARY (Site role, Swoop mode, Site settings, Viewer, Kill), README, both changelogs, two skills, and ADR 0015 for the search rule.

**Not in this release:** the SDKs and CLI get no `swoop` field (question 7), and the dashboard does not hide swoop entries from a person set to none (question 6).

## Waves

Overview. Every task, with Files / Do / Done when, is in tasks.md. No two tasks in a wave share a file.

1. **Foundations** (7 tasks):
   - the swoop mode in the access core;
   - candidate helpers;
   - site-settings paths and the successor helper;
   - the nav item and guard fix;
   - a module-level `createSite` with lowercase copy;
   - the shared admin pieces;
   - the viewer's final "no swoop" refusal.
2. **Leaf pieces, hook and routes** (9):
   - `MemberSearchInput`, `SiteSwitches`, `SiteGeneralSection` and `SiteDangerZone`;
   - the `SiteMachinesList` fixes;
   - `SiteList` with `/admin/sites`;
   - the `useSiteMembers` hook;
   - the candidates route;
   - kill and the session list on SWOOP_SETTINGS_MANAGE.
3. **The add dialog, the members API and the callers** (5):
   - `AddMemberDialog` with `MemberAccessFields`;
   - the dashboard, then the other five pages, stop hosting the dialog;
   - swoop links go to the swoop section;
   - the members API carries the swoop mode, with the in-handler re-checks.
4. **Members, header and pills** (3), starting with the site-billing heads-up:
   - `SiteMembersSection` with `ChangeAccessDialog`;
   - `PageHeader` owning the entries;
   - the viewer-pill email gate checked against the swoop mode.
5. **The site settings page** (1): `SiteSettings` and `/admin/sites/[siteId]`.
6. **Removals** (1): delete what the pages replaced, and add the redirect.
7. **e2e specs, docs and the contract** (13), authored in parallel. Their checks are eslint, `playwright --list`, `validate:api` and the openapi jest.
8. **One serial e2e run** (1): build once, run every new and changed spec, then docs-links, and fix in the owning files.
9. **Verification and release** (3): the local gate; the 4.1.27 build and upload to dev; ship to dev and prove it there, with the owner's steps.

## Questions for the owner (ask at plan approval, one batch)

1. **Slawek, until this ships.** Today the only way to give him control of B4A is to make him admin on elm-gate.
   - That grants every site capability on that one-machine site except delete: commands, config, pairing, members and agent tokens.
   - Control also needs his own second factor enrolled.
   - Do that now as a stopgap (a mutating call on your go), or wait for this release (member plus swoop mode control)?
2. **The in-handler re-checks** (members PATCH/DELETE and site DELETE).
   - The gap is on prod too (`main` @ c68638a8) and is reachable only while `capability_enforcement` is off.
   - Your public-repo rule says a live hole ships privately first. Ship these three through the private security plan (`Owlette-secplan-wt`) and rebase this release onto it? Or let them ride in this release with neutral wording?
   - The plan builds them either way; the push in 9.3 waits for this answer.
3. **Superadmin accounts as candidates.** They are left out of add-member suggestions: they reach every site already and are deliberately not members. Ruling 6 says superadmins search "everyone". Keep superadmin accounts out of the list?
4. **"new site" from the header** saves the new site as your last site, so you come back to it. OK, or should it switch without saving?
5. **Kill and the admin swoop page** move to "site owners and admins" (the swoop-settings capability). A member set to control cannot kill other people's sessions or see the site's session list; an admin held to watch still can. OK?
6. **People set to no swoop** still see swoop entries in the dashboard, and the viewer refuses them with "you can't use swoop on this site". Hiding the entries needs the dashboard to read the mode. Later, or now?
7. **The SDKs and the CLI** don't get `swoop` in this release. The API takes it, and `owlette site set-role` keeps working. Add them in a later release?
8. **Tutorial voiceover.** Scene 14's voiceover says promotion is account-level, which is false after this release. Re-record episodes 02, 14 and 17 now, or later?

## Risks

- **Release 1 lands first.** 4.1.26 (swoop join, viewer pills) edits files this release edits again:
  - `app/swoop/[siteId]/[machineId]/page.tsx`, `SwoopStage`, `useSwoopSession`, `lib/swoop/policy.server.ts` and `revokeViewerSessions.server.ts`;
  - `e2e/specs/swoop/session.spec.ts`;
  - `swoop.mdx`, `api/errors.mdx`, the GLOSSARY, firestore-data-model and openapi.

  Cut this branch from dev after it merges, and find anchors by code, not by line. The pill email gate does not exist yet; Task 4.3 checks it after the merge.
- **Release 3 runs alongside, and it collides more than before.** The swoop mode took this release into the access core. The collision list (also in context.md "Seams for release 3", and in the machine-scope plan):
  - the core: `lib/capabilities.ts`, `lib/sitePolicy.server.ts`, `lib/authorizedHandler.server.ts`, `app/api/_shared.ts`, `lib/apiAuth.server.ts`;
  - swoop: `lib/swoop/policy.server.ts`, `lib/swoop/revokeViewerSessions.server.ts`, the kill and site-session routes;
  - membership: `lib/membership.server.ts`, both members routes, `sites/[siteId]/route.ts`;
  - tests: `e2e/helpers/seed.ts`, `rules/membership.test.ts`, `membershipEscalation.test.ts`, `sitePolicy.test.ts`;
  - the candidates route, `hooks/useSiteMembers.ts`, `lib/talonSuccessors.ts`, `hooks/useFirestore.ts` (different functions), and the members components.

  Release 3 should rebase onto this release's waves 1-3 before it edits any of them.
- **site-billing** (owlette-65's unpushed `feat/site-billing`) puts an owner-only billing row into `ManageSitesDialog.tsx`, which this release deletes. That row has to land on the site settings page instead. The message to that session is the first line of wave 4.
- **Security disclosure.** The re-checks reveal a gap that is live on prod. Question 2 decides the route. Neutral wording is not concealment, so the owner's call comes first.
- **The superadmin candidate branch** reads every user document on each dialog open. The prod user count is unmeasured, because the prod key is installer-scoped.
- **The superadmin owner column** on `/admin/sites` still reads the legacy `sites/{id}.owner`, as the dialog did. When per-site-roles wave 6.1 strips that field, the column goes blank. That is recorded in context.md, not in a code comment.
- **The add-member popover inside a dialog** (focus, Escape, interact-outside, the iOS keyboard) is proven in jsdom and Playwright chromium only. Check it on the owner's phone during the dev proof.
- **e2e contamination.**
  - Specs that create sites or grant rows must release them and reset `users/{uid}.lastSiteId` (the suite runs `workers: 1`).
  - The header's "new site" saves the new site as the last site, so specs that create through it must undo that.
  - Dedicated `E2E member …` users from earlier specs appear in the add-member list; the members spec picks by name, not by keyboard order.
- **Two reversals the owner's rulings imply,** stated here rather than made quietly:
  - Site admins now change other members' roles and swoop modes in the UI; `web/e2e-live/specs/roles.spec.ts` calls the superadmin-only rule "settled".
  - MACHINE_REMOTE_CONTROL is no longer "site admin/owner only": the code comment and the GLOSSARY Viewer entry say so today, and both are rewritten. No ADR says it (ADR 0009 requires the step-up, and that stands).
- **The tutorial episodes** (02, 14, 17) and their voiceover show the old dialog. The scene scripts are updated so they still run; re-recording is question 8.
- **Local e2e on this box.** Only Task 8.1 runs Playwright. A late `ERR_ADDRESS_IN_USE` gets one rerun after two minutes; a second failure is real.

## Rollback

- **Revert the merge on dev.** Railway redeploys dev.owlette.app. The 4.1.27 installers carry no agent change and can stay latest; or set latest back to 4.1.26 if the owner prefers.
- **Nothing else to undo.** There is no rules, index or data migration to reverse.
- **The redirect.** `/admin/members` → `/admin/sites` ships as a 307 (`permanent: false`), so browsers do not cache it. Make it a 308 only once the release is on prod.
- **Swoop modes after a revert.** Code from before this release ignores `swoop`, so after a revert:
  - an admin held to watch or none gets control back;
  - a member set to control loses it.

  Before reverting, list the rows that carry `swoop`: an Admin SDK scan of `collectionGroup('members')`, filtered in memory, because no index exists on that field. Then the owner either accepts the widening for the revert window, or demotes those admins to member first.
- **The in-handler re-checks** come out with the revert. The gap is then back on dev until the private fix (question 2) or a re-deploy.

## Success Criteria

- **Swoop mode:**
  - An untouched row behaves exactly as before: every pre-existing capabilities, policy, membership, escalation and swoop test passes unchanged, and an add with "by role" writes no field.
  - On dev:
    - a member set to control takes control after the step-up, and their machine menu offers no commands;
    - an admin held to watch gets "view only" and still runs the site;
    - a member set to no swoop sees "you can't use swoop on this site", and the viewer does not retry.
  - Slawek controls TEC-B4A as a member of elm-gate.
- **Kill and the session list:** a member set to control is refused both, and an admin held to watch keeps both.
- **Escalation:**
  - With the kill switch off, a plain member cannot change or remove another member, delete the site, or hand out swoop control.
  - Nobody changes their own row or the owner's.
- **Site list:**
  - Owners, admins and superadmins reach `/admin/sites`, with a gear exactly where they hold SITE_MEMBER_MANAGE (superadmins: everywhere).
  - Members are sent back.
  - `/admin/members` lands on `/admin/sites`.
- **Site settings:**
  - `/admin/sites/{id}` shows general, members, machines, and swoop & screens to that site's admins, plus danger zone to its owner and superadmins.
  - `?section=` deep links work, and an unknown or hidden section falls back to general.
  - A member-only site says so. An unreachable site says "site not found".
- **Header:**
  - "site settings", "manage sites" and "new site" appear per role, and none of them in demo mode.
  - "admin panel" lands on `/admin/sites` for site admins and on `/admin/installers` for superadmins.
  - "turn on swoop…", the swoop picker and the viewer's "open site settings" open `?section=swoop`.
  - A hard load of any `/admin/sites` page as a site admin never shows "access denied" (proven on dev by the live smoke).
- **Add member:**
  - A site admin is offered only people on other sites they administer. A superadmin is offered everyone except the site's members (and, per question 3, superadmin accounts).
  - A full email adds any account. Re-adding an existing member says "already on this site".
  - API keys and members are refused, with the kill switch on and off.
- **Roles and removal:** owners and admins change role and swoop on rows other than their own and the owner's. Removal offers this site's owners and admins as talon successors.
- **Nothing stale left:**
  - No source or test names `ManageSitesDialog`, `/dashboard?settings=`, `onManageSites`, "admin is an account-level role" or "this changes the account, not just this site".
  - `/admin/members` survives only in the redirect and its tests.
- **Phone:**
  - At 390px nothing on either page, the add-member dialog, its list or the change access dialog is clipped, in light and dark.
  - Both pages are in theme-review and the a11y route-smoke.
- **Docs and contract:**
  - `npm run validate:api` and `public/docs-links.spec.ts` are green.
  - These match the shipped behaviour: the docs pages from docs-openapi.md §C, `sites.mdx`, `member-management.mdx`, the swoop and reference pages, openapi, GLOSSARY, README, both changelogs, both skills and ADR 0015.
- **Checks and release:**
  - Lint, typecheck, jest, rules tests, the full local e2e, CI e2e on dev and `npm run smoke:dev` against dev.owlette.app are green.
  - 4.1.27 (exe, pkg, deb) is uploaded to dev and verified before the push.
  - The owner has answered the eight questions and signed off the steps marked for him.
