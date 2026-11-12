# site billing — Context
**Last updated**: 2026-11-11

## Where things are
- Worktree `C:\Users\admin\Documents\Git-restored\Owlette-site-billing-wt`, branch `feat/site-billing`, rebased on `origin/dev` 3634ad5a. Push only with `git push origin feat/site-billing:feat/site-billing` (a bare push lands on dev).
- tridant id contract: `C:/Users/admin/Documents/Git/tridant-id`, read `origin/staging` (e370a01, 2026-11-03): `internal-docs/api/billing.md`, `internal-docs/site-billing.md`, `internal-docs/api/entitlements.md`, `internal-docs/oidc.md`. Staging API `https://api-staging.tridant.io`, portal and OIDC issuer `https://id-staging.tridant.io`.
- tridant ids: products `prd_owlette_core`, `prd_owlette_pro`; subjects `owlette:{uid}`; sites `owlette:{siteId}`; staging OIDC client `oic_cwGUoks7wJjctlSp` (redirects `https://dev.owlette.app/api/auth/tridant/callback`, `http://localhost:3000/api/auth/tridant/callback`).
- Release: rides 4.2.0; release talk goes through the owlette-f8 session.

## Key Files

### Create
- `web/lib/tridantBilling.server.ts`, `web/lib/tridantBillingE2e.server.ts` — tridant billing client and its e2e fake
- `web/lib/planAccounts.server.ts` — `plan_accounts/{uid}`, `billing_checkouts/{sessionId}`
- `web/lib/planTrial.server.ts` — `ensureTrial`, `registerOwnedSites`, `registerSite`, `reconcileSiteRegistration`
- `web/lib/siteBilling.server.ts` — upgrade, add, switch, stop, confirm; the `sites/{id}.billing` pointer
- `web/lib/planResponse.ts` — the account plan wire type
- `web/lib/tridantOidc.server.ts`, `web/app/api/auth/tridant/link/route.ts`, `web/app/api/auth/tridant/callback/route.ts` — link an existing tridant account
- `web/app/api/sites/[siteId]/billing/route.ts`, `web/app/api/sites/[siteId]/plan/route.ts`, `web/app/api/billing/checkout/[sessionId]/route.ts`, `web/app/api/cron/plan-trials/route.ts`
- `web/components/admin/sites/SiteBillingSection.tsx`, `web/components/plan/UpgradeSiteDialog.tsx`, `web/hooks/useSiteBilling.ts`
- `web/e2e/specs/plans/billing.spec.ts`
- `docs/adr/0018-a-site-has-a-plan-and-its-owner-pays.md` (written 2026-11-11)

### Modify
- Plan core: `web/lib/plan.server.ts`, `web/lib/tridantEntitlements.server.ts`, `web/lib/tridant.server.ts`, `web/lib/planUsage.server.ts`, `web/lib/planPause.server.ts`, `web/lib/pairingPlan.server.ts`, `web/lib/authorizedHandler.server.ts`, `web/app/api/_shared.ts`
- Capability: `web/lib/capabilities.ts`, `web/lib/rateLimit.server.ts`
- Lifecycle: `web/lib/actions/{createSite,transferSiteOwnership,deleteSite}.server.ts`, `web/lib/userDeleteCascade.server.ts`
- Routes: `web/app/api/account/plan/route.ts`, `web/app/api/cron/plan-daily/route.ts`, `web/app/api/agent/auth/device-code/authorize/route.ts`, key routes (`api/keys`, `api/keys/[keyId]/rotate`, `api/account/api-keys`, `api/cli/device-code/authorize`)
- Functions: `functions/src/lib/planSnapshot.ts`
- Client: `web/hooks/{usePlan,useSitePlan}.ts`, `web/components/plan/{UpgradeGate,TrialBanner}.tsx`, `web/app/settings/plan/page.tsx`, `web/lib/siteSettingsPath.ts`, `web/components/admin/sites/SiteSettings.tsx`, the gate callers (Task 4.1)
- Docs and config: `web/content/docs/{plans,api/errors,reference/firestore-data-model}.mdx`, `docs/runbooks/plans-and-billing.md`, `web/lib/product-facts.ts`, landing pricing and FAQ, both changelogs, `scripts/env-manifest.json`, `infra/cron-jobs.json`, `web/openapi.yaml`, `web/scripts/validate-openapi.ts`, `GLOSSARY.md`

## Decisions
1. **Per-site entitlement read.** tridant bills per site, and an organization-level read merges every licence (one pro site would make all of an owner's sites pro).
2. **The payer is the site owner; only the owner changes billing** (owner). tridant supports a payer who isn't the owner; owlette doesn't expose it.
3. **Free is per account, counted by owlette.** tridant's `owlette.sites`/`owlette.machines` in a free answer are the limits (1 and 1); owlette counts the account's free owned sites and the machines across them.
4. **Core has no site cap** (owner).
5. **The trial starts lazily on the first plan read with a verified email,** only while enforcement is on. An unverified account is on free and is told to verify. Existing accounts are started through a cron-secret route, dry run by default.
6. **Sites are registered with tridant after the trial starts and at creation,** because the trial covers only sites registered under the organization. Needs `site.write`.
7. **Ownership transfer stops billing at the period end** (owner). Delete stops billing first. Account deletion unlinks the subject. The daily job moves a transferred site to its new owner's organization once it is idle.
8. **The API-key mint gate goes** (owner); `requireApiKeyPlan` checks the site on every request.
9. **One key, existing env name** `TRIDANT_LICENSE_KEY`: bound to owlette, scopes `license.read`, `site.write`, `billing.write:prd_owlette_core` (owner). It expires after 400 days; the client logs tridant's `Sunset` header at error.
10. **Billing actions live in site settings → billing** (owner-only, like the danger zone). Checkout returns there with `session_id`; the section confirms server side. `/settings/plan` is the account overview. owlette never holds a Stripe key.
11. **Usage runs at 23:30 UTC**, stamps a machine on the UTC day of its heartbeat, reports since `billing.current_period_start` with `as_of = now`, pro floored at 3. No grace exists after the 1st.
12. **Fail open** when tridant is unreachable, rejects the key or answers something unreadable; `resolved:false` is free when enforced.
13. **Link flow in 4.2.0** through tridant's OIDC client for owlette; the ID token (fresh within 10 minutes) is the consent. The ID token is not verified locally: it is only used to choose the organization, and tridant verifies it. The callback route is the one a later "continue with tridant" sign-in will use.
14. **`SITE_BILLING_MANAGE` is bypass-exempt**: with `capability_enforcement` off, a member must not put sites on the owner's card.
15. **hoot mcp needs nothing**: `web/lib/fleet/handler.server.ts` already calls `requireEntitlement(siteId, 'owlette.hoot')` and answers 402, which the agent retries without touching its tokens.

## Owner steps (one sitting, Task 7.1)
1. The staging api key (bound to owlette, three scopes).
2. The OIDC client secret from Davor.
3. `cron-plan-daily` for dev on cron-job.org at 23:30 UTC.
4. The go for `PLAN_ENFORCEMENT=on` on dev, after the bulk trial dry run.

## Next Steps
1. Wave 1: four parallel tasks.
2. Commit each wave after reviewing its diff and running the touched suites.
