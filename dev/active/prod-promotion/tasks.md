# prod promotion — Tasks
**Progress**: 0/20 complete

Read [plan.md](plan.md), then [research/main-vs-dev.md](research/main-vs-dev.md) and
[research/env-vars.md](research/env-vars.md), then only the files your task names. **The owner's explicit go is
required per task** — no task starts because the previous one finished.

Every SHA and line number here was read on 2026-09-22 against `origin/dev` `723fc344` / `origin/main` `73f5d512`,
before the `release/3.3.6` forward-merge landed. **Re-read them; do not trust them.** Locate code by symbol.

**Hard prerequisite for the whole file:** the forward-merge of `release/3.3.6` into `dev`
([../forward-merge-3.3.6/](../forward-merge-3.3.6/)) has landed and `dev` is green. Wave 0 does not start before it.

## Standing rules

- **Read-only on production until a `[human]`-gated task says otherwise.** GETs, status-code probes and
  `--json` key reads are fine anywhere. Anything that writes — env vars, indexes, a merge, a Vercel deploy, a cron
  registration, a Worker — happens only inside a task that says `[human]`, and only after the owner says go.
- **Explicit `--project prod` on every `firebase` and `--project owlette-prod-90a12` on every `gcloud` command.**
  Never rely on a prior `firebase use`. `.firebaserc:3` defaults to `owlette-dev-3838a`, so the wrong command
  deploys production config to dev, exits 0 and prints nothing (`manual-infrastructure.md:21-26`).
- **Never print, log, echo or paste a secret value.** Key names only. When reading provider vars by hand, pipe
  `--json` through an `Object.keys` filter, the way `scripts/sync-env.mjs:45-53` does.
- **Every mutating step has a read-back in its `Done when:`** — a separate command that proves the write landed,
  not the exit code of the write.
- **A red gate stops the wave.** Fix forward on `dev` and re-run the gate on the new commit. Never merge around a
  red `smoke:dev`, a red `check`, or a `Building` index.
- **`git push` to `main` happens in Task 3.1 and nowhere else.** No force-push, ever; `main` blocks it anyway.
- **`dev/active/` is gitignored** (`.gitignore:32`) — search it with plain `grep -rn`, not ripgrep-based tools.
  Task 0.4 force-adds this directory so the plan survives the working tree.
- **Web edits:** `npx eslint <file>` clean on every file touched, `npx tsc --noEmit` clean, lowercase UI copy,
  `lucide-react` icons only, theme tokens only, no new npm packages.
- Labels: `[agent]` runs unattended on this box; `[human]` needs the owner's accounts, dashboards, eyes or go.

---

## Wave 0: prerequisites on `dev`

Four commits on `dev`, in this order. The last one freezes the promotion base.

- [ ] **Task 0.1: Gate the prod Worker deploy behind `workflow_dispatch`** `[agent]`
  - Files: `.github/workflows/swoop-signal-deploy.yml`, `infra/swoop-signal/README.md`
  - Do: Make it impossible for the promotion merge to create the prod signalling Worker (plan D1, risk R6). In the
    `on:` block, drop `main` from `push.branches` so only `dev` auto-deploys, and add a `workflow_dispatch` with a
    `choice` input `environment` (`dev` | `prod`, **default `dev`**). Derive `WRANGLER_ENV` from the event rather
    than the branch — `${{ github.event_name == 'workflow_dispatch' && inputs.environment || 'dev' }}`; keep the
    existing comment's warning in mind and note in a comment that this expression's fall-through lands on **dev**,
    which is the safe direction (the current `github.ref_name == 'main' && 'prod' || 'dev'` expression is the one
    being replaced). Widen the deploy job's `if: github.event_name == 'push'` to also admit `workflow_dispatch`.
    Leave the `test` job, the PR trigger, `concurrency`, `permissions` and the `/health` smoke step untouched.
    Record in the README's setup section that the prod deploy is now a deliberate dispatch
    (`gh workflow run swoop-signal-deploy.yml --ref main -f environment=prod`) and that it must not be run before
    the three prod secrets are set, because a Worker missing `SWOOP_SIGNAL_RING_SECRET` answers every ring
    `500 ring_secret_unconfigured` while `/health` still returns 200 and the smoke step deliberately sends no
    secret. Do not touch `wrangler.toml`, the Worker source, or any repo secret or variable.
  - Done when: `sed -n '/^on:/,/^permissions:/p' .github/workflows/swoop-signal-deploy.yml` shows `push.branches`
    as `[dev]` only and a `workflow_dispatch` with an `environment` choice defaulting to `dev`; no expression in
    the file can select `prod` from a `push` event; the `Actions Security` (zizmor) check is **read and green** on
    the PR for this change — it reports without failing the job by design (`.github/workflows/zizmor.yml:14-16`),
    so a green tick is not enough, read the SARIF findings for this file; and `cd infra/swoop-signal && npm ci &&
    npm run dryrun && npm test` passes (both a `wrangler deploy --dry-run` and the local vitest suite — neither
    calls Cloudflare).
  - Depends on: the forward-merge.

- [ ] **Task 0.2: Re-key the screenshot upload rate limit on the machine, not the client IP** `[agent]`
  - Files: `web/app/api/sites/[siteId]/machines/[machineId]/screenshots/upload-url/route.ts`,
    `web/app/api/sites/[siteId]/machines/[machineId]/screenshots/finalize/route.ts` (comment only),
    `web/__tests__/api/sites-screenshots.test.ts`
  - Do: Fix the one real regression this promotion would ship to the fielded fleet (plan D2, risk R1). Today
    `export const POST = withRateLimit(handlePost, { strategy: 'api', identifier: 'ip' })` resolves to 300/hour
    (`web/lib/rateLimit.ts:118-123`) keyed on `getClientIp`, which prefers `cf-connecting-ip`
    (`web/lib/rateLimit.ts:185-189`) — behind Cloudflare that is the site's NAT egress address, shared by every
    machine at the site. Move the check **inside** `handlePost`, after `requireMachineAuthAndScope` has resolved
    `siteId` / `machineId`, keyed `screenshot_upload:{siteId}:{machineId}`, following the existing in-handler
    precedent at `web/app/api/agent/alert/route.ts:178-189` (`checkRateLimit(limiter, key)` → on `!success`, the
    same 429 problem shape and `getRateLimitHeaders` the wrapper produces, so the response contract does not
    change). Remove the `withRateLimit` wrapper; unauthenticated floods are bounded by the 401 in
    `requireMachineAuthAndScope`, which signs nothing and touches no storage. **State the chosen ceiling against
    the real cadence in the route's doc comment:** talon visual checks run at up to one per five seconds per
    machine (`web/lib/talons/visualCheck.server.ts:12-15`) = 720/hour, so 300/hour is reachable by a single busy
    machine — either raise the per-machine ceiling above that cadence or say in writing why 300 is right. The
    fielded 3.3.6 agent raises `ScreenshotCaptureError` with no retry on a 429
    (`agent/src/screenshot_capture.py:222-225`; the retry logic at `:246-270` covers only the signed-URL PUT), so
    **a normal fleet must not be able to reach the limit.** Update the `finalize` route's doc comment, which
    currently says "would halve the per-IP screenshot budget" — it is no longer per-IP. Do not add a new limiter to
    `rateLimit.ts` unless the ceiling changes; reuse `apiRateLimit`.
  - Done when: a unit test asserts two machines at one site get **independent** budgets and that the 429 body and
    headers are unchanged from the wrapper's; `npx eslint` and `npx tsc --noEmit` clean; `cd web && npm test`
    green; and `grep -n "identifier: 'ip'" web/app/api/sites/\[siteId\]/machines/\[machineId\]/screenshots/upload-url/route.ts`
    returns nothing.
  - Depends on: the forward-merge.

- [ ] **Task 0.3: Env-surface housekeeping on `dev`** `[agent]`
  - Files: `infra/swoop-signal/README.md`, `web/app/api/agent/swoop/bundle/route.ts` (comment only),
    `.claude/skills/env-management.md`, `scripts/env-manifest.json` (the `classes` note only),
    `web/playwright.config.ts`, `web/.env.example`
  - Do: Clear the documentation drift that would mislead whoever runs Wave 1 (env-vars "Housekeeping"). Four stale
    claims: (1) `infra/swoop-signal/README.md:72-80` and (2) `web/app/api/agent/swoop/bundle/route.ts:62-67` both
    say the manifest has no `_PREVIOUS` row — it has two, `scripts/env-manifest.json:113` and `:116`; (3) the
    README also says the deploy workflow has never run — it has run seven times, six successfully, most recently
    on `dev` 2026-09-19, which is what created `signal-dev.owlette.app`; (4) `.claude/skills/env-management.md:53-56`
    and the `must-match` note at `scripts/env-manifest.json:35` both say there are **three** `must-match` keys —
    there are **seven** (`LLM_ENCRYPTION_KEY`, `MFA_ENCRYPTION_KEY`, `SESSION_SECRET`, `TURNSTILE_SECRET`,
    `SWOOP_JWT_PRIVATE_KEY`, `SWOOP_SESSION_MASTER_KEY`, `SWOOP_SIGNAL_RING_SECRET`). Then classify the three
    newly-documented secret-shaped keys in `web/playwright.config.ts` so a developer who copies `web/.env.example`
    can still run e2e: `CLOUDFLARE_TURN_KEY_API_TOKEN`, `R2_S3_SECRET_ACCESS_KEY` and `CLOUDFLARE_API_TOKEN` all
    match `SECRET_SHAPED` (`:63`) and are in neither list, so `auditEnvLocalForUnclassifiedSecrets()` (`:106`)
    throws. All three reach third parties → `THIRD_PARTY_CREDENTIALS` (`:34-40`). Note that
    `CLOUDFLARE_TURN_KEY_ID` does **not** match the pattern and needs no entry. Finally, `web/.env.example:203-204`
    adds bare `CLOUDFLARE_ACCOUNT_ID=` / `CLOUDFLARE_API_TOKEN=` lines that appear in neither the manifest's `vars`
    nor its `never-set` inventory — copied into Railway they read as undeclared drift and fail `check`. Either add
    them to `never-set.keys` with a reason (they are local tooling, per `.claude/.env.example`) or mark them
    local-only in the example's own comment; read `scripts/env-manifest.json:38` first — registering a key under
    `vars` with empty `targets` **permanently silences** the undeclared alarm and is the wrong fix. Also update the
    `_PREVIOUS` comment at `web/.env.example:190-195`, which says "leave unset", to match Task 1.2's empty-string
    convention. Change no `targets` array and no key class.
  - Done when: `grep -rn "three" .claude/skills/env-management.md` and the manifest's `classes.must-match` note
    both describe seven, naming all seven; `grep -rn "has no row\|never run\|no row for it yet" infra/swoop-signal/README.md web/app/api/agent/swoop/bundle/route.ts`
    returns nothing; `cd web && npx playwright test --list` starts without throwing with all three keys present in
    a local `web/.env.local`; `cd web && npm test -- envManifest` green
    (`web/__tests__/infra/envManifest.test.ts` covers the eight swoop keys' classes and targets); `npx eslint`
    clean on the config.
  - Depends on: the forward-merge.

- [ ] **Task 0.4: Changelog, version, tracked plan — and freeze the promotion base** `[agent]` + `[human]` sign-off
  - Files: `docs/changelog.md`, `web/content/docs/changelog.mdx`, `dev/active/prod-promotion/**` (force-added),
    and — only if a version file disagrees — whatever `node scripts/sync-versions.js 3.3.6` rewrites
  - Do: `manual-infrastructure.md:324-329` declares its order supersedes `production-deploy.md` steps 6-9, and its
    step 1 is changelog + version, committed first: "nothing downstream is safe to build until this lands."
    **Changelog:** in **both** files (`web/content/docs/changelog.mdx` is the published one), fold the two
    `[Unreleased]` metrics-chart items into the existing `## [3.3.6] - YYYY-MM-DD` entry as web bullets, and add
    the entries the promotion currently ships with none (`grep -i swoop docs/changelog.md` → no matches): swoop
    (**one line: it ships disabled by default, pending its own release**), the cross-platform agent, machine OS
    reporting, the logs multi-select action filter, docs search, restart schedules, and the two behaviour changes
    users will notice — `403` on self-demote/self-remove, and the `capability_enforcement` switch no longer
    covering the swoop capabilities (plan R10). Match the surrounding voice: lowercase `### verb — plain-English
    headline`, prose, no ticket numbers. **`[Unreleased]` ends empty or absent.**
    **🔴 `[human]` sign-off before this commit:** the `[3.3.6]` entry as inherited from `release/3.3.6` describes
    the install-directory hardening in operational detail and this commit publishes it to owlette.app/docs/changelog
    (plan risk R5, memory `project_install_dir_hardening.md`). The owner confirms the disclosure hold is satisfied,
    or holds the promotion, or approves a shortened entry. Do not resolve it by dropping the entry.
    **Version:** run `node scripts/sync-versions.js` with no arguments to print the status. If every file already
    reads `3.3.6` after the forward-merge, change nothing and say so. If any disagrees — the forward-merge research
    records version-string conflicts in `agent/host/Cargo.lock` and `desktop/src-tauri/Cargo.lock` — run
    `node scripts/sync-versions.js 3.3.6` and re-check. It writes `/VERSION`, `agent/VERSION`,
    `web/package.json`, `desktop/package.json`, `desktop/src-tauri/tauri.conf.json` and the `desktop`, `host` and
    `swoop` `Cargo.toml`s; `firestore.rules`'s own version is independent and stays at `2.11.0`.
    **Tracked plan:** `git add -f dev/active/prod-promotion/` so plan, tasks and both research files survive the
    working tree, exactly as `dev/active/swoop/` is (research open question 11).
    **Freeze:** after the commit lands and CI is green, record the promotion base SHA at the top of this file and
    in plan.md. Every Wave 2 gate runs against that SHA. **Do not push a `v3.3.6` tag** — `build-installer.yml` is
    tag-triggered and 3.3.6 is already built, released and fielded.
  - Done when: `grep -n "^## \[" docs/changelog.md web/content/docs/changelog.mdx` shows no `[Unreleased]` with
    content and a `[3.3.6]` entry in both; `grep -ci swoop docs/changelog.md web/content/docs/changelog.mdx` is
    non-zero in both; `node scripts/sync-versions.js` prints `3.3.6` on every line; `git ls-files dev/active/prod-promotion`
    lists four files; `git rev-parse origin/dev` matches the recorded promotion base; `git tag --points-at HEAD`
    is empty.
  - Depends on: 0.1, 0.2, 0.3.

---

## Wave 1: prod preparation `[human]`

Every task here writes to production. Each needs its own explicit go. Days ahead of the push is fine and preferred.

- [ ] **Task 1.1: Firestore export, then the `swoop_sessions` index, then the `Enabled` gate** `[human]`
  - Files: none (`firestore.indexes.json:288-296` is the source; do not edit it)
  - Do: Retire risk R4 (plan D3). In order, per `manual-infrastructure.md:324-345` steps 2-4:
    (1) cheap insurance, even though no migration is needed —
    `gcloud firestore export gs://owlette-prod-backup/pre-3.3.6-$(date +%Y%m%d-%H%M) --project owlette-prod-90a12`;
    (2) `firebase deploy --only firestore:indexes --project prod` — **the `--project prod` is the whole task**
    (standing rule; `manual-infrastructure.md:21-26`);
    (3) wait. `firebase deploy` returns when the build is *enqueued*, not `READY`. A query against a building index
    fails `FAILED_PRECONDITION`, and the talon stale-run janitor swallows that inside its own error boundary, so the
    symptom is silent degradation rather than an alarm.
    The index is `swoop_sessions` / `COLLECTION_GROUP` / `siteId:ASC, state:ASC`, needed by
    `web/lib/swoop/sessionStore.server.ts:219-226` via `revokeViewerSessions.server.ts:24`,
    `web/app/api/cron/swoop-retention/route.ts` and the kill route. It is additive; **on a rollback, leave it**.
  - Done when: `firebase firestore:indexes --project prod` lists **35** composite indexes where it listed 34, and
    `gcloud firestore indexes composite list --project owlette-prod-90a12` shows the `swoop_sessions` entry with
    state **`READY`** / **`Enabled`**, not `CREATING` / `Building`. Paste the entry. The same two commands are the
    ones that would catch a deploy mis-targeted at dev — if prod still shows 34, check
    `firebase firestore:indexes --project dev` for 36 before re-running.
  - Depends on: nothing. Can run before Wave 0 finishes.

- [ ] **Task 1.2: The ten keys on `railway-prod`, the four on `railway-dev`** `[human]`
  - Files: none (never a values file; `scripts/env-manifest.json` is the key registry and is not edited here)
  - Do: Plan D4. **Start from the diff, not from memory:** `node scripts/sync-env.mjs diff railway-dev railway-prod`
    prints a key-presence diff and is the checklist. At research time `railway-prod` was missing exactly the ten new
    keys and nothing else, and `railway-dev` was missing four. Set, on `railway-prod`:
    `SWOOP_JWT_KID`, `SWOOP_JWT_PRIVATE_KEY`, `SWOOP_JWT_PUBLIC_KEY`, `SWOOP_SESSION_MASTER_KEY`,
    `SWOOP_SIGNAL_RING_SECRET`, `SWOOP_SIGNAL_URL=https://signal.owlette.app`, `CLOUDFLARE_TURN_KEY_ID`,
    `CLOUDFLARE_TURN_KEY_API_TOKEN`, and the `_PREVIOUS` pair (`SWOOP_JWT_KID_PREVIOUS`,
    `SWOOP_JWT_PUBLIC_KEY_PREVIOUS`) as **empty strings**. On `railway-dev`, set the four it lacks: the
    `CLOUDFLARE_TURN_*` pair and the same `_PREVIOUS` pair as empty strings. Address the services by flag —
    `-s owlette-prod -e dev` and `-s owlette-dev -e dev`; both live in the single `dev` environment and there is no
    environment named "production" (`.claude/skills/env-management.md:17`).
    Four things to get right:
    • **The empty strings are deliberate and sufficient.** `missing = declared − live` (`sync-env.mjs:93`) and
      `liveKeys` counts keys by name (`:45-53`), so an empty value reads as present; the consumer is falsy-guarded
      at `web/app/api/agent/swoop/bundle/route.ts:73`. Without them `check` is red forever.
    • **`SWOOP_SIGNAL_RING_SECRET` must be byte-identical across `railway-prod`, `vercel-prod` and — later — the
      prod Worker.** The Worker is not deployed by this plan, so **generate the value now, store it where the swoop
      plan's Worker setup will read it, and hand it over.** Note the Worker's own names differ: it takes
      `SWOOP_JWT_KID_PREV` / `SWOOP_JWT_PUBLIC_KEY_PREV`, **not `_PREVIOUS`** (env-vars §5).
    • **If the owner has no Cloudflare Realtime TURN key yet**, set the `CLOUDFLARE_TURN_*` pair to **empty
      strings** on all targets rather than inventing values: `credentials()` at `web/lib/swoop/turn.server.ts:52-56`
      is falsy-guarded and returns null, which is exactly today's STUN-only behaviour on dev, and `check` still goes
      green.
    • **Setting `SWOOP_SIGNAL_URL` before the Worker exists is an accepted trade** (plan R7): it replaces a clean
      `503 swoop_not_configured` with a 201 whose `wss` dial cannot resolve. It is unreachable while swoop is off
      per site, and setting it now makes the undetermined `web/proxy.ts` Edge-inlining question moot (env-vars §4).
      **No site is enabled until the prod Worker exists.**
    Never echo a value. Do not touch the `firebase` section of anything, and do not set the three dev-only keys on
    prod (see Task 2.3).
  - Done when: `node scripts/sync-env.mjs diff railway-dev railway-prod` shows no key present on one and absent on
    the other among the ten; a keys-only read of each service confirms all ten names on `railway-prod`
    (`railway variables -s owlette-prod -e dev --json | node -e "…Object.keys…"` — names only, per the standing
    rule); and `railway-dev` no longer reports four missing. Record which keys were set to empty strings and why,
    in this file.
  - Depends on: nothing. Must complete **before** the Wave 3 build, not just before the merge.

- [ ] **Task 1.3: Confirm whether the failover load balancer exists, and which origins are in its pool** `[human]`
  - Files: none
  - Do: Settle plan R2 / D7 — the one question the research could not answer, because the
    `CLOUDFLARE_API_TOKEN` in `.claude/.env.local` is the Workers deploy token and lacks *Zone › Load Balancers ›
    Read* (it can list zones; the LB list returns `{"code":10000,"message":"Authentication error"}`).
    `.claude/skills/cf-load-balancing.md:17-20` says no LB, pool or monitor existed as of 2026-09-10 and that the
    May 2026 apply was destroyed the same day — while `vercel-origin.owlette.app/api/health` answers today on
    `da031235`, one promotion behind prod. Either the Cloudflare dashboard (owlette.app → Traffic → Load
    Balancing) or one command with an LB-scoped token settles it:
    `curl -H "Authorization: Bearer $TOKEN" https://api.cloudflare.com/client/v4/zones/<zone_id>/load_balancers`.
    Record: does an LB on `owlette.app` exist; which pools are in `default_pool_ids` and in what order; is
    `steering_policy` still `"off"`; are both pools `enabled`; and is `vercel-origin.owlette.app` still DNS-only
    (grey cloud — proxying it breaks Vercel's HTTP-01 renewals). **Change nothing.** Do not `terraform apply`:
    `infra/cloudflare/` is byte-identical `main`↔`dev`, there is no `terraform.tfvars` and no `*.tfstate` in this
    checkout, and applying moves `owlette.app` behind the LB immediately. If the LB does not exist, standing it up
    is separate work and the answer to record is "there is no automatic failover", which changes what Task 3.3
    proves but not whether it runs.
  - Done when: the answer, with the raw JSON or a dashboard screenshot reference, is written into this file, and
    Task 3.3's read-back is adjusted to match (with an LB: both origins must serve one commit; without: the Vercel
    origin is a manual standby and its commit is recorded, not relied on).
  - Depends on: nothing.

- [ ] **Task 1.4: Record the rollback anchors and confirm the Railway → Firebase mapping** `[human]`
  - Files: none
  - Do: Two things that can only be done *before* the push. (1) **The abort anchor.** Railway's "redeploy previous
    deployment" is the fast rollback and is documented in no runbook (research §4.6 gap 1); the id is hard to find
    once a new deployment supersedes it. `railway status --json` (project `owlette`, environment `dev`, service
    `owlette-prod`) reports the active deployment id and its commit — at research time deployment `49cbfb29`,
    commit `73f5d512`. Record both, plus the exact dashboard click-path (Railway → `owlette-prod` → Deployments →
    the entry → Redeploy), in this file **and** in Task A.1. Record `git rev-parse origin/main` as the code-path
    anchor too. (2) **The one-time prerequisite `production-deploy.md:43-45` asks for and the repo cannot prove**
    (research §4.0, `dev-to-prod-workflow.md:26-29`): confirm the `owlette-prod` service's `FIREBASE_PROJECT_ID`
    really names `owlette-prod-90a12` and that its R2 bucket is the prod one. This needs reading two values, so it
    is the owner's to do in the Railway dashboard; **report only "confirmed" or "mismatch", never the values.**
  - Done when: the deployment id, its commit, `origin/main`'s SHA and the click-path are written into this file and
    into Task A.1; and the project mapping reads confirmed. A mismatch stops the promotion.
  - Depends on: nothing.

---

## Wave 2: verification on the promotion base

All four gates in plan D10, plus the two walkthroughs. Every one runs against the **frozen promotion base** from
Task 0.4. If `dev` has moved, re-freeze and re-run — do not reason about which gate "was probably still valid".

- [ ] **Task 2.1: `/preflight` clean on the promotion base** `[agent]`
  - Files: none
  - Do: Run `/preflight` (`.claude/commands/preflight.md`) on a `dev` checkout at the promotion base. It runs, in
    order: `node scripts/check-security-alerts.mjs` (exit 1 ⇒ stop); the e2e scope check; `cd web && npm run lint`
    and `npx tsc --noEmit`; `cd web && npm test` (~4400 jest tests); `cd web && npm run test:rules` (121 tests
    across 5 files — `web/__tests__/rules/` gained the `swoopSessions` spec, so this one matters here, and it must
    finish before e2e because both want port 8080); `cd web && npm run e2e` (a real production build, then
    Playwright against the Firebase emulators, app on :3100). Prereqs: JDK 21 on PATH, `firebase-tools@15`
    globally, chromium installed once. Fix every red on `dev` and re-run; do not waive, and do not ack a security
    finding on your own judgment — `verify:*` keys are refused outright and every ack needs the owner's written
    reason in the release commit body.
  - Done when: every step exits 0 and `check-security-alerts.mjs` prints `RESULT: CLEAR` **on the promotion base**
    (the research's CLEAR was on `docs/dashboard-coverage`, a different ref). Paste the summary lines.
  - Depends on: 0.4.

- [ ] **Task 2.2: `npm run smoke:dev` green on the exact promotion base** `[agent]`
  - Files: none
  - Do: The gate `/preflight` does not run and nothing in CI enforces (risk R3b, `production-deploy.md:139-190`).
    From a `dev` checkout pulled to the promotion base: `cd web && npm run smoke:dev`. It waits up to 10 minutes
    for `https://dev.owlette.app/api/health` to report `origin/dev` HEAD, then drives a real browser against dev: a
    hoot turn with a tool call, cancel mid-turn, a denied tier-3 call, a public share link, passkey registration
    and sign-in, and per-site member management. **All four conditions must hold** (`:157-173`): exit 0 with a
    summary `commit` line reading `<sha> (origin/dev; dev served it when the specs started)`; that SHA still
    `origin/dev` at merge time — re-run `git fetch origin dev && git rev-parse origin/dev` immediately before Task
    3.1; **no** `--any-commit`; **no** forwarded `-- --grep`; and **no `WARNING` line** in the summary. A red run
    blocks the promotion: fix forward on `dev` and re-run on the new commit. Record any check marked `FLAKY` (it
    passed only on its retry). Note what this does **not** cover: swoop (`web/e2e-live/README.md:1-7` scopes it to
    the seven flows above), the cross-platform agent work, and restart-schedule authoring — Task 2.5 covers those
    by hand.
  - Done when: the summary is pasted here showing exit 0, the `commit` line in the exact required form, and no
    `WARNING`.
  - Depends on: 0.4, and dev having deployed the promotion base.

- [ ] **Task 2.3: `sync-env.mjs check` green, the diff checklist closed, the three dev-only keys decided** `[human]`
  - Files: none
  - Do: First, link the Vercel CLI — `web/.vercel` is absent in this checkout, so `sync-env.mjs status` exits 1 at
    the Vercel step with "Your codebase isn't linked to a project on Vercel", and neither `status`, `check` nor
    `sync vercel-prod` can run until it is linked (project `owlette`, target `production`;
    `.claude/skills/env-management.md:88`). Then run `node scripts/sync-env.mjs check` — it must exit **0** across
    all three targets, no missing and no undeclared. `.claude/skills/env-management.md:65` mandates it before a
    prod deploy; **do not waive it.** Then close the checklist from `node scripts/sync-env.mjs diff railway-dev
    railway-prod`: every remaining asymmetry is either intended (a dev value differing from a prod value is
    invisible to this tool, which compares key presence only) or gets a decision written here. Finally, decide the
    three dev-only debugging keys explicitly, one line each (plan D4; recommended: all three stay off
    `railway-prod`): `RATE_LIMIT_OBSERVE_ONLY` — on prod it would turn rate-limit enforcement into logging;
    `W8_1_DRILL_TS` — a `railway-dev`-only security-boundary drill timestamp, read by
    `web/e2e/specs/security-boundary/` which the default suite excludes; `SECURITY_BOUNDARY_SENTRY_METRICS` —
    belongs with the drills. Remember what a green `check` does **not** prove: Vercel stores sensitive vars
    write-only, so coverage is provable and **value equality never is** — only Task 3.3's `sync --apply` makes the
    three `must-match` values equal.
  - Done when: `node scripts/sync-env.mjs check` exits 0 (paste the tail); the diff output is pasted with a
    decision beside every asymmetry; and the three dev-only keys each carry a written decision.
  - Depends on: 1.2, 0.3.

- [ ] **Task 2.4: Fleet-path probes, and a live heartbeat + screenshot from a paired 3.3.6 machine** `[agent]`
  - Files: none
  - Do: Prove success criteria 3 and 4 *before* the push, against dev, so the post-push run has a baseline.
    (1) **Contract proof, static:** re-run the blob comparison for the nine pre-existing agent routes plus
    `web/app/api/_shared.ts`, `/api/chunks/download-urls`, `/api/roosts/[roostId]/version-url` and
    `/api/bug-report` — `git rev-parse origin/main:<path>` vs `origin/dev:<path>` for each. All thirteen were
    identical at research time. **Note the one correction to the research:**
    `…/screenshots/finalize/route.ts` also differs, comment-only (a note that finalize is deliberately not
    separately rate-limited, and a reworded `MAX_HISTORY` comment) — confirm that is still all it is, and remember
    Task 0.2 edits that comment.
    (2) **Live probe, unauthenticated, against dev and prod, recorded side by side:** each of the nine agent routes
    plus the two screenshot legs, asserting a status code that is neither 404 nor 5xx and matches between the two
    hosts. `curl`, never python `urllib` — Cloudflare bot-blocks the latter with `error code: 1010`. Keys for
    authenticated probes are in `.claude/.env.local` (`OWLETTE_API_KEY` for dev against `$OWLETTE_DEV_API_URL`;
    `OWLETTE_API_KEY_PROD` is **installer-scoped only** and 403s `scope_insufficient` on site/machine routes).
    Reads need no approval; **fire no mutating call.**
    (3) **If a paired 3.3.6 machine exists** (`[human]` to confirm which, and to pair one if not): watch one
    heartbeat land (`lastSeen` advances, the machine reads online) and drive one on-demand screenshot through the
    full three legs — `POST …/screenshots/upload-url` → the signed `PUT` → `POST …/screenshots/finalize` — plus one
    legacy live-view frame through `POST /api/agent/screenshot`. If no machine is paired, say so plainly; the
    criterion then moves to Task 4.3's watch and the promotion carries that as an unverified item.
  - Done when: a table of the thirteen blob comparisons and the eleven status-code probes (dev vs prod) is in this
    file; and either a heartbeat + a completed three-leg screenshot upload is recorded, or the absence of a paired
    machine is recorded as an explicit unverified item.
  - Depends on: 0.2 (the rate-limit change must be the code under test).

- [ ] **Task 2.5: Staging walkthrough** `[human]`
  - Files: none
  - Do: Plan D11. Check first whether a Railway PR environment or a Vercel preview of the promotion base is
    actually available: the research found one Railway project with one environment and exactly two services
    (`owlette-prod` ← `main`, `owlette-dev` ← `dev`), no PR-environment config in the repo, and
    `.claude/skills/cf-load-balancing.md:14-15` records that the Vercel project's Ignored Build Step cancels every
    deployment that is not `main` — so **a Vercel preview is structurally impossible** and the expected answer is
    "neither is available". Then walk the critical flows by hand at `https://dev.owlette.app` on the promotion base
    and **say in writing that this was dev, not a prod-shaped staging environment**: login including passkey; the
    site list and the machine list (card and list views); machine detail; roost; the billing pages; docs (including
    search, which changed); and `/download`. Also exercise the three things no automated gate covers and that are
    **not** inert: the logs multi-select action filter, restart-schedule authoring, and a machine whose agent
    reports `osFamily` / `osVersion` alongside one that does not. Confirm no machine card offers a swoop entry.
  - Done when: a pass/fail line per flow is in this file, with the environment named, plus a screenshot or a note
    for anything that looked wrong; and the availability answer for a Railway PR environment / Vercel preview is
    recorded either way.
  - Depends on: 0.4, and dev having deployed the promotion base.

---

## Wave 3: the push `[human]`

Nothing in this wave starts until Waves 0-2 are complete and the owner says go, in this sitting.

- [ ] **Task 3.1: PR `dev` → `main`, merged as a regular merge commit** `[human]`
  - Files: none
  - Do: Immediately first: `git fetch origin dev && git rev-parse origin/dev` — it must equal the promotion base
    Task 2.2 smoked. If `dev` has moved, stop and re-run Wave 2 on the new commit. Then open the PR `dev` → `main`
    and merge it as a **regular merge commit, not a squash** (`dev-to-prod-workflow.md:123-124`), subject
    `chore: merge dev for v3.3.6 production release`. The body carries: the promotion base SHA, the four gate
    results, the Wave 1 read-backs (index `Enabled`, keys set), any acked security finding with its written reason,
    and the abort anchor from Task 1.4. Branch protection on `main` requires three checks — `run suite against
    firebase emulators`, `firestore rules tests`, `lint, types and unit tests` — with
    `required_approving_review_count: 0`, `enforce_admins: false`, `strict: false`, so it is self-mergeable the
    moment they are green. **Know what that does and does not buy:** the checks gate the PR, not the deploy —
    Railway watches the `main` branch through its own integration, nothing sequences it after the checks, and a red
    `playwright e2e` on the push neither stops nor rolls back the deploy (research §4.1). **Do not push a tag.**
  - Done when: the merge commit is on `origin/main`, its SHA is recorded here, `git log --first-parent origin/main -1`
    shows it, and `git diff origin/main origin/dev --stat` is empty.
  - Depends on: 2.1, 2.2, 2.3, 2.4, 2.5, and A.1 being written.

- [ ] **Task 3.2: Watch Railway and the `main` workflows to completion, then read back** `[human]`
  - Files: none
  - Do: Watch the Railway build for `owlette-prod` to completion before anything else (`manual-infrastructure.md:8`
    — "watch the build to completion before smoke checks"). Then read back:
    `curl -s https://owlette.app/api/health` must report `{"ok":true,"origin":"railway","commit":"<merge sha>"}`.
    `curl -s https://owlette.app/api/openapi | jq '.paths|length'` must read **120**, up from 114
    (`info.version` stays `2.3.1` — expected, not a failed bump). Swoop posture:
    `GET /api/sites/x/swoop-settings` → **401** (was 404), `GET /swoop/x/y` → **307** to `/login`.
    Then the workflows the push fires: `gh run list --branch main --limit 20` and watch with
    `gh run watch <id> --exit-status` in the background — `e2e`, `functions`, `agent-tests`, `rust-build`,
    `openapi-validate`, `admin-sdk-guard`, `no-token-logs`, `repo-refs`, `codeql`, `zizmor`, `loc-metric`,
    `security-preflight`. On a failure: `gh run view <id> --log-failed`, diagnose, and **propose** a fix — never
    auto-fix-and-repush, `main` is protected and `dev` auto-deploys.
    **🔴 The check that proves Task 0.1 worked:** `gh run list --workflow swoop-signal-deploy.yml --limit 10` must
    show **no run** for the merge commit, and `dig +short signal.owlette.app` must still return nothing
    (NXDOMAIN). If a run appears, the prod Worker and its one-way `v1` Durable Object migration have been created —
    stop, do not redeploy over it, and read `infra/swoop-signal/README.md`'s rollback section before touching
    anything.
  - Done when: every read-back above matches, no `main` workflow is red, `swoop-signal-deploy` shows no run for the
    merge commit, and `signal.owlette.app` is still NXDOMAIN. Paste each result.
  - Depends on: 3.1.

- [ ] **Task 3.3: Vercel — sync the mirror, deploy the same commit, prove one build on both origins** `[human]`
  - Files: none
  - Do: `node scripts/sync-env.mjs sync vercel-prod --apply`. It reads `railway-prod` as the source and is the
    **only** way to guarantee `SWOOP_JWT_PRIVATE_KEY`, `SWOOP_SESSION_MASTER_KEY` and `SWOOP_SIGNAL_RING_SECRET`
    are byte-identical across the mirror, because Vercel stores sensitive vars write-only and no check can compare
    them (`.claude/skills/env-management.md:76-80`; `manual-infrastructure.md:53` calls this mirror
    "CATASTROPHICALLY SILENT"). It is idempotent. Never sync `RAILWAY_*` — the tool filters them, and
    `RAILWAY_PUBLIC_DOMAIN` on Vercel would break the `/api/health` origin label. Then get Vercel to **build the
    new `main`**: it was on `da031235`, one promotion behind prod even before this push, and its env vars are
    applied at build time. Then read both origins:
    `curl -s https://owlette.app/api/health` and `curl -s https://vercel-origin.owlette.app/api/health` must report
    the **same** `commit`, with `origin` reading `railway` and `vercel:<region>` respectively. Adjust the assertion
    to Task 1.3's answer: with an LB, this is the failover contract; without one, record the Vercel commit as a
    manual standby rather than relying on it. Leave `vercel-origin.owlette.app` DNS-only (grey cloud) — proxying it
    breaks Vercel's HTTP-01 renewals.
  - Done when: `sync --apply` reports every declared key written; both `/api/health` responses are pasted showing
    the same commit; and `node scripts/sync-env.mjs check` still exits 0.
  - Depends on: 3.2, 1.3, 2.3.

---

## Wave 4: post-deploy and the 24-hour watch `[human]`

- [ ] **Task 4.1: The post-deploy check set, and the tag decision** `[human]`
  - Files: none
  - Do: `manual-infrastructure.md:377` step 10, adapted. Run
    `node scripts/check-status-page-ready.mjs --base-url https://owlette.app` and
    `node scripts/checks/smoke-r2-roundtrip.mjs --base-url https://owlette.app --site <id> --api-key owk_…`.
    Confirm the two intended behaviour changes with a real session (plan R10): a site owner attempting to demote or
    remove **their own** membership row gets `403 cannot_modify_own_membership`; and, from the same session, a
    `POST …/machines/{m}/swoop/sessions` returns **403 `swoop_disabled`** rather than 500 or 201 — which also
    proves the swoop path fails closed with no Worker behind it. Walk the same flows as Task 2.5, now on
    `owlette.app`. **The tag:** `manual-infrastructure.md` step 10 ends "tag the release", but
    `build-installer.yml` is triggered by `v[0-9]+.[0-9]+.[0-9]+` and the 3.3.6 installer is already built,
    released and fielded — so **do not push `v3.3.6`**. Record the decision and, if the owner wants a marker for
    the web promotion, use a non-matching name (e.g. `web-3.3.6`) after checking it against every workflow's tag
    filter first.
  - Done when: both scripts are green, both behaviour checks return the expected 403s, the flow walkthrough passes,
    and the tag decision is written here with the filter check that backs it.
  - Depends on: 3.2.

- [ ] **Task 4.2: Register `cron-swoop-retention` for prod** `[human]`
  - Files: none (`infra/cron-jobs.json:152-175` is a registry — nothing applies it)
  - Do: Last, once the route is serving (`manual-infrastructure.md:374-376`: "a job scheduled against a route that
    does not exist yet just logs 404s nobody reads"). Create the cron-job.org entry for prod:
    `GET https://owlette.app/api/cron/swoop-retention`, header `X-Cron-Secret` with prod's `CRON_SECRET` raw (not
    `Bearer`), schedule `30 4 * * *`, timeout ≥ 30 s. There is no API and no Terraform for this — vendor UI only.
    **Its failure mode is silent:** nothing errors, and session documents naming the user who started each session
    and every viewer in it accumulate forever with no other deletion path, while abandoned records keep answering
    as live to the revocation sweep. Read the response body, not just the status: `truncated:true` means the run hit
    a ceiling and records remain; a steadily non-zero `closed` count is a bug upstream, not a healthy sweep.
  - Done when: one manual run returns **200** with `truncated:false`, the body is pasted here, and the job shows
    enabled on the `30 4 * * *` schedule. The next scheduled run is checked in Task 4.3.
  - Depends on: 3.2.

- [ ] **Task 4.3: The 24-hour watch** `[human]`
  - Files: none
  - Do: Watch the things that fail late rather than at deploy. Hourly for the first three hours, then at 24 h:
    `curl -s https://owlette.app/api/health` stays 200 with the merge SHA (a 503 means the origin cannot reach
    Firestore and, if the LB exists, that it is about to be failed out — never probe `/api/cron/health-check`
    instead, it is a write-side cron route needing `X-Cron-Secret`). **Agent heartbeats:** the fleet's `lastSeen`
    values keep advancing and no machine drops to offline in a pattern that starts at the deploy.
    **Screenshot uploads:** on-demand and talon visual-check screenshots complete, and the `api-ops` limiter
    records **zero** 429s for the fleet — the fielded agent has no retry on a 429, so any 429 at all is a finding,
    not noise. **Sentry:** no new issue class attributable to the release; pay attention to
    `problemFromError → ProblemType.Internal` from any `swoop/*` path, which would mean something reached the swoop
    code that should have been gated off. **`/download`** serves the 3.3.6 installer. And `cron-swoop-retention`
    has run once on its own schedule returning 200.
  - Done when: the 24-hour observations are written here, each as a value not an impression; and either the
    promotion is declared complete or Task A.1 is executed.
  - Depends on: 4.1, 4.2.

---

## Abort

- [ ] **Task A.1: Write, rehearse and — only if needed — execute the abort** `[human]`
  - Files: none (the write-up belongs in `docs/runbooks/hotfix-rollback.md`, which names this gap itself at
    `:453-475`; **do not edit it during an incident**)
  - Do: **Written before Task 3.1, not during an incident.** Trigger: a red read-back in Task 3.2, a 5xx spike,
    broken agent heartbeats, or a broken dashboard critical flow.
    1. Stop. Do not push a fix forward under pressure, and do not revert first.
    2. **Fast path — Railway → `owlette-prod` → Deployments → the pre-promotion entry → Redeploy.** No build, no
       git, minutes. The deployment id and its commit come from Task 1.4 (at research time deployment `49cbfb29`,
       commit `73f5d512`). Paste the recorded id and click-path into this task now, so it is here when it is
       needed. This is the fastest lever available and it is in no runbook (research §4.6 gap 1).
    3. **Code path — `git revert -m 1 <merge sha>` on `main` through a PR.** `-m 1` keeps `main`'s first-parent
       line. No force-push. The three required checks must go green on the revert PR like any other. No runbook
       covers reverting a 170-commit merge and the repo's own precedent is a cautionary tale
       (`hotfix-rollback.md:341-345`), which is why step 2 comes first.
    4. **Leave alone:** the `swoop_sessions` index (deleting it only breaks swoop queries; rebuilding is slow), the
       new env vars (every read is lazy, inside a function body, and every consumer fails closed or degrades within
       swoop only — §3.1), and the Vercel origin (already on an older commit).
    5. **No Worker rollback is needed** — Task 0.1 keeps it out of the push, so there is no one-way door in this
       promotion. If one is ever deployed: `cd infra/swoop-signal && npx wrangler deployments list -e prod` then
       `npx wrangler rollback <version-id> -e prod`. It does not touch secrets and it does **not** undo a Durable
       Object migration, so a rollback across `v1` is not a rollback.
    6. Diagnose on `dev`, fix forward, re-enter at Wave 2.
    **Rehearsal:** check whether Railway permits redeploying a previous deployment of `owlette-dev` and, if so,
    rehearse step 2 there — time it and record how the dashboard behaves. If Railway does not allow it, record
    that the fast path is unrehearsed, which is itself the finding.
  - Done when: steps 1-6 are written out with the real deployment id, the real click-path and the real merge SHA
    placeholder filled in, **before** Task 3.1 runs; the rehearsal is either recorded with a timing or recorded as
    not possible; and the write-up is copied into `docs/runbooks/hotfix-rollback.md` as its own section (a separate
    commit on `dev`, after the promotion settles — not during it).
  - Depends on: 1.4. Blocks 3.1.
