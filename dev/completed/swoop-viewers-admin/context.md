# swoop viewer count and admin sessions page — Context
**Last updated**: 2026-10-03

## Key Files

Create:
- `web/app/api/sites/[siteId]/swoop/sessions/route.ts` — the per-site live-session list
- `web/app/admin/swoop/page.tsx`, `web/app/admin/swoop/layout.tsx` — the admin page
- `web/__tests__/hooks/useMachines.swoopViewers.test.ts`, `web/__tests__/api/swoop/site-sessions.test.ts`,
  `web/__tests__/app/admin-swoop-page.test.tsx`
- `web/e2e/specs/swoop/viewer-badge.spec.ts`, `web/e2e/specs/admin/swoop.spec.ts`

Modify:
- `web/lib/swoop/sessionStore.server.ts` — `syncMachineSwoopViewers`, `listLiveSwoopSessionsForSite`, calls
  from `upsertSwoopViewer` / `removeSwoopViewer` / `endSwoopSession`
- `web/hooks/useFirestore.ts` — `Machine.swoopViewers`, the `useMachines` mapping
- `web/components/MachineContextMenu.tsx` — `swoopViewers` prop, row badge, trigger pill
- `web/app/dashboard/components/MachineCardView.tsx`, `MachineListView.tsx` — pass the prop
- `web/app/api/sites/[siteId]/machines/[machineId]/route.ts` — expose the field
- `web/app/admin/navItems.ts` — the nav item
- `web/openapi.yaml` — the new operation
- Tests: `web/__tests__/lib/swoop/sessionStore.server.test.ts`, `web/__tests__/components/MachineContextMenu*.test.tsx`,
  `web/__tests__/components/RequireAdminAccess.test.tsx`, `web/e2e/specs/access-control/route-guards.spec.ts`,
  `web/e2e/COVERAGE.md`
- Docs: `web/content/docs/dashboard/swoop.mdx`, `web/content/docs/reference/firestore-data-model.mdx`

Untouched by design: everything under `agent/`, `firestore.rules`, `firestore.indexes.json`.

## Decisions

1. The count is mirrored by the server from the session records (`swoopViewers` on the machine doc), not
   written by the agent: no agent release needed, one source for badge and page, self-healing through the
   retention cron. A minted-but-never-connected tab counts until `viewer_left` or the lease lapse (≤ 5½ min).
2. Flat field name `swoopViewers`, written with `update()` so a vanished machine never gets a ghost doc.
3. The badge counts `live` sessions only; the admin page lists `pending` and `live` with a state column.
4. The list route is per site under `authorizedSiteHandler` with `MACHINE_REMOTE_CONTROL` (kill's capability),
   API keys refused like every swoop route; the page fans out over the user's sites and drops 403s.
5. The kill confirm names the side effect: every pending step-up window on the machine is closed too.
6. No kill button on the dashboard; the admin page is where it lives.
7. The nav item is `minRole: 'admin'`: site admins see their sites, superadmins all.

## Next Steps

Wave 1's three tasks touch disjoint files and run in parallel: 1.1 (store), 1.2 (hook + API + doc), 1.3 (menu).
Then 2.1–2.3, then 3.1 + 3.2, then 4.1 and the PR. Each task: lint the touched files, run its tests, and leave
a dated line in `tasks.md`'s Log. Commits per task on `swoop/macos`; `git add -f` for anything under
`dev/active`.
