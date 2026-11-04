# Admin sites page and swoop mode (release 2) — Context
**Last updated**: 2026-11-04 (revised against two critiques)

## Why this exists

The trigger: Slawek, on another owlette account, can only watch TEC-B4A, not control it. The owner moved TEC-B4A to a site of its own (LIVE NATION, `elm-gate`, on dev) as a workaround.

- Slawek is a member there, and members watch.
- Today the only way to give him control is to make him admin on `elm-gate`. That is too much (owner ruling 13). An admin holds every site capability except SITE_DELETE: commands, machine config, pairing, agent-token revoke and member management.
- After this release he stays a member, and an owner or admin of `elm-gate` sets his **swoop mode** to control in the site's members section. He then takes control of TEC-B4A after a step-up, and gets no commands, no configuration and nothing site-wide. He needs his own second factor enrolled for the step-up.
- This release also builds the page that setting lives on: `/admin/sites/{siteId}`, members section.
- Release 3 (machine-scoped membership) lets the owner give someone one machine on a site with several. B4A could then move back to TEC's site. Scope × mode covers the owner's case; there are no per-machine modes (ruling 14).

## Owner rulings this plan follows (2026-11-04, binding)

- **4. Site settings becomes a page under the admin panel.**
  - `/admin/sites` lists your sites, with a gear only on sites you administer. Superadmins see every site.
  - `/admin/sites/[siteId]` has five sections: general, members, machines, swoop & screens, danger zone.
  - It replaces both the header's manage sites dialog and `/admin/members`.
  - The switcher keeps "site settings" (the page for the current site) and "manage sites" (`/admin/sites`), for people who administer any site.
  - The detail component stays route-agnostic, so it could be mounted in a dialog later.
- **5. "new site"** stays reachable from the site switcher for people who administer nothing yet. It opens CreateSiteDialog and is owned by PageHeader.
- **6. The add-member typeahead.**
  - Site admins are offered people on the sites they administer (where they hold SITE_MEMBER_MANAGE), minus the target site's current members. Never a platform-wide search for site admins.
  - A full email still adds anyone through the existing `POST {email}`.
  - Superadmins search everyone, minus the site's members.
  - No new package.
- **8. A full release:** version bump, changelog, the exe built here, the pkg on the MBA and the deb on the kiosk VM, uploaded to dev and verified before any push or merge.
- **11. Order:**
  - 4.1.26 (swoop join and viewer pills) ships first.
  - Then this release.
  - Then machine-scoped membership (release 3). Releases 2 and 3 may be built in parallel where files don't collide, and release 3's scope editor lives in this release's members section.
- **12. No shortcuts.**
  - e2e for every new user-facing behaviour.
  - A bug fix starts with a failing test.
  - Docs, README, GLOSSARY and openapi are updated in the same change.
- **13. A per-person swoop mode, separate from the role.**
  - Each member row gets `swoop: 'none' | 'view' | 'control'`. It applies to every machine the person can reach (the whole site today; their scoped machines once machine scope lands).
  - With the field absent, the role decides: member → view, admin and owner → control. So no existing row changes behaviour; it is dormant until used.
  - A member set to control gains MACHINE_REMOTE_CONTROL and nothing else (no commands, no config, no site-wide capability).
  - An admin set to view or none loses MACHINE_REMOTE_CONTROL (and VIEW, for none) and keeps everything else.
  - Control still needs an enrolled second factor and the step-up window.
  - The site setting `membersMayWatch` is the default for members with no explicit mode; an explicit mode on the row wins.
  - Downgrading a mode revokes that person's live control sessions (`controlOnly`), the way a demotion does today; `none` revokes their watch sessions too.
  - The mode is set by whoever holds SITE_MEMBER_MANAGE, never on your own row and never on the owner's row.
- **14. Who owns the swoop mode, and what it ships with.** It needs no firestore.rules change, so it ships in this release.
  - The members section and the add-member dialog carry role and swoop mode; release 3 adds the machines picker beside them.
  - The members API gains `swoop` on GET, POST and PATCH, with validation.
  - Docs: swoop.mdx "watching versus control", member-management, the reference/authentication capability table, GLOSSARY "Site role" plus a "swoop mode" entry. Also openapi.
  - Tests:
    - the capabilities cross product with the override;
    - the members route;
    - escalation blocks with positive controls;
    - policy tests for `membersMayWatch` against an explicit mode;
    - e2e: a member granted control gets control after a step-up, and an admin held to view gets "view only".
  - No per-machine modes in this pass.

## Key Files

**Create**
- Routes:
  - `web/app/admin/sites/page.tsx`, `web/app/admin/sites/layout.tsx`
  - `web/app/admin/sites/[siteId]/page.tsx`, `web/app/admin/sites/[siteId]/layout.tsx`
  - `web/app/api/sites/[siteId]/member-candidates/route.ts`
- Libs: `web/lib/swoopMode.ts`, `web/lib/memberCandidates.ts`, `web/lib/siteSettingsPath.ts`
- Shared admin components, in `web/components/admin/`: `Panel.tsx`, `SegmentedControl.tsx`, `BackLink.tsx`, `DetailSkeleton.tsx`
- Site components, in `web/components/admin/sites/`:
  - Pages and sections: `SiteList.tsx`, `SiteSettings.tsx`, `SiteGeneralSection.tsx`, `SiteMembersSection.tsx`, `SiteSwitches.tsx`, `SiteDangerZone.tsx`
  - Members: `MemberSearchInput.tsx`, `MemberAccessFields.tsx`, `AddMemberDialog.tsx`, `ChangeAccessDialog.tsx`
  - Shared: `highlightMatch.tsx`, `displayRole.ts` (moved)
- Tests:
  - `web/__tests__/lib/swoopMode.test.ts`, `web/__tests__/lib/sitePolicy.test.ts`, `web/__tests__/lib/memberCandidates.test.ts`, `web/__tests__/lib/siteSettingsPath.test.ts`
  - `web/__tests__/api/sites-member-candidates.test.ts`
  - `web/__tests__/components/admin/{Panel,SegmentedControl}.test.tsx`
  - Under `web/__tests__/components/admin/sites/`: `SiteList`, `SiteSettings`, `SiteGeneralSection`, `SiteMembersSection`, `SiteSwitches`, `SiteDangerZone`, `AddMemberDialog`, `ChangeAccessDialog`, `MemberAccessFields`, `MemberSearchInput`, `highlightMatch`, `displayRole` (moved)
- e2e: `web/e2e/specs/sites/site-list.spec.ts`, `web/e2e/specs/sites/site-members.spec.ts`, `web/e2e/specs/mobile/admin-sites.spec.ts` (git mv of `sites-dialogs.spec.ts`)
- Docs: `web/content/docs/dashboard/admin/sites.mdx`, `docs/adr/0015-adding-a-member-searches-only-your-own-sites.md`

**Modify**
- Access core:
  - `web/lib/capabilities.ts`, `web/lib/sitePolicy.server.ts`, `web/lib/authorizedHandler.server.ts`, `web/app/api/_shared.ts`, `web/lib/apiAuth.server.ts`
  - `web/lib/swoop/policy.server.ts`, `web/lib/swoop/revokeViewerSessions.server.ts` (reason type)
- Routes:
  - `web/app/api/sites/[siteId]/members/route.ts`, `web/app/api/sites/[siteId]/members/[uid]/route.ts`, `web/app/api/sites/[siteId]/route.ts` (DELETE re-check)
  - `web/app/api/sites/[siteId]/machines/[machineId]/swoop/kill/route.ts`, `web/app/api/sites/[siteId]/swoop/sessions/route.ts`
- Writer and helpers: `web/lib/membership.server.ts`, `web/lib/talonSuccessors.ts`, `web/lib/timeUtils.ts` (comment)
- Hooks: `web/hooks/useSiteMembers.ts`, `web/hooks/useFirestore.ts`, `web/hooks/useCurrentSite.ts`
- Admin panel: `web/app/admin/navItems.ts`, `web/components/RequireAdminAccess.tsx`, `web/next.config.ts`, `web/components/admin/issues/IssueList.tsx`, `web/components/admin/issues/IssueDetail.tsx`, `web/components/ui/button.tsx` (size `xs`)
- Shared components: `web/components/PageHeader.tsx`, `web/components/CreateSiteDialog.tsx`, `web/components/SiteMachinesList.tsx`, `web/components/swoop/SwoopStage.tsx`
- Copy and comments: `web/components/ManageUserSitesDialog.tsx`, `web/components/AccountSettingsDialog.tsx`, `web/app/admin/users/page.tsx`, `web/app/talons/components/TalonEditorDialog.tsx`, `web/components/MachinePowerConfirm.tsx`, `web/app/globals.css` (comment)
- Pages that hosted the dialog:
  - `web/app/dashboard/page.tsx`, `web/app/talons/page.tsx`, `web/app/roosts/RoostsPageClient.tsx`, `web/app/deployments/page.tsx`, `web/app/logs/page.tsx`
  - `web/app/hoot/components/HootChatView.tsx`, `web/app/demo/page.tsx`
- Swoop links: `web/components/swoop/SwoopPicker.tsx`, `web/app/swoop/[siteId]/[machineId]/page.tsx`
- The 4.1.26 viewer-pill email gate (Task 4.3), whose files are found after release 1 merges.
- Jest:
  - `lib/capabilities.test.ts`, `lib/swoop/policy.server.test.ts`, `lib/authorizedHandler.test.ts`, `lib/membership.test.ts`, `lib/talonSuccessors.test.ts`
  - `api/sites-members.test.ts`, `api/membershipEscalation.test.ts`, `api/swoop/settings-and-kill.test.ts`, `api/swoop/site-sessions.test.ts`
  - `RequireAdminAccess.test.tsx`, `AdminLayout.test.tsx`, `PageHeader.test.tsx`, `SwoopPicker.test.tsx`, `SwoopStage.test.tsx`, `SiteMachinesList.test.tsx`, `CreateSiteDialog.test.tsx`, `MachinePowerConfirm.test.tsx` (comment)
  - `app/swoop-viewer-refused.test.tsx`, `app/roosts-page.swap.test.tsx`, `api/sites-machines.test.ts` (comment)
  - `hooks/useSiteMembers.test.ts`, `hooks/useSwoopSession.test.tsx`
  - Rules: `rules/membership.test.ts` (a test only; no rules change)
- e2e:
  - `helpers/seed.ts` (an optional `swoop` on `seedMemberRow` / `grantMembership`)
  - `sites/{create-site,edit-site,delete-site,delete-site-owner,site-role-boundaries}`
  - `swoop/{turning-it-on,session}`, `dispatch/active-hours`, `plans/free`
  - `mobile/admin-drawer`, `access-control/{route-guards,pageheader}`, `a11y/route-smoke`
  - `theme-review/routes.spec.ts`, `COVERAGE.md`
  - videos `02`, `14`, `17`
  - `e2e-live/specs/roles.spec.ts`, `e2e-live/README.md`
- Docs:
  - `dashboard/admin/{index,member-management,user-management}.mdx`, `dashboard/admin/meta.json`
  - `dashboard/{index,getting-started,swoop,timezones,account-settings,machine-monitoring,talons}.mdx`
  - `getting-started.mdx`, `setup/firebase.mdx`
  - `reference/{authentication,firestore-data-model}.mdx`, `api/{errors,rate-limits}.mdx`
- Records: `web/openapi.yaml`, `GLOSSARY.md`, `README.md`, `docs/changelog.md`, `web/content/docs/changelog.mdx`, `.claude/skills/codebase-map/SKILL.md`, `.claude/skills/firebase-integration/SKILL.md`
- Sibling plan (one-time coordination edits, already made): `dev/active/machine-scope/{plan,context,tasks}.md`. Its ADR becomes 0016, and its collision list names this release's swoop-mode files.

**Delete**
- `web/components/ManageSitesDialog.tsx` and its test
- `web/app/admin/members/page.tsx`, `web/app/admin/members/layout.tsx`
- `web/__tests__/app/members-display-role.test.ts`, moved to `components/admin/sites/displayRole.test.ts`

**Not touched**
- `firestore.rules`, `firestore.indexes.json`. The `members.uid` collection-group index the listing uses already exists. Member rows are server-written only, and a rules test pins that.
- `MachineContextMenu.tsx` and its test. Its `onSiteSettings` prop stays; only the dashboard's handler changes.
- `AuthContext.tsx` and `useSiteMemberships`. The dashboard does not read the swoop mode (decision 26).
- `.claude/hooks`, `.claude/settings.json`.
- The SDKs and the CLI (decision 27).
- `web/lib/rateLimit.server.ts`. Kill and the list take SWOOP_SETTINGS_MANAGE's existing 30/min.

## Decisions

1. **Pages, not dialogs, with a route-agnostic detail component** (ruling 4).
   - What pages buy: deep links from the header, the swoop picker and viewer, and the machine menu. No dialogs nested three deep (add member, remove, restart confirms). It works full-page on a phone, and mirrors `/admin/issues`.
   - `SiteSettings` takes `section`, `onSectionChange` and `onDeleted`, and holds no router.
2. **Sections one at a time, chosen by `?section=general|members|machines|swoop|danger`.**
   - An unknown or hidden section renders general.
   - The control is one shared `SegmentedControl`, extracted from IssueList's StatusFilter (role=group, `aria-pressed` buttons on a new button size `xs`). There is no Tabs primitive, and Radix tabs would be a new package.
   - Danger zone shows only to `isSiteOwner` (owner or superadmin), matching the server's SITE_DELETE.
3. **One link builder**, `siteSettingsPath(siteId, section?)` (`web/lib/siteSettingsPath.ts`), for every link to a site's settings. Swoop links target `?section=swoop`.
4. **Add-member candidates follow user-search.md §4, shape B** (ruling 6). Shape B means fetch once per dialog open and filter in the browser.
   - **What the route does:** `GET /api/sites/{siteId}/member-candidates`, with SITE_MEMBER_MANAGE and an in-handler re-check, because the kill switch skips the wrapper's check. API keys get 403 `api_key_not_permitted`.
   - **Who appears:**
     - For site admins: the union of active rosters on the sites where `hasCapability` grants SITE_MEMBER_MANAGE over `siteStanding(listUserStanding(uid))`. That is the same row reading as every gate, with no local role check.
     - For superadmins: every user.
     - Both exclude the target site's active members, soft-deleted accounts and superadmin accounts. Superadmins reach every site with no row, and `membership.server.ts:19-22` says they are deliberately not members. Ruling 6 says "everyone", so this exclusion is question 3.
   - **What it returns:** `{uid, email, displayName}` only. There is no `?q=`: Firestore cannot match case-insensitively, and each request costs a blocking audit row and spends the shared 30/min budget. It never resolves a typed email; exact email stays in `POST /members {email}`.
5. **The browser ranks** with `rankMemberCandidates`: prefix matches first, then substring, capped at 6 two-line rows. That fits without a scroll region; axe's `scrollable-region-focusable` rule would otherwise demand a tab stop.
6. **The search input is `MemberSearchInput`, a textbox**, with `aria-autocomplete`, `aria-controls` and `aria-activedescendant`, after hoot's `@` list, which passes the axe gate. The axe gate rejects a combobox role in a form row, and the name says what it is. When the typed text is a full email, Enter never picks a different person whose address merely contains it.
7. **`AddMemberDialog` mounts only while open**, so `useMemberCandidates` fetches a fresh list on every open with no effect-driven reset.
8. **Members section fixes** (not ported from `/admin/members`):
   - **"change access..."** (role and swoop) is offered on rows other than your own and the owner's. It is seeded from the site role and the mode. The copy is site-scoped.
   - **Add toasts** branch on `roleHonored` ("already on this site").
   - **Successors** come from `siteTalonSuccessors`: the site's owners and admins.
   - **The owner refusal** is detected by error code (`SiteMemberApiError.code`), not regex.
   - **The "account-level" hint and copy** are gone.
   - **A reversal:** `e2e-live/specs/roles.spec.ts` calls role change superadmin-only "settled". The owner's 2026-11-04 ruling reverses that.
9. **PageHeader owns "site settings", "manage sites" and "new site".**
   - Its props `onManageSites` and `onSiteSettings` go away, with the hoot and demo no-ops.
   - Who sees what: "new site" shows only for people who administer nothing (ruling 5); everyone else creates from `/admin/sites`. All three are hidden with `disableNav` or no user.
   - CreateSiteDialog loads through `next/dynamic` (dashboard precedent). It uses the module-level `createSite`, lifted out of `useSites`, so no extra site listener opens. Its unused user-id parameter is dropped.
10. **After a "new site" from the header, the page switches to the site through its own `onSiteChange`**, which also saves it as the last site.
    - The four pages' old `pickSite` (switch without saving) is removed. It existed only for their now-deleted CreateSiteDialog copies.
    - We judged that a person who just made a site and moved to it expects to come back to it. This is question 4, asked at approval.
    - SiteList's "new site" navigates to the new site's settings and does NOT save it as the last site. Creating from the admin page should not change the dashboard's site, and this also keeps e2e fixtures stable.
11. **No per-row swoop on/off icon in the site list.**
    - It cost one live Firestore listener per row: hundreds for a superadmin.
    - The swoop & screens section shows the state.
    - `getting-started.mdx`'s "each row … shows whether that site has swoop on" is deleted.
12. **RequireAdminAccess waits for memberships** (`userSites !== undefined`) before deciding.
    - It fixes a real bounce on hard loads of any `/admin` page for site admins, which the new deep links make common.
    - It needs no AuthContext change, which avoids a collision with release 3.
    - The live smoke hard-loads two site pages as a site admin on dev, so the fix is proven where the bug was seen.
13. **`/admin/members` redirects to `/admin/sites` as a 307** (`permanent: false`, `next.config.ts`) until the release reaches prod, so a revert is not cached by browsers. The dashboard's `?settings=` handler is deleted, not redirected: its only producers were `SwoopPicker` and the swoop viewer, which now link to the page, and grep finds no desktop or agent producer.
14. **Delete is honest.**
    - The copy says what the cascade does (`deleteSite.server.ts:5-22`): machines and history, roosts, talons, webhooks and access go; agent tokens are revoked; the ID is retired.
    - Afterwards the caller lands on `/admin/sites` if they still administer a site, else on `/dashboard`. With no administered site left, `/admin/sites` would bounce with "access denied".
    - The stale openapi sentence "cascade cleanup is deferred" goes, and so do the false `useFirestore` comment and TODO.
15. **The swoop switch's description says "by default"** and follows `membersMayWatch`. The old text, "let admins watch and control", was wrong, and a person's swoop mode now changes it per person.
16. **`/admin/users`' row item "manage sites" is renamed "manage site access"**, its dialog's own title, with its state renamed to match. "manage sites" now means only the switcher entry to `/admin/sites`.
17. **`SiteMachinesList` stays where it is**, rendered directly by the machines section with no wrapper file.
    - Its version column hides below sm.
    - Its restart and remove buttons are now only ever shown to admins, because the whole page is admin-only. The old dialog offered them to members.
18. **The superadmin owner column still reads the legacy `sites/{id}.owner`**, as the dialog did. A per-site member-row read for every row would cost more than the column is worth. The wave 6.1 dependency is recorded here and in plan.md Risks, never as a code comment.
19. **ADR 0015 records the search rule:** a later "make it search everyone" must argue against it. Machine scope's ADR is 0016; both plans say so, and neither takes "the next free number". There is no ADR for the page structure, which is easy to reverse.
20. **It ships as 4.1.27**, a full release after 4.1.26 (ruling 8).
21. **The swoop mode field.**
    - It is called `swoop`, with the values `none`, `view` and `control` (the owner's words). One pure module, `web/lib/swoopMode.ts`, defines it for the server and the dashboard.
    - Absent means "by role" and is the default for every existing row. It is never stored as null and never on the owner's row; the UI's "by role" deletes the field.
    - A present but malformed value reads as `none`, failing closed.
    - The UI labels are `by role`, `no swoop`, `watch` and `control`.
22. **Where the mode applies.**
    - `hasCapability` applies an explicit mode to MACHINE_REMOTE_VIEW and MACHINE_REMOTE_CONTROL only, never on an owner row. Both stay in BYPASS_EXEMPT_CAPABILITIES, so a held-back admin stays held back during the break-glass.
    - `evaluateSwoopAccess` skips `members_may_not_watch` when the row carries a mode.
    - The capability matrix still states the role defaults, and a test pins that `grantedSwoopMode` agrees with it.
23. **One builder of standing.** `siteStanding` (capabilities.ts) turns member rows into `siteRoles` and `swoopModes`, and every builder from a member row uses it: the wrapper, `_shared`'s `requireSiteCapability`, `assertUserHasSiteCapability`, and the candidates listing (`listUserStanding`).
    - It returns `swoopModes` only when some site has a mode, so an actor built from untouched rows is exactly today's actor (`authorizedHandler.test.ts:295`).
    - Today only the wrapper's routes ask for the swoop capabilities. Carrying the mode everywhere stops a later route from handing a held-back admin control through a builder that dropped it.
    - Builders that never read a member row (hoot, talons, users/me) are untouched.
24. **The wrapper's refusal of a swoop capability carries `code: 'capability_missing'`.** Only for BYPASS_EXEMPT capabilities: every other refusal keeps code `forbidden`, so no public API contract changes outside swoop.
    - The viewer already ends on that code (`backoff.ts` WITHDRAWALS) and already steps a control ask down to a watch ask on it (`intent.ts`).
    - The stage says "you can't use swoop on this site".
25. **Kill and the site's session list take SWOOP_SETTINGS_MANAGE**, not MACHINE_REMOTE_CONTROL.
    - Kill ends everyone's sessions on a machine and closes every step-up window there. The list shows every viewer's email on the site. Both administer the site's swoop.
    - So a member set to control can use neither (rulings 13 and 7), and an admin held to watch keeps both; `/admin/swoop` would otherwise read their 403 as an empty site.
    - This changes machine-scope decision 9 (a scoped admin may kill): a scoped admin holds no site-wide capability, so they cannot kill. That also removes the "closes everyone's step-up windows" leak that decision had to accept. The machine-scope plan's collision note says so.
    - This is question 5.
26. **The dashboard does not read the swoop mode in this release.** A person set to none still sees swoop entries; the viewer refuses them with a final line and no retry. The control decision is the server's, and the viewer always asks for control first and steps down. Hiding entries would need AuthContext and `useSiteMemberships` to carry the mode, which release 3 also edits. This is question 6.
27. **The SDKs and the CLI get no `swoop` field in this release.** The API accepts it, PATCH with `{role}` alone is unchanged, and `owlette site set-role` keeps working. This is question 7.
28. **The members API and the mode.**
    - GET returns `swoop` (null means by role).
    - POST takes an optional mode (null is a 400). A re-add writes nothing, the mode included (`roleHonored: false`).
    - PATCH takes `role` and/or `swoop`, with `null` meaning back to by role. Its revocation follows `grantedSwoopMode` before and after:
      - losing control ends the control seats (`controlOnly`);
      - losing swoop altogether ends every seat;
      - reasons are `role_changed` or the new `swoop_changed`.
      - It does not look at `membersMayWatch`, which this PATCH did not change; the lease already enforces it.
    - **A role change keeps an explicit mode**, as release 3 keeps machine scope on a role change. An admin set to control who is demoted keeps control.
    - `changeRole` is replaced by `updateMember` (role and/or swoop, one transaction, returning before and after), the name release 3 already planned.
    - Audit verbs: `member_role_changed` when a role is sent, else `member_swoop_changed`.
29. **One access dialog.** The row menu's "change role..." becomes **"change access..."**, holding role and swoop through `MemberAccessFields`. The add dialog uses the same fields. Release 3 adds its machines field to `MemberAccessFields`, so a person's access is edited in one place. The members table shows the effective swoop mode, marked "by role" when unset.
30. **In-handler re-checks** in members PATCH and DELETE (SITE_MEMBER_MANAGE) and site DELETE (SITE_DELETE), placed before the body read and `withIdempotency`, as members POST does.
    - Members routes answer `site_member_manage_required`. Site DELETE answers exactly what the wrapper would (`forbidden`, "capability not granted"), so it adds no new code.
    - `PATCH /api/sites/{id}` (name, timezone) stays on the wrapper alone: renaming a site during the break-glass grants nothing and is audited.
    - The gap is live on prod. Per the owner's public-repo rule, commit and changelog wording is neutral and the push waits for question 2.
31. **No ADR for the swoop mode.** Ruling 14 lists its records (docs, GLOSSARY, openapi), and the GLOSSARY entry carries the term. The decision is easy to reverse while few rows carry the field: delete the field and the branch in `hasCapability`. No ADR said control was admin-only: ADR 0009 requires the step-up, and that stands. The code comment and GLOSSARY Viewer entry that did say it are rewritten.
32. **Shared pieces, not copies.** `Panel`, `SegmentedControl`, `BackLink` and `DetailSkeleton` move out of IssueDetail and IssueList into `web/components/admin/`, and the issue pages import them. Button sizing lives in `button.tsx` (`xs`). SiteList takes its sites and current site from `useCurrentSite()` rather than deriving them again.
33. **No speculative seams.**
    - There is no `accessColumn` prop: release 3 adds its column inline.
    - No code comment tells a later release what to do; those notes live in "Seams for release 3" below.
34. **e2e runs once, serially.** Wave 7 authors specs, and its checks are eslint and `playwright test --list`. Task 8.1 alone builds `.next-e2e` and binds the emulator ports (Auth 9099, Firestore 8080, Storage 9199, app 3100), then runs every new and changed spec and docs-links in two sessions (chromium, mobile-chromium). Parallel tasks on fixed ports would collide.
35. **Owner questions are asked once, at plan approval** (plan.md, eight questions). The tasks that implement an answer (2.8, 4.2, 9.3) name the question.

## Copy rules (all user-facing text lowercase)

- Toasts are a lowercase title plus a description: `member added`, `already on this site`, `access updated`, `site updated`, `site created`, `site deleted`, `site ID copied`, `machine removed`.
- Errors read `could not …`, with the server detail as the description. The exact strings are in each task.
- The literal string `superadmin` never renders on a site-scoped surface; `displayRole` collapses it.
- Glossary terms only: site, machine, site role, site admin, superadmin, swoop mode. Never org, tenant, or "operators" for owlette's own staff ("owlette's superadmins"). Never a bare "admin" when you mean the global role. The path is written "admin panel → sites".
- Swoop mode labels: `by role`, `no swoop`, `watch`, `control` (`SWOOP_MODE_LABELS` plus "by role"). The viewer's refusal: `you can't use swoop on this site` / `a site owner or admin sets who can watch and control. ask one of them.`
- Site ID keeps its capital ID, as `CreateSiteDialog` already writes it.

## Seams for release 3 (machine-scoped membership)

What release 3 builds on, and what it changes. These are notes for that plan, never code comments.
- **`MemberStanding` and `siteStanding` (capabilities.ts).**
  - Add `machineIds` to the input and `machineScopes` to the output. Every member-row builder then carries scope with no further edit.
  - Release 3 planned its own `siteStanding(siteId, role, machineIds)`; it extends this one instead.
- **`SiteAccessFacts`, `deriveMembership`, `deriveSwoopMode`, `listUserStanding` (sitePolicy.server.ts).**
  - Add `machineIds` beside `swoopMode`.
  - The candidates route then drops scoped admins through `hasCapability` with no route edit. That is machine-scope Task 5.8, which shrinks to a test.
  - `web/__tests__/lib/sitePolicy.test.ts` exists after this release, so release 3 extends it rather than creating it.
- **`hasCapability`'s swoop branch.** A scoped person's mode applies to their in-scope machines only (scope × mode).
- **`updateMember` (membership.server.ts).**
  - It already changes role and/or swoop in one transaction and returns before and after. Release 3 adds `machineIds`.
  - The PATCH route's revocation adds the `scope_changed` machine filter beside `swoop_changed`.
- **`MemberAccessFields` and `ChangeAccessDialog`.**
  - The machines field goes in `MemberAccessFields`, which both the add dialog and "change access..." render.
  - MultiSelect's "empty means all" must map to an absent field, never `[]`.
  - The access column goes inline in `SiteMembersSection`'s table.
- **Kill and the site's session list need SWOOP_SETTINGS_MANAGE now**, which is site-wide. A scoped admin cannot kill (this replaces machine-scope decision 9).
- **`seedMemberRow` / `grantMembership`** take an `extra` object (`{ swoop }` now). Release 3 adds `machineIds` to it.
- **`siteTalonSuccessors`** must exclude scoped admins (no TALON_MANAGE).
- **Client gates** (`isSiteAdmin`, `administersAnySite`) drive the gear, "site settings" and the admin panel. They learn scope in AuthContext, which release 2 deliberately does not touch.
- **Collisions.** Both releases touch these files; land or rebase onto release 2's waves 1-3 before editing them:
  - the core: `web/lib/capabilities.ts`, `web/lib/sitePolicy.server.ts`, `web/lib/authorizedHandler.server.ts`, `web/app/api/_shared.ts`, `web/lib/apiAuth.server.ts`;
  - swoop: `web/lib/swoop/policy.server.ts`, `web/lib/swoop/revokeViewerSessions.server.ts`, the kill and site-session routes;
  - membership: `web/lib/membership.server.ts`, both members routes, `web/app/api/sites/[siteId]/route.ts`;
  - helpers and hooks: `web/e2e/helpers/seed.ts`, `web/hooks/useFirestore.ts` (different functions), `web/hooks/useSiteMembers.ts`, `web/lib/talonSuccessors.ts`;
  - tests: `web/__tests__/rules/membership.test.ts`, `web/__tests__/api/membershipEscalation.test.ts` (blocks 13-18 are this release's), `web/__tests__/lib/sitePolicy.test.ts`;
  - the candidates route and the members components.

## Coordination

- **Release 1 (4.1.26).**
  - Cut this branch from origin/dev after it merges.
  - It edits these files, which this release edits again: `app/swoop/[siteId]/[machineId]/page.tsx`, `components/swoop/SwoopStage.tsx`, `hooks/useSwoopSession.ts`, `lib/swoop/policy.server.ts`, `lib/swoop/revokeViewerSessions.server.ts` (which keeps `controlOnly`), `e2e/specs/swoop/session.spec.ts`, `swoop.mdx`, `api/errors.mdx`, the GLOSSARY, firestore-data-model and openapi.
  - Find anchors by code.
  - Its viewer-pill email gate is checked in Task 4.3.
- **Release 3 (machine scope, `dev/active/machine-scope`).** On 2026-11-04 its plan was edited in three places to match this revision:
  - its ADR is 0016;
  - its plan.md collision bullet names this release's swoop-mode files and points here;
  - its context.md notes the kill change.

  The full seam list above is what its wave-5 rebase (Task 5.0) records.
- **site-billing.** owlette-65's unpushed `feat/site-billing`, in `../Owlette-site-billing-wt`.
  - Its tasks.md:136-139 add an owner-only billing row to `ManageSitesDialog.tsx`, which this release deletes.
  - The first line of wave 4 is the message to that session: billing belongs on the site settings page (general, or a section of its own).
  - Its planned `UpgradeGate`/`useSitePlan` signature change does not touch these files.
- **The private security plan** (`Owlette-secplan-wt`, unpushed). It may take the three in-handler re-checks (question 2). If it does, Task 9.3 rebases onto it before pushing.

## Commands

All from `web/` unless noted.
- **Lint one file:** `npx eslint <file>`.
- **Typecheck:** `npx tsc --noEmit`. It skips `__tests__/**`, `e2e/**` and `*.spec.ts` (`web/tsconfig.json` exclude), so jest and `playwright test --list` are the checks for those.
- **Jest:** one file with `npx jest __tests__/<path>`; everything with `npm test -- --ci`.
- **Rules tests:** `npm run test:rules`. It needs the emulator on :8080, so never run it beside another emulator.
- **OpenAPI drift:** `npm run validate:api`.
- **A spec loads:** `npx playwright test --list --project=chromium e2e/specs/<path>` (`--project=mobile-chromium` for `specs/mobile/**`; `--config=playwright.videos.config.ts`, `playwright.theme-review.config.ts` or `playwright.live.config.ts` for those suites).
- **Running e2e (Task 8.1 and 9.1 only):**
  1. `npm run e2e:build` once.
  2. From the repo root: `firebase emulators:exec --only auth,firestore,storage --project demo-playwright-e2e "cd web && npx playwright test --project=chromium <files>"`.
  3. The full suite is `npm run e2e`.
- **On this box:**
  - A late `ERR_ADDRESS_IN_USE` or a stuck load is ephemeral-port exhaustion: rerun once after two minutes. A second failure is real.
  - Beside another session's emulator, use shifted ports (`firebase -c` plus env hosts; see `web/e2e/README.md`).
  - A worktree needs its own `npm ci`, not a node_modules junction, which breaks Turbopack.
- **Live dev smoke:** `npm run smoke:dev`. It needs `agent/config/firebase-creds-dev.json` and `web/.env.local`.
- **Security gate:** `node scripts/check-security-alerts.mjs`, from a named branch. On a detached HEAD it grades main.
- **API checks:**
  - Use `curl`, not python urllib, which Cloudflare blocks.
  - The header is `x-api-key`, with `OWLETTE_API_KEY` against `$OWLETTE_DEV_API_URL`, both in `.claude/.env.local`.
  - Read-only calls need no approval. Installer finalize and setAsLatest, and any change to a real person's access, need the owner's go.

## Next Steps

1. At plan approval, ask the owner the eight questions in plan.md, in one batch, and log the answers. Question 1 (a stopgap for Slawek) may need action before this release ships.
2. Wait for 4.1.26 to merge to dev.
3. Create a worktree from origin/dev (`git worktree add ../Owlette-admin-sites-wt -b feat/admin-sites origin/dev`). Run its own `npm ci` in `web/`.
4. `dev/active/` is gitignored, so keep a tracked copy of this plan on the branch (`git add -f dev/active/admin-sites`), as the owner asks.
5. Run wave 1 (seven parallel tasks). Task 1.4's guard test must fail before its fix; log that.
6. Run waves 2 and 3. Before wave 4, send the site-billing message (its first line).
7. Run waves 4-7, then Task 8.1 (the only e2e run before the gate), then 9.1. Hand the owner the captures and the headed preview, and get his visual sign-off before 9.2.
8. 9.2 and 9.3 carry the owner steps:
   - MBA availability if needed;
   - finalize/setAsLatest on dev;
   - question 2 before the push;
   - the merge;
   - the phone, desktop and swoop mode checks;
   - Slawek's mode on elm-gate;
   - the tag.
