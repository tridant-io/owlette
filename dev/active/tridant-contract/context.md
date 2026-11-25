# tridant contract adoption — Context
**Last updated**: 2026-11-20

Worktree: `C:\Users\admin\Documents\Git-restored\Owlette-tridant-contract-wt`, branch
`feat/tridant-contract` (local only, nothing pushed). Every task runs there, from `web/` for npm
commands. Web only: no `agent/src` file is touched, so the deploy-agent hook never fires.

## The contract (tridant id staging `efe770d`, v1.1.1; prod runs the same routes)

All calls go through `tridantFetch` (`web/lib/tridant.server.ts`) with `TRIDANT_LICENSE_KEY`
(scopes `license.read`, `site.write`, `billing.write:prd_owlette_*`), except installer releases,
which use `TRIDANT_RELEASE_KEY` (`release.write:prd_owlette_*`). Refs: payer `owlette:{uid}`
(`subjectFor`), site `owlette:{siteId}` (`siteRef`).

**A6 — payer on PATCH and DELETE `/v1/billing/sites/:ref`.** `PATCH` body takes
`payer: { subject }`; `DELETE` takes `?payer_subject=owlette:{uid}` (URL-encode it). Optional.
When sent, the site's open billing must belong to the organization that subject maps to, else
`409 payer_mismatch` and nothing changes. An **unmapped** subject (an unlinked or deleted account)
also answers `payer_mismatch`.

**A7 — re-add applies the tier.** `POST /v1/billing/sites` for a site whose removal is pending
cancels the removal **and applies the `product` and `founders` named** (`200`, `already: false`).
Owlette's follow-up `PATCH` after an add is redundant. Deployed on staging and prod.

**A8 — the site answer** (`GET /v1/sites/:ref/entitlements?app=owlette`):
`billing: { current_period_start, current_period_end, cancel_at_period_end, ends_at, product_id,
founders }` for a site billed per site. While `standing === 'trialing'` the top level also carries
`trial_ends_at` (epoch ms, the latest end among running trial licences; `null` possible).

**A11 — `DELETE /v1/sites/:ref`** (scope `site.write`). `200 { ok, removed: true, site }`;
`409 site_running` (`license_id`) while a licence runs or a billing item is still open (it closes
when its period's invoice is written, so a stopped billed site is removable only after its period
ends); `409 site_is_default` (never for an Owlette site: app-pushed sites are inserted with
`is_default=0`); `404 site_not_found` (already gone: treat as done).

**A4 — `GET /v1/key`**, no scope, writes nothing. `200 { id, name, app, scopes: string[],
expires_at: number|null, expires_in_days: number|null, sunset: string|null }`. Scope matching as
tridant grants it: `billing.write:<product>` and `release.write:<product>` cover the product's whole
group, so any `billing.write:prd_owlette_*` counts for billing; a legacy `*` grants
`license.read`, `license.validate`, `site.write` and never a product-bound scope.

**A9 — `POST /v1/billing/trial/preview`**, same body as `POST /v1/billing/trial`, no writes.
`200 { subject, payer: 'linked'|'would_create'|'link_required', trial:
'would_start'|'already'|'already_subscribed'|'used'|null, org_id: string|null }`.

**A17 — `409 trial_already_used`** from `POST /v1/billing/trial`: the subject had a trial on an
organization since closed. No trial, ever, for that subject. Handle like `already_subscribed`.

**A14 — `POST /v1/sites/entitlements?app=owlette`** (scope `license.read`), body
`{ sites: [ref, …] }`, 1–100 refs (else `400 sites_required`). `200 { results: [...], max: 100 }`,
one entry per ref **in request order**, each exactly the single read's answer plus `subject: ref`;
an unmapped ref answers `resolved: false`. Send `?app=owlette` as the single read does: the gate
narrows by `?app`, else by the key's bound app.

**A2 — the settle window.** A period's renewal invoice is held as a draft for
`site_settle_hours` (24 h, confirmed on prod) after the period end. A `POST /v1/usage` entry whose
`as_of` lies in the just-closed period answers `status: 'recorded'`, `recorded: true`,
`settling: true`, `settles_at: <ms>` and lands on the invoice. After `settles_at` it answers
`period_closed`. Per entry `as_of` is epoch ms or ISO; at most 5 minutes ahead of tridant's clock.
The newest `as_of` per site and period is the one billed; the same `as_of` twice is safe.
Every `recorded` answer also carries `period_start` and `period_end`.

**A5 —** tridant applies `min_seats` (Pro 3) on any line with usage. Owlette keeps its own Pro
floor because it also bills a Pro site with 0 machines (ADR 0018).

## Key files

**Modify (web/):**
- `lib/tridant.server.ts` — key check, optional timeout
- `lib/tridantBilling.server.ts`, `lib/tridantBillingE2e.server.ts` — client and its e2e fake
- `lib/tridantEntitlements.server.ts` — answer parse, e2e seed mapping, batch read
- `lib/plan.server.ts` — `Plan` carries the new fields
- `lib/siteBilling.server.ts`, `lib/actions/transferSiteOwnership.server.ts`
- `lib/planTrial.server.ts`, `lib/planAccounts.server.ts`, `lib/planResponse.ts`
- `app/api/cron/plan-trials/route.ts`, `app/api/account/plan/route.ts`, `app/settings/plan/page.tsx`
- `lib/actions/deleteSite.server.ts`, `lib/actions/deleteOwnAccount.server.ts`
- `lib/planUsage.server.ts`
- `e2e/helpers/plans.ts`, `e2e/specs/plans/*.spec.ts`, `e2e/COVERAGE.md`
- `../infra/cron-jobs.json`, docs (task 5.1), both changelogs (task 6.1)

**Create (web/):**
- `lib/tridantSiteRemoval.server.ts` — remove a deleted site from tridant, with a retry record
- `lib/planSettle.server.ts`, `app/api/cron/plan-settle/route.ts` — the month-end settle pass

**Shared test fixtures:** `__tests__/api/helpers/planEnforcement.ts` (`Entitlements` fixtures).
Only task 1.2 edits it; later tasks read it and build any extra fixture locally in their own test.

**Jest mocks with explicit factories** (a function the code under test now calls must be added to
the factory, or the test sees `undefined`). Owners per wave are named in each task.
- `@/lib/tridantBilling.server`: account/plan, auth-tridant-link, billing-checkout-confirm,
  sites-billing, transferSiteOwnership, UserRole…deleteSite, planTrial.server, planUsage.server,
  siteBilling.stranded, userDeleteCascade.
- `@/lib/planAccounts.server`: account/plan, auth-tridant-link, billing-checkout-confirm,
  sites-billing, planTrial.server, planUsage.server, siteBilling.stranded.
- `@/lib/siteBilling.server`: deleteOwnAccount, planUsage.server.
- `@/lib/planTrial.server`: account/plan, auth-tridant-link, cron/plan-trials, transferSiteOwnership,
  UserRole…deleteSite, planUsage.server.
- `@/lib/tridantEntitlements.server`: 27 files; only a task that adds a function some code under
  test calls must touch them (task 2.4's batch read is called only from planUsage).

## Decisions

1. **The payer goes only where Owlette knows who pays.** Switch (the owner, who must be the
   recorded payer), an owner's stop when the record names that owner, the transfer's stop (the
   recorded payer), and the daily stranded-billing repair (the recorded payer). Never on a stop
   before delete, and not on an owner's stop of a previous owner's billing: those must land.
2. **Stranded billing on `payer_mismatch`:** re-read the site answer uncached. Its organization
   is the owner's recorded `orgId` → adopt (pointer to the owner). Otherwise (another
   organization, or the owner has no `orgId`) → stop without a payer and log a warning. An owner
   with no organization cannot be the payer, and a stop is reversible until the period ends.
3. **A8:** with plans enforced and the site billed, the tier, founders flag and end shown come
   from tridant's answer (`productId` → tier). The pointer stays as the fallback when plans are off
   or tridant is unreachable, and keeps `payerUid`, which tridant does not answer.
4. **Pro floor** stays in Owlette, keyed on `billing.productId === PRODUCT.pro` instead of
   `owlette.deployments`, which a trialing-then-core site reads as pro.
5. **Trial end** is refreshed from `trial_ends_at` only from a site whose `orgId` equals the
   account's stored `orgId` (a transferred site can still sit under the old owner's organization).
6. **Site removal (A11):** only when `tridantConfigured()`. Remove at once; `404` is done. On
   `site_running` or no answer, write the server-only `tridant_site_removals/{siteId}` record; the
   daily job retries it, re-stops a billing that still runs with no end, and drops the record after
   45 days with an error log. No `firestore.rules` change (the catch-all deny covers it).
7. **Batch read (A14)** in the daily job only: one call per page of 100 sites primes the 60 s
   entitlement cache; a failed call primes nothing, and each site falls back to its single read.
8. **Settle pass (A2):** `/api/cron/plan-settle`, daily 06:00 UTC. For every site whose saved
   report's period ended in the last 24 h and is not yet settled: stamp its machines, recount to
   the period's last millisecond, resend with `as_of = periodEnd - 1`. Covers a failed 23:30 run,
   an unrecorded report, and machines last seen between 23:30 and midnight. A machine still online
   at 06:00 is filed under the new day by its heartbeat, so it is not counted in the closed month
   (it already was, by the 23:30 run).
9. **Key check (A4)** in the bulk trial dry run (gates `apply` on the license key only; the
   release key is reported, never blocks) and once per daily run (in its summary). Never in
   `/api/health`, status-ping or cron/health-check.
10. **Trial already used (A17)** ends the retry loop like `already_subscribed` and shows its own
    line on the plan page.

## Next Steps

Wave 1: tasks 1.1 and 1.2 in parallel. Before wave 1, `git diff fc38f327..HEAD --stat --
web/package-lock.json` must be empty (node_modules was installed at fc38f327); it was.
