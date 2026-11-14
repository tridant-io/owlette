# swoop viewer count and admin sessions page — Tasks
**Progress**: 10/10 complete

Standing rules: work only in the worktree `C:\Users\admin\Documents\Git-restored\Owlette-swoop-mac-wt` on branch
`swoop/macos`; never touch the main checkout; `firestore.rules` and `.claude/hooks` untouched; all user-facing
copy lowercase; `npx eslint <file>` and `npx tsc --noEmit -p web` clean after every edit; no new packages; a
task's docs land in the same change; files under `dev/active` need `git add -f`. The owner's two rules: never ask
the same manual step twice, and measure before claiming.

## Wave 1: data

- [x] **Task 1.1: Store mirror and site lister** `[agent]`
  - Files: `web/lib/swoop/sessionStore.server.ts`, `web/__tests__/lib/swoop/sessionStore.server.test.ts`
  - Do: In the store (read its header first: every read and write of a session is shaped here), add
    `listLiveSwoopSessionsForSite({ siteId, nowMs? }): Promise<SwoopSession[]>` — the same collection-group
    query as `listUnendedSwoopSessionsForUser` (:240-259) without the uid filter, dropping sessions where the
    private `leaseLapsed(session, nowMs)` (:288-294) is true. Add
    `syncMachineSwoopViewers(siteId, machineId, nowMs?): Promise<void>` — reads
    `listUnendedSwoopSessionsForMachine({ siteId, machineId })` (:266-281), keeps `state === 'live'` and not
    lapsed, sums `viewers.length`, and writes `{ swoopViewers: n }` on `sites/{siteId}/machines/{machineId}` with
    `update()` (never `set`: a machine that is gone must not get a ghost doc). It never throws: catch, and log
    through the module's existing logger at warn with siteId/machineId. Call it at the end of
    `upsertSwoopViewer` (:378), `removeSwoopViewer` (:395) and `endSwoopSession` (:427), after their own write,
    awaited so the API answers with the count in place. Export both new functions. Docstrings in the file's
    voice (lowercase comments where the file uses them; match the surrounding style).
  - Tests, in the existing test file's chainable-mock style (:5-23): the lister queries `siteId ==` and
    `state in ['pending','live']` and drops a lapsed session; the sync counts only live, un-lapsed sessions
    (pending excluded; a live session with two viewers and a lapsed one with one → 2); it calls `update` with
    `{ swoopViewers: n }` on the machine ref, not `set`; an `update` rejection (not-found) is swallowed; each of
    the three mutators triggers exactly one sync; `endSwoopSession` on the last session writes 0.
  - Done when: `cd web && npx jest __tests__/lib/swoop/sessionStore.server.test.ts` passes, eslint and tsc clean.
  - Depends on: nothing.

- [x] **Task 1.2: The machine field on the web** `[agent]`
  - Files: `web/hooks/useFirestore.ts`, `web/__tests__/hooks/useMachines.swoopViewers.test.ts` (create),
    `web/app/api/sites/[siteId]/machines/[machineId]/route.ts`, `web/content/docs/reference/firestore-data-model.mdx`
  - Do: Add `swoopViewers?: number` to the `Machine` interface (:254, beside `capabilities` :277-280) with a doc
    comment: "live swoop viewers, mirrored from the session records by the server; absent until the first
    session". In `useMachines`'s whitelist (:1382-1406) map
    `swoopViewers: typeof data.swoopViewers === 'number' ? data.swoopViewers : undefined`. In the machine
    detail API route (:63-93, beside `capabilities` :87) expose `swoopViewers: typeof data.swoopViewers ===
    'number' ? data.swoopViewers : null`. In the data-model doc, add the field's row next to `capabilities`
    (:104-122). Test, copying `useMachines.capabilities.test.ts` (mocked `onSnapshot`, `emitMachines`): the
    value follows snapshots (2 → 0), is undefined when absent, and a string is ignored.
  - Done when: the new test passes, `npx jest __tests__/hooks` passes, eslint and tsc clean.
  - Depends on: nothing.

- [x] **Task 1.3: Menu badge and trigger pill** `[agent]`
  - Files: `web/components/MachineContextMenu.tsx`, `web/__tests__/components/MachineContextMenu.test.tsx`,
    `web/__tests__/components/MachineContextMenu.a11y.test.tsx`
  - Do: Add `swoopViewers?: number` to the props (:27-60) with a comment like `swoopCapable`'s. Let
    `const watching = isOnline && swoopCapable ? (swoopViewers ?? 0) : 0`. On the swoop row (:327-338) after the
    label, when `watching > 0`: `<Badge className="ml-auto tabular-nums" aria-label={`${watching} watching`}
    data-testid="machine-context-menu-swoop-count">{watching}</Badge>` (import `Badge` from
    `@/components/ui/badge`; pick the variant that reads on the row's `text-primary` — `secondary` is fine).
    On the trigger button (:205-211), when `watching > 0`, a count pill overlaid like the display-drift dot in
    `MachineCardView.tsx:272-311` but carrying the number: `<span className="absolute -top-1 -right-1
    inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold
    tabular-nums text-primary-foreground pointer-events-none" aria-hidden data-testid=
    "machine-context-menu-swoop-pill">{watching}</span>` — the trigger's `Button` needs `relative`. Keep the
    trigger's accessible name unchanged (the a11y test pins it); add `aria-label` text on the row badge only.
    Nothing renders at 0 or undefined, and never on the live-view branch. No colour literals: theme tokens only.
  - Tests: extend `openMenu`'s props type; cases: `swoopViewers: 2` with `swoopCapable` → the row has the badge
    "2" and the trigger the pill "2"; `0` and undefined → neither testid; `swoopViewers: 2` without
    `swoopCapable` → live view row, no badge, no pill; offline → nothing. a11y test: the badge's label reads
    "2 watching" and the trigger's name is unchanged.
  - Done when: both test files pass, eslint and tsc clean.
  - Depends on: nothing.

## Wave 2: wiring and the route

- [x] **Task 2.1: The views pass the count** `[agent]`
  - Files: `web/app/dashboard/components/MachineCardView.tsx`, `web/app/dashboard/components/MachineListView.tsx`,
    `web/content/docs/dashboard/swoop.mdx`
  - Do: Pass `swoopViewers={machine.swoopViewers}` beside `swoopCapable` (`MachineCardView.tsx:391`,
    `MachineListView.tsx:731`). In `swoop.mdx`, one sentence near the top (after the "two things are true"
    list): "a machine with someone in a session shows the count on its menu button and on the menu's swoop row".
  - Done when: `npx eslint` on both files clean, `npx tsc --noEmit -p web` clean, `npx jest
    __tests__/components` passes.
  - Depends on: 1.2, 1.3.

- [x] **Task 2.2: The site sessions route** `[agent]`
  - Files: `web/app/api/sites/[siteId]/swoop/sessions/route.ts` (create), `web/openapi.yaml`,
    `web/__tests__/api/swoop/site-sessions.test.ts` (create)
  - Do: `GET /api/sites/{siteId}/swoop/sessions`. Wrap with `authorizedSiteHandler` exactly as the kill route
    does (`…/swoop/kill/route.ts:179-185`: `capability: Capability.MACHINE_REMOTE_CONTROL`, `siteIdParam:
    'path'`, no target), and refuse API keys first with `apiKeyRefusal(ctx)` from
    `app/api/sites/[siteId]/machines/[machineId]/swoop/_shared.ts:105-113` (import the helper; if it lives
    beside machine-scoped params, re-use it as is — it takes the ctx). Read sessions with
    `listLiveSwoopSessionsForSite({ siteId })` (Task 1.1). Resolve names with one `db.getAll` over
    `users/{uid}` for the distinct uids, skipping missing or `deletedAt` users, the members-route pattern
    (`app/api/sites/[siteId]/members/route.ts:116-138`). Answer `{ ok: true, data: { sessions: [{ sid,
    machineId, state, startedAt, viewers: [{ uid, email, displayName, ctl, joinedAt }] }] } }`, sorted by
    `startedAt` ascending. Errors as problem+json through `web/lib/apiErrors.ts`. Document it in
    `web/openapi.yaml` beside the swoop operations (:5964-6365): `tags: [Machines]`, `security: -
    firebaseIdToken: []`, the response schema, `Problem4xx` refs; then `cd web && npx tsx
    scripts/validate-openapi.ts` must pass.
  - Tests, copying `settings-and-kill.test.ts`'s mocks (:26-97) and `stageSession` (:157-168), but mock
    `@/lib/swoop/sessionStore.server`'s `listLiveSwoopSessionsForSite` (the mock db has no `collectionGroup`):
    a member gets 403; an API key gets 403 `api_key_not_permitted`; a site admin gets 200 with two sessions,
    names resolved (`email`, `displayName`), a missing user → nulls; the list is sorted by `startedAt`.
  - Done when: the test passes, the OpenAPI validator passes, eslint and tsc clean.
  - Depends on: 1.1.

- [x] **Task 2.3: Admin nav and guards** `[agent]`
  - Files: `web/app/admin/navItems.ts`, `web/__tests__/components/RequireAdminAccess.test.tsx`,
    `web/e2e/specs/access-control/route-guards.spec.ts`
  - Do: Add `{ name: 'swoop', href: '/admin/swoop', icon: MonitorPlay, description: 'view and end live swoop
    sessions', minRole: 'admin' }` to `NAV_ITEMS` (:33-97), placed after `agent tokens`. Update the pinned name
    arrays (:143-165) and the `requiredRoleForPath` cases (:180-197) so `/admin/swoop` → `'admin'`. Add
    `/admin/swoop` to the guard spec's site-scoped routes (:13-19) so a member is bounced and an admin reaches
    it. The page itself arrives in 3.1; until then `/admin/swoop` 404s, which the guard spec must not assert
    against — if the spec asserts a heading, leave that case to 3.1 and only assert the member bounce here.
  - Done when: `npx jest __tests__/components/RequireAdminAccess.test.tsx` passes, eslint clean.
  - Depends on: nothing (kept in Wave 2 so it lands with the page in one PR).

## Wave 3: the page and the badge proof

- [x] **Task 3.1: The admin page** `[agent]`
  - Files: `web/app/admin/swoop/page.tsx` (create), `web/app/admin/swoop/layout.tsx` (create),
    `web/__tests__/app/admin-swoop-page.test.tsx` (create), `web/content/docs/dashboard/swoop.mdx`
  - Do: Copy the shape of `web/app/admin/tokens/page.tsx`. Sites from `useSites(user?.uid, userSites,
    isSuperadmin)` (:42); on load and on refresh, `fetch` `/api/sites/{siteId}/swoop/sessions` for every site in
    parallel with `cache: 'no-store'` and the seq guard (:61-91); drop 403s silently (a member-role site), show
    other failures as one `toast.error` with the problem's `detail ?? title`. One `Card` + `Table`: machine,
    site (name), viewers (one line per viewer: `email || displayName || uid`, with a small `Badge` `control` /
    `watch` from `ctl`), state (`pending` / `live`), started (local time), duration (from `startedAt`, re-rendered
    every second with a 1 s interval, `m:ss` or `h:mm:ss`), actions: a ghost **kill** button. Kill opens a
    confirm `Dialog` (lowercase title "end this session?", body: "the viewer is disconnected at once. this also
    closes every pending second-factor window on <machine>."), then `POST /api/sites/{siteId}/machines/
    {machineId}/swoop/kill` with `{ sid }`; on 2xx `toast.success('session ended', { description: via ===
    'signal' ? 'delivered live' : 'queued for the machine' })` and refetch; on failure `toast.error` with the
    problem `detail`. Refresh `IconButton` with the spinning `RefreshCw`, "loading sessions..." while loading, an
    empty state with `MonitorPlay` at `opacity-50` and "no one is in a swoop session right now". `layout.tsx`:
    `export const metadata = { title: 'admin · swoop' }`. All copy lowercase. Add a short "admin → swoop" section
    to `swoop.mdx` (what the page lists, who sees it, what kill does incl. the step-up windows).
  - Test (jsdom, mocking `fetch`, `@/contexts/AuthContext` and `@/hooks/useSites` the way other admin page tests
    or `MachineContextMenu.test.tsx` mock their contexts): renders two rows from two sites; kill → confirm →
    `fetch` called with the kill URL and `{ sid }` → refetch; a 403 site is dropped without a toast; empty state
    text.
  - Done when: the test passes, eslint and tsc clean, and `/admin/swoop` renders in `npm run dev` for a
    superadmin (the owner's passkey is bound to dev.owlette.app, so the local render is checked by the e2e in
    4.1, not by a browser here).
  - Depends on: 2.2, 2.3.

- [x] **Task 3.2: The badge e2e** `[agent]`
  - Files: `web/e2e/specs/swoop/viewer-badge.spec.ts` (create)
  - Do: Copy `access-control/machine-card.spec.ts`'s shape (`seedMachine`, `cardFor`, `openContextMenu`,
    `roleState('admin')`). Seed one site-A machine with a unique id, then
    `getAdminDb().doc('sites/site-A/machines/<id>').set({ capabilities: { swoop: 1 }, swoopViewers: 2 },
    { merge: true })`. Open the card's menu: `machine-context-menu-swoop-count` reads "2" and
    `machine-context-menu-swoop-pill` is visible on the trigger. Merge `swoopViewers: 0`, reload: neither
    testid exists. Clean up the machine in `afterAll` (the suite shares state).
  - Done when: `firebase emulators:exec … "cd web && npx playwright test e2e/specs/swoop/viewer-badge.spec.ts
    --project=chromium"` passes after `npm run e2e:build`.
  - Depends on: 2.1.

## Wave 4: proof and the PR

- [x] **Task 4.1: The admin page e2e** `[agent]`
  - Files: `web/e2e/specs/admin/swoop.spec.ts` (create), `web/e2e/COVERAGE.md`
  - Do: Copy `admin/tokens.spec.ts`. In `beforeAll` seed a dedicated site and machine (`seedSite`,
    `seedMachine`) and write a live session record through the Admin SDK at
    `sites/{site}/machines/{m}/swoop_sessions/{sid}` with the `SwoopSession` shape (`sessionStore.server.ts
    :56-81`; `sid` matches `/^[A-Za-z0-9_-]{1,64}$/`; `createdBy: 'user:<uid>'`; one viewer `{ viewerId, uid,
    ctl: true, joinedAt: now, leaseExpiresAt: now + 300_000 }`; `startedAt: now`; `state: 'live'`) for a
    dedicated user whose `users` doc carries an email. As superadmin: `/admin/swoop` shows the row with the
    machine id, the email and `control`; click kill, confirm; the toast appears; the Admin SDK shows
    `state: 'ended'`, `endReason: 'killed'`, and a `swoop_kill` command in `…/commands/pending`. As a site
    admin of another site (`roleState('admin')` on site-A): the dedicated site's row is absent. Release what
    was seeded in `afterAll`. Add the page to `COVERAGE.md`'s admin rows.
  - Done when: the spec passes locally with the emulators.
  - Depends on: 3.1.

- [x] **Task 4.2: Verification and the PR** `[agent+human]`
  - Do: `cd web && npm run lint && npm run typecheck && npm test`; the full local e2e (`npm run e2e`);
    `node scripts/check-security-alerts.mjs`; `npx tsx scripts/validate-openapi.ts`. Commit per task on
    `swoop/macos` (`type: details`), push, open one PR to dev with the usual body, and merge on the owner's word.
    Then on dev: open a session on TEC-MBA and check the row badge and the pill appear; open `/admin/swoop` and
    see the session; kill it from there and see the viewer page say "ended from elsewhere".
  - Human: the owner's word on the badge and the page on dev.
  - Done when: merged, and the three dev checks observed.
  - Depends on: 3.2, 4.1.

## Log
### 2026-10-03
- Plan created from three research passes (agent events and writes; dashboard and admin patterns; tests and
  e2e), approved by the owner ("create task files and start on tasks once complete"). Server-side mirror chosen
  over the agent write (decision 1).
- Wave 1 done in parallel (three Opus workers), reviewed and committed: 1.1 `24736621` (the store also recounts in
  `setSwoopSessionState`, since the mint adds the viewer while the session is still pending — without it a
  one-viewer session would read 0 for its whole life; the retention test's query list gained the second
  `state`), 1.2 `f73547ec` (the `MachineDetail` OpenAPI schema still lacks `swoopViewers`: folded into 2.2),
  1.3 `151347d3` (the row badge's `aria-label` on a span was invalid ARIA; replaced with `sr-only` text).
  Also `c46c471e`, outside the plan: the keyboard menu's legend shows only where a key is converted and the
  windows-key note says what to do (owner: "this just confuses me"). The pre-commit gate checks the main
  checkout, which fails on the owner's own branch work; commits go through PowerShell after the worktree's
  own lint/tsc/jest.
- Waves 2–4.1 done the same way: 2.3 `d2e0d439`, 2.1 `fbe2169b`, 2.2 `53096bc3` (the route also documents
  `swoopViewers` on `MachineDetail`), 3.2 `30048de9` (badge e2e, 1 of 1), 3.1 `39ccd4c6` (kill uses button.tsx's
  `ghost-destructive` / `destructive` variants rather than the tokens page's amber literals; `control` /
  `watch` badges; `useSites` lives in `@/hooks/useFirestore`), 4.1 `8b9c51a3` (admin e2e 2 of 2 plus the route
  guards, 34 of 34 in that run). Verification so far: lint 0 errors (5 old warnings in untouched files),
  typecheck clean, jest 6371 passed, security CLEAR, OpenAPI valid; the full local e2e is running.

### 2026-10-04 audit
- Ticked 4.2: #277 merged 2026-10-03 (e299de6b) and shipped in 4.1.1.
