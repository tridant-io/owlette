# Superadmin activity monitoring — Tasks
**Progress**: 10/12 complete

Every task: read `context.md` first (shapes, decisions, files never to touch). Work only in
`C:\Users\admin\Documents\Git-restored\Owlette-activity-wt`. UI copy is lowercase. After
editing a web file run `npx eslint <file>` and fix what you introduced. Run the task's own
jest files and report the output. Do not commit or push.

## Wave 1: foundations

- [x] **Task 1.1: sign-in and second-factor events**
  - Files: `web/lib/authEvents.server.ts` (new), `web/app/api/auth/session/route.ts`,
    `web/app/api/mfa/verify-login/route.ts`, `web/app/api/passkeys/step-up/verify/route.ts`,
    `web/app/api/passkeys/authenticate/verify/route.ts`,
    `web/__tests__/lib/authEvents.server.test.ts` (new), `web/__tests__/api/auth-session.test.ts`,
    `web/__tests__/api/mfa/verify-login.test.ts`, and the existing tests of the two passkey routes.
  - Do: write `authEvents.server.ts` exporting `recordSignIn(request, {userId, role, method, authTime})`
    and `recordAuthFailure(request, {userId, capability, event, reason, method?})`. Both
    write one doc to `global/audit_log/entries` in the decision-row layout:
    `{correlationId: generateCorrelationId(), actor: {type:'user', userId, role}, capability,
    target: {kind:'user', id: userId}, outcome, denyReason?, metadata: {event, method?,
    network: {key, prefix, viaEdge}}, timestamp: FieldValue.serverTimestamp()}`.
    `capability` is `'AUTH_SIGN_IN'` or `'AUTH_SECOND_FACTOR'`, typed locally, NOT added to
    `web/lib/capabilities.ts`. Network comes from `requestNetwork(request)` in
    `web/lib/network.server.ts` (never from the swoop binding helpers). Both are
    fire-and-forget: return `void`, catch and `logger.error`, never throw, never awaited by
    the route. `recordSignIn` writes outcome `allow`, event `sign_in`, doc id
    `signin_<userId>_<authTime>` with `.create()`, swallows ALREADY_EXISTS, and does nothing
    when `authTime` (seconds) is more than 10 minutes old. `recordAuthFailure` writes
    outcome `deny` with an auto id.
    Call sites:
    - session route: keep `decoded.auth_time` and `decoded.firebase?.sign_in_provider` from
      the verified token. After `createSession` resolves, `recordSignIn` with `method` =
      `'app_link'` when `appLinkMfa` is set, `'passkey'` when the provider is `custom`, else
      the provider string; `role` = `userDoc.data()?.role ?? 'member'` (the doc is already
      read). On the soft-deleted 403: `recordAuthFailure` (`AUTH_SIGN_IN`, event
      `sign_in_failed`, reason `user_deleted`). On the uid-mismatch 403: the same with
      reason `user_id_mismatch` and the VERIFIED uid. Nothing on the invalid-token 401 (no
      trustworthy uid). Do not change `createSession`'s arguments.
    - `mfa/verify-login`: `AUTH_SECOND_FACTOR`, event `second_factor_failed`, at the three
      failure branches, reasons `invalid_backup_code`, `invalid_totp_code`, `attempts_exceeded`.
    - `passkeys/step-up/verify`: on a rejected proof, `second_factor_failed`, reason
      `proof.code`, method `passkey`.
    - `passkeys/authenticate/verify`: only where the passkey was found and the assertion
      did not verify (uid known), `AUTH_SIGN_IN`, `sign_in_failed`, reason
      `passkey_assertion_failed`. Not on the earlier branches, where the uid is unverified.
    Never use `emitMutation` here (decision 3). In each route test, `jest.mock('@/lib/authEvents.server')`
    and assert the call and its arguments; `auth-session.test.ts` pins `createSession`'s
    arguments, which must stay as they are.
  - Done when: the new lib test covers the row shape, the deterministic id, the 10-minute
    gate, ALREADY_EXISTS swallowed and a write failure not throwing; the four route tests
    assert their calls; `npx jest __tests__/api/auditMutationCoverage.test.ts` is green.

- [x] **Task 1.2: indexes**
  - Files: `firestore.indexes.json`
  - Do: add four composites and two field overrides, matching the file's existing style.
    Composites: `audit_log` COLLECTION_GROUP (`event.kind` ASC, `recordedAt` DESC);
    `audit_log` COLLECTION_GROUP (`event.actor` ASC, `recordedAt` DESC); `entries`
    COLLECTION (`outcome` ASC, `timestamp` DESC); `entries` COLLECTION (`actor.userId` ASC,
    `timestamp` DESC). Field overrides for `audit_log.timestamp` and `audit_log.recordedAt`,
    each with COLLECTION ASCENDING, COLLECTION DESCENDING, COLLECTION array CONTAINS and
    COLLECTION_GROUP DESCENDING (copy the `machines.lastHeartbeat` entry: an override
    replaces the field's defaults, so the COLLECTION scopes must be restated or the
    per-site audit queries break). Check whether any test or doc enumerates the indexes
    (grep `firestore.indexes` in `web/__tests__`, `docs/`, `web/content/docs`) and update it.
  - Done when: the file parses, `firebase deploy --only firestore:indexes --dry-run` is NOT
    run (no deploys without the owner's go), and the task report lists the six additions.

- [x] **Task 1.3: feed library**
  - Files: `web/lib/activity/types.ts`, `web/lib/activity/rows.ts`,
    `web/lib/activity/feed.server.ts` (all new), `web/__tests__/lib/activity/rows.test.ts`,
    `web/__tests__/lib/activity/feed.server.test.ts` (new)
  - Do: `types.ts` holds the shapes in `context.md` verbatim plus the path constants
    (`ACTIVITY_STATE_DOC = 'global/activity_watch'`, findings collection under it) and
    `MUTATION_KINDS` (the 15 kinds of `MutationKind` in `web/lib/auditLogClient.ts`, so
    `api_key_used` is excluded) and `AUTH_CAPABILITIES`.
    `rows.ts`: pure mappers `fromChangeDoc`, `fromDecisionDoc(source, siteId | null)`,
    `fromFindingDoc` to `ActivityRow`. Change row: actor parsed from `event.actor`
    (`user:`, `apiKey:`, `machine:` prefixes; anything else `unknown`), `siteId` null when
    `event.siteId` is `_platform`, `action` = `${kind}:${attributes.verb}` (or
    `${kind}:${attributes.commandType}` for `machine_command_dispatched`), `at` =
    `recordedAt`, kind `change`, details = attributes + hash. Decision row: kind `sign_in`
    when `capability` is an auth capability, else `refused`; `at` from `timestamp` via
    `timestampToMs` (`web/lib/firestoreTime.server.ts`); `network` from `metadata.network`;
    `reason` = `denyReason ?? errorCode`; details = metadata + correlationId + target.
    `feed.server.ts`: `loadActivityPage(db, {view, userId?, siteId?, pageSize, pageToken?})`
    returning `{rows, nextPageToken}`, and `loadActivitySince(db, startMs)` returning every
    change, deny/error, auth and `SITE_DELETE` row newer than `startMs` (for the cron).
    Sources per view: changes = `collectionGroup('audit_log').where('event.kind','in',MUTATION_KINDS).orderBy('recordedAt','desc')`;
    refused = `collectionGroup('audit_log').where('outcome','in',['deny','error']).orderBy('timestamp','desc')`
    plus the same on `global/audit_log/entries`; sign-ins = `entries.where('capability','in',AUTH_CAPABILITIES).orderBy('timestamp','desc')`;
    flagged = findings ordered by `detectedAt` desc; all = every source. A deny row with an
    auth capability comes back from two sources: dedupe by id, kind `sign_in`.
    User filter: changes by `event.actor in [...]` (decision 5: `user:<uid>` plus that
    user's key ids from `users/{uid}/api_keys`, cap 30); refused by `actor.userId == uid`
    ordered by `timestamp`, outcome filtered in memory (site rows and `entries`); sign-ins
    by `actor.userId == uid` on `entries`, capability filtered in memory; findings in memory.
    Site filter: query `sites/{siteId}/audit_log` directly, ordered by `recordedAt` and by
    `timestamp`, kinds and outcomes filtered in memory; no platform or sign-in rows;
    findings in memory by `subject.siteId`.
    Cursor per decision 6. In-memory-filtered sources read batches of 100 up to 300 docs a
    request; a source that hits the cap sets a horizon (its oldest scanned time) and the
    merged page stops there, with a token that continues from it (decision 7).
    Never read `api_key_used` rows into memory unfiltered on the collection-group path.
  - Done when: jest covers each mapper against fixtures of all three stored shapes
    (user, api key, machine and system actors; `_platform`; a sign-in row), the merge
    order, dedupe, a page boundary inside one millisecond (no row lost or repeated), the
    horizon case, and each filter choosing the queries listed above (assert on a stub db
    in the style of `web/__tests__/api/adminIssues.test.ts`).

- [x] **Task 1.4: email templates and the header pill**
  - Files: `web/lib/emailTemplates.server.ts`, `web/app/api/test-email/route.ts`,
    `web/app/admin/email/page.tsx`, `web/e2e/specs/admin/email.spec.ts`,
    `web/__tests__/lib/emailTemplates.test.ts`
  - Do: add `buildActivityFindingEmail({envLabel, finding, activityUrl})` and
    `buildActivityDigestEmail({envLabel, findings, alreadyEmailed, periodEnd, activityUrl})`,
    each returning `{subject, html}`, modelled on `buildIssueEmail` (same file) and laid
    out as in the approved design (https://claude.ai/artifact/VaJVXo5RtFJEFjTmCedGZB, boards
    "email · high severity" and "email · daily digest"). Define the input type inside this
    file (title, severity, summary, facts as `[string, string][]`, at); do not import from
    `web/lib/activity`. Alert: heading = the finding's title with a severity pill, a boxed
    summary, the facts table, one button "open in activity", the link fallback. Digest:
    heading "daily digest" with an "N to review" pill, the period line, one block per
    finding (title, one detail line, time in utc), a short "already emailed in this period"
    table when `alreadyEmailed` is non-empty, one button "open flagged activity", and the
    footer line "no digest is sent on a day with nothing to review". Subjects through
    `safeEmailSubject`: `[ENV] owlette activity · <title> — <subject>` and
    `[ENV] owlette activity · daily digest — N to review`. Escape every dynamic value with
    `escapeHtml`. Do NOT pass an `unsubscribeUrl` key to `wrapEmailLayout` (platform mail).
    Register both kinds in BOTH template lists (`EMAIL_TEMPLATES` in the test-email route
    and the page's own copy) with sample builders that call the real builders, and raise
    the option count asserted in `email.spec.ts` by two.
    Header pill (owner ruling 2026-11-15): in `wrapEmailLayout` the environment badge sits
    about 3px above the wordmark's x-height, because the two table cells centre on the
    wordmark's line box. Align the badge to the wordmark's x-height with email-safe inline
    CSS (for example `vertical-align: baseline` on both cells plus a 1px lift on the badge).
    This changes every Owlette email: check it by sending the test email from
    `/admin/email` or by rendering the html in a browser, at both `PRODUCTION` and
    `DEVELOPMENT` labels, and attach before and after screenshots to the task report.
  - Done when: `emailTemplates.test.ts` covers both subjects, header-injection in a title,
    html escaping of a hostile summary, the digest with and without `alreadyEmailed`, and
    no unsubscribe link in either; the header before/after screenshots exist; the existing
    template tests still pass.

## Wave 2: route and rules

- [x] **Task 2.1: GET /api/admin/activity**
  - Files: `web/app/api/admin/activity/route.ts` (new), `web/__tests__/api/adminActivity.test.ts`
    (new), `web/openapi.yaml`, `web/lib/openapiReference.ts`, `web/__tests__/api/openapi.test.ts`,
    `web/content/docs/api/pagination.mdx`
  - Do: copy the structure of `web/app/api/admin/issues/route.ts`. Auth
    `requirePlatformAuthAndScope(request, 'user', 'read')`. Query params: `view` (one of
    `ActivityView`, default `all`), `user` (uid), `site` (site id), `page_size` (default 50,
    max 100), `page_token`; reject bad values with `problemValidation`. Call
    `loadActivityPage`. Fill `actor.label` for user actors on the page with one
    `db.getAll` over `users/{uid}` (email, else display name). Respond
    `withPaginationFields({rows}, nextPageToken)` through `applyAuthDeprecations`; errors
    through `problemFromError(err, 'admin/activity:GET')`. The route writes NO audit row of
    its own (owner ruling). Add the operation to `web/openapi.yaml` beside the
    `/api/admin/issues` operations with security, example and code sample, a scope-note
    branch for `/api/admin/activity` in `web/lib/openapiReference.ts`, an assertion in
    `openapi.test.ts` in the style of the existing admin-issues one, and the row in
    `pagination.mdx`'s table.
  - Done when: jest covers a superadmin session, a `user=*:read` key, a key of another
    resource (403 `scope_insufficient`), a global admin and a member (403), a deleted
    superadmin (403), each view, both filters, a bad view (400), pagination round-trip, and
    labels filled; `npx jest __tests__/api/openapi.test.ts` is green.
  - Depends on: Task 1.3

- [x] **Task 2.2: rules and the findings store**
  - Files: `web/lib/activity/rules.ts`, `web/lib/activity/findings.server.ts` (new),
    `web/__tests__/lib/activity/rules.test.ts`, `web/__tests__/lib/activity/findings.server.test.ts` (new)
  - Do: `rules.ts` is pure: `evaluateRules({rows, knownNetworks, hasHistory, siteRoles})`
    returns `Finding[]`. Named constants: `WINDOW_MS = 15 min`, `SECOND_FACTOR_BURST = 5`,
    `DESTRUCTIVE_BURST = 5`, `REFUSAL_BURST = 20`. Rules:
    - `superadmin_promoted` (high): change row `user_mutated:promoted` with
      `details.to === 'superadmin'`. Id `superadmin_promoted:<rowId>`.
    - `mfa_removed` (high): `user_mutated:mfa_disabled` or `user_mutated:mfa_force_reset`. Id by row.
    - `site_deleted` (high): platform decision row, capability `SITE_DELETE`, outcome allow. Id by row.
    - `second_factor_burst` (high): 5+ deny rows with an auth capability for one user
      inside any 15 minutes. Id `second_factor_burst:<uid>:<floor(newestAt / WINDOW_MS)>`.
    - `destructive_burst` (high): 5+ destructive change rows by one actor inside 15
      minutes. Destructive = verbs `machine.remove`, `uninstall`, `member_removed`,
      `agent_token.revoke`, `soft_deleted`, `deleted` (site), or `commandType`
      `reboot_machine` / `shutdown_machine`. Id by actor and bucket.
    - `new_network_sign_in`: a sign-in allow row whose `network.key` is not `unknown`,
      for a user with `hasHistory`, whose key is not in `knownNetworks[uid]`. High when the
      row's role is `superadmin`; digest when `siteRoles[uid]` is `owner` or `admin`;
      otherwise no finding. Id `new_network_sign_in:<uid>:<key>`.
    - `refusal_burst` (digest): 20+ deny rows by one actor inside 15 minutes, not counting
      `rate_limited`, `plan_locked` or auth-capability rows. Id by actor and bucket.
    - `ownership_transferred` (digest): `site_member_mutated:ownership_transferred`. Id by row.
    - `user_deleted` (digest): `user_mutated:soft_deleted`. Id by row.
    Every finding gets a lowercase `title`, a one-sentence `summary`, `facts` and `rowIds`.
    Ids never contain `/`.
    `findings.server.ts`: `saveNewFindings(db, findings, now)` writes each with `.create()`
    (fields: the finding, `detectedAt: now`, `emailedAt: null`, `digestedAt: null`),
    swallows ALREADY_EXISTS and returns only the ones it created; `claimForEmail(db, id, now)`
    sets `emailedAt` in a transaction and returns false when it was already set;
    `claimDigest(db, day)` sets `lastDigestDay` on the state doc in a transaction and
    returns false when it already equals `day`; `markDigested(db, ids, now)`;
    `readState` / `writeScannedThrough`.
  - Done when: `rules.test.ts` has, for every rule, a firing case, a just-under-threshold
    case and the id's stability across two evaluations of overlapping windows; `unknown`
    network and no-history users never fire `new_network_sign_in`;
    `findings.server.test.ts` proves a second `saveNewFindings` of the same id creates
    nothing and a second `claimForEmail` returns false.
  - Depends on: Task 1.3

## Wave 3: page and cron

- [x] **Task 3.1: the page**
  - Files: `web/app/admin/activity/page.tsx`, `web/app/admin/activity/layout.tsx`,
    `web/components/admin/activity/ActivityList.tsx`,
    `web/components/admin/activity/activityDisplay.ts`, `web/hooks/useActivity.ts` (new),
    `web/app/admin/navItems.ts`, `web/__tests__/hooks/useActivity.test.ts`,
    `web/__tests__/components/admin/activity/activityPage.test.tsx` (new), and any existing
    test that enumerates nav items (grep `navItems` in `web/__tests__`).
  - Do: build the approved design (https://claude.ai/artifact/VaJVXo5RtFJEFjTmCedGZB,
    boards "activity · desktop" and "activity · phone") from the repo's own parts, copying
    `web/app/admin/issues/page.tsx`, `layout.tsx`, `IssueList.tsx` and `useIssues.ts`.
    `layout.tsx` exports `metadata = { title: 'admin · activity' }`. Nav entry: name
    `activity`, href `/admin/activity`, lucide `Activity` icon, description
    `everything done across every site, and what was flagged`, `minRole: 'superadmin'`,
    `group: 'support'`, placed after issues. Header through `AdminPageHeader`: title
    `activity`, description `what people, api keys and machines did across every site, newest first`,
    a refresh `IconButton` as the action, and in the toolbar a `SegmentedControl` (all,
    flagged, changes, refused, sign-ins), a user picker and a site picker. View, user and
    site live in the URL search params. For the pickers reuse what the admin pages already
    use to list users and sites (see `web/app/admin/users/page.tsx` and
    `web/app/admin/sites`); go through hooks or API routes, never Firestore from a
    component. `useActivity({view, userId, siteId})` copies `useIssues` (page size 50,
    generation guard, `loadMore`, `refresh`). Each row is a button that opens its details:
    time, a kind badge (flagged · high, flagged · digest, change, refused, sign-in: told
    apart by label, not colour alone), who and what on one line, a muted second line (site,
    network, reason), and the opened state showing `details` as a definition list plus two
    buttons, `everything from this actor` and `everything on this site`, which set the
    filters. `activityDisplay.ts` holds the pure row-to-text mapping (who, what, meta) for
    all four kinds and all five actor types, and the relative time. States: skeleton rows,
    an alert with `try again`, an empty state (`nothing here` /
    `no activity matches this view and these filters`), `load more`. Theme tokens only,
    no hardcoded colours, lucide icons only, button styling through `button.tsx` variants.
    Phone rules: no cut-off control, one-row header, the row regrids as `IssueRow` does.
  - Done when: the hook test covers first page, load more, a filter change discarding a
    stale response and an error; the component test covers every row kind's text, the
    opened row, both shortcut buttons and the three states; `npx eslint` and `npx tsc --noEmit`
    are clean for the new files; `npx jest __tests__/app/route-titles.test.ts` is green.
  - Depends on: Task 2.1

- [x] **Task 3.2: the cron route**
  - Files: `web/app/api/cron/activity-watch/route.ts` (new),
    `web/__tests__/api/cron/activity-watch.test.ts` (new), `infra/cron-jobs.json`,
    `scripts/env-manifest.json`, `docs/runbooks/manual-infrastructure.md`,
    `web/content/docs/setup/web-deployment.mdx`
  - Do: copy `web/app/api/cron/api-key-expiry/route.ts` (auth with `cronSecretMatches` on
    `x-cron-secret`, 401 otherwise; copy its docstring's wording about cron-job.org, not
    the stale "Railway" wording in older routes). One run:
    1. `readState`. Scan start = the older of `scannedThrough` and now minus 20 minutes,
       never older than 24 hours; scan end = now minus 30 seconds.
    2. `loadActivitySince(db, start)`.
    3. For each sign-in allow row with a known network key, gather that user's earlier
       sign-in rows (`entries.where('actor.userId','==',uid).orderBy('timestamp','desc').limit(200)`,
       auth sign-in allows older than the row, last 90 days) into `knownNetworks` and
       `hasHistory`, and the user's highest site role from
       `collectionGroup('members').where('uid','==',uid)` into `siteRoles`.
    4. `evaluateRules`, then `saveNewFindings`.
    5. For each NEW high finding: `claimForEmail`, then send `buildActivityFindingEmail`
       (claim before send: a lost email beats a loop).
    6. Digest: when the utc hour is 16 or later and `claimDigest(today)` wins, take the
       digest findings of the last 48 hours with `digestedAt == null`; if there are any,
       `markDigested` then send `buildActivityDigestEmail`, listing the last 24 hours'
       high findings as already emailed. None means no email.
    7. `writeScannedThrough(end)`. Respond with counts (rows scanned, findings created,
       emails sent).
    Recipient: `process.env.ACTIVITY_EMAIL ||` the admin address resolved exactly as
    `web/app/api/bug-report/route.ts` resolves `ISSUE_EMAIL`'s fallback. Resend missing:
    `logger.warn` and carry on. The activity link is `trustedBaseUrl()` +
    `/admin/activity?view=flagged`. Keep the route thin: no rule logic in it.
    Register the job in `infra/cron-jobs.json` (copy the `cron-api-key-expiry` entry:
    id `cron-activity-watch`, schedule `*/5 * * * *`, both environments, all required
    fields) and add `ACTIVITY_EMAIL` to `scripts/env-manifest.json` following how the
    manifest and its test treat an optional address. Add the row to the runbook's cron
    table and raise its "ten scheduled endpoints" counts to eleven; add the route to the
    cron list in `web-deployment.mdx`.
  - Done when: jest (in the style of `api-key-expiry.test.ts`, with Resend mocked) covers
    401 without the secret, a run that creates one high finding and sends one email, a
    second identical run that sends none, the claim preceding the send (call order), the
    digest sent once per day and not at all with nothing to review, Resend unconfigured,
    and the scan start after a long gap; `npx jest __tests__/infra` is green.
  - Depends on: Task 1.4, Task 2.2

## Wave 4: e2e and docs

- [x] **Task 4.1: playwright**
  - Files: `web/e2e/specs/admin/activity.spec.ts` (new),
    `web/e2e/specs/access-control/route-guards.spec.ts`, `web/e2e/COVERAGE.md`
  - Do: copy `web/e2e/specs/admin/issues.spec.ts` (role states, emulator seeding with the
    Admin SDK, unique suffixes, cleanup, the hand-sent session cookie). Seed one row of
    every stored shape: a change row and a deny row under a seeded site's `audit_log`, a
    platform change row under `sites/_platform/audit_log`, a sign-in allow row and a
    failed-second-factor row in `global/audit_log/entries`, and one high and one digest
    finding. As a superadmin: the page lists them newest first; each view shows only its
    kind; the site filter and the user filter narrow the list; a row opens and its
    shortcut sets the filter; `load more` appears with more than a page. At a 390 px
    viewport: no horizontal scroll and every control inside the viewport. A site admin is
    bounced from `/admin/activity`; a key without the scope gets 403 `scope_insufficient`
    from the API. Add `/admin/activity` to `PLATFORM_ROUTES` in `route-guards.spec.ts` and
    a line to `COVERAGE.md`. The emulator does not enforce indexes: say so in the spec's
    header comment.
  - Done when: the one-spec command in `web/e2e/README.md` passes for the new spec and
    for `route-guards.spec.ts`, with the output in the report.
  - Depends on: Task 3.1

- [x] **Task 4.2: docs**
  - Files: `docs/changelog.md`, `web/content/docs/changelog.mdx`,
    `web/content/docs/dashboard/index.mdx`, `web/content/docs/dashboard/admin/index.mdx`,
    `web/content/docs/reference/firestore-data-model.mdx`, `GLOSSARY.md`, `README.md`,
    `.claude/skills/codebase-map/SKILL.md`, `dev/active/superadmin-activity/privacy-draft.md` (new)
  - Do: one `### added` entry under `## [Unreleased]`, identical in both changelogs, in
    the house style (lowercase title, plain prose): the activity page, sign-in events, the
    detection rules and the two emails, and what is not covered (failed passwords). A
    second entry for the email header fix. The page-table row and the internal-pages
    paragraph in the dashboard docs. In the data model: the two auth capabilities on
    `global/audit_log/entries`, the `global/activity_watch` state doc and its `findings`
    collection. Glossary entries for **activity** (the cross-site timeline a superadmin
    reads) and **finding** (what a detection rule raises), with their Avoid synonyms.
    README: one line where the admin features are listed. Fix the codebase map: it says
    there is no `/api/admin/*` and omits `/admin/issues`, `/admin/hoot` and now
    `/admin/activity`. Privacy: do NOT edit `web/app/privacy/page.tsx`. Write
    `privacy-draft.md` with the proposed wording (sign-ins record the network and a
    shortened IP address; Owlette staff can view activity across sites to investigate
    abuse) and the exact lines of the policy it would change, for the owner to approve.
  - Done when: both changelogs carry the same two entries under Unreleased (grep the
    headings to confirm they did not land in a released section), the docs build's own
    checks pass (`npx jest __tests__` files that cover docs, if any), and the draft exists.
  - Depends on: Task 3.1, Task 3.2

## Wave 5: verify and prove

- [ ] **Task 5.1: verify**
  - Files: none new
  - Do: run `/verify` on the branch's diff (standards and spec reviewers, `model: sonnet`),
    then `/preflight` from the worktree: security alerts with `GATE_REF=refs/heads/dev`,
    lint, typecheck, jest, rules tests, the full Playwright suite. Fix what they find.
    A late `ERR_ADDRESS_IN_USE` in a full local e2e run on this box is port exhaustion:
    rerun those specs alone before believing them.
  - Done when: every check is green and the reviewers' findings are closed or put to the
    owner.
  - Depends on: all of waves 1 to 4

- [ ] **Task 5.2: prove it on dev**
  - Files: `dev/active/superadmin-activity/proof.md` (new)
  - Do: needs the owner's go for each of: commit, push and PR into dev, the dev index
    deploy, `ACTIVITY_EMAIL` on Railway dev, the dev cron registration (the owner's own
    step). In that order: indexes Enabled, then the merge, then the cron job. Then on
    dev.owlette.app: sign in and find the sign-in row; fail a TOTP five times on a test
    account and see the finding and the email; promote and demote a test user and see the
    finding and the email; run the cron twice more and confirm no second email; screenshot
    the page on desktop and at phone width in the owner's theme; send one test email and
    screenshot the header pill in a real inbox. Tell owlette-f8 the footprint for #420.
  - Done when: `proof.md` holds the screenshots, the finding ids, the email timestamps and
    anything unverified, stated plainly.
  - Depends on: Task 5.1

## Log
### 2026-11-15
- Plan created, ready for execution. Research: three read-only passes against dev at
  5cfb3cb0 (audit data, sign-in and network, admin/cron/email patterns).
- Owner: design approved content-wise; fix the email header pill in the live template too.
- Wave 1 done (1.1 to 1.4), uncommitted. Together: 13 jest suites / 142 tests green,
  `tsc --noEmit` and eslint clean. Nothing deployed, nothing sent.
- 1.1: the two passkey routes had no tests; `authenticate-verify.test.ts` and
  `step-up-verify.test.ts` are new.
- 1.3 notes for later tasks: `fromDecisionDoc(doc, source, siteId)`; a bad page token
  throws `InvalidPageTokenError` (2.1 maps it to a 400); a page can come back empty with
  a token after a capped scan, so the hook (3.1) keeps offering load more while the token
  is non-empty; a finding row's `at` is its `detectedAt`.
- 1.4 notes: the email input is `ActivityEmailFinding` (title, severity, summary, optional
  detail, a `subject` string, facts, at), not `Finding`; the cron route (3.2) maps one to
  the other (`subject` = the user's label or the actor).
- 1.4 finding: the live header was NOT offset in chromium. Before: badge centre 0.5px
  below the wordmark's x-height centre; after the baseline change: 0.5px above. The
  offset the owner saw was in the design mock, not the live template. The header change
  is in the working tree (baseline cells + 1px lift), unproven in a real mail client;
  owner to say keep or revert. Screenshots in `shots/`.
- Wave 2 done (2.1, 2.2), uncommitted. `tsc --noEmit` and eslint clean; the activity,
  route, openapi and auth-event suites green together (7 suites, 81 tests).
- 2.2 stopped once, correctly: a sign-in row's role was not reachable from an
  `ActivityRow`. `fromDecisionDoc` now carries `details.role` on sign-in rows.
- 2.2 corrections to the plan: a machine uninstall is `machine_command_dispatched` with
  `commandType: 'uninstall_software'` (added to the destructive set; the deployment route's
  `uninstall` verb stays). A site delete writes both the global `SITE_DELETE` row and a
  `site_mutated:deleted` change row. The 2fa rule's title is `2fa removed` (the UI's term).
- For 3.2: findings print uids where a person should read an email (targets, the burst
  subject). Add `labels?: Record<string, string>` (uid to email) to `RuleInput`, use it
  wherever a uid is printed, and have the cron resolve every uid in the scanned rows
  (actors and user targets) with one `getAll`.
- For /verify: `loadActivitySince` hands the allowed `SITE_DELETE` row to the rules with
  kind `refused` (every non-auth decision row maps to that kind). Works, reads wrong.
- 2.1: the operation is tagged `Users` in openapi.yaml; `user` and `site` are checked
  against a local id pattern (no existing validator fits a uid).
- Wave 3 done (3.1, 3.2), uncommitted. `tsc --noEmit` clean, eslint clean on every changed
  web file, and the 23 suites the feature touches green together (282 tests). The page has
  not been seen rendered; no mail sent; nothing deployed.
- 3.1: pickers come from `useUserManagement` and `useSites` (shadcn `Select`); no count
  badge on the flagged tab (the API returns no count). Flagged rows now say `emailed`,
  `in a digest`, `in the next digest` or `not emailed yet`: `fromFindingDoc` carries
  `emailedAt` and `digestedAt` (added after 3.1 reported them missing).
- 3.2: the route emails every unmailed high finding of the last day, not only this run's,
  so a run that dies before the send, or runs with mail unconfigured, is picked up by the
  next. A send that fails AFTER its claim is still lost (claim before send). Findings read
  as emails through `labels`. `ACTIVITY_EMAIL` is in the manifest with no targets, as
  `ISSUE_EMAIL` is. Response: `{ok, rowsScanned, findingsCreated, emailsSent}`.
- For 4.2: `web/content/docs/setup/environment-variables.mdx` (CRON_SECRET row: "the ten
  /api/cron/* routes" and its list) needs eleven and `activity-watch`, plus an
  `ACTIVITY_EMAIL` row; `web/content/docs/dashboard/admin/email-alerts.mdx` has its own
  cron table. The runbook had no "ten scheduled endpoints" count to raise; its table row
  is in.
- Wave 4 done (4.1, 4.2), uncommitted. Playwright on the emulators: 57 passed (14
  activity, 39 route-guards, 4 email). `tsc --noEmit` and eslint clean; the feature's 23
  jest suites green (283 tests). Not run: the full Playwright suite and the full jest
  suite (task 5.1).
- BUG found by the emulator, fixed test-first: `Finding.facts` was `[string, string][]`,
  which Firestore rejects as a nested array, so every finding save would have thrown and
  no alert would ever have been sent. Facts are now `{label, value}[]` everywhere, and
  `saveNewFindings` drops undefined `subject` keys. The fake-db jest tests could not see it.
- New e2e case proves the real path on the emulator: five failed second factors, the cron
  route called with its secret, one stored `second_factor_burst` finding with facts, shown
  on the page, no duplicate on a second call. `CRON_SECRET` is now set in the e2e web
  server env (`web/e2e/helpers/cron.ts`, `web/playwright.config.ts`).
- The refused view includes failed sign-ins and second factors, by design.
- Page fixes after seeing it rendered: the view buttons and pickers sit in their own row
  under the header (they wrapped onto two rows at 1440); a sign-in row no longer says
  `platform`, shows a role only for a superadmin, and says `unknown network`.
- 4.2: docs written; `privacy-draft.md` holds the proposed policy wording (the policy
  page is untouched). The header-fix changelog entry is its own `### fixed` block
  (`docs/changelog.md` lines 22-25, `web/content/docs/changelog.mdx` lines 19-22) and
  says "dev or prod badge": drop it on a revert, or reword it to the real labels on a keep.
- Screenshots of the real page in `shots/`: page-desktop-all, page-desktop-open-row,
  page-desktop-flagged-open, page-desktop-light, page-phone.
- Owner, 2026-11-15: "revert; commit". The email header change is reverted
  (`wrapEmailLayout`'s header is HEAD's bytes again; its test and its changelog entry are
  gone). The two new templates stay.
- /verify, 2026-11-15, on the uncommitted diff. Checks: `tsc --noEmit` clean; eslint clean
  on every changed file; full jest 578 suites, 14,497 passed, 1 skipped; Playwright on the
  emulators 57 passed (activity 14, route-guards 39, email 4). Not run yet: /preflight
  (security alerts, rules tests, the full Playwright suite): due before any push.
- Standards review (sonnet): no must-fix, no exploit path on either new route, eight low
  notes, all fixed on the owner's word: the sign-in history query now filters to
  `AUTH_SIGN_IN` in the query (a busy superadmin's other platform rows crowded their
  sign-ins out of the newest 200, a false "new network"; one more `entries` composite:
  `actor.userId`, `capability`, `timestamp`); the two `audit_log` field overrides are gone
  (no query needed them); the finding email is no longer called an alert
  (`buildActivityFindingEmail`, template `activity_finding`); pill colours in
  `EMAIL_COLORS`; `loadUserLabels` shared by both routes; `bursts()` is a sliding window;
  the auth-event log line prints a uid prefix.
- Spec review (sonnet): fixed, test-first: `system:<name>` and `cortex:user_<uid>` change
  actors were read as unknown (hoot-made changes now sit under their user, marked
  `through hoot`, and the user filter includes them); burst findings stored a subject the
  feed could not parse (now `userId`, or the writers' actor string); a passed second
  factor was never recorded (`recordSecondFactorPassed`, at `mfa/verify-login` and
  `passkeys/step-up/verify`); the dead `detail` email option is removed; an opened finding
  shows when it was emailed.
- Left as they are, on purpose: an api-key call to the feed leaves the usual
  `api_key_used` row (a session opening the page writes nothing); a send that fails after
  its claim is lost; a digest claim on a day with nothing to review uses up that day (the
  findings roll into the next).
- NOT verified anywhere yet: real indexes (the emulator enforces none), real mail
  delivery and the recipient, the live dev site, the ASN header on dev and prod.
- 2026-11-15: owner on dev asked why a swoop host refusal named no user; fixed by resolving the viewer from the session's start row (`subject` on the row, `attachSubjects`, machine named from `target.machineId`).
- 2026-11-15: owner ruling, hide routine fleet session rows: `ROUTINE_ACTIONS` is dropped from the changes source in memory (scan cap and horizon); `loadActivitySince` still reads them.
- 2026-11-15: owner: toggle + multiple addresses for activity emails, superadmin only, on admin → alerts (`global/activity_watch` `emailEnabled` / `emailRecipients`, `/api/admin/activity/settings`, `ActivityEmailSettings` card).
- 2026-11-15: owner on dev, of "no addresses set: emails go to hey@tridant.io": "confusing. why not just populate it". The list is now who gets mail: until a list is saved it starts with the configured address as a normal entry; saved empty means nobody (cron sends and claims nothing). `fallback` is gone from the API and the card; `ACTIVITY_EMAIL` only seeds the list.
