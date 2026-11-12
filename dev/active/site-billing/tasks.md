# site billing — Tasks
**Progress**: 0/25 complete

Worktree: `C:\Users\admin\Documents\Git-restored\Owlette-site-billing-wt`, branch `feat/site-billing` off `origin/dev` 9c929f97. All paths are relative to it. Read `plan.md` (decisions) and `context.md` first. The tridant contract is `git -C C:/Users/admin/Documents/Git/tridant-id show origin/staging:internal-docs/api/billing.md` (site billing) plus `origin/staging:worker/src/routes/api.ts` (`getSiteEntitlementsS2S`, `pushSiteS2S`). Conventions: lowercase UI copy and comments; problem+json errors (`web/lib/apiErrors.ts`); no direct Firestore from components; never log tridant keys or user emails; `tridantFetch` never throws. After each task run `npx eslint` on touched web files, `npx tsc --noEmit -p web`, and the touched jest suites.

## Wave 1: foundations

- [ ] **Task 1.1: per-site entitlement read and a parser that accepts tridant's real types**
  - Files: `web/lib/tridantEntitlements.server.ts`, `web/__tests__/lib/tridantEntitlements.server.test.ts`
  - Do:
    - Fix the parser. tridant sends flag features as JSON booleans, limits as numbers or the string `'unlimited'`, and `owlette.storage_bytes` as `null` (`tridant-id origin/staging:worker/src/routes/_entitlements.ts` `coerceValue`). Normalise every `ent` value to the string form `plan.server.ts` reads: `true`→`'1'`, `false`→`'0'`, finite number→`String(n)`, `'unlimited'` stays, `null`→ key omitted. Reject only a non-object `ent` or wrong top-level types. Apply it to the existing uid read too (it is removed in 6.4).
    - Add `getSiteEntitlements(siteId)`: `GET /v1/sites/owlette:${encodeURIComponent(siteId)}/entitlements?app=owlette` with `TRIDANT_LICENSE_KEY` via `tridantFetch`. Result `{ok:true, resolved, standing, inGoodStanding, ent, epoch, orgId, billing}` where `billing` is `{periodStart, periodEnd, endsAt, cancelAtPeriodEnd}` (ms numbers or null) when the answer has a `billing` object, else `null`; or the existing failure union.
    - 60 s promise cache keyed by siteId (failures cached too, like the uid cache); export `invalidateSiteEntitlements(siteId)`; extend `__resetForTests`.
    - E2E seam: under `OWLETTE_E2E==='1'` read Firestore `e2e_entitlements/site:{siteId}` (`{resolved, standing, inGoodStanding?, ent, billing?}`; `ent` values may be booleans/numbers/strings and go through the same parser), uncached; no doc → `not_configured`. Keep the uid seam as is.
  - Done when: tests cover a live Pro answer with boolean flags, a Free default answer, `no_mapping_for_site`, a billed site with `billing`, `'unlimited'`, `null` storage, a malformed answer, the cache and invalidation, and the site seam. The old test asserting booleans are malformed is replaced.

- [ ] **Task 1.2: tridant billing client with an e2e fake**
  - Files: `web/lib/tridantBilling.server.ts` (create), `web/lib/tridantBillingE2e.server.ts` (create), `web/__tests__/lib/tridantBilling.server.test.ts` (create)
  - Do: typed wrappers over `tridantFetch` (`web/lib/tridant.server.ts`) using `process.env.TRIDANT_LICENSE_KEY`. Constants: `PRODUCT = {core:'prd_owlette_core', pro:'prd_owlette_pro'}`, `subjectFor(uid) = 'owlette:'+uid`, `siteRef(siteId) = 'owlette:'+siteId`. Result for every call: `{ok:true, …} | {ok:false, reason:'not_configured'|'unreachable'|'rejected'|'malformed_response', status?, code?}` where `code` is tridant's `error` string from the body.
    - `startCheckout({uid, email, name, siteId, siteName, tier, founders, successUrl, cancelUrl})` → `POST /v1/billing/checkout` → `{checkoutUrl, sessionId}`.
    - `confirmCheckout(sessionId)` → `GET /v1/billing/checkout/:id` → `{status:'pending'|'complete'|'failed', error?, orgId, sites:[{siteId (strip 'owlette:'), productId, founders, status, endsAt}]}`.
    - `addSite({uid, siteId, siteName, tier, founders})` → `POST /v1/billing/sites`.
    - `switchTier(siteId, tier, founders)` → `PATCH /v1/billing/sites/:ref`.
    - `stopSite(siteId)` → `DELETE /v1/billing/sites/:ref` → `{endsAt}`.
    - `startTrial({uid, email, name})` → `POST /v1/billing/trial` with `product: PRODUCT.pro, days: 14` → `{orgId, expiresAt, already}`.
    - `reportUsage(entries:{siteId, machines}[])` → `POST /v1/usage {sites:[…]}` in chunks of 500 → per-entry `{siteId, recorded, error?}`.
    - `pushSite({uid, siteId, name})` → `POST /v1/sites {subject, provider:'owlette', external_id: siteId, name}`.
    - `unlinkAccount(uid)` → `DELETE /v1/billing/link/owlette:{uid}`.
    - `foundersRemaining()` → public `GET /v1/products` (no key) → `{core: number|null, pro: number|null}` from `founders_remaining` of the two rows; 5 min cache.
    - E2E fake (`tridantBillingE2e.server.ts`), used by every wrapper when `OWLETTE_E2E==='1'`: `startCheckout` writes `e2e_billing/{sessionId}` (`sessionId='e2e_'+random`) and returns `checkoutUrl` = the `successUrl` with `{CHECKOUT_SESSION_ID}` replaced; `confirmCheckout` reads it, writes `e2e_entitlements/site:{siteId}` (Pro or Core ent, `inGoodStanding:true`, `billing` = this month) and answers `complete`; `addSite`/`switchTier`/`stopSite` update that doc; `startTrial`/`pushSite`/`unlinkAccount`/`reportUsage` answer ok and record in `e2e_billing_calls`.
  - Done when: unit tests (mock `tridantFetch`) cover each wrapper's request body and path, error-code mapping, the usage chunking, the founders cache, and the fake.

- [ ] **Task 1.3: owner-only billing capability**
  - Files: `web/lib/capabilities.ts`, `web/lib/rateLimit.server.ts`, `web/__tests__/lib/capabilities.test.ts`, `web/content/docs/api/rate-limits.mdx`, `web/content/docs/reference/authentication.mdx`
  - Do: add `Capability.SITE_BILLING_MANAGE` (follow the existing value naming), granted to the owner row only (`capabilities.ts` ~166-169), site-scoped (`SITE_SCOPED_CAPABILITIES`), user limit 10/min and system limit 50/min in both `Record<Capability,…>` maps. Update the test that asserts the owner row is "admin plus SITE_DELETE" to include it. Add it to the two docs tables.
  - Done when: capability and rate-limit tests pass; tsc clean.

- [ ] **Task 1.4: plan_accounts and billing_checkouts stores**
  - Files: `web/lib/planAccounts.server.ts` (create), `web/__tests__/lib/planAccounts.server.test.ts` (create), `web/__tests__/rules/planCollections.test.ts`
  - Do: server-only collections, denied to clients by the catch-all rule (no `firestore.rules` change).
    - `plan_accounts/{uid}`: `{trialStartedAt, trialEndsAt, orgId, linkRequired, trialError, updatedAt}`. Helpers `getPlanAccount(uid)`, `claimTrialStart(uid)` (transaction; returns false when a start is already recorded or claimed in the last 60 s), `recordTrial(uid, {orgId, endsAtMs})`, `markLinkRequired(uid)`, `recordTrialError(uid, code)`.
    - `billing_checkouts/{sessionId}`: `{uid, siteId, tier, founders, createdAt}`. Helpers `recordCheckout(...)`, `getCheckout(sessionId)`.
    - Rules test: a signed-in client (including the doc's own uid) cannot read or write `plan_accounts/{uid}` or `billing_checkouts/{id}`.
  - Done when: unit tests and `npm run test:rules` pass.

## Wave 2: plan logic

- [ ] **Task 2.1: per-site plan resolver and free counting**
  - Files: `web/lib/plan.server.ts`, `web/lib/pairingPlan.server.ts`, `web/lib/planPause.server.ts`, `web/lib/authorizedHandler.server.ts` (only the plan step ~:741), `web/__tests__/lib/plan.server.test.ts`, `web/__tests__/lib/planPause.server.test.ts`, `web/__tests__/api/helpers/planEnforcement.ts`, `web/__tests__/lib/authorizedHandler.test.ts`, `web/__tests__/api/agent/device-code.test.ts`, `web/__tests__/api/agent/exchange.test.ts`
  - Do:
    - `resolveSitePlan(siteId, siteData?)`: `offBeforeReads()`; read the site doc when not given; a superadmin site owner is unrestricted; `getSiteEntitlements(siteId)` (1.1). Failure → `{enforced:false, reason}` (fail open). Otherwise `{enforced:true, resolved, standing, paid: inGoodStanding, ent, billing}`. `resolved:false` means Free.
    - `requireEntitlement(siteId, flag, siteData?)` now uses `resolveSitePlan`. `planTier(plan)`: free unless paid; `trial` when standing is `trialing`; `pro` when `owlette.deployments` or `owlette.roost` is entitled; `core` when `owlette.control` is; else free.
    - Free counting: `machineSlotAvailable(siteId, machineId, siteData?)`: a paid site → true; otherwise count distinct machine ids across the site owner's **free** owned sites (resolve each owned site's plan once per call), exempt when `machineId` already exists in any owned site, and allow while the count is below that free site's `owlette.machines` (default 1). `siteSlotAvailable(ownerUid)`: count owned sites whose plan is free; allow while below the free default `owlette.sites` (1). Trialing and billed sites never count.
    - `pairingPlan.machineLimitRefusal(siteId, machineId, siteData?)` keeps its signature and uses the new `machineSlotAvailable`. `planPause` memo becomes per site (drop the payer map); `pausedByPlan` uses `resolveSitePlan`. `authorizedHandler` uses `resolveSitePlan(siteId)`.
    - Keep `payerForSite` and `resolvePlan(uid)` exported but unused-by-new-code until 3.2, 3.3 and 3.5 move their last callers; 6.4 deletes them.
    - Fixtures in `planEnforcement.ts` become site-keyed and use tridant's real value types where they pass through the parser.
  - Done when: tests cover off, unconfigured, unreachable, superadmin owner, Free, trial, Core, Pro per site; free counting across a mix of paid and free owned sites; re-pair exemption; pause memo per site. Pairing tests still pass.
  - Depends on: Task 1.1

- [ ] **Task 2.2: trial start**
  - Files: `web/lib/planTrial.server.ts` (create), `web/__tests__/lib/planTrial.server.test.ts` (create)
  - Do: `ensureTrial(uid)`: return early unless `plansEnforced()`; read `plan_accounts/{uid}` and return if a trial is recorded or `linkRequired`; `getAuth().getUser(uid)` must have `emailVerified` and an email, else return; `claimTrialStart(uid)` or return; `startTrial({uid, email, name: displayName})`. On ok: `recordTrial`, then `registerOwnedSites(uid)`. On `code:'link_required'`: `markLinkRequired`. On `code:'already_subscribed'`: `recordTrial` with no end. Other failures: `recordTrialError(uid, reason or code)` and return (the next plan read retries). Never throws. `registerOwnedSites(uid)`: `pushSite` for every site the user owns; `409 site_belongs_to_another_org` is logged and skipped; then `invalidateSiteEntitlements` for each. Also export `registerSite(uid, siteId, name)` for 3.2 (no-op unless `plan_accounts/{uid}.orgId` is set).
  - Done when: tests cover enforcement off, unverified email, already started, link_required, already_subscribed, an upstream failure, the claim race, and site registration with one 409.
  - Depends on: Tasks 1.1, 1.2, 1.4

- [ ] **Task 2.3: per-site usage, report and snapshot**
  - Files: `web/lib/planUsage.server.ts`, `web/app/api/cron/plan-daily/route.ts`, `web/__tests__/lib/planUsage.server.test.ts`, `web/__tests__/api/cron/plan-daily.test.ts`, `functions/src/lib/planSnapshot.ts`, `functions/src/rolloutScheduler.ts` (only if the snapshot read changes), `functions/test/planSnapshot.test.ts`, `functions/test/rolloutScheduler.test.ts`, `infra/cron-jobs.json` (description only)
  - Do:
    - `runPlanDaily(now)`: per site, stamp `billing_usage/{siteId}/days/{YYYY-MM-DD}` (`machineIds` arrayUnion, active = `lastHeartbeat` within 26 h, day = yesterday UTC as today); write `plan_snapshot/{siteId}` `{enforced, control, roost, resolvedAt}` from `getSiteEntitlements`.
    - For each site whose answer has `billing`: `activeMachinesBetween(siteId, billing.periodStart, now)` (distinct ids across day docs from the period start's UTC day); Pro sites (`owlette.deployments` entitled) report `max(n,3)`, Core `n`; one `reportUsage` call (chunked by the client). Log entries with `recorded:false` (`site_not_billed` is normal during a Stripe trial) without failing the run. Only when `plansEnforced()`.
    - Prune day docs older than 100 days, as now. Export `activeMachinesBetween(siteId, startMs, endMs)`.
    - Functions: `readSitePlanSnapshot(db, siteId)` reads `plan_snapshot/{siteId}` directly; `planBlockReason` copy: "this site's plan doesn't include …".
    - Cron registry description: "reports active machines per billed site to tridant id".
  - Done when: web and functions tests cover stamping per site, snapshot per site, the report with the Pro floor and a Core site, a failed entry, enforcement off (no report), and pruning.
  - Depends on: Tasks 1.1, 1.2

## Wave 3: server routes and lifecycle

- [ ] **Task 3.1: billing routes and the site plan route**
  - Files: `web/lib/siteBilling.server.ts` (create), `web/app/api/sites/[siteId]/billing/route.ts` (create), `web/app/api/billing/checkout/[sessionId]/route.ts` (create), `web/app/api/sites/[siteId]/plan/route.ts` (create), `web/scripts/validate-openapi.ts` (INTERNAL_ROUTES), `web/__tests__/api/sites-billing.test.ts` (create), `web/__tests__/api/billing-checkout-confirm.test.ts` (create), `web/__tests__/api/site-plan.test.ts` (create)
  - Do: model the routes on `web/app/api/sites/[siteId]/swoop-settings/route.ts` (refuse api keys with 403 `api_key_not_permitted`, `readAndParseJsonBody`, `problemFromError`) and `transfer-ownership` (`withIdempotency`, `emitMutation`).
    - `POST /api/sites/[siteId]/billing` (`authorizedSiteHandler`, `Capability.SITE_BILLING_MANAGE`): body `{tier:'core'|'pro', founders:boolean}`, validated by hand. 503 `billing_unavailable` unless plans are configured (`plansEnforced()`); 403 `email_unverified` unless the caller's Firebase record is verified; 409 `already_billed` when the pointer is active with no `endsAt`. `startCheckout` with `successUrl = trustedBaseUrl()+'/settings/plan/return?session_id={CHECKOUT_SESSION_ID}'`, `cancelUrl = trustedBaseUrl()+'/settings/plan?checkout=canceled'`, record `billing_checkouts/{sessionId}`, answer `{checkoutUrl}`. On `subscription_exists`: `addSite`, write the pointer, invalidate, answer `{added:true}`. Map `link_required`, `site_billed_elsewhere`, `founders_sold_out`, `site_is_default` to 409 problems with those codes and lowercase details; `unreachable` to 503; anything else to 502 `billing_upstream`.
    - `PATCH` (`{tier, founders?}`) → `switchTier`, update the pointer; `DELETE` → `stopSite`, set `pointer.endsAt`. 404 `not_billed` when there is no pointer.
    - `GET /api/billing/checkout/[sessionId]`: session auth (`requireSessionOrIdToken(req, {rejectAgentTokens:true})`, `assertActiveUser`), only the uid recorded in `billing_checkouts`; `confirmCheckout`; on `complete` write the pointer for the recorded site and invalidate; answer `{status, siteId, tier, error?}`.
    - `GET /api/sites/[siteId]/plan` (any member): `{enforced, reason?, tier, standing, paid, flags (the 8 PLAN_FLAGS as booleans), billing: {tier, founders, endsAt}|null, period: {start, end}|null, isOwner}`.
    - The pointer is `sites/{id}.billing = {tier, founders, payerUid, endsAt|null, updatedAt}` written with the admin SDK.
    - The session-only routes go into `INTERNAL_ROUTES` with a reason, like `hoot-settings`.
  - Done when: tests cover owner-only (an admin member gets 403), api-key refusal, every 409 mapping, `subscription_exists` → add, idempotency, the confirm route's uid check and pointer write, the plan route for a member; `auditMutationCoverage` and `npm run validate:openapi` (check `web/package.json` for the script name) pass.
  - Depends on: Tasks 1.2, 1.3, 1.4, 2.1

- [ ] **Task 3.2: site lifecycle**
  - Files: `web/lib/actions/createSite.server.ts`, `web/lib/actions/transferSiteOwnership.server.ts`, `web/lib/actions/deleteSite.server.ts`, `web/lib/userDeleteCascade.server.ts`, `web/lib/planTrial.server.ts` (add `reconcileSiteRegistration`), `web/lib/planUsage.server.ts` (call it from `runPlanDaily`), `web/__tests__/lib/actions/UserRole.assignSite.removeSite.deleteUser.bootstrapUser.createSite.updateSite.deleteSite.test.ts`, `web/__tests__/lib/actions/transferSiteOwnership.test.ts`, `web/__tests__/lib/userDeleteCascade.test.ts`, `web/__tests__/lib/planTrial.server.test.ts`, `web/__tests__/lib/planUsage.server.test.ts`
  - Do:
    - createSite: keep `siteSlotAvailable(ownerUid)` (now counts free sites); after the batch commits, `registerSite(ownerUid, siteId, name)` best effort.
    - transferSiteOwnership: replace `successorPlanRefusal` with: if the site is free now and the successor has no free-site slot → the existing 402 refusal; otherwise allow. After the transaction, if the site has a billing pointer: `stopSite` (best effort) and set `pointer.endsAt`; then `registerSite(successorUid, …)`. `skipPlanCheck` keeps its meaning.
    - deleteSite: before deleting, `stopSite` when a pointer exists (ignore `site_not_billed`).
    - userDeleteCascade: after the transfers, `unlinkAccount(uid)` best effort.
    - `reconcileSiteRegistration(siteId, siteData, answer)` in `planTrial.server.ts`, called per site from `runPlanDaily`: when the site answer's `orgId` differs from the owner's `plan_accounts/{owner}.orgId` (or the answer is `resolved:false` while the owner has an `orgId`) and the answer has no `billing`, call `registerSite`. tridant moves an idle site and answers `moved: true`; `409 site_belongs_to_another_org` with `reason: site_running` means the old billing period is still running, so log it and retry on the next run; `reason: site_is_default` or `subject_not_of_provider` is logged as an error. This is how a transferred site reaches its new owner's org once its old billing period ends.
  - Done when: tests cover each hook, including best-effort failures not blocking the action, and the reconcile cases.
  - Depends on: Tasks 1.2, 2.1, 2.2, 2.3

- [ ] **Task 3.3: account plan API with the lazy trial**
  - Files: `web/app/api/account/plan/route.ts`, `web/lib/plan.server.ts` (the `PlanResponse` wire type only), `web/openapi.yaml` (`/api/account/plan`, `AccountPlanResponse`), `web/__tests__/api/account/plan.test.ts`
  - Do: `await ensureTrial(uid)` first (never fails the response). Answer `{enforced, reason, missingKeys, trial: {status:'none'|'active'|'ended'|'link_required', endsAt}, sites: [{siteId, name, tier, standing, paid, billing, period, activeMachinesThisPeriod}], free: {sitesUsed, sitesLimit, machinesUsed, machinesLimit, liveMachines}, foundersRemaining}` for the sites the caller owns. `liveMachines` = across free owned sites, earliest `pairedAt` then lowest id, first `machinesLimit`. Early return with `enforced:false` and no reads when off.
  - Done when: tests cover off, trial, free with live machines, a billed site with a period, link_required; openapi validation passes.
  - Depends on: Tasks 2.1, 2.2, 2.3

- [ ] **Task 3.4: pairing check outside the transaction**
  - Files: `web/app/api/agent/auth/device-code/authorize/route.ts`, `web/__tests__/api/agent/device-code.test.ts`
  - Do: move `machineLimitRefusal` before `runTransaction` (opened ~:67) so a tridant call never runs inside a Firestore transaction; keep the refusal semantics (device code `refused`, 402 `{error}`). Poll and exchange already check outside a transaction; confirm and leave them.
  - Done when: tests prove the refusal still lands and the check runs before the transaction.
  - Depends on: Task 2.1

- [ ] **Task 3.5: drop the API-key mint gate**
  - Files: `web/app/api/_shared.ts`, `web/app/api/keys/route.ts`, `web/app/api/keys/[keyId]/rotate/route.ts`, `web/app/api/account/api-keys/route.ts`, `web/app/api/cli/device-code/authorize/route.ts`, `web/__tests__/api/planProFlags.test.ts`, `web/__tests__/api/keys.test.ts`, `web/__tests__/api/account/api-keys.test.ts`, `web/__tests__/api/cli-device-code-authorize.test.ts`
  - Do: delete `requireApiKeyMintPlan` and its four calls; keep `requireApiKeyPlan` (the per-request, per-site check). Update the tests that expected a mint refusal.
  - Done when: tests pass; no `resolvePlan(` caller remains in `_shared.ts`.
  - Depends on: Task 2.1

## Wave 4: client hooks and gates

- [ ] **Task 4.1: hooks and gates by site**
  - Files: `web/hooks/usePlan.ts`, `web/hooks/useSitePlan.ts`, `web/components/plan/UpgradeGate.tsx`, `web/app/dashboard/page.tsx`, `web/app/deployments/page.tsx`, `web/app/talons/page.tsx`, `web/app/roosts/RoostsPageClient.tsx`, `web/app/settings/webhooks/page.tsx`, `web/app/admin/webhooks/page.tsx`, `web/app/admin/alerts/page.tsx`, `web/app/hoot/components/HootChatView.tsx`, `web/components/ApiKeysManager.tsx`, `web/app/swoop/[siteId]/[machineId]/page.tsx`, tests under `web/__tests__/hooks/` and `web/__tests__/components/` and `web/__tests__/app/` for these
  - Do: `usePlan` returns the 3.3 account shape. `useSitePlan(siteId)` becomes a per-site store reading `GET /api/sites/{siteId}/plan`, with `refresh()`, and keeps `{machineLimitFor(id), controlLocked, swoopLocked}` (machine lock from the account plan's `free.liveMachines` when the site is free). `UpgradeGate`/`usePlanGated` take `siteId` instead of `siteOwner`; `governingPlan` goes. A gated owner sees an upgrade link to `/settings/plan#site-{siteId}`, a member sees "ask the site owner to upgrade this site". Update every caller. `ApiKeysManager` loses its mint gate.
  - Done when: hook and component tests cover owner vs member, loading (never flashes a gate), free vs paid; eslint and tsc clean; the dashboard renders unchanged with enforcement off.
  - Depends on: Tasks 3.1, 3.3

## Wave 5: billing UI

- [ ] **Task 5.1: billing page, upgrade dialog, return page**
  - Files: `web/app/settings/plan/page.tsx`, `web/app/settings/plan/return/page.tsx` (create), `web/components/plan/UpgradeSiteDialog.tsx` (create), `web/hooks/useSiteBilling.ts` (create), tests under `web/__tests__/app/` and `web/__tests__/components/`
  - Do: model the dialog on the removed `git show adbfd06f^:web/components/billing/ChoosePlanDialog.tsx` (radiogroup tier cards, "continue to checkout", `window.location.href = checkoutUrl`, toast the problem `detail`); prices from `PRICING_FACTS` (`web/lib/product-facts.ts`), founders price while `foundersRemaining` > 0, retry at list price on `founders_sold_out`. The page: trial card (ends date, or link_required notice), a row per owned site (`id="site-{siteId}"`, name, tier badge, period, active machines, "ends {date}" when stopping) with upgrade / switch / stop for the owner, free usage. `useSiteBilling` wraps POST/PATCH/DELETE and refreshes `usePlan` and `useSitePlan`. The return page polls `GET /api/billing/checkout/{session_id}` (pending → retry every 2 s up to 30 s), then shows done, failed (with support copy) or still pending. All copy lowercase.
  - Done when: component tests cover each state; screenshots at 1440 and 390, light and dark, reviewed; eslint clean.
  - Depends on: Task 4.1

- [ ] **Task 5.2: site settings entry and trial banner**
  - Files: `web/components/ManageSitesDialog.tsx`, `web/components/plan/TrialBanner.tsx`, `web/components/PageHeader.tsx` (only if the plan nav entry needs a rename), tests for both components
  - Do: an owner-only "billing" row in the site edit panel (tier badge, "manage billing" link to `/settings/plan#site-{id}`); `TrialBanner` shows the trial end date, a link_required notice, and the free state, from the 3.3 shape.
  - Done when: tests cover owner vs member and each banner state.
  - Depends on: Task 4.1

## Wave 6: docs, bulk trials, e2e, cleanup

- [ ] **Task 6.1: docs, pricing copy, runbook**
  - Files: `web/content/docs/plans.mdx`, `web/content/docs/api/errors.mdx`, `web/content/docs/reference/firestore-data-model.mdx`, `docs/runbooks/plans-and-billing.md`, `web/lib/product-facts.ts`, `web/components/landing/PricingSection.tsx`, `web/components/landing/FAQSection.tsx`, `web/__tests__/lib/pricingFacts.test.ts`, landing e2e specs that assert pricing copy, `scripts/env-manifest.json` (`TRIDANT_LICENSE_KEY` description: three scopes), `docs/changelog.md`, `web/content/docs/changelog.mdx`
  - Do: "the site's plan decides" everywhere it says the owner's; per-site billing, Free per account, trial, lapse, `plan_required`, the new error codes; data model for `sites.billing`, `plan_accounts`, `billing_checkouts`, `billing_usage/{siteId}`, `plan_snapshot/{siteId}`; Core loses "1 site" and becomes "per site"; billing is per calendar month from the 1st (UTC), the first part month prorated by days, and a subscription started during the trial bills from the trial end; runbook: the key's three scopes, staging setup, the bulk trial route (6.2), rollback; Unreleased entries in both changelogs.
  - Done when: docs build/lint and pricing tests pass.
  - Depends on: Waves 3–5

- [ ] **Task 6.2: bulk trial start for existing accounts**
  - Files: `web/app/api/cron/plan-trials/route.ts` (create), `web/__tests__/api/cron/plan-trials.test.ts` (create)
  - Do: a cron-secret route (copy the `X-Cron-Secret` pattern from an existing `web/app/api/cron/*` route) that pages through users and runs `ensureTrial(uid)` for each verified account; dry run by default (`?apply=1` to act), answering counts (eligible, started, link_required, failed). Not registered on cron-job.org; triggered by hand per the runbook.
  - Done when: tests cover dry run, apply, and the secret check.
  - Depends on: Task 2.2

- [ ] **Task 6.3: e2e**
  - Files: `web/e2e/specs/plans/free.spec.ts`, `web/e2e/specs/plans/billing.spec.ts` (create), `web/playwright.config.ts` (only if env is needed)
  - Do: move `free.spec.ts` to the site-keyed seam (`e2e_entitlements/site:{siteId}`, boolean flags). New `billing.spec.ts` with the 1.2 fake: an owner upgrades a free site to Pro → the return page shows done → the site reads Pro; switch to Core; stop shows "ends {date}"; a site admin sees no billing actions; a second free site is refused.
  - Done when: both specs pass locally and the full suite stays green.
  - Depends on: Waves 4–5

- [ ] **Task 6.4: remove the owner-pays code**
  - Files: `web/lib/plan.server.ts`, `web/lib/tridantEntitlements.server.ts`, their tests
  - Do: delete `payerForSite`, `resolvePlan(uid)`, the uid `getEntitlements` and the uid e2e seam once `git grep` shows no callers.
  - Done when: `git grep -n "payerForSite\|resolvePlan(\|getEntitlements("` finds nothing outside history; tests pass.
  - Depends on: Tasks 3.2, 3.3, 3.5

- [ ] **Task 6.5: full verification**
  - Files: none
  - Do: run `/preflight` (security alerts, lint, tsc, jest, rules tests, functions tests, openapi, full e2e). Fix reds. Then `/verify`.
  - Done when: everything is green and `/verify` passes.
  - Depends on: Tasks 6.1–6.4

## Wave 7: staging proof (owner steps marked)

- [ ] **Task 7.1 (owner): the staging key.** In admin-staging.tridant.io → API keys → New: scopes `billing.write` (owlette Core), `license.read`, `site.write`. Put it in railway-dev as `TRIDANT_LICENSE_KEY` and in `.claude/.env.local` as `TRIDANT_LICENSE_KEY_DEV`. Never paste it in chat.
- [ ] **Task 7.2: ship to dev.** PR `feat/site-billing` → `dev` after preflight; with the owner's go, set `TRIDANT_API_URL=https://api-staging.tridant.io` on railway-dev (`node scripts/sync-env.mjs`), register `cron-plan-daily` for dev on cron-job.org, then (owner go) `PLAN_ENFORCEMENT=on` on railway-dev. Watch the e2e run.
- [ ] **Task 7.3: the proof run.** On dev.owlette.app with a fresh test account: verified sign-up → `/settings/plan` shows the trial → create a site → it reads trialing → upgrade it to Pro (founders) with Stripe test card 4242 → return page done → the site reads Pro and is billed → add a second site at Core (no checkout) → trigger `plan-daily` by hand → usage recorded (`recorded:true`) → ask Davor (or use the staging Stripe sandbox) to advance the test clock → the invoice shows one line per site → stop a site → after the period end it reads Free. Record each step with screenshots in the log.
- [ ] **Task 7.4: bulk trials on dev.** Run the 6.2 route as a dry run, review the counts with the owner, then apply on the owner's go.

## Wave 8: moved

- [ ] **Task 8.1: link an existing tridant account.** Moved to the "continue with tridant" plan: tridant accepts a fresh OIDC ID token from Owlette's own client as link consent (`POST /v1/billing/link {subject, org_id, id_token}`, `auth_time` within 10 min, ask with `max_age=600`). Staging client `oic_cwGUoks7wJjctlSp`, redirects `https://dev.owlette.app/api/auth/tridant/callback` and `http://localhost:3000/api/auth/tridant/callback`. Original note: If tridant accepts an OIDC ID token as link consent, fold this into the "continue with tridant" plan. Otherwise: the server proxies tridant's app sign-in (`POST /v1/auth/code`, `/v1/auth/code/verify`, `/v1/auth/mfa/verify` when `mfa_required`) to get the owner's `session_token`, then `POST /v1/billing/link {subject, session_token, org_id}`, clears `plan_accounts.linkRequired`, and retries the trial or checkout.

## Log
### 2026-10-13
- Plan created from three research passes (owlette plan code, purchase-flow patterns, tridant contract and dependencies). Owner approved the plan and decisions 1–6. #317 merged into dev as 9c929f97 the same day.

## heads-up from the admin-sites release (2026-11-04)
- `web/components/ManageSitesDialog.tsx` is DELETED on `feat/admin-sites` (release 4.1.27). Site settings is now a page: `/admin/sites/[siteId]` with sections general, members, machines, swoop & screens, danger zone (`web/components/admin/sites/SiteSettings.tsx`). The owner-only billing row this plan puts in the dialog (tasks ~136-139) belongs in that page: the general section, or a `billing` section of its own, owner-only like the danger zone. Rebase after 4.1.27 merges.
