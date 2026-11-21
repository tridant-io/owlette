# tridant contract adoption — Tasks
**Progress**: 9/13 complete

Every task: work in `C:\Users\admin\Documents\Git-restored\Owlette-tridant-contract-wt` and assert
`git branch --show-current` is `feat/tridant-contract` before editing (`|| exit 1` on every `cd`).
Read `dev/active/tridant-contract/context.md` first: it holds the tridant contract, the decisions
and which test files mock what. House rules: lowercase comments and user-facing copy, comment only
the non-obvious why, no new packages, no `firestore.rules` change, never log a token, email or
tridant response body. Run `npx eslint <file>` on every web file you edit and
`npx tsc --noEmit -p .` plus the named jest files from `web/`. Do not commit; the orchestrator
commits each wave. Do not touch files outside your task's list.

## Wave 1: client layer

- [x] **Task 1.1: billing client and its e2e fake**
  - Files: `web/lib/tridantBilling.server.ts`, `web/lib/tridantBillingE2e.server.ts`,
    `web/e2e/helpers/plans.ts`, `web/__tests__/lib/tridantBilling.server.test.ts`
  - Do:
    - `switchTier(siteId, tier, founders?, payerUid?)`: when `payerUid` is given, send
      `payer: { subject: subjectFor(payerUid) }` in the PATCH body.
    - `stopSite(siteId, payerUid?)`: when given, append `?payer_subject=` + the URL-encoded
      subject to the DELETE path.
    - New `removeSite(siteId)`: `DELETE /v1/sites/owlette:{encoded siteId}`, answers
      `BillingResult<{ removed: boolean }>`; failures carry tridant's `code` as other calls do.
    - New `previewTrial(input: TrialInput)`: `POST /v1/billing/trial/preview` with the same body as
      `startTrial`. Parse to `{ payer: 'linked'|'would_create'|'link_required', trial:
      'would_start'|'already'|'already_subscribed'|'used'|null, orgId: string|null }`; an unknown
      `payer` value is malformed.
    - `reportUsage`: let each `UsageEntry` carry an optional `asOfMs` that overrides the call's
      `asOfMs` for that entry. Add to `UsageOutcome` the fields tridant returns on a recorded entry:
      `settling: boolean`, `settlesAt: number|null`, `periodStart: number|null`,
      `periodEnd: number|null` (null when absent).
    - `addSite`: replace the comment saying a re-added site keeps its old plan (A7: tridant now
      applies the product and founders named).
    - Fake (`tridantBillingE2e.server.ts`), keeping it a faithful stand-in:
      - seeds now carry the billed tier and rate inside `billing`: `billing.productId` (the real
        product id) and `billing.founders`; drop the top-level `founders` field and read the tier
        from `billing.productId` instead of from `ent`.
      - `addSite` re-adding a site whose removal is pending applies the requested tier and founders
        (A7) and answers `already: false`.
      - `switchTier` and `stopSite` with a payer answer `409 payer_mismatch` when the seed's
        `orgId` is not `org_e2e_{payerUid}`.
      - `startTrial`: `e2e_billing_config/trial.trialUsed` (array of uids) answers
        `409 trial_already_used`, next to the existing `linkRequired` list.
      - `previewTrial`: reads the same config: `link_required` → `{ payer: 'link_required',
        trial: null }`; `trialUsed` → `{ payer: 'would_create', trial: 'used' }`; otherwise
        `{ payer: 'would_create', trial: 'would_start' }`; `orgId` null unless linked.
      - `removeSite`: logged to `e2e_billing_calls` as `removeSite`; answers
        `409 site_running` while the seed has billing that has not ended, else deletes the seed and
        answers `removed: true`.
      - `reportUsage` echoes each entry's own `asOfMs` in the call log.
    - `web/e2e/helpers/plans.ts`: any helper that seeds a billed site writes `billing.productId` and
      `billing.founders` (not top-level `founders`); add a `trialUsed` option wherever the helper
      sets `linkRequired` on `e2e_billing_config/trial`.
    - Tests: the PATCH body and DELETE path with and without a payer (subject encoded), removeSite's
      path and its 200, 404, 409 answers, previewTrial's parse and a malformed answer, per-entry
      `as_of` in the usage body, and the `settling`/`settlesAt`/`period*` parse.
  - Done when: lint and typecheck clean; `npx jest __tests__/lib/tridantBilling.server.test.ts`
    green; nothing else in the repo calls the new functions yet.

- [x] **Task 1.2: key check, timeout, the site answer's new fields**
  - Files: `web/lib/tridant.server.ts`, `web/lib/tridantEntitlements.server.ts`,
    `web/lib/plan.server.ts`, `web/__tests__/lib/tridant.server.test.ts`,
    `web/__tests__/lib/tridantEntitlements.server.test.ts`, `web/__tests__/lib/plan.server.test.ts`,
    `web/__tests__/api/helpers/planEnforcement.ts`
  - Do:
    - `TridantRequest` gains optional `timeoutMs` (default stays 5000).
    - New `checkTridantKeys()` in `tridant.server.ts`: calls `GET /v1/key` with
      `TRIDANT_LICENSE_KEY` and `TRIDANT_RELEASE_KEY` (each skipped as `not_configured` when
      blank). Per key answer `{ keyName, ok, reason?, missing: string[], expiresAt: number|null,
      expiresInDays: number|null }`. Required: license key needs `license.read`, `site.write` and a
      `billing.write:prd_owlette_*`; release key needs a `release.write:prd_owlette_*`. Match as
      tridant grants: a product-bound scope counts for its whole owlette group (any
      `prd_owlette_` product), and `*` grants only `license.read`, `license.validate`,
      `site.write`. `ok` is true when tridant answered and nothing is missing. Under
      `OWLETTE_E2E=1` answer both keys ok without a call. Never log a key; logging `keyName` and
      the missing scope names is fine.
    - `SiteBillingPeriod` gains `productId: string|null` and `founders: boolean` from
      `billing.product_id` / `billing.founders`. `Entitlements` gains `trialEndsAt: number|null`
      from top-level `trial_ends_at`. `siteSeedToAnswer` maps the seed's `billing.productId`,
      `billing.founders` and top-level `trialEndsAt` into tridant's names (the e2e fake writes
      them, see task 1.1).
    - `plan.server.ts`: the enforced `Plan` gains `trialEndsAt: number|null`, set in
      `planFromAnswer`. `billing` already flows through. Nothing else changes in this file.
    - `planEnforcement.ts`: the billed fixtures carry `productId` (`prd_owlette_pro` /
      `prd_owlette_core`) and `founders: false`; every fixture carries `trialEndsAt` (a number on
      `TRIAL_ENTITLEMENTS`, null on the others).
    - Tests: the key check (scopes complete, one missing, `*` legacy key, group match, 401,
      unreachable, not configured, e2e), `timeoutMs` passed to the abort signal, the new parse
      fields present and absent, the seed mapping.
  - Done when: lint and typecheck clean; those three test files green; the full jest suite shows no
    new red (run it once: `npx jest` from `web/`; if a suite outside your files turns red because a
    fixture changed shape, fix the assertion in that test only if it is a pure shape update, and
    list it in your report).

## Wave 2: callers

- [x] **Task 2.1: site billing — payer, A7, A8, the stranded fix**
  - Files: `web/lib/siteBilling.server.ts`, `web/lib/actions/transferSiteOwnership.server.ts`,
    `web/__tests__/lib/siteBilling.stranded.test.ts`, `web/__tests__/api/sites-billing.test.ts`,
    `web/__tests__/lib/actions/transferSiteOwnership.test.ts`,
    `web/__tests__/api/billing-checkout-confirm.test.ts`, `web/__tests__/api/site-plan.test.ts`
  - Depends on: 1.1, 1.2
  - Do:
    - `switchSiteTier` sends the owner (who is the recorded payer there) as payer.
      `stopSiteBilling` sends the owner as payer only when the pointer's `payerUid` is that owner;
      a stop of a previous owner's billing goes without one, as today.
    - Add `payer_mismatch` to `CONFLICTS` with copy like "this site is billed under another tridant
      account. its plan can change once that billing ends." (lowercase, matches the others).
    - A7: in `upgradeSite`, drop the follow-up `switchTier` after `addSite`; the pointer is written
      from what `addSite` answers for the site (tier from `productId`, its `founders`), falling back
      to the request.
    - A8: `liveBilling` takes tier and founders from `resolved.billing.productId` /
      `resolved.billing.founders` (`tierOf`; fall back to `planTier` when `productId` is null).
      `siteBillingView`: when plans are enforced and the answer has billing, the summary's tier,
      founders and `endsAt` come from the answer, with the pointer's as fallback per field;
      `billedByPreviousOwner` still comes from the pointer.
    - Stranded repair (`stopStrandedBilling`), decision 2 in context.md: stop with the recorded
      payer. On `payer_mismatch`: `invalidateSiteEntitlements`, re-read with
      `getSiteEntitlements`; if the answer bills the site under the owner's recorded `orgId`
      (`getPlanAccount(owner)`), write a pointer for the owner (tier/founders/endsAt from the
      answer); otherwise stop without a payer and log a warning with the site id and code only.
      `site_not_billed` closes the record as today.
    - Transfer (`handOverBilling`): stop with the pointer's `payerUid` as payer when it is a
      string. A `payer_mismatch` is logged like the other failures; the daily repair handles it.
    - `stopBillingBeforeDelete`: no payer (it must land). Replace "nothing retries once the site is
      gone" in its doc comment: task 2.3 adds the retry record for the tridant site, though the
      billing stop itself still is not retried.
    - Update the mock factories in the listed tests for any function the code now calls. Tests:
      payer sent / not sent per call site, the mismatch refusal answered 409 `payer_mismatch`, the
      stranded adopt and stop-without-payer branches, the owner with no `orgId`, the upgrade with no
      PATCH, the view reading tier and founders from the answer.
  - Done when: lint and typecheck clean; the five listed test files green.

- [x] **Task 2.2: trial — A17 and the bulk dry run (A9, A4)**
  - Files: `web/lib/planTrial.server.ts`, `web/lib/planAccounts.server.ts`, `web/lib/planResponse.ts`,
    `web/app/api/cron/plan-trials/route.ts`, `web/app/api/account/plan/route.ts` (only `trialOf`),
    `web/app/settings/plan/page.tsx`, `web/components/plan/TrialBanner.tsx` (only if it switches on
    the trial status), `web/__tests__/lib/planTrial.server.test.ts`,
    `web/__tests__/api/cron/plan-trials.test.ts`, `web/__tests__/api/account/plan.test.ts`
  - Depends on: 1.1, 1.2
  - Do:
    - `planAccounts.server.ts`: `PlanAccount` gains `trialUsed: boolean`; new
      `recordTrialUsed(uid)` settles the claim like `recordSubscribed` (sets `trialStartedAt`) and
      sets `trialUsed: true`, `trialError: null`. `trialEndsAt` stays null, so `trialActive` is
      false and `billedFrom` counts from the period start.
    - `ensureTrial`: `trial_already_used` → `recordTrialUsed`, status `trial_used` (new
      `TrialStatus` member).
    - `planResponse.ts`: `AccountPlanTrial['status']` gains `'used'`. `trialOf` in the account plan
      route answers `{ status: 'used', endsAt: null }` when `account.trialUsed`, checked before the
      started branch.
    - Plan page: one lowercase line for `used`, e.g. "this account's free trial was already used on
      an earlier tridant account. pick a plan for each site." Match how the page renders
      `link_required` and `ended` (same component, same tone; read sibling states first).
    - `plan-trials` route: auth through `cronSecretMatches` (as plan-daily does). The dry run (no
      `apply`) calls `previewTrial` for each eligible account (same 10-wide worker pool) and answers
      counts `{ wouldStart, already, alreadySubscribed, used, linkRequired, failed }`; it logs the
      uids (never emails) of `link_required` and `used` accounts at info, one line per page. Both
      modes answer `keys` from `checkTridantKeys()`; `apply=1` answers 503 with detail naming the
      license key when its check is not ok. The release key never blocks. Counts for `apply` gain
      `trialUsed`. Update the route's doc comment.
    - Tests: `trial_already_used` recorded and not retried; the dry run's counts and log; apply
      refused on a bad license key and allowed with a bad release key; `trialOf` for `used`.
  - Done when: lint and typecheck clean; the three listed test files green.

- [x] **Task 2.3: remove a deleted site from tridant (A11)**
  - Files: create `web/lib/tridantSiteRemoval.server.ts` and
    `web/__tests__/lib/tridantSiteRemoval.server.test.ts`; modify
    `web/lib/actions/deleteSite.server.ts`, `web/lib/actions/deleteOwnAccount.server.ts`,
    `web/__tests__/lib/actions/deleteOwnAccount.test.ts`,
    `web/__tests__/lib/actions/UserRole.assignSite.removeSite.deleteUser.bootstrapUser.createSite.updateSite.deleteSite.test.ts`,
    `web/__tests__/lib/userDeleteCascade.test.ts`, `web/__tests__/rules/planCollections.test.ts`
  - Depends on: 1.1
  - Do:
    - `removeTridantSite(siteId)`: nothing when `!tridantConfigured()` (from `plan.server.ts`).
      Calls `removeSite`; `ok` or `404` → done. `409 site_running`, `unreachable` or
      `malformed_response` → set `tridant_site_removals/{siteId}` = `{ siteId, requestedAt (ms),
      attempts: 0, lastCode }`. `site_is_default` or any other rejection → log at error (site id,
      status, code). Never throws.
    - `sweepSiteRemovals(nowMs)` for the daily job (task 3.1 calls it): for each record, call
      `removeSite`; done → delete the record. `site_running` → read `getSiteEntitlements` (after
      `invalidateSiteEntitlements`); if it bills the site with `endsAt === null`, `stopSite(siteId)`
      without a payer, logged at warn; bump `attempts` and `lastCode`. A record older than 45 days
      is deleted with an error log. Answers counts `{ removed, pending, dropped, errors }`.
      Never throws; one record's failure does not stop the others.
    - Call `removeTridantSite` right after `stopBillingBeforeDelete` in `deleteSite.server.ts` and in
      `deleteOwnAccount.server.ts` (only when not a dry run, as the stop is).
    - Test mocks: the three action tests mock `@/lib/tridantSiteRemoval.server` (explicit factory),
      not the billing client, for this. `planCollections.test.ts` asserts clients can neither read
      nor write `tridant_site_removals`.
    - Module tests: not configured, removed, 404, site_running → record, sweep removes and deletes,
      sweep re-stops a running billing with no end, 45-day drop.
  - Done when: lint and typecheck clean; the listed jest files green; `npm run test:rules` green for
    `planCollections` if the emulator is available (say so if it is not).

- [x] **Task 2.4: batch entitlement read (A14)**
  - Files: `web/lib/tridantEntitlements.server.ts`,
    `web/__tests__/lib/tridantEntitlements.server.test.ts`
  - Depends on: 1.2
  - Do:
    - `primeSiteEntitlements(siteIds: string[]): Promise<{ primed: number; failed: boolean }>`:
      chunks of 100; each chunk is one `POST /v1/sites/entitlements?app=owlette` with
      `{ sites: refs }` and `timeoutMs: 15000`. Each result is parsed with `parseEntitlements` and
      stored in the site cache under its site id exactly as a single read would store it (same TTL),
      matched by position and checked against `subject === ref`; a result that does not parse or
      does not match is skipped (that site falls back to its own read). A failed chunk primes
      nothing and is logged once at warn with its size.
    - Under `OWLETTE_E2E=1` it does nothing and answers `{ primed: 0, failed: false }` (the seam
      reads seeds uncached).
    - Tests: order and subject matching, a malformed entry skipped, a failed chunk, chunking at 100,
      a primed site served from cache with no second call, the request path and body.
  - Done when: lint and typecheck clean; the test file green.

## Wave 3: the daily job and the plan page

- [x] **Task 3.1: daily job — batch, saved reports, removals, keys, Pro floor**
  - Files: `web/lib/planUsage.server.ts`, `web/__tests__/lib/planUsage.server.test.ts`,
    `web/__tests__/api/cron/plan-daily.test.ts`
  - Depends on: 2.1, 2.3, 2.4
  - Do:
    - Before the per-site work on each page, when enforced, `await primeSiteEntitlements(ids)`.
    - Pro floor: apply `PRICING_FACTS.pro.minMachines` when `plan.billing.productId === PRODUCT.pro`
      (not the `owlette.deployments` flag).
    - Save each billed site's report on `billing_usage/{siteId}` (merge) as
      `report: { periodStart, periodEnd, countedFrom, floor, machines, asOf, status, recorded,
      settled: false, at }`, where `countedFrom` is `billedFrom(...)` and `floor` is the minimum
      applied (0 when none). Write it after `reportUsage` answers, with each site's outcome; when the
      call failed outright, save with `status` = the failure reason and `recorded: false`.
    - Export `stampSite`-equivalent for the settle pass: `stampSiteMachines(siteId, nowMs)` that
      reads the site's machines and stamps them (refactor `stampSite` to use it; same behaviour).
    - Call `sweepSiteRemovals(nowMs)` once per run (whatever the enforcement switch) and
      `checkTridantKeys()` once per run when `tridantConfigured()`; add `removals` and `keys`
      (per key `{ keyName, ok, missing, expiresInDays }`) to `PlanDailySummary`. A key not ok logs
      at error.
    - Rewrite the comments that are now false: the header ("the last run of a month is the one that
      bills": the settle pass resends the morning after) and "a report that reaches tridant id after
      the 1st counts for nothing".
    - Tests: prime called per page, floor by product id (a core site whose flags read pro gets no
      floor), saved report shape on success and on outright failure, removals and keys in the
      summary.
  - Done when: lint and typecheck clean; both test files green.

- [x] **Task 3.2: account plan route — billing from tridant, trial-end refresh**
  - Files: `web/app/api/account/plan/route.ts`, `web/lib/planAccounts.server.ts`,
    `web/__tests__/api/account/plan.test.ts`
  - Depends on: 2.1, 2.2
  - Do:
    - `readOwnedSite`: when the plan is enforced and has billing, the entry's `billing` comes from
      the answer (tier via `productId`, `founders`, `endsAt`), the pointer as fallback; plans off
      keeps the pointer. `foundersHeld` then follows automatically; keep its doc comment true.
    - `planAccounts.server.ts`: `recordTrialEnd(uid, endsAtMs)` (merge, `updatedAt`).
    - Trial end: after the owned sites are read, take the latest `plan.trialEndsAt` among sites with
      `standing === 'trialing'` whose `plan.orgId === account.orgId`. When it differs from
      `account.trialEndsAt`, record it (inside `degrade`) and use the new value in this answer
      (`trialOf`, `siteCreationState`'s `trialActive`, and the usage counts' `billedFrom`, so compute
      it before the counts or recount; pick the simpler that stays correct).
    - Tests: billing from the answer and the fallback, an extended trial recorded and shown, a site
      under another organization ignored.
  - Done when: lint and typecheck clean; the test file green.

## Wave 4: month-end retry

- [x] **Task 4.1: settle pass and its cron route (A2)**
  - Files: create `web/lib/planSettle.server.ts`, `web/app/api/cron/plan-settle/route.ts`,
    `web/__tests__/lib/planSettle.server.test.ts`, `web/__tests__/api/cron/plan-settle.test.ts`;
    modify `infra/cron-jobs.json`
  - Depends on: 3.1
  - Do:
    - `runPlanSettle(now = new Date())`: nothing unless `plansEnforced()`. Query `billing_usage`
      where `report.periodEnd` is in `(now - 24h, now]`; skip `report.settled === true`. For each:
      `stampSiteMachines(siteId, nowMs)`, then count with
      `activeMachinesBetween(siteId, report.countedFrom, report.periodEnd - 1)`, apply
      `max(count, report.floor)`, and send one `reportUsage` call for all of them with per-entry
      `asOfMs: report.periodEnd - 1`. Save each outcome onto `report` (`settled: recorded`,
      `status`, `machines`, `asOf`, `settlesAt`). A `period_closed` answer logs at error (tridant's
      R11 flags the gap too). Answer `{ ok, candidates, sent, settled, errors }` and log it.
    - Route `GET /api/cron/plan-settle`: `cronSecretMatches` on `X-Cron-Secret`, like plan-daily;
      doc comment names the schedule `0 6 * * *` UTC on cron-job.org per environment.
    - `infra/cron-jobs.json`: a `cron-plan-settle` entry modelled on `cron-plan-daily` (schedule
      `0 6 * * *`, purpose, failureMode, environments dev and prod, minTimeoutSeconds 60). Also
      bring the `cron-plan-trials` entry's `purpose` up to date: its dry run now previews each
      account with tridant (`previewTrial`) and reports both keys' checks; `apply` refuses on a bad
      license key (task 2.2). The `cron-plan-daily` entry's purpose, failureMode, note and
      detectedBy still say the last run of a month bills / a report after the 1st counts for
      nothing: correct them (the settle pass resends the morning after), and mention the removal
      sweep and the key check. Same for the doc comment in `web/app/api/cron/plan-daily/route.ts`
      (add it to this task's files).
    - Writing onto the saved report: task 3.1 writes `report` with `{ mergeFields: ['report'] }`
      (each daily run replaces the whole map). The settle pass must update it with dotted paths
      (`report.settled`, `report.status`, …) or a merge, never replace it.
    - Known, accepted: a daily run that lands after midnight UTC already reads the new period and
      replaces the closed period's report before 06:00; a billed answer with a null `periodEnd`
      never settles. Do not engineer around them; 5.1 documents them.
    - Tests: window bounds, settled skipped, recount and floor, per-entry `as_of`, outcomes saved,
      `period_closed` logged, auth 401, plans off does nothing; `npx jest cronJobs` green.
  - Done when: lint and typecheck clean; the new tests and `__tests__/infra/cronJobs.test.ts` green.

## Wave 5: docs and e2e

- [ ] **Task 5.1: docs, ADR 0018, glossary**
  - Files: `docs/runbooks/plans-and-billing.md`, `docs/runbooks/manual-infrastructure.md`,
    `docs/adr/0018-a-site-has-a-plan-and-its-owner-pays.md`, `GLOSSARY.md`,
    `web/content/docs/plans.mdx`, `web/content/docs/reference/firestore-data-model.mdx`,
    `web/content/docs/setup/environment-variables.mdx`, `scripts/env-manifest.json` (only if a
    note there about the license key's scopes is now wrong)
  - Depends on: 4.1
  - Do: describe what waves 1–4 built, reading the diff (`git diff e88296c2 -- web/`).
    - ADR 0018: amend, with the argument, (a) "a report after the 1st counts for nothing" (false:
      tridant holds the invoice 24 h, and the settle pass resends at 06:00), (b) the trial is once
      per account as well as once per organization (`trial_already_used`), (c) the site record is a
      fallback, no longer the only copy of tier and founders. Amend in place, dated 2026-11-20, in
      the ADR's own format; do not rewrite its decision.
    - `web/content/docs/setup/web-deployment.mdx` (add to this task's files): its table of every
      scheduled route (about :269–285, the one the registry's `$schema-note` points to) needs a
      `plan-settle` row. The ADR 0018 bullet you amend also says "usage is reported once a day,
      late in the UTC day": rewrite the whole bullet, not just the "after the 1st" clause.
    - Also stale since wave 3: `web/content/docs/setup/web-deployment.mdx:278`,
      `docs/runbooks/plans-and-billing.md` about :496 ("the last run of a month bills"); with plans
      off, tridant is still called by the removal sweep and the key check when configured. Document
      the two accepted edges: a daily run after midnight UTC replaces the closed period's report
      before the settle pass reads it; a billed answer with no period end never settles.
    - Runbooks: the `plan-settle` registration (dev now, prod when plans go on), the dry run's new
      answer and key check, the removal record and its 45-day drop, the payer-mismatch refusal.
      `plans-and-billing.md` (about :300–330) still shows the old plan-trials example JSON and says
      "a dry run stops here: every other count is 0": replace with the dry run's and apply's real
      answers (read `web/app/api/cron/plan-trials/route.ts`).
      `manual-infrastructure.md` :277 and :283 list the cron jobs: add plan-settle.
    - Data model: `billing_usage/{siteId}.report`, `tridant_site_removals/{siteId}`,
      `plan_accounts.trialUsed`. Glossary "Trial": once per account and per organization.
    - `web/openapi.yaml` (add to this task's files): the `/api/account/plan` site `billing`
      description (about :15090) says "`null` for a site that was never billed"; it is now also
      null when plans are enforced and tridant bills nothing, and its tier, founders and end come
      from tridant's answer. The `foundersHeld` description (about :15178) says it is read from
      the billing records: now tridant's answer, else the record. `plans-and-billing.md` :582 says
      founders held is "read from the pointers": same fix.
    - Copy is lowercase where the surrounding docs are; use GLOSSARY terms.
  - Done when: every file reads true against the code; no new docs file created.

- [ ] **Task 5.2: e2e**
  - Files: `web/e2e/specs/plans/billing.spec.ts`, `web/e2e/specs/plans/free.spec.ts` (only if its
    seeds use the old `founders` field), `web/e2e/COVERAGE.md`, plus any other spec under
    `web/e2e/specs/` whose seed writes top-level `founders` (grep first)
  - Depends on: 4.1
  - Do: specs drive the real ui against the fake.
    - The billing section's tier and founders badge come from the seed's `billing.productId` /
      `billing.founders`.
    - A trial extended in the seed (`trialEndsAt` later than the account's) shows the new end on the
      plan page. No helper writes a site seed's top-level `trialEndsAt` yet (the only one,
      `endTrial`, writes `plan_accounts`): add an option to the trialing-site seed helper in
      `e2e/helpers/plans.ts` that writes it on `e2e_entitlements/site:{id}` (with `orgId` matching
      the account's), since `siteSeedToAnswer` maps it to `trial_ends_at`.
    - Switching a site billed under another organization shows the payer-mismatch message.
    - Deleting a billed site logs `removeSite` in `e2e_billing_calls`, answered `site_running`
      (the fake logs `{ fn: 'removeSite', siteId, answer }`). Under e2e `tridantConfigured()` is
      true, so that delete also leaves a `tridant_site_removals/{siteId}` record: make
      `clearPlanState` in `e2e/helpers/plans.ts` clear that collection (and assert the record).
    - The `used` trial line, seeded through `e2e_billing_config/trial.trialUsed`.
    - Update `COVERAGE.md`.
  - Done when: the plans specs pass locally (`npm run e2e -- e2e/specs/plans`); if this box's
    ephemeral ports run out (late `ERR_ADDRESS_IN_USE`), rerun after TIME_WAIT drains.

## Wave 6: finish

- [ ] **Task 6.1: merge dev, changelogs, full checks, review**
  - Files: `docs/changelog.md`, `web/content/docs/changelog.mdx`, conflict resolutions only
  - Depends on: all
  - Do: `git fetch` and merge `origin/dev` (grep for conflict markers after, require 0). Add one
    entry under Unreleased in both changelogs, in their voice: what an owner notices (plan page
    shows tridant's tier and founders rate, a trial extended in tridant shows its new end, the
    "trial already used" line, the payer-mismatch message) and the operator notes (register
    `plan-settle`, the dry run's new answer). Then `/preflight` (security gate, lint, typecheck,
    unit, rules, e2e) and `/verify`.
  - Done when: all green, both reviewers pass, findings fixed or answered.

## Log
### 2026-11-20
- Plan created after research and the owner's approval; worktree fast-forwarded to `e88296c2`.
- Wave 1 done (1.1, 1.2). /verify: standards and spec both pass with low findings, all fixed:
  "removal" kept for `removeSite` only (a stopped site is "stopped"), `request()` logs the path
  without its query, usage `period*` read on `recorded` entries only, a key-check doc comment.
  The fake's `reportUsage` models the settle window and its `removeSite` logs its answer.
  Full jest 592/592. Notes for later tasks: `planUsage.server.test.ts` and
  `siteBilling.stranded.test.ts` build `UsageOutcome`/`Plan` literals without the new fields
  (tasks 3.1, 2.1); the `stopSite` mocks in transfer, deleteSite and stranded tests forward only
  `siteId` (2.1, 2.3 widen them); no e2e spec seeds top-level `founders`.
- Wave 2 done (2.1–2.4). /verify: standards and spec pass, low findings fixed: one
  `stopOpenBilling` in siteBilling serves the stop before delete and the removal sweep;
  `payingOwner` serves `liveBilling` and the stranded repair; the stranded repair closes the
  record, with no second stop, when the re-read shows no billing; the batch prime skips a site
  invalidated during its call (`invalidatedAt`) and shares `store()` with `cached()`;
  plan-trials problem titles lowercase. Orchestrator added: `openapi.yaml` `used` status, a
  `recordTrialUsed` round trip in `planAccounts.server.test.ts`, the `used` card test. Decisions
  taken by the tasks (accepted): founders follow the product when the answer names none; the
  stranded repair waits a run when the re-read fails; the `used` card reads "no pro trial";
  the sweep keeps every record while tridant is not configured. For 3.1: mock factories of
  `@/lib/tridantEntitlements.server` and `@/lib/tridantSiteRemoval.server` in planUsage tests
  need `primeSiteEntitlements` / `sweepSiteRemovals`; `planUsage.server.test.ts` builds
  `Entitlements`/`UsageOutcome` literals without the new fields.
- Wave 3 done (3.1, 3.2). /verify: spec clean; standards one low (a "tier" comment, fixed).
  Follow-up beyond 3.1's text: `movedTrialEnd` lives in `planAccounts.server.ts`, shared by the
  route and the daily job, which records and uses a trial end tridant moved (billed sites whose
  answer reads `trialing`; one reading `active` mid-trial does not refresh it, accepted until the
  test-clock run shows which it reads). tridant's trial licence covers the whole organization, so
  every site answers the same `trial_ends_at`. The saved report is written with
  `mergeFields: ['report']`. Full jest 593/593 (useSwoopSession's load flake passed alone, 87/87).
  The plan page now leaves out "billed as" on a site tridant no longer bills, as the site page does.
- Wave 4 done (4.1). /verify: standards one low (registry said `recorded` stays the daily run's;
  the pass now writes `report.recorded` too, registry and header fixed); spec two lows, both
  fixed: `site_not_billed` on a resend settles (tridant closes a stopped site's billing item when
  the invoice opens, so the month bills on the daily run's report), and a report counted from its
  period end or later (the trial covered the period) is not a candidate. `inBatches` is shared
  from planUsage. Verified against tridant source: `as_of = periodEnd - 1` lands as `recorded`,
  `settling: true` whether or not tridant has rolled the subscription; tridant holds the invoice to
  at least periodEnd + 24 h, so `(now - 24h, now]` is inside it. For the test-clock run with
  Davor: a stopped site's final month cannot take a late report (its item closes when the invoice
  opens), so the settle window does not cover it. Full jest 595/595.
