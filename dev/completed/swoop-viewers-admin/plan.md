# swoop viewer count and admin sessions page — Plan
**Created**: 2026-10-03 | **Status**: Active

Branch `swoop/macos` in the worktree `C:\Users\admin\Documents\Git-restored\Owlette-swoop-mac-wt`. Never the main
checkout. Owner's ask (2026-10-03): "for the swoop menu item (3 dot menu) can we add a number badge on it that
shows how many users are connected, if connections > 0? … maybe admin panel should have a swoop page, and this is
where swoop connections can be listed and killed?" Approved as this plan after the research below.

## Summary

Mirror the live swoop viewer count onto each machine record from the session store, show it as a badge on the
machine menu's swoop row and as a pill on the menu button, and give admins a `/admin/swoop` page that lists every
live session across their sites with a kill per session. No agent change, no rules change.

## Research findings that shaped it

- Nothing writes a viewer count anywhere today. The agent's `SwoopManager` keeps `_viewers` in memory
  (`agent/src/swoop_manager.py:148,575-583`) and the tray reads it from `service_status.json`; the web has
  nothing.
- Sessions live at `sites/{siteId}/machines/{machineId}/swoop_sessions/{sid}` and are server-only (no rule,
  catch-all deny), so the dashboard cannot read them. Every write goes through
  `web/lib/swoop/sessionStore.server.ts` (`writeSession` :140-151). Shape: `SwoopSession { sid, siteId,
  machineId, state: 'pending'|'live'|'ended', createdBy, startedAt (ms), viewers: [{ viewerId, uid, ctl,
  joinedAt, leaseExpiresAt }], endReason?, endedAt?, … }` (:29-81). Private `leaseLapsed(session, nowMs)`
  (:288-294) with `SWOOP_LEASE_SECONDS = 300`, `SWOOP_LEASE_GRACE_SECONDS = 30`.
- Mutators every writer uses: `upsertSwoopViewer` (:378), `removeSwoopViewer` (:395), `endSwoopSession` (:427).
  Callers: sessions POST/DELETE, the agent's event mirror (`web/app/api/agent/swoop/events/route.ts:203-231`),
  the kill route, `revokeViewerSessions.server.ts`, the retention cron.
- The only collection-group query on `swoop_sessions` is `listUnendedSwoopSessionsForUser` (:240-259):
  `collectionGroup('swoop_sessions').where('siteId','==',…).where('state','in',['pending','live'])`, covered by
  the composite index at `firestore.indexes.json:289-296`. A site-wide list reuses it; no new index.
- `useMachines` (`web/hooks/useFirestore.ts:1069`) whitelists fields when it rebuilds a machine
  (:1382-1406, e.g. `capabilities: data.capabilities` at :1394); unknown fields are dropped. `Machine` type at
  :254, `capabilities` at :277-280. Agent writes are merge/dotted (`agent/src/firebase_client.py:736,1044,
  1066,1561`), so a server-written top-level field survives heartbeats. Precedent for a server-written machine
  field: `cortexEnabled` (`web/lib/actions/setHootEnabled.server.ts:39`, `machineRef.update`).
- `MachineContextMenu` (`web/components/MachineContextMenu.tsx`): props :27-60, `swoopCapable` :56, the swoop
  row :327-338 inside `{isOnline && …}` (:320), testid `machine-context-menu-swoop`, menu `w-48` (:219), the
  trigger `machine-context-menu-trigger` (:205-211). The card has no swoop icon; the display button carries the
  overlay-dot pattern (`MachineCardView.tsx:272-311`). Views pass `swoopCapable={machine.capabilities?.swoop
  === 1}` at `MachineCardView.tsx:391` and `MachineListView.tsx:731`.
- Admin panel: `web/app/admin/navItems.ts` (`NAV_ITEMS` :33-97, lowercase names, `minRole`),
  `requiredRoleForPath` fails closed to superadmin (:120-125). Pinned by
  `web/__tests__/components/RequireAdminAccess.test.tsx:143-197` and
  `web/e2e/specs/access-control/route-guards.spec.ts:13-27`. Model page `web/app/admin/tokens/page.tsx`
  (fetch with `cache: 'no-store'` and a seq guard :61-91, site `<Select>` from `useSites` :42,313-324, refresh
  IconButton :325-333, loading :427, empty :429-434, Card+Table :425-516, confirm Dialog :524-549, toasts
  :147-156). Per-page `layout.tsx` sets the title (`tokens/layout.tsx:8-10`).
- Auth wrappers: `authorizedSiteHandler` (single site, capability, audit; `web/lib/authorizedHandler.server.ts
  :450`) is what the kill route uses (`kill/route.ts:179-185`, capability `MACHINE_REMOTE_CONTROL`, API keys
  refused by `apiKeyRefusal` in `swoop/_shared.ts:105-113`). `authorizedPlatformHandler` is superadmin-only.
  Names for uids: the members route pattern, one `db.getAll(users/…)`, `email || displayName`
  (`web/app/api/sites/[siteId]/members/route.ts:116-138`).
- Kill route: `POST /api/sites/{siteId}/machines/{machineId}/swoop/kill`, body `{ sid? }`, revokes every
  step-up window on the machine (:113-124), ends records with `endReason: 'killed'`, answers
  `{ ok, data: { machineId, sid?, via: 'signal'|'command', commandId? } }`; in the emulator `via` is
  `command` and a `swoop_kill` lands in `…/commands/pending`.
- OpenAPI is hand-written `web/openapi.yaml` (swoop ops :5964-6365); `scripts/validate-openapi.ts` needs
  operation-level `security`; `openapi-validate.yml` runs on route changes.
- Tests to copy: `web/__tests__/components/MachineContextMenu.test.tsx` (jsdom, props at :55-73),
  `web/__tests__/api/swoop/settings-and-kill.test.ts` (route handler mocks :26-97, `stageSession` :157-168),
  `web/__tests__/hooks/useMachines.capabilities.test.ts`, `web/__tests__/lib/swoop/sessionStore.server.test.ts`,
  `web/e2e/specs/access-control/machine-card.spec.ts` (`openContextMenu` :70-75),
  `web/e2e/specs/admin/tokens.spec.ts` (superadmin list + destructive action), `web/e2e/helpers/seed.ts`
  (`seedMachine` writes without merge; add fields with `getAdminDb().doc(...).set({...}, { merge: true })`).

## Approach

- **Data flow.** `sessionStore.server.ts` gains `syncMachineSwoopViewers(siteId, machineId)`: sums
  `viewers.length` over the machine's unended, un-lapsed sessions (state `live` only for the count) and writes
  `swoopViewers: n` on `sites/{siteId}/machines/{machineId}` with `update()` (never creates a doc). Called
  best-effort (try/catch, logged) from `upsertSwoopViewer`, `removeSwoopViewer` and `endSwoopSession`, so every
  writer keeps it current. It also gains `listLiveSwoopSessionsForSite({ siteId })` for the admin route.
- **Dashboard.** `swoopViewers?: number` on `Machine`, mapped in `useMachines`; `MachineContextMenu` gets a
  `swoopViewers` prop: a count badge on the swoop row and a count pill on the trigger when `> 0`. Both views
  pass it.
- **Admin page.** `GET /api/sites/{siteId}/swoop/sessions` under `authorizedSiteHandler` with
  `MACHINE_REMOTE_CONTROL` and `apiKeyRefusal`, viewer names from one `getAll` on `users`. The page fetches it
  for every site the user administers (superadmin: all), drops 403s, shows one table, kills with the existing
  route + `{ sid }`. Nav item `minRole: 'admin'`.

## Decisions

1. **Server-side mirror, not the agent.** Works for every agent in the field today (incl. 4.1.0), same source as
   the admin page so the two never disagree, self-heals through the retention cron. Trade-off: a tab that minted
   but never connected counts until the agent's `viewer_left` or the lease lapse (≤ 5½ min).
2. **Flat field `swoopViewers`** (like `cortexEnabled`), written with `update()`.
3. **Count live sessions only**; the admin page lists pending and live with a state column.
4. **Per-site route** under the existing wrapper, not a new cross-site auth path.
5. **The kill confirm says it also closes every step-up window on the machine**, because the route does.
6. No kill button on the dashboard (owner). No agent change. `firestore.rules` untouched.

## Waves

See tasks.md. Wave 1: store mirror + site lister; machine field on the web; menu badge and pill. Wave 2: views
pass the count; the site sessions route + OpenAPI; admin nav and guards. Wave 3: the admin page; the badge e2e.
Wave 4: the admin page e2e; verification and the PR.

## Risks

- Two viewer changes in the same instant can race the recomputed sum; each write is a full recount, so the next
  change heals it. Low impact for a badge.
- One request per site on the admin page; fine at today's fleet sizes; a cross-site route can come later.
- `machineRef.update()` on a machine record that is gone throws; swallowed and logged.
- The `e2e.yml` `checks` job runs `npm run lint`, `typecheck` and `npm test -- --ci`; the nav-list tests are
  pinned with `toEqual`, so 2.3 must update them in the same change.

## Success criteria

- Open swoop on a machine: within a second its menu row shows "1" and the three-dot button its pill; close the
  tab: both gone within the agent's `viewer_left` (seconds) or the lease lapse.
- `/admin/swoop` lists live sessions with names, state and a ticking duration; kill ends one and the viewer's
  page says "this session was ended from elsewhere".
- Members do not see the page; site admins see their sites; superadmins see all.
- jest, the two new e2e specs, the OpenAPI check and the security check pass; no agent change;
  `firestore.rules` untouched; docs updated in the same change (`swoop.mdx`, `firestore-data-model.mdx`).
