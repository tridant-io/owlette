# site billing — Plan
**Created**: 2026-10-13 | **Reviewed and refreshed**: 2026-11-11 against dev 3634ad5a and tridant id staging e370a01 | **Status**: Active, ships in 4.2.0

## Summary
Owlette's plan gating (#317, on dev since 2026-10-13, dormant) assumes "the site owner's plan" and reads tridant id once per owner. tridant id bills **per site**: each site names the org that pays for it, one invoice per org per calendar month, one line per site (active machines × the site's tier price). This plan moves the gating onto per-site entitlements and builds the purchase flow: trial, upgrade, add a site, switch tier, stop, and linking an existing tridant account. It is proven on dev.owlette.app against tridant staging and ships in 4.2.0 **dormant**: nothing is enforced unless `PLAN_ENFORCEMENT=on` and tridant id is configured, and production's tridant id is not promoted yet.

## What the 2026-11-11 review changed
1. **#317's parser rejects every live tridant answer** (flags arrive as JSON booleans), so gating fails open today. Fixed first (1.1).
2. **Usage reports have no grace.** A report counts only if tridant has it before the 1st, 00:00 UTC. Reports carry `as_of`, the newest wins, and answers are per entry. The daily job moves from 03:00 to 23:30 UTC and stamps a machine on the UTC day of its last heartbeat (2.3).
3. **Site settings is a page now** (`/admin/sites/{siteId}`), not a dialog. Billing actions live in one place: an owner-only `billing` section there. `/settings/plan` becomes the account overview and links to it. Checkout returns to that section, so there is no separate return page (5.1, 5.2).
4. **Linking an existing tridant account is in scope** (3.6). Without it, anyone whose email already has a tridant organization (a Moonshine customer, the owner) gets `link_required` and can neither trial nor buy. It uses tridant's OIDC client for Owlette and a fresh ID token as consent. "continue with tridant" sign-in stays a later plan and reuses the same callback route.
5. **tridant API keys are bound to an app and expire** (400 days, `Sunset` header in the last 30). An expired key would make every check fail open, so the client logs loudly when it sees `Sunset` (1.1).
6. **`SITE_BILLING_MANAGE` is bypass-exempt.** With `capability_enforcement` off, a member must not be able to spend the owner's card (1.3).
7. **Pairing changed underneath**: `stampPairedAt` is `recordPairing` and also prunes machine scopes and fleet grants. hoot mcp is already gated through `requireEntitlement(siteId, 'owlette.hoot')`, so it follows the site's plan with no extra work.
8. **ADR 0018 and glossary entries** record the model (written with this refresh).

## Approach

### Data flow
- **Entitlements per site.** `GET /v1/sites/owlette:{siteId}/entitlements?app=owlette` (scope `license.read`), 60 s cache per site, cleared on Owlette's own billing changes. The answer: `resolved`, `standing`, `in_good_standing`, `grace_until`, `ent` (flags are JSON booleans, limits numbers or `'unlimited'`, `storage_bytes` null), `org_id`, and for a billed site `billing.{current_period_start, current_period_end, cancel_at_period_end, ends_at}` in epoch ms. An unknown site answers `resolved:false, note:'no_mapping_for_site'` with the defaults, which are owlette free. A site under a running trial answers `standing:'trialing'` with Pro values and no `billing`.
- **The payer is the site owner.** Only the site owner may change a site's billing. Checkout and trial use the subject `owlette:{ownerUid}`; sites are `owlette:{siteId}`. A server-written `sites/{id}.billing` pointer (`{tier, founders, payerUid, endsAt, updatedAt}`) mirrors what tridant bills, for the UI. tridant is the source of truth for entitlement.
- **Free is counted by Owlette, per account.** A site is *paid* when its answer is in good standing (trialing, active, or past_due inside grace); otherwise it is *free*. An account may own at most 1 free site, and its free sites may hold at most 1 machine in total. Paid and trialing sites are unlimited. Checked where it is checked today: pairing (device-code authorize, poll, exchange), site creation, ownership transfer.
- **Trial.** tridant owns it: `POST /v1/billing/trial {payer:{subject,email,name}, product:'prd_owlette_pro', days:14}`, one per organization ever, covering every site *registered under the organization*. Owlette starts it on the server the first time a signed-in user with a **verified** email reads their plan (nothing on the server sees an email become verified; Google accounts are verified at sign-up). Only while `plansEnforced()`. State in server-only `plan_accounts/{uid}`. After the trial starts, the owner's sites are registered with `POST /v1/sites` (scope `site.write`); new sites are registered at creation. An unverified account is on Free and is told to verify to start the trial. `409 link_required` marks the account and offers the link flow.
- **Link.** "link your tridant account": `GET /api/auth/tridant/link` redirects to tridant's authorize endpoint (PKCE S256, `scope=openid email orgs`, `max_age=600`); `GET /api/auth/tridant/callback` exchanges the code and calls `POST /v1/billing/link {subject, org_id, id_token}`. One owned organization links at once; several send the user back to pick one, and the second round trip is silent. Then the trial start is retried.
- **Purchase.** `POST /api/sites/{id}/billing {tier, founders}` → tridant `POST /v1/billing/checkout` → Stripe Checkout URL; on `409 subscription_exists` it adds the site to the running subscription instead (`POST /v1/billing/sites`, card on file, no checkout). Stripe returns to `/admin/sites/{id}?section=billing&session_id=…`; the section confirms through `GET /api/billing/checkout/{sessionId}` → tridant `GET /v1/billing/checkout/:id`, and the pointer is written. `PATCH` switches Core↔Pro, `DELETE` stops billing at the period end. Founders while tridant's `founders_remaining > 0`; `409 founders_sold_out` retries at list price.
- **Usage.** The daily job (23:30 UTC) stamps active machines per site, then for each billed site counts distinct machines since `billing.current_period_start` and reports them to `POST /v1/usage` with `as_of = now`, Pro as `max(n,3)`. `period_rolled_over` and transport failures are retried by the next run. The rollout scheduler's snapshot becomes `plan_snapshot/{siteId}`.
- **Site lifecycle.** Delete stops billing first. Ownership transfer stops billing at the period end and the new owner upgrades again. The daily job re-registers a site whose tridant organization is not its owner's (tridant moves an idle site). Account deletion unlinks the subject.
- **UI.** Site settings gains an owner-only `billing` section: tier, period, active machines, upgrade / switch / stop, and the checkout return. `/settings/plan` shows the trial, free usage, the link notice, and the owned sites with a link to each one's billing section. Gates follow **the site's plan**: an owner gets a link to the site's billing section, anyone else reads "ask the site owner".

### Decisions (owner, 2026-10-13 unless dated)
1. Only the site owner can change a site's billing.
2. Billing runs on calendar months from the 1st, 00:00 UTC; the first part month is prorated by days; a subscription started during the trial bills from the trial's end (built by tridant).
3. Core's "1 site" cap is dropped: every Core site is billed on its own. Pricing copy says "per site".
4. Ownership transfer stops billing at the period end; the new owner upgrades again.
5. The API-key mint-time plan gate is dropped; keys are checked per site on every request.
6. One tridant key per environment under the env name `TRIDANT_LICENSE_KEY`, bound to the app `owlette`, scopes `license.read`, `site.write`, `billing.write:prd_owlette_core`.
7. (2026-11-11) Ships in 4.2.0, dormant on production.
8. (2026-11-11, engineering) Link flow in scope; billing actions live in site settings; `SITE_BILLING_MANAGE` is bypass-exempt; the daily job runs at 23:30 UTC.

### Out of scope
- "continue with tridant" sign-in (later plan; reuses `/api/auth/tridant/callback`).
- roost storage: the flat 1 TiB per site cap stays; tridant's `owlette.storage_bytes` and overage are not read.
- Gating `fleet-settings` writes (a grant on an unentitled site refuses at call time, which is enough).
- Turning enforcement on in production. That needs tridant id's production promotion (tridant-id#124, #125) and its own go.
- A Stripe test-clock invoice run from Owlette's side. tridant proved the invoice lines on staging; Owlette's proof ends at `recorded: true`.

## Waves
1. Foundations: site entitlement read with the parser fix; tridant billing client with an e2e fake; owner-only capability; server-only stores.
2. Plan logic: per-site resolver and free counting; trial start; per-site usage, report and snapshot.
3. Server: billing and site-plan routes; site lifecycle; account plan API with the lazy trial; pairing check out of the transaction; drop the mint gate; link routes.
4. Client hooks and gates by site.
5. Site settings billing section; account plan page and banner.
6. Docs and pricing copy; bulk trial route; e2e; cleanup of the owner-pays code; full verification.
7. Owner sitting, ship to dev, staging proof.

Task detail: `tasks.md`.

## Risks
- **Fail-open hides misconfiguration.** A wrong or expired key makes every site unrestricted. `/api/account/plan` reports `enforced:false` with the reason, the client logs `rejected` and `Sunset` loudly, and the runbook checks both.
- **A report after the 1st is lost for that month.** One missed nightly run on the last day under-bills machines first seen that day. Accepted; the run is idempotent and can be triggered by hand.
- **A transferred site stays in the old owner's tridant organization until its billing period ends** (`409 site_belongs_to_another_org`, `reason: site_running`); the daily job retries.
- **A Core site bought mid-trial reads Pro until the trial ends** (tridant merges the trial licence). Accepted.
- **After `DELETE`, `billing.cancel_at_period_end` stays false** (it is the subscription's flag). Read `billing.ends_at`.
- **tridant refuses localhost return URLs**, so a real checkout completes only on dev.owlette.app. Local dev and e2e use the fake.
- **Free counting reads one site answer per owned site**, cached, and fails open per site.
- **A failed fulfilment** (`status:'failed'`) has had its Stripe subscription cancelled by tridant; the section says so and the owner starts a new checkout.
- **Turning `PLAN_ENFORCEMENT` on for dev affects every dev user.** Trials are bulk-started first; owner go at wave 7.
- **43 test files touch the plan modules.** 2.1 owns the churn and runs the full web suite.

## Success Criteria
- On dev.owlette.app against tridant staging: a new verified account gets a 14-day Pro trial and its sites read trialing; an account whose email already has a tridant organization links it and then trials; an owner upgrades a site to Pro (founders) with a Stripe test card and returns to Pro active; adds a second site at Core with no checkout; switches and stops a site; the daily job answers `recorded: true` for each billed site.
- With enforcement on and the e2e seam: a second free site and a second free machine are refused; members read "ask the site owner"; only the owner can change billing, also with `capability_enforcement` off.
- With enforcement off or tridant unset, behaviour is unchanged.
- web lint, tsc, jest, rules tests, functions tests, openapi validation and the full e2e suite are green; docs, runbook, ADR, glossary and both changelogs describe it.
