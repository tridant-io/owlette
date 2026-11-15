# Superadmin activity monitoring — Context
**Last updated**: 2026-11-15

Worktree `C:\Users\admin\Documents\Git-restored\Owlette-activity-wt`, branch
`feat/superadmin-activity`, cut from `origin/dev` at `5cfb3cb0` (4.2.2). Never work in the
main checkout: it sits on another branch, hundreds of commits behind dev. The worktree
needs its own `npm ci` in `web/` before jest or e2e (no node_modules junction).

## What exists today (verified against 5cfb3cb0)
Three stores, two row shapes:

1. **Decision rows**, field `timestamp` (Firestore Timestamp). `sites/{siteId}/audit_log/{autoId}`
   and the platform copy `global/audit_log/entries/{autoId}`. Written by
   `web/lib/auditLog.server.ts` and `web/lib/authorizedHandler.server.ts`.
   `{correlationId, actor, capability, target{kind,id,machineId?}, outcome: allow|deny|error,
   metadata?{route, method, ...}, denyReason?, errorCode?, enforcementBypassed?, timestamp}`.
   `actor` is `{type:'user', userId, apiKeyId?, role}`, `{type:'system', name}` or
   `{type:'machine', siteId, machineId}`. An allow row is written for EVERY authorized
   call, reads included.
2. **Change rows**, field `recordedAt` (epoch ms number), hash-chained, doc id = hash.
   Same collection `sites/{siteId}/audit_log`; platform-scoped ones land in
   `sites/_platform/audit_log`. Written by the `recordAuditEvent` cloud function from
   `emitMutation` / `emitApiKeyUsed` (`web/lib/auditLogClient.ts`).
   `{event{kind, siteId, actor: 'user:<uid>'|'apiKey:<id>'|'machine:<id>'|'system:<name>'|'cortex:user_<uid>' (hoot, for that user), occurredAt,
   target?, attributes{verb, endpoint, method, ...}}, recordedAt, previousHash, hash}`.
   `api_key_used` is one row per API-key request: high volume, excluded from the feed.
3. **Sign-in rows** (new, task 1.1) go into store 1's platform copy.

A query ordered by `timestamp` returns only decision rows; ordered by `recordedAt`, only
change rows. Nothing calls `collectionGroup('audit_log')` today.

## Shared shapes (created by task 1.3 in `web/lib/activity/types.ts`)
```ts
export type ActivityKind = 'change' | 'refused' | 'sign_in' | 'flagged';
export type ActivityView = 'all' | 'flagged' | 'changes' | 'refused' | 'sign-ins';

export interface ActivityActor {
  type: 'user' | 'api_key' | 'machine' | 'system' | 'unknown';
  id: string;            // uid, key id, machine id or system name
  label?: string;        // email for a user, filled by the route
}

export interface ActivityRow {
  id: string;            // `${source}:${docId}`, source = change | decision | platform | finding
  kind: ActivityKind;
  at: number;            // epoch ms
  actor: ActivityActor;
  siteId: string | null; // null = platform
  action: string;        // 'user_mutated:promoted', 'MACHINE_REMOVE', 'sign_in', a rule id
  outcome: 'allow' | 'deny' | 'error' | null;
  reason?: string;       // denyReason or errorCode
  target?: { kind?: string; id: string; machineId?: string };
  network?: { key: string; prefix: string | null };
  severity?: 'high' | 'digest';      // flagged only
  details: Record<string, unknown>;  // what the opened row shows
}

export type RuleId =
  | 'superadmin_promoted' | 'mfa_removed' | 'site_deleted' | 'second_factor_burst'
  | 'destructive_burst' | 'new_network_sign_in' | 'refusal_burst'
  | 'ownership_transferred' | 'user_deleted';

export interface Finding {
  id: string;            // deterministic, no '/'
  rule: RuleId;
  severity: 'high' | 'digest';
  title: string;         // lowercase, e.g. 'second factor burst'
  summary: string;       // one sentence
  subject: { userId?: string; actor?: string; siteId?: string | null };
  at: number;            // epoch ms of the newest row behind it
  facts: { label: string; value: string }[];
  rowIds: string[];
}
```

New paths, all server-only (the rules' catch-all denies clients; no rules change):
- `global/audit_log/entries/{id}` gains rows with `capability: 'AUTH_SIGN_IN' | 'AUTH_SECOND_FACTOR'`.
- `global/activity_watch` (state doc): `{scannedThrough: number, lastDigestDay: 'YYYY-MM-DD'}`.
- `global/activity_watch/findings/{findingId}`: a `Finding` plus
  `{detectedAt: number, emailedAt: number | null, digestedAt: number | null}`.

## Decisions
1. **Sign-in rows use plain strings, not the `Capability` union.** `Capability` keys the
   rate-limit and matrix tables (`web/lib/rateLimit.server.ts` `USER_LIMITS`,
   `SYSTEM_LIMITS`); a sign-in is not a capability decision. `authEvents.server.ts` has
   its own small writer into the same collection, so the existing `entries` index and the
   feed pick the rows up.
2. **One sign-in row per Firebase sign-in**, id `signin_<uid>_<auth_time>`, written with
   `create()` and only when `auth_time` is under 10 minutes old. `/api/auth/session` runs
   on every page load; `auth_time` does not change on token refresh.
3. **No `emitMutation` in the auth routes.** They are on `auditMutationCoverage`'s exempt
   list and the stale check fails if they gain a marker.
4. **Reads stay out of the feed.** No "allowed" view in this cut.
5. **The user filter reaches that user's API keys and hoot.** Change rows name a key as
   `apiKey:<id>` and a change hoot made for the user as `cortex:user_<uid>`; the route lists
   `users/{uid}/api_keys` and queries
   `event.actor in ['user:<uid>', 'cortex:user_<uid>', 'apiKey:<id>', ...]` (cap 30 values).
6. **A time cursor, not a doc cursor.** Four sources cannot share a doc id cursor.
   `page_token` = base64url JSON `{t, ids}`; the next page asks each source for rows with
   time `< t + 1` and drops `ids` (every row already sent whose time floors to `t`).
7. **Filters without an index post-filter in memory**, with a scan cap, as the existing
   audit-log route does. A capped source sets a horizon so the merged page never skips.
8. **One cron route does detection and the digest**: one schedule to register per
   environment.
9. **Recipient is `ACTIVITY_EMAIL`, falling back to the admin address**, mirroring
   `ISSUE_EMAIL` in `web/app/api/bug-report/route.ts`. A self-hosted install must not mail
   tridant, so the address is not hardcoded.
10. **Key scope `user=*:read`**, as `/api/users/deletions` and `/api/users/activity` do.
    No new API key resource.
11. **Nav: one item, `activity`, in the `support` group**, superadmin only, beside issues.
12. **All detection queries order descending** with a `>` bound, so the existing
    `(field ASC, time DESC)` composites serve them.
13. **The new-network history reads sign-in rows only.** `global/audit_log/entries` also holds an
    allow row per platform call, so the cron's per-user history query filters
    `capability == AUTH_SIGN_IN` itself (index `actor.userId, capability, timestamp`); a busy
    superadmin's older sign-ins must not fall outside the newest 200 rows. No single-field
    `audit_log` overrides: every collection-group query carries an equality or `in` filter.

## Key files
Create:
- `web/lib/authEvents.server.ts`
- `web/lib/activity/types.ts`, `rows.ts`, `feed.server.ts`, `rules.ts`, `findings.server.ts`, `labels.server.ts`
- `web/app/api/admin/activity/route.ts`
- `web/app/api/cron/activity-watch/route.ts`
- `web/app/admin/activity/page.tsx`, `layout.tsx`
- `web/components/admin/activity/ActivityList.tsx`, `activityDisplay.ts`
- `web/hooks/useActivity.ts`
- `web/e2e/specs/admin/activity.spec.ts`
- jest files beside each (paths in `tasks.md`)

Modify:
- `web/app/api/auth/session/route.ts`, `web/app/api/mfa/verify-login/route.ts`,
  `web/app/api/passkeys/step-up/verify/route.ts`,
  `web/app/api/passkeys/authenticate/verify/route.ts`
- `firestore.indexes.json`
- `web/lib/emailTemplates.server.ts`, `web/app/api/test-email/route.ts`,
  `web/app/admin/email/page.tsx`, `web/e2e/specs/admin/email.spec.ts`
- `web/app/admin/navItems.ts`
- `web/openapi.yaml`, `web/lib/openapiReference.ts`, `web/content/docs/api/pagination.mdx`
- `infra/cron-jobs.json`, `scripts/env-manifest.json`,
  `docs/runbooks/manual-infrastructure.md`, `web/content/docs/setup/web-deployment.mdx`
- `web/e2e/specs/access-control/route-guards.spec.ts`, `web/e2e/COVERAGE.md`
- docs: both changelogs, `web/content/docs/dashboard/index.mdx`,
  `web/content/docs/dashboard/admin/index.mdx`,
  `web/content/docs/reference/firestore-data-model.mdx`, `GLOSSARY.md`, `README.md`,
  `.claude/skills/codebase-map/SKILL.md`

Never touch: `firestore.rules`, `.claude/hooks/`, `.claude/settings.json`,
`web/app/privacy/page.tsx` (draft only, see task 4.2).

Copy from: `web/app/admin/issues/*`, `web/components/admin/issues/IssueList.tsx`,
`web/hooks/useIssues.ts`, `web/app/api/admin/issues/route.ts`,
`web/app/api/users/deletions/route.ts`, `web/app/api/cron/api-key-expiry/route.ts`,
`buildIssueEmail` in `web/lib/emailTemplates.server.ts`, and their tests
(`web/__tests__/api/adminIssues.test.ts`, `web/__tests__/api/cron/api-key-expiry.test.ts`,
`web/e2e/specs/admin/issues.spec.ts`).

## The owner's one sitting (batch these; ask once)
1. Go to commit, then to push the branch and open the PR into dev.
2. Go for `firebase deploy --only firestore:indexes --project dev`, then prod on #420's
   day, each before that environment's web. Wait for every index to read Enabled.
3. `ACTIVITY_EMAIL=hey@tridant.io` on Railway dev, Railway prod and Vercel
   (`node scripts/sync-env.mjs`; a go is needed, it mutates env).
4. Register the job on cron-job.org twice: `GET https://dev.owlette.app/api/cron/activity-watch`
   and `GET https://owlette.app/api/cron/activity-watch`, every 5 minutes, header
   `X-Cron-Secret` with that environment's `CRON_SECRET`. After the route is live there.
5. Approve or change the privacy wording in `privacy-draft.md`.

## Coordination
- owlette-f8 carries release talk and #420. It was unreachable when the owner ruled this
  rides #420; tell it the footprint (web, one index deploy before the web, one new cron,
  one optional env var) as soon as it can be reached.
- Other sessions share the main checkout; say what is about to change before changing it.

## Next steps
1. `npm ci` in the worktree's `web/` (assert the branch first).
2. Run wave 1's four tasks in parallel (`/execute`); spawn executors with `model: sonnet`.
3. Ask the owner for the go to commit after each wave is reviewed.
