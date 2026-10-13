# site billing — Plan
**Created**: 2026-10-13 | **Status**: Active (owner approved 2026-10-13)

## Summary
Owlette's plan gating (#317, merged 2026-10-13 as 9c929f97) assumes "the site owner pays" and reads tridant id once per owner. tridant id now bills **per site** (tridant-id#75/#76, on staging since 2026-10-13): each site names the org that pays for it, one invoice per org per period, one line per site (active machines × tier price). This plan reworks the gating onto per-site entitlements and builds the purchase flow (trial, upgrade, add a site, switch tier, stop), proven end to end on dev.owlette.app against tridant staging. Everything stays behind `PLAN_ENFORCEMENT`, so nothing changes for anyone until the switch is on.

## Approach

### Data flow
- **Entitlements per site.** `GET /v1/sites/owlette:{siteId}/entitlements?app=owlette` (scope `license.read`), 60 s cache per site, cleared on Owlette's own billing changes. The answer carries `resolved`, `standing`, `in_good_standing`, `ent` (flags are JSON booleans, limits numbers or `'unlimited'`, `storage_bytes` null) and, for a billed site, `billing.{current_period_start,current_period_end,cancel_at_period_end,ends_at}`. An unknown site answers `resolved:false, note:'no_mapping_for_site'` with the defaults, which are owlette free.
- **The payer is the site owner.** Only the site owner may change a site's billing (owner decision). Checkout and trial use the subject `owlette:{ownerUid}`; sites are `owlette:{siteId}`. A server-only `sites/{id}.billing` pointer (`{tier, founders, payerUid, endsAt, updatedAt}`) mirrors what tridant bills, for the UI and the usage report. tridant stays the source of truth for entitlement.
- **Free is counted by Owlette, per account.** A site is *paid* when its answer is in good standing (trialing, active, or past_due inside grace); otherwise it is *free*. An account may own at most 1 free site, and its free sites may hold at most 1 machine in total. Paid and trialing sites are unlimited. Checked where they are today: pairing (device-code authorize, poll, exchange), site creation, ownership transfer.
- **Trial.** tridant owns it: `POST /v1/billing/trial {payer:{subject,email}, product:'prd_owlette_pro', days:14}`, one per org ever, covering every site *registered under the org*. Owlette starts it on the server the first time a signed-in user with a **verified** email reads their plan (there is no server signal when an email becomes verified; Google accounts are verified at sign-up, so they start on their first visit). Only while `plansEnforced()`. State in a new server-only `plan_accounts/{uid}`. After the trial starts, the owner's sites are registered with `POST /v1/sites` (scope `site.write`) so the trial reaches them; new sites are registered at creation. `409 link_required` (the email already has a tridant org) marks the account and waits for the link flow (wave 8).
- **Purchase.** A new owner-only capability `SITE_BILLING_MANAGE`.
  - `POST /api/sites/{id}/billing {tier, founders}`: tridant `POST /v1/billing/checkout` → Stripe Checkout URL; on `409 subscription_exists` it adds the site to the running subscription instead (`POST /v1/billing/sites`, card on file, no checkout).
  - Stripe returns to `/settings/plan/return?session_id=…`; `GET /api/billing/checkout/{sessionId}` confirms with tridant (`GET /v1/billing/checkout/:id`) and writes the pointer.
  - `PATCH` switches Core↔Pro, `DELETE` stops billing at the period end (tridant keeps it running and bills that period).
  - Founders while `founders_remaining > 0` (public `GET /v1/products`); `409 founders_sold_out` retries at list price.
- **Usage.** The daily cron stamps active machines per site (`billing_usage/{siteId}/days/{day}`), then for each billed site counts distinct machines since `billing.current_period_start` and reports them to `POST /v1/usage` (last report in a period wins), Pro as `max(n,3)`. The rollout scheduler's snapshot becomes `plan_snapshot/{siteId}`.
- **Site lifecycle.** Delete stops billing first. Ownership transfer stops billing at the period end and the new owner upgrades again (the payer is always the site owner). Account deletion also unlinks the tridant subject.
- **UI.** `/settings/plan` becomes the billing page: trial state, the user's sites (tier, period, ends-at, actions: upgrade, switch, stop), free usage. A return page, an upgrade dialog, a "billing" row in each site's settings for owners. Gates follow **the site's plan**: owners get an upgrade link, members get "ask the site owner".

### Decisions (owner, 2026-10-13)
1. Only the site owner can change a site's billing.
2. Billing periods run on calendar months from the 1st, 00:00 UTC (built by tridant on staging 2026-10-13; the first part month is prorated by days; a mid-trial subscription bills from the trial end).
3. Core's "1 site" cap is dropped: under per-site billing every Core site is billed on its own. Pricing copy says "per site".
4. Ownership transfer stops billing at the period end; the new owner upgrades again.
5. The API-key mint-time plan gate is dropped; keys are checked per site on every request (`requireApiKeyPlan`).
6. One tridant key per environment, kept under the env name `TRIDANT_LICENSE_KEY`, with scopes `license.read`, `site.write`, `billing.write:prd_owlette_core`.

### Integration points
`web/lib/plan.server.ts` (resolver, limits), `web/lib/tridantEntitlements.server.ts` (site read, parser), `web/lib/tridant.server.ts` (unchanged base client), new `web/lib/tridantBilling.server.ts`, `web/lib/planUsage.server.ts`, `web/lib/planPause.server.ts`, `web/lib/pairingPlan.server.ts`, `web/lib/authorizedHandler.server.ts`, `web/app/api/_shared.ts`, `web/lib/actions/{createSite,transferSiteOwnership,deleteSite}.server.ts`, `web/lib/userDeleteCascade.server.ts`, `functions/src/lib/planSnapshot.ts`, `web/hooks/{usePlan,useSitePlan}.ts`, `web/components/plan/*`, `web/app/settings/plan/*`, `web/components/ManageSitesDialog.tsx`.

## Waves
1. Foundations: site entitlement client with the parser fix; tridant billing client with an e2e fake; owner-only capability; `plan_accounts` store.
2. Plan logic: per-site resolver and free counting; trial start; per-site usage, report and snapshot.
3. Server: billing and site-plan routes; site lifecycle; account plan API with the lazy trial; pairing check out of the transaction; drop the mint gate.
4. Client hooks and gates by site.
5. Billing page, return page, upgrade dialog; site settings entry and trial banner.
6. Docs and pricing copy; bulk trial route; e2e; cleanup of the owner-pays code; full verification.
7. Staging proof on dev.owlette.app (owner steps marked).
8. Link an existing tridant account: moved to the "continue with tridant" plan (tridant accepts a fresh OIDC ID token as link consent).

Task detail: `tasks.md`.

## Risks
- **#317's parser rejects every live answer** (booleans), so it fails open today. Fixed in 1.1; the tests must use tridant's real shapes.
- **A transferred site stays under the old owner's tridant org until its billing period ends.** tridant now moves an idle site on `POST /v1/sites` (`moved: true`); while billing still runs it answers `409 site_belongs_to_another_org` with `reason: site_running`, and the daily job retries. Was: **a transferred, unbilled site stays under the old owner's tridant org** (`POST /v1/sites` answers `409 site_belongs_to_another_org`; only billing can move a site). It keeps reading the old owner's trial. Asked of tridant; until then logged, not fatal.
- **A Core site bought mid-trial reads Pro until the trial ends** (tridant merges the trial licence). Accepted.
- **`DELETE` leaves `billing.cancel_at_period_end` false** (it reads the subscription flag). Use `billing.ends_at`.
- **tridant refuses localhost return URLs**, so a real checkout only completes on dev.owlette.app. Local dev and e2e use the fake.
- **Free counting reads one site answer per owned site.** Cached and bounded by the owner's site count; fails open per site.
- **Fulfilment failures are not retried by tridant** (`status:'failed'`); the return page says so and support resolves it.
- **Turning `PLAN_ENFORCEMENT` on for dev affects every dev user.** Owner go at wave 7.

## Success Criteria
- On dev.owlette.app against tridant staging: a new verified account gets a 14-day Pro trial; its sites read trialing; it upgrades a site to Pro (founders) with a Stripe test card and returns to Pro active; it adds a second site at Core with no checkout; the daily report records usage; advancing the Stripe test clock produces one invoice with a line per site; stopping a site runs to the period end, then the site reads Free.
- With enforcement on and the e2e seam: free limits refuse a second free site and a second free machine; members see "ask the site owner"; only the owner can change billing.
- With enforcement off or tridant unset, behaviour is unchanged.
- web lint, tsc, jest, rules tests, functions tests, openapi validation and the full e2e suite are green; docs, runbook and both changelogs describe it.
