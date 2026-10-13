# site billing — Context
**Last updated**: 2026-10-13

## Key Files

### Create
- `web/lib/tridantBilling.server.ts`, `web/lib/tridantBillingE2e.server.ts` — tridant billing client and its e2e fake
- `web/lib/planAccounts.server.ts` — `plan_accounts/{uid}`, `billing_checkouts/{sessionId}`
- `web/lib/planTrial.server.ts` — `ensureTrial`, `registerOwnedSites`, `registerSite`
- `web/lib/siteBilling.server.ts` — upgrade, add, switch, stop, confirm; the `sites/{id}.billing` pointer
- `web/app/api/sites/[siteId]/billing/route.ts`, `web/app/api/sites/[siteId]/plan/route.ts`, `web/app/api/billing/checkout/[sessionId]/route.ts`, `web/app/api/cron/plan-trials/route.ts`
- `web/app/settings/plan/return/page.tsx`, `web/components/plan/UpgradeSiteDialog.tsx`, `web/hooks/useSiteBilling.ts`
- `web/e2e/specs/plans/billing.spec.ts`

### Modify
- Plan core: `web/lib/plan.server.ts`, `web/lib/tridantEntitlements.server.ts`, `web/lib/planUsage.server.ts`, `web/lib/planPause.server.ts`, `web/lib/pairingPlan.server.ts`, `web/lib/authorizedHandler.server.ts`, `web/app/api/_shared.ts`
- Capability: `web/lib/capabilities.ts`, `web/lib/rateLimit.server.ts`
- Lifecycle: `web/lib/actions/{createSite,transferSiteOwnership,deleteSite}.server.ts`, `web/lib/userDeleteCascade.server.ts`
- Routes: `web/app/api/account/plan/route.ts`, `web/app/api/cron/plan-daily/route.ts`, `web/app/api/agent/auth/device-code/authorize/route.ts`, key routes (`api/keys`, `api/keys/[keyId]/rotate`, `api/account/api-keys`, `api/cli/device-code/authorize`)
- Functions: `functions/src/lib/planSnapshot.ts`
- Client: `web/hooks/{usePlan,useSitePlan}.ts`, `web/components/plan/{UpgradeGate,TrialBanner}.tsx`, `web/app/settings/plan/page.tsx`, `web/components/ManageSitesDialog.tsx`, the gate callers listed in Task 4.1
- Docs: `web/content/docs/{plans,api/errors,reference/firestore-data-model}.mdx`, `docs/runbooks/plans-and-billing.md`, `web/lib/product-facts.ts`, landing pricing and FAQ, both changelogs, `scripts/env-manifest.json`, `web/openapi.yaml`, `web/scripts/validate-openapi.ts`

## Decisions
1. **Per-site entitlement read.** `GET /v1/sites/owlette:{siteId}/entitlements?app=owlette`. tridant bills per site, and an org-level read merges every licence (one Pro site would make all of an owner's sites Pro).
2. **The payer is the site owner; only the owner changes billing** (owner, 2026-10-13). tridant supports a payer who isn't the owner; Owlette doesn't expose it.
3. **Free is per account, counted by Owlette.** tridant's `owlette.sites`/`owlette.machines` are per-site values with no account meaning; Owlette counts free owned sites (≤1) and machines across them (≤1).
4. **Core has no site cap** (owner). Every Core site is billed on its own.
5. **Trial starts lazily on the first plan read with a verified email,** only while enforcement is on. No server signal exists for verification; this covers Google and password accounts with one code path. Bulk start for existing accounts through a cron-secret route (dry run by default), not a script, so the logic exists once.
6. **Sites are registered with tridant after the trial starts and at creation,** because the trial only covers sites registered under the org. Registration needs `site.write`.
7. **Ownership transfer stops billing at the period end** (owner). Delete stops billing first. Account deletion unlinks the subject.
8. **The API-key mint gate goes** (owner); `requireApiKeyPlan` checks the site on every request.
9. **One key, existing env name** `TRIDANT_LICENSE_KEY`, scopes `license.read`, `site.write`, `billing.write:prd_owlette_core` (owner).
10. **Checkout returns to `/settings/plan/return`;** the return page confirms server side with the session id. Owlette never holds a Stripe key.
11. **Usage reports since `billing.current_period_start`**, Pro floored at 3, last report wins. Days stamped per site.
12. **Fail open** on tridant being unreachable or malformed; `resolved:false` is Free when enforced.

## Next Steps
1. Run Wave 1 (four parallel tasks) in the worktree.
2. Owner: create the staging key (Task 7.1) any time before Wave 7.
3. Watch tridant-id#75/#76 for Davor's answers: billing anchored to the 1st, the site-move ask, link consent by OIDC token (ask 5).
