# prod promotion — Tasks
**Progress**: 10/20 complete — **promotion base frozen at `fdcf86d1` (dev, 2026-09-22 22:33 UTC, #175 merged)**

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

- [x] **Task 0.1: Gate the prod Worker deploy behind `workflow_dispatch`** `[agent]`
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

- [x] **Task 0.2: Re-key the screenshot upload rate limit on the machine, not the client IP** `[agent]`
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

- [x] **Task 0.3: Env-surface housekeeping on `dev`** `[agent]`
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

- [x] **Task 0.4: Changelog, version, tracked plan — and freeze the promotion base** `[agent]` + `[human]` sign-off
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

- [x] **Task 1.1: Firestore export, then the `swoop_sessions` index, then the `Enabled` gate** `[human]`
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

- [x] **Task 1.2: The ten keys on `railway-prod`, the four on `railway-dev`** `[human]`
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

- [x] **Task 1.3: Confirm whether the failover load balancer exists, and which origins are in its pool** `[human]`
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

- [~] **Task 1.4: Record the rollback anchors and confirm the Railway → Firebase mapping** `[human]`
  - Files: none
  - Do: Two things that can only be done *before* the push. (1) **The abort anchor.** Railway's "redeploy previous
    deployment" is the fast rollback and is documented in no runbook (research §4.6 gap 1); the id is hard to find
    once a new deployment supersedes it. `railway status --json` (project `owlette`, environment `dev`, service
    `owlette-prod`) reports the active deployment id and its commit — at research time deployment `49cbfb29`,
    commit `73f5d512`. Record both, plus the exact dashboard click-path (Railway → `owlette-prod` → Deployments →
    the entry → Redeploy), in this file **and** in Task A.1. Record `git rev-parse origin/main` as the code-path
  - **Anchors recorded 2026-09-22:** Railway `owlette-prod` deployment `49cbfb29` (SUCCESS, commit `73f5d512`, branch `main`, 2026-09-14T20:15Z) → Deployments → that entry → Redeploy; code anchor `origin/main` = `73f5d512`.
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

- [x] **Task 2.1: `/preflight` clean on the promotion base** `[agent]`
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

- [x] **Task 2.2: `npm run smoke:dev` green on the exact promotion base** `[agent]`
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

- [x] **Task 2.3: `sync-env.mjs check` green, the diff checklist closed, the three dev-only keys decided** `[human]`
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

- [~] **Task 2.4: Fleet-path probes, and a live heartbeat + screenshot from a paired 3.3.6 machine** `[agent]`
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

## Log
- 2026-09-22 — Prerequisite met: `release/3.3.6` is on `dev` (#174 → `23c42e1e`, 21:25 UTC); dev's CI green after
  one rerun of the macOS leg (`test_shared_utils.py::TestIdentityPathNormalisation::test_a_recorded_row_still_matches_after_a_restart`
  flaked once on dev and once on the PR; passes on rerun; dev's own identity code, untouched by the merge —
  worth a look on the macOS runner, not a promotion blocker); dev.owlette.app serves `23c42e1e`.
- 2026-09-22 — Wave 0 done as four commits on `chore/promotion-wave0` (branch off `23c42e1e`), **draft PR #175 →
  dev**, gates and CI running: 0.1 `3deb0bb6` (worker deploy: `push.branches: [dev]`, `workflow_dispatch`
  `environment` choice defaulting to dev, `WRANGLER_ENV` from the event, README says the prod deploy is a
  dispatch and must wait for the three secrets; local `wrangler deploy --dry-run` both envs ok, vitest 76 passed
  — vitest exits 127 on this Windows box after a green run, a workerd teardown quirk; CI is the proof, and the
  zizmor SARIF for the file is still to be read on the PR); 0.2 `34a74ebb` (per-machine key
  `screenshot_upload:{siteId}:{machineId}`, new `screenshotUploadRateLimit` 1000/h — 300/h was below the 720/h
  talon cadence, so a new limiter rather than `apiRateLimit`; `withRateLimit` exports `rateLimitedResponse` +
  `applyRateLimitCounters` so the 429 and the counters are shared, not copied; test: two machines behind one ip,
  independent budgets, 429 body + headers asserted; eslint/tsc clean; 64 tests in the four related suites);
  0.3 `aac01264` (all six spots; manifest JSON valid; envManifest test 4 passed; `playwright test --list` lists
  402 tests with the three keys present in a temporary `.env.local`; the surviving greps for "never run" /
  "three" are unrelated sentences); 0.4 `714b6240` (both changelogs: `[Unreleased]` empty, 3.3.6 entry gains
  eleven sections — the task's "restart schedules" item has no commit on `main..dev` touching the dialog, so
  no entry; the tri-platform entry says groundwork only, since no macOS/Linux installer exists; the R5
  sign-off was given by the owner earlier — the 3.3.6 entry is intended public; `sync-versions` prints 3.3.6 on
  every line; four plan files tracked; no tag at HEAD). **Freeze:** the promotion base is recorded once #175
  lands on `dev`.
- 2026-09-22 — Wave 0 gates on #175 (`714b6240`): local `npm run lint` 0 errors, `tsc` clean, jest 302 suites /
  6023 passed, e2e **400 passed** (the changelog anchors included); CI: swoop signal deploy (worker suite success,
  deploy skipped — a PR), playwright e2e, openapi drift check, CodeQL, Actions Security, dependency review and the
  quick gates all green (16 pass, 1 skip). **zizmor SARIF read** for `swoop-signal-deploy.yml`: four
  `ref-version-mismatch` Medium warnings (the `# v6` comments on the pinned checkout/setup-node hashes), identical
  to dev's scan of the same file before the change — nothing new, and no finding on the `inputs.environment`
  expression (used in `env:`, never in `run:`). #175 marked ready for review; the owner's "Go" merges it.
- 2026-09-22 — **#175 merged into `dev` as `fdcf86d1` on the owner's "Go". Promotion base = `fdcf86d1`.** Every
  Wave 2 gate runs against it; a later fix on `dev` moves the base and re-runs the gates. Remote branch deleted.
  dev's CI on the merge and the dev.owlette.app deploy being watched.
- 2026-09-22 — Task 2.4 (agent parts done; the live half needs the owner). (1) Blob comparison `origin/main` vs
  the base: the nine `/api/agent/*` routes, `_shared.ts`, `chunks/download-urls`, `roosts/[roostId]/version-url`
  and `bug-report` — **all thirteen identical**. `screenshots/finalize/route.ts` differs by two comments only
  (the not-separately-limited note, now "the machine's screenshot budget", and a reworded `MAX_HISTORY` comment);
  `screenshots/upload-url/route.ts` differs by design (Task 0.2). (2) Unauthenticated probes, dev / prod, status
  identical on every fleet route and none 404 or 5xx: `agent/site` POST 405/405 · `agent/alert` 401/401 ·
  `agent/screenshot` 401/401 · `auth/exchange` 400/400 · `auth/refresh` 400/400 · `auth/device-code` 200/200 ·
  `device-code/poll` 400/400 · `device-code/authorize` 400/400 · `generate-installer` 400/400 ·
  `screenshots/upload-url` 401/401 · `screenshots/finalize` 401/401 · `health` 200/200; control:
  `sites/x/swoop-settings` GET 401 on dev, 404 on prod (not yet promoted). **Note:** the device-code probe is a
  generating call — an empty POST minted one throwaway pairing phrase on each host (they expire unused); the
  other probes were refused before doing anything. (3) Live heartbeat/screenshot: this dev box's agent (3.3.5
  source via the deploy hook, paired to dev) could not be read — `OWLETTE_API_KEY` in `.claude/.env.local` is a
  placeholder (401), and the prod key is installer-scoped. **Owner:** a dev key with machine read scope, or the
  dashboard, to confirm a heartbeat; and a paired fielded 3.3.6 machine for the three-leg screenshot. Otherwise
  this stays an explicit unverified item carried to Task 4.3.
- 2026-09-22 — Task 2.2 blocked on a credential: `npm run smoke:dev` needs the dev service account at
  `agent/config/firebase-creds-dev.json` (or `SMOKE_SA_PATH`), which is not on this box; `web/.env.local` has the
  dev project id and web api key; `SMOKE_LLM_API_KEY` is absent but only needed on a first run. dev.owlette.app
  serves the base. **Owner:** place the service-account file, then the agent runs the smoke.
- 2026-09-22 — Task 2.1 done on the base `fdcf86d1`: RESULT: CLEAR (1 acknowledged blocker(s), 27 warning(s) to report) Tests:       1 skipped, 6023 passed, 6024 total Tests:       139 passed, 139 total   400 passed (12.9m)  — every step exit 0 (security alerts, lint, tsc, jest, rules, e2e). dev's own CI on the merge: e2e, swoop worker deploy (dev deployed, prod untouched), CodeQL, openapi drift all green.
- 2026-09-22 — Task 1.4, read-only half done from this box (Railway CLI logged in as the owner): **abort anchor —
  `owlette-prod` active deployment `49cbfb29`, status SUCCESS, commit `73f5d512`, branch `main`, created
  2026-09-14T20:15Z; `origin/main` = `73f5d512`** (the same commit). Click-path: Railway → project `owlette` →
  service `owlette-prod` → Deployments → the `49cbfb29` entry → Redeploy. Mapping: `FIREBASE_PROJECT_ID` and
  `NEXT_PUBLIC_FIREBASE_PROJECT_ID` on `owlette-prod` are the prod project — **confirmed**; the R2 endpoint/bucket
  names carry no dev marker — confirmed; 48 keys on the service. Also recorded in Task A.1.
- 2026-09-22 — Environment for Waves 1–2, now on this box: gcloud signed in (owner's account; `CLOUDSDK_PYTHON`
  must point at `agent/.venv/Scripts/python.exe`, gcloud's own python is too old) and it lists prod's composite
  indexes; Firebase CLI sees both projects; Railway CLI logged in and linked to `owlette`/`dev`/`owlette-dev`;
  Vercel CLI logged in and `web/` linked to project `owlette` (the `.env.local` it wrote into the worktree's
  `web/`, holding only `VERCEL_OIDC_TOKEN`, was removed — it would have tripped playwright's secret audit); dev
  service account at `agent/config/firebase-creds-dev.json`. `sync-env.mjs status`: railway-dev 4 missing,
  railway-prod 10 missing, vercel-prod 10 missing — exactly the research's picture. Still owed by the owner: a
  Cloudflare token with the load-balancer scope (Task 1.3), the TURN key or the empty-string decision, and the
  dev API key. Side note, owner-approved dev data edit: the owner's own dev account carried one passkey (registered
  2026-09-19, unusable from any of their authenticators) that locked them out at `/verify-2fa`; on "clear it"
  the passkey record was deleted and the account set to zero factors / mandatory setup, mirroring
  `applyMfaFactorChange`'s zero case. No trusted devices existed. Dev only.
- 2026-09-22 — Task 2.2 done. `npm run smoke:dev` from a checkout at exactly `origin/dev` (the run refuses any
  other commit), owner's dev service account + `web/.env.local` via `SMOKE_SA_PATH` / `SMOKE_ENV_FILE`:
  **`commit fdcf86d1d30b104ca20f4145c10d7b31e630b43b (origin/dev; dev served it when the specs started)` ·
  `totals 7 passed, 0 flaky, 0 failed, 0 skipped` · playwright exit 0 · stub agent exit 0 · `exit 0`**, no
  `--any-commit`, no forwarded grep, no `WARNING` line. `SMOKE_LLM_API_KEY` was unset; the smoke-siteadmin
  account already held a hoot key, so the hoot turn ran. Not covered by this suite (per its README): swoop,
  the cross-platform agent work, restart-schedule authoring — Task 2.5. Re-run required if `dev` moves before
  Task 3.1.
- 2026-09-22 — Task 1.1 on the owner's "go 1.1", run from this box with the owner's gcloud/firebase logins.
  Pre-checks: bucket `owlette-prod-backup` exists; prod's 34 composite indexes are exactly the file's 35 minus
  `swoop_sessions` once the listing's implicit `__name__` field is ignored (a first comparison without that
  normalisation looked like 32 would be deleted — it would not have been; the deploy ran `--non-interactive`, which
  fails on any delete prompt rather than deleting). (1) Export: operation started,
  `outputUriPrefix: gs://owlette-prod-backup/pre-3.3.6-20260922-1814` (state PROCESSING at return — completes on
  its own). (2) `firebase deploy --only firestore:indexes --project prod --non-interactive` → "deployed indexes
  in firestore.indexes.json successfully for (default) database". (3) READY poll running; the read-back
  (`swoop_sessions` READY, 35 composite) is appended below when it lands.
- 2026-09-22 — Task 1.2 done on the owner's "go 1.2". Values generated by `scratchpad/set_prod_keys.mjs` in the
  shapes the code decodes (raw 32-byte Ed25519 seed/public key as standard base64, `SWOOP_JWT_KID` =
  `prod-2026-09-22`, a random 32-byte base64 master key, a random 32-byte hex ring secret,
  `SWOOP_SIGNAL_URL=https://signal.owlette.app`) and handed straight to the Railway CLI; nothing printed or
  written. **Empty strings, and why:** `SWOOP_JWT_KID_PREVIOUS` / `SWOOP_JWT_PUBLIC_KEY_PREVIOUS` (no rotation in
  progress; presence keeps `check` green) and `CLOUDFLARE_TURN_KEY_ID` / `CLOUDFLARE_TURN_KEY_API_TOKEN` (no TURN
  key supplied yet — falsy-guarded, STUN-only as on dev; set for real once the owner creates a Realtime TURN
  key). Same four empties on `railway-dev`. Read-back: both Railway targets **✓ in sync**; `diff railway-dev
  railway-prod` leaves only the intended asymmetries (dev-only `RATE_LIMIT_OBSERVE_ONLY`,
  `SECURITY_BOUNDARY_SENTRY_METRICS`, `W8_1_DRILL_TS`; prod-only Instatus/Sentry/`NEXT_PUBLIC_BASE_URL`/
  `ROOST_ENV`). No redeploy was triggered: `owlette-prod` is still deployment `49cbfb29` @ `73f5d512`, so the
  abort anchor stands. **The ring secret lives on `railway-prod`** (readable there by the owner's CLI) and is
  what the prod Worker's `wrangler secret put SWOOP_SIGNAL_RING_SECRET -e prod` must receive, byte for byte.
  `vercel-prod` still reports the 10 missing — that is the `sync vercel-prod --apply` step, which needs its own go.
- 2026-09-22 — Vercel mirror on the owner's "go vercel": `node scripts/sync-env.mjs sync vercel-prod --apply` set
  42/46 (every value piped provider→provider, so the seven `must-match` values on `vercel-prod` now equal
  `railway-prod`'s); the four **empty-string** keys failed — the script pipes values over stdin and Vercel's
  non-interactive `env add` reads an empty stdin as "missing value". `vercel env add <key> production --value ""
  --yes` accepts an empty value, so the four were set that way by hand. **`node scripts/sync-env.mjs check` → `✓
  all targets match the manifest`, exit 0 (Task 2.3's gate).** Follow-up for `dev`: `sync-env.mjs` should pass
  `--value ""` when a value is empty instead of piping nothing.
- 2026-09-22 — Findings for `dev`, not promotion blockers, all pre-existing on `main`: (1) `/setup-2fa`'s
  "continue to dashboard" left the owner on the setup page after a first passkey enrolment even though the user
  record was correct (enrolled, setup not required) — the page and the passkey routes are byte-identical on
  `main`; the owner is testing a full navigation vs the in-app one to tell a stale session cookie from a client
  navigation bug. (2) `infra/swoop-signal/README.md` and `.claude/.env.example` name a "Workers Durable
  Objects" token permission that the Cloudflare token UI does not offer; Workers Scripts › Edit covers it.
  (3) Cloudflare's TURN console shows the key **id** on the app card; the API token is shown only at creation,
  so prod needs its own TURN app created to obtain both.
- 2026-09-22 — Task 1.1 read-back: `gcloud firestore indexes composite list --project owlette-prod-90a12` → `CICAgPj-pYIK | swoop_sessions | COLLECTION_GROUP | READY | siteId ASCENDING, state ASCENDING`; `firebase firestore:indexes --project prod` lists **35** composite indexes (was 34). Done. Task 2.3: `check` exit 0 recorded above; the diff decisions (three dev-only keys stay off prod: RATE_LIMIT_OBSERVE_ONLY, W8_1_DRILL_TS, SECURITY_BOUNDARY_SENTRY_METRICS) are the recommended ones and await the owner's one-line confirmation.
- 2026-09-22 — Task 1.3 done with the owner's rolled `CLOUDFLARE_API_TOKEN` (verified `active`; note: current
  Cloudflare tokens are longer than the 40 characters I had claimed). **`GET /zones/{owlette.app}/load_balancers`
  → `result: []` (total_count 0); `GET /accounts/{id}/load_balancers/pools` → `result: []`.** DNS: `owlette.app`
  = proxied CNAME to `h90clljq.up.railway.app` (plus MX/TXT); `vercel-origin.owlette.app` = A `76.76.21.21`,
  **DNS-only (grey cloud)** — correct for Vercel's HTTP-01 renewals; no `www` record. **Answer: there is no
  automatic failover. Vercel is a manual standby reached by hand-editing DNS.** Task 3.3's read-back therefore
  records the Vercel origin's commit after `sync --apply` + redeploy rather than requiring both origins to serve
  one commit behind an LB. Nothing changed; no terraform run.
- 2026-09-22 — Task 2.3 closed: `check` exit 0 on all three targets; the diff's remaining asymmetries are the
  intended ones (recorded under 1.2); the three dev-only keys stay off `railway-prod` per plan D4, which the owner
  accepted with the defaults on 2026-09-22 — `RATE_LIMIT_OBSERVE_ONLY` (would turn prod's limiter into logging),
  `W8_1_DRILL_TS` and `SECURITY_BOUNDARY_SENTRY_METRICS` (security-boundary drills, dev only).
  **Wave 2 remaining before the push:** 2.4's live half (needs the dev API key; else carried as unverified) and 2.5
  (the walkthrough on dev.owlette.app — the owner's, or the agent drives it headlessly with the smoke accounts and
  records screenshots, at the owner's choice). A.1's anchors are written in.
- 2026-09-23 — **Failover load balancer, stage 1 (rehearsal) done on the owner's "go rehearsal".** Load
  Balancing was not enabled on the Tridant account (first apply failed on the monitor with `interval is not in
  range [1, 1]`, nothing created); the owner enabled it (and is cancelling the stray subscription on the TEC
  account). `infra/cloudflare` gained `lb_host` (`bcf7852b` on `chore/promotion-wave2`) so the LB can be
  rehearsed on a throwaway name. Applied with `lb_host = lbtest.owlette.app`: monitor `85f9e279…`, pools
  `owlette-railway-primary` (`h90clljq.up.railway.app`, Host owlette.app) `cc4f595b…` and
  `owlette-vercel-standby` (`vercel-origin.owlette.app`) `4b9cbbfc…`, LB `07a5c9e4…` on `lbtest.owlette.app`;
  `terraform.tfvars` (gitignored) holds the ids and origins; state is local in `infra/cloudflare/`.
  **Proof:** `https://lbtest.owlette.app/api/health` → `origin: railway` (73f5d512); Railway pool disabled via
  API → within 10 s `origin: vercel:iad1` (da031235); pool re-enabled → within 11 s `origin: railway`.
  `owlette.app` untouched throughout. **Stage 2 (go-live) is a new Task 3.4, after 3.3:** once Vercel serves
  the new `main`, set `lb_host = ""` and `terraform apply` — Terraform replaces the lbtest LB with one named
  `owlette.app` (the LB hostname takes precedence over the existing proxied CNAME, which stays as the
  fallback); read back `/api/health` on owlette.app and confirm `GET zones/{id}/load_balancers` lists it. Until
  then the standby serves stale code, which is why it must not front owlette.app yet. Task 3.3's read-back
  reverts to the with-LB form: both origins must serve one commit.
- 2026-09-23 — **Task 2.5 walkthrough, owner-driven on `https://dev.owlette.app` (dev, not a prod-shaped
  staging environment; Railway PR environment / Vercel preview: neither available, as the research predicted).**
  Passkey login PASS (after the owner's account was reset to zero factors on 2026-09-22 and re-enrolled).
  Machine list, card and list views PASS. Machine detail PASS. `/download` PASS. Logs action multi-select PASS
  (machine and level stay single-select: by design, not a regression). Docs search: works, relevance for
  "roost" weak (top hits are CLI / CI examples, not the roost overview) — dev follow-up, not a blocker.
  **Two findings:** (1) the collapsed metrics row's labels floated to the middle of their cells on a wide card
  (a button centres its text; five 1fr cells) — real bug from `18db25dc`, **fixed on `fix/card-metrics-row-left`
  = PR #176 against dev** with a red-then-green e2e spec (17px offset at 1920px before, ≤1px after). If it
  merges before the push, `dev` moves off `fdcf86d1` and Tasks 2.1/2.2 re-run on the new SHA (both are
  minutes). (2) "OS not reported on the card" for the owner's own box: that machine runs a partial mirror of
  `agent/src` without the OS-reporting code (`0` matches for the OS fields there vs `7` on dev's tree), so the
  card's no-OS fallback is correct; OS reporting is unproven on dev until a merged-build agent pairs — the VM
  harness now takes `-Server dev` (`/SERVER=dev` on both installs; uncommitted on `chore/promotion-wave2`).
  **Swoop shows on dev and that is expected:** the plan's "no card offers a swoop entry" assumed no site had
  opted in, but dev's `sites/default_site/settings/swoop` has `enabled: true` since 2026-09-19 and TEC-A4D's
  heartbeat carries `capabilities.swoop = 1`, so the entry renders and a session connects. Off-by-default is the
  policy gate (`swoop_disabled` 403 when the settings doc is absent), not hidden UI. On prod no site has the
  doc, confirmed by the Wave 1 export listing. Not yet walked: roost, billing, restart-schedule authoring. Dev
  finding carried from 2026-09-22: `/setup-2fa` "continue to dashboard" only toasts.
- 2026-09-23 — **#176 merged into dev on the owner's "merge 176": dev moved to `1ebf3585` (merge commit of
  `f58a0115`, diff vs `fdcf86d1` = the card fix, its spec, two changelog lines). The promotion base is now
  `1ebf3585`;** Tasks 2.1 and 2.2 re-run against it: security CLEAR (3 acked, 57 warnings, unchanged), lint 0
  errors / 9 pre-existing warnings, tsc clean, jest 6023 passed. Local e2e and the `playwright e2e` run for
  `1ebf3585` in progress; `smoke:dev` waits for Railway to serve `1ebf3585` on dev.owlette.app.
- 2026-09-23 — Task 2.2 re-run on `1ebf3585`: dev.owlette.app `/api/health` served `1ebf3585` from ~03:40 UTC;
  `smoke:dev` 7 passed / 0 failed (hoot stub ×3, passkeys, roles ×2, share), exit 0.
- 2026-09-23 — Task 2.1 closed on `1ebf3585`: local e2e suite green (see the counts in the preflight report of
  this date), CI `playwright e2e` and `security preflight` runs for `1ebf3585` both green. **Waves 0-2 complete
  on base `1ebf3585`; Wave 3 waits on the owner's "go".**
- 2026-09-23 — **Wave 3 started on the owner's "go".** Task 3.1: `origin/dev` = `1ebf3585` confirmed; PR #177
  `dev` → `main` opened (title `chore: merge dev for v3.3.6 production release`, body = base SHA, gates, Wave 1
  read-backs, the three acked findings with reasons, abort anchor `49cbfb29` @ `73f5d512`). Auto-merge is not
  enabled on the repo, and the PR's own runs of the three required checks had to start from scratch, so the merge
  waits on them. The GitHub Advanced Security `zizmor` check on the PR reports "40 new alerts including 1 error"
  (#365 cache-poisoning in `build-installer.yml`, plus id-token permissions in three publish workflows): all
  pre-existing on dev (#365 created 2026-09-19), surfaced only because the PR's base is 216 commits behind; the
  security gate script rates the branch CLEAR and this check is not required by main's protection. Merge fires
  automatically once the three required checks are green.
- 2026-09-23 04:05 UTC — **Task 3.1 DONE: #177 merged as regular merge commit `c68638a8` on `origin/main`**
  (`git log --first-parent origin/main -1` = `chore: merge dev for v3.3.6 production release`;
  `git diff origin/main origin/dev --stat` empty). The first merge attempt was refused: the PR's check list
  showed the dev push's green runs under the same names while the PR's own runs were still pending, so the
  second wait keyed on GitHub's `mergeStateStatus` (UNSTABLE = non-required zizmor red, required checks green).
  No tag pushed. Task 3.2 read-backs in progress.
- 2026-09-23 04:10 UTC — Task 3.2 partial read-backs on `c68638a8`: no `swoop-signal-deploy` run exists for the
  merge commit (latest runs are dev pushes, as designed); `signal.owlette.app` → NXDOMAIN at 1.1.1.1; no tag
  containing 3.3.6 on origin; `security preflight` for `c68638a8` completed, `playwright e2e` in progress.
  Task 3.3: env already mirrored — `diff railway-prod vercel-prod` = 46 keys in both, none one-sided;
  `check vercel-prod` exit 0 (from the `Owlette-merge` worktree, the one linked to Vercel), so no `--apply` was
  needed. Vercel production build of `main` started 04:08 UTC. Waiting on: owlette.app serving `c68638a8`
  (Railway), `vercel-origin.owlette.app` serving `c68638a8`, then the health/openapi/swoop-settings/`/swoop`
  read-backs, then Task 3.4 LB go-live.
- 2026-09-23 04:12 UTC — **Task 3.2 DONE on `c68638a8`:** Railway deployment SUCCESS (`c68638a8`, created
  04:04:57 UTC); `owlette.app/api/health` → `origin: railway`, commit `c68638a8`; openapi 120 paths;
  `GET /api/sites/x/swoop-settings` 401; `POST …/swoop/sessions` 401; `/swoop/x/y` 307 → `/login?redirect=`;
  `/dashboard` 307 → login; `/docs` 200; `/download` 307; installer route gated (401). **Task 3.3 DONE:**
  Vercel production build of `main` Ready; `vercel-origin.owlette.app/api/health` → `origin: vercel:iad1`,
  commit `c68638a8` — both origins on one commit. **Task 3.4 DONE (LB go-live):** `lb_host = ""` +
  `terraform apply` → `cloudflare_load_balancer.owlette` renamed in place `lbtest.owlette.app` → `owlette.app`
  (0 added, 1 changed, 0 destroyed; id `07a5c9e4…`); `GET zones/{id}/load_balancers` lists exactly one:
  `owlette.app`, enabled, proxied, steering off; six health reads through it all `railway c68638a8`. No prod
  failover drill run (the rehearsal on lbtest proved it 2026-09-23 02:25 UTC; a pool disable on prod is a
  mutating call reserved for the 24-hour watch if the owner wants it). `lbtest.owlette.app` no longer has an LB.
- 2026-09-23 04:20 UTC — Task 4.1 partial: `check-status-page-ready.mjs --base-url https://owlette.app` exits 1
  with 11 fails — every one is the documented pre-promotion state (six `INSTATUS_COMPONENT_*_ID` keys are
  unset on every target per `scripts/env-manifest.json`, "promote once the Instatus component exists"; the live
  probe needs `CRON_SECRET` in the local environment, which is not pasted anywhere). Not a regression of this
  promotion; carried as an unverified item. `smoke-r2-roundtrip.mjs` cannot run from this box: the only prod
  key on hand is installer-scoped. **Tag decision: no tag pushed.** Filters checked: `build-installer.yml`
  `v[0-9]+.[0-9]+.[0-9]+`, `cli-publish.yml` `cli-v…`, `node-sdk-publish.yml` `node-sdk-v…`,
  `py-sdk-publish.yml` `py-sdk-v*` — `web-3.3.6` matches none, safe if the owner wants a marker. **Owner
  items left in 4.1:** the two 403 behaviour checks with a real prod session (`cannot_modify_own_membership`,
  `swoop_disabled`) and the flow walkthrough on owlette.app. 4.2 (cron-job.org entry) is vendor-UI only.
