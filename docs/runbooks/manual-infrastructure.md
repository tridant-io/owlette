# manual infrastructure runbook

The 3.0.1 cutover shipped four artifacts that no `git push` deploys: the talons Firestore indexes
(`firestore.indexes.json`), the Cloud Functions that back the display and `process_restarted` talon
taps (`functions/src/talonLogEvents.ts`), the cron-job.org registration for `/api/cron/talons`, and
the `installer_metadata/cortex_cli` pin that a 3.0.0+ installer needs or Cortex is dead on every
fresh install (`docs/internal/cortex-cli-provisioning.md:28`). Two runbooks disagreed on the order:
`docs/runbooks/talons.md:75-99` says indexes first, wait for `Enabled`, register the cron last, while
`docs/runbooks/production-deploy.md:152-206` deploys the web app at step 6 and Firestore at step 8 —
the exact reversal that talons.md exists to prevent.

This file is the single answer to "what else do I have to do by hand, and in what order". It is the
inventory and the ordering; it does not replace the per-surface runbooks it points at.

---

## what a git push does NOT deploy

> **`.firebaserc` defaults to DEV.** `.firebaserc:3` sets `"default": "owlette-dev-3838a"`. Every
> production `firebase` command in this file passes `--project prod` explicitly, and so must yours.
> A `firebase deploy --only firestore` with no project flag — relying on a `firebase use prod` from
> earlier in the shell — deploys production rules and indexes to **dev**, successfully, with a green
> result and no warning. Never trust an ambient alias at 2am.

One row per surface. **SILENT** means nothing errors, nothing is logged, and nobody is paged — the
work simply never happens. Those are the rows that bite.

| surface | trigger | command | per-env? | how it fails |
|---|---|---|---|---|
| web app (Railway) | auto on push | `git push origin main` (prod) / `git push origin dev` (dev) | yes | LOUD — Railway build log. Watch it to completion before smoke checks. |
| Firestore composite indexes | manual | `firebase deploy --only firestore:indexes --project prod` | yes | **SILENT** at deploy, loud and late at runtime — `FAILED_PRECONDITION` 500s. Half-silent worst case: the talon janitor swallows the throw, so `staleRecovered` just stays 0 forever. |
| Firestore security rules | manual | `firebase deploy --only firestore:rules --project prod` | yes | **SILENT** — no CI job exists, the previous ruleset stays live indefinitely. Surfaces as permission-denied, or as old permissive rules still allowing what the new ones blocked. |
| Cloud Storage rules | manual | `firebase deploy --only storage --project prod` | yes | **SILENT** — same shape. `storage.rules:19` reads `users/{uid}.role == 'superadmin'`, so it carries the same migration-before-rules constraint. |
| Cloud Functions (all exports) | manual | `firebase deploy --only functions --project prod` | yes | **SILENT** for the fleet — old revisions keep running, new behaviour never ships. The deploy itself fails loudly if the predeploy build breaks (`firebase.json:17-19`). |
| Cloud Scheduler jobs (9 `onSchedule` functions) | manual (side effect of the functions deploy) | `firebase deploy --only functions --project prod`, then `gcloud scheduler jobs list --project owlette-prod-90a12 --location us-central1` | yes | **SILENT** — a scheduler job only exists in a project after that function has been deployed there. A function only ever deployed to dev has no prod job and nothing says so. |
| `functions/.env.<projectId>` | manual (local file) | `ls functions/.env.owlette-prod-90a12` before deploying | yes | **SILENT and dangerous** — `functions/.gitignore` blocks all `.env*`, so a clean checkout deploys functions with the secrets missing and the deploy still reports success. A missing `CORTEX_INTERNAL_SECRET` 503s the internal HTTPS functions (`functions/src/lib/requireInternalSecret.ts:14-18`) **and silently kills two talon paths**: `talonLogEvents.ts:91-95` and `metricsHistory.ts:559-563` each log a warning and then resolve *successfully*, so every display talon, every `process_restarted` talon, and every threshold alert simply stops firing. |
| cron-job.org scheduled jobs (7 endpoints) | manual (vendor UI) | no CLI — see [per-environment bootstrap](#per-environment-bootstrap) | yes | **SILENT, all seven** — talons never fire, queued alerts never email, retention never deletes (which makes the privacy policy untrue), status-ping never publishes. A wrong secret answers 401 and also fires nothing. |
| Cloudflare failover LB (monitor + 2 pools + LB) | manual | `cd infra/cloudflare`, `cp terraform.tfvars.example terraform.tfvars` (fill it in), `export CLOUDFLARE_API_TOKEN=…`, then `terraform init && terraform plan && terraform apply` | account-wide | LOUD at apply on a bad token or missing add-on. **SILENT afterwards** — state is local `*.tfstate` (gitignored), so a second machine applying without it recreates resources or drifts. |
| Cloudflare Load Balancing add-on | one-time bootstrap | dashboard only: Traffic → Load Balancing → enable | account-wide | LOUD — the API rejects LB creation until the add-on is on, so `terraform apply` errors rather than half-building. |
| `owlette.app` as a domain on the Vercel standby | one-time bootstrap | `cd web && vercel domains add owlette.app` | account-wide | **SILENT until the day it matters** — both pools rewrite `Host: owlette.app`; if Vercel does not accept that host the standby answers wrong only once Railway has already failed. |
| Instatus status-page components (9 ids) | manual (vendor UI + env vars) | create in Instatus, set the ids, then `node scripts/check-status-page-ready.mjs --env-only` | yes | **SILENT** — `setInstatusComponentStatus` returns `{skipped:true}` with a reason when the key, page id, or component id is missing (`web/lib/instatusClient.ts:104`). It never throws, status-ping still returns 200, the component just never updates. |
| Cloudflare Turnstile widget | one-time bootstrap | dashboard only: Turnstile → add a widget covering `owlette.app`, `dev.owlette.app`, `localhost`; then set `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET`, `TURNSTILE_HOSTNAMES` | yes (env vars; one widget serves every host) | LOUD — a prod boot without `TURNSTILE_SECRET` prints a banner and raises a Sentry event (`web/instrumentation.ts:47-64`) and register + forgot-password 403 every request (`web/lib/turnstile.server.ts:69-77`). The silent variant: `TURNSTILE_SECRET` is a **`must-match`** var, so a prod/standby mismatch breaks both flows on failover only. |
| Upstash Redis database | one-time bootstrap | dashboard only: create the database, then set `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | yes | MIXED — a boot banner and a Sentry event fire (`web/instrumentation.ts:14-36`) but nothing throws and the app serves normally. Every endpoint silently collapses to a per-process 15/min in-memory limiter (`web/lib/rateLimit.ts:21-42`) — roughly 90x looser than the signup limit, multiplied by the replica count. |
| Resend account + verified sending domain | one-time bootstrap | dashboard only: verify the `RESEND_FROM_EMAIL` domain, then set `RESEND_API_KEY` | yes | **SILENT** — `getResend()` returns null and all three email crons log a warning and `continue` (`process-alerts:170`, `display-alerts:94`, `health-check:565`). The queues drain, the crons answer `ok: true`, nobody is emailed. An unverified domain is the same shape, rejected per send. |
| R2 buckets + CORS policy | manual | `node scripts/provision-r2.mjs --verify-only`, then `node scripts/provision-r2.mjs` | account-wide (creates all four buckets) | LOUD — exits 1 on a bad token, on R2 not enabled, and on any CORS PUT failure (`scripts/provision-r2.mjs:272`). Note the CORS rules are a **full-replace PUT** (`:178-179`) applied to the two *content* buckets only — the manifest buckets are deliberately CORS-less — so this script is the sole source of truth for allowed origins. |
| R2 S3-compatible access keys | one-time bootstrap | dashboard only: R2 → Manage R2 API Tokens → Object Read & Write over the four buckets; then set `R2_S3_ACCESS_KEY_ID`, `R2_S3_SECRET_ACCESS_KEY`, `R2_S3_ENDPOINT` | yes (env vars) | LOUD at runtime (uploads fail) with a **SILENT** variant: if `ROOST_ENV` is not explicitly `prod` on the prod service, `r2Client.server.ts:44-60` defaults to dev and prod writes land in the **dev bucket** with no error. |
| R2 object lifecycle rules | not implemented | none — no script, no terraform, no wrangler config in this repo | account-wide | **SILENT** — the buckets have no lifecycle policy, so abandoned staged uploads accumulate and there is no deleted-object recovery window. `docs/internal/threat-model.md:350` and `:518` call for both; nothing implements them. |
| GCS bucket + SA for the security-boundary audit export | one-time bootstrap | five `gcloud` commands — see [per-environment bootstrap](#per-environment-bootstrap) | yes | **SILENT, and silent right now in prod** — `functions/src/securityBoundaryAuditExport.ts:135-140` guards on project id, logs `skipping — prod export infra not yet provisioned`, and returns success. The daily 06:30 UTC job (`:121-122`) reports green while exporting nothing. |
| Cloud Monitoring uptime check + alert policies | one-time bootstrap | console only: GCP → Monitoring → Uptime checks / Alerting. The dev resource ids are recorded in `infra/monitoring/security-boundary-alerts.yaml:20-23` and `:136` — record the prod ones the same way | yes | **SILENT** — that file is `environment: dev` at `:3` and every id in it names a dev project. There is no prod synthetic probe and no prod alert policy; those pages never fire for production. |
| Railway env vars (dev + prod services) | manual | `node scripts/sync-env.mjs check` (exit 1 on drift), writes via Railway UI/CLI | yes | MIXED — a missing `NEXT_PUBLIC_*` is **silent** (inlined at build time; redeploy after adding it). A missing server secret is loud at boot or first use. A missing `ROOST_ENV` is the silent one — R2 writes go to dev. |
| Vercel env mirror (failover origin) | manual | `node scripts/sync-env.mjs diff railway-prod vercel-prod`, then `node scripts/sync-env.mjs sync vercel-prod --apply` | mirror of prod | **CATASTROPHICALLY SILENT** — Vercel stores sensitive vars write-only, so `check` proves a key exists, never that its value matches. `SESSION_SECRET` mismatch logs every user out on failover; `MFA_ENCRYPTION_KEY` locks out every 2FA user; `LLM_ENCRYPTION_KEY` breaks stored-key decryption; `TURNSTILE_SECRET` breaks register + forgot-password. None of it shows until Railway actually fails over. |
| Firebase Auth authorized domains | one-time bootstrap | console only: Authentication → Settings → Authorized Domains | yes | LOUD for users, invisible to the deploy — the app deploys clean and then nobody can sign in. Add the Vercel standby alias too, or failover breaks login. |
| Firebase App Check enforcement | one-time bootstrap | console only, per project: App Check → Authentication → Enforce. Full procedure: [app-check-rollout.md](app-check-rollout.md) | yes | Currently a no-op — without the site key `maybeInitAppCheck()` returns immediately (`web/lib/firebase.ts:125-127`). The trap is the CSP in `web/proxy.ts`: reCAPTCHA Enterprise is blocked by the current policy and fails **silently**, so every client reports unverified and the rollout metrics mislead. **Never enforce Cloud Firestore** — it takes the whole agent fleet offline. |
| npm publish — `@owlette/cli` | git tag | `git tag cli-v1.0.0 && git push origin cli-v1.0.0` | no | LOUD — the workflow refuses on a tag/version mismatch, a wrong tag shape, or a real publish with no tag. npm OIDC trusted publishing; the very first publish must be bootstrapped by hand. |
| npm publish — `@owlette/sdk` | git tag | `git tag node-sdk-v1.0.0 && git push origin node-sdk-v1.0.0` | no | LOUD — same guard chain, same OIDC prerequisite, same manual first publish. |
| PyPI publish — `owlette-sdk` | git tag | `git tag py-sdk-v1.0.0 && git push origin py-sdk-v1.0.0` | no | LOUD — refuses on tag/version mismatch. PyPI supports a pending publisher, so no bootstrap and no token; but a pending publisher does not reserve the name, so push the tag promptly. |
| agent installer — build | manual | `cmd /c "<repo>\agent\build_installer_full.bat < NUL > %TEMP%\installer-build.log 2>&1"` | no | LOUD (exit code + log), but it **hangs a non-interactive shell forever** without `< NUL` — the batch file ends with `pause` and pauses on every error branch. Invoke by full path; never cd-then-run. |
| agent installer — CI build + SLSA L3 provenance | git tag | `git tag v3.0.2 && git push origin v3.0.2` | no | LOUD (the verify job runs `slsa-verifier`). The **silent** part is what it does not do: it attaches the exe and attestation to the GitHub Release and stops. No Firebase Storage push, no `installer_metadata`, no `latest` pointer — tagging rolls out nothing. |
| agent installer — rollout to agents | manual | 3-step signed-URL upload — see below | yes | LOUD: 400 without an `Idempotency-Key` (`web/lib/idempotency.ts:103-115`), 403 on a key without `installer=*:write`, 412 `checksum_mismatch` on corruption, and the signed URL dies after 15 minutes. **Silent failure = skipping it entirely**: a green CI run on a tag looks like a release while no agent ever sees the version. |
| cortex CLI pin (`installer_metadata/cortex_cli`) | manual | `node scripts/upload-cortex-cli.mjs --env=prod --file="<path to claude.exe>" --yes` | yes | **SILENT per machine** — a fresh Firebase project has no pin, so `ensure_cli()` fails closed, `main()` writes `cortexStatus.error` and exits without an exception, backing off 5 min to 1 h (`agent/src/cortex_cli_fetch.py:93-94`). A 3.0.0+ installer promoted into an environment with a missing pin leaves Cortex dead on every fresh install. |

### the two commands that do not fit a table cell

**Agent installer rollout** (after the build, and after the version bump + changelog entry are
committed — the exe bakes its own version into its filename):

```bash
API_KEY=$(grep OWLETTE_API_KEY .claude/.env.local | cut -d= -f2)
BASE_URL="https://owlette.app"   # dev: https://dev.owlette.app
VERSION="X.Y.Z"
SHA256=$(sha256sum agent/build/installer_output/Owlette-Installer-v$VERSION.exe | cut -d' ' -f1)

# 1. request a signed upload URL (15-minute window)
curl -s -X POST "$BASE_URL/api/installer/upload" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -H "Idempotency-Key: installer-upload-$VERSION-$(date +%s)" \
  -d "{\"version\":\"$VERSION\",\"fileName\":\"Owlette-Installer-v$VERSION.exe\",\"releaseNotes\":\"Release $VERSION\",\"setAsLatest\":true}"

# 2. PUT the bytes to the returned uploadUrl — no Idempotency-Key, no api key (direct to GCS)
curl -X PUT "$UPLOAD_URL" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @agent/build/installer_output/Owlette-Installer-v$VERSION.exe

# 3. finalize
curl -s -X PUT "$BASE_URL/api/installer/upload" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -H "Idempotency-Key: installer-finalize-$VERSION-$(date +%s)" \
  -d "{\"uploadId\":\"$UPLOAD_ID\",\"checksum_sha256\":\"$SHA256\"}"
```

**GCS bucket + service account for the security-boundary audit export** (prod, currently
unprovisioned — the `<placeholder>` values in `infra/monitoring/security-boundary-audit-export.yaml:32-45`
are the evidence). The bucket name below is not canonical: only dev's exists (`:27`), and the prod
field is still a placeholder. Pick a name that mirrors dev's, then write it back into that file's
`prod:` block so the placeholders stop being the signal.

```bash
BUCKET=gs://owlette-prod-security-boundary-audit-exports   # your choice; mirror dev's shape

gcloud storage buckets create $BUCKET \
  --project=owlette-prod-90a12 --location=us-central1 --uniform-bucket-level-access
gcloud storage buckets update $BUCKET \
  --lifecycle-file=infra/monitoring/security-boundary-audit-export-lifecycle.json
gcloud iam service-accounts create security-boundary-audit-export \
  --project=owlette-prod-90a12 --display-name='Security boundary audit export'
gcloud projects add-iam-policy-binding owlette-prod-90a12 \
  --member=serviceAccount:security-boundary-audit-export@owlette-prod-90a12.iam.gserviceaccount.com \
  --role=roles/datastore.importExportAdmin
gcloud storage buckets add-iam-policy-binding $BUCKET \
  --member=serviceAccount:security-boundary-audit-export@owlette-prod-90a12.iam.gserviceaccount.com \
  --role=roles/storage.objectAdmin
```

Then set `SECURITY_BOUNDARY_AUDIT_EXPORT_BUCKET` and `SECURITY_BOUNDARY_AUDIT_EXPORT_ENV=prod` in
`functions/.env.owlette-prod-90a12` and redeploy. Setting the env vars alone does **not** enable it:
the early return in `securityBoundaryAuditExport.ts:135-140` keys off the *project id*, not those
vars, so enabling prod export also requires removing that guard and attaching a prod service account
(the conditional `serviceAccount` at `:130-132` is dev-only today).

### the four scheduler jobs that log green while doing nothing

Worth knowing before you read a green Cloud Scheduler dashboard as proof of anything:

| function | why it is inert | what the run reports |
|---|---|---|
| `chunkGcNightly` | `getDefaultStore()` throws `R2 object store not wired — blocked on wave 0.5` (`chunkGc.ts:315`) | per-site error caught, summary of all-skipped sites |
| `reconcileQuota` | `getDefaultStorageMetrics()` throws `R2 storage metrics not wired — blocked on wave 0.5` (`quotaEnforce.ts:403`) | completes green with `sites=0` reconciled |
| `exportAuditDaily` | `getDefaultExporter()` throws `BigQuery audit sink not wired — deferred to wave 0.6` (`auditLog.ts:313`) | logs `records=0`, exits successfully |
| `exportSecurityBoundaryAuditDevDaily` | returns early outside `owlette-dev-3838a` (`securityBoundaryAuditExport.ts:135-140`) | logs `skipping — prod export infra not yet provisioned` |

The in-Firestore audit chain remains authoritative, and 7-year retention holds because nothing prunes
`audit_log` — not because the export works.

---

## per-environment bootstrap

From zero to a working environment, in dependency order. Do the whole list per environment; dev and
prod are separate Firebase projects, separate Railway services, separate `CRON_SECRET` values, and
separate Instatus component ids.

**1. Firebase project.** Create it (or confirm the id: `owlette-dev-3838a` / `owlette-prod-90a12`)
and add it to `.firebaserc` as an alias. Enable Authentication (Email/Password + Google), Firestore,
and Cloud Storage.

**2. Firebase Auth authorized domains.** Console → Authentication → Settings → Authorized Domains.
Add the app's public hostname, the Railway origin hostname, and — for prod — the Vercel standby alias
`owlette-eight.vercel.app`. Skipping this deploys cleanly and then nobody can sign in.

**3. Third-party accounts, then env vars — manifest first.** Four vendor accounts have to exist
before their keys mean anything: **Resend** (verify the sending domain, or every alert email is
dropped at send), **Upstash** (a Redis database, or rate limiting collapses to a per-process
fallback), **Cloudflare Turnstile** (a widget covering every hostname that serves the app), and —
for prod — **Instatus** (step 5). Then add every key to `scripts/env-manifest.json` (key + class +
targets; **never values**) and set them on the target. Check coverage:

```bash
node scripts/sync-env.mjs            # coverage grid + drift
node scripts/sync-env.mjs check      # exit 1 on drift
```

Two limits on what that check proves. It only sees keys the manifest lists, and of the nine Instatus
component ids only `INSTATUS_COMPONENT_DASHBOARD_ID` is registered — use step 5's gate for the rest.
And it compares key *presence*, never values (see the Vercel caveat below).

The ones that are silent when wrong: `ROOST_ENV=prod` on the prod service (without it R2 writes go to
the dev bucket), every `NEXT_PUBLIC_*` (build-time inlined — redeploy after adding one), and
`CRON_SECRET` (rotating it silently invalidates every one-click unsubscribe link already sitting in a
recipient's inbox, because `web/app/api/unsubscribe/route.ts:23-28` uses it as the HMAC key).

For prod only, mirror to the Vercel failover origin and re-run this after **every** prod secret
rotation — it is the only way to guarantee the four `must-match` secrets actually match:

```bash
node scripts/sync-env.mjs diff railway-prod vercel-prod
node scripts/sync-env.mjs sync vercel-prod --apply
```

**4. R2 buckets, CORS, and keys.** The buckets are account-wide, not per environment — one run
creates all four (`owlette-{prod,dev}-{content,manifests}`):

```bash
node scripts/provision-r2.mjs --verify-only
node scripts/provision-r2.mjs
```

The CORS policy is a full-replace PUT applied to the two content buckets only (manifests move
server-side and stay CORS-less on purpose), so adding a dev port means re-running the whole script.
The S3-compatible access keys it cannot mint are a dashboard visit: R2 → Manage R2 API Tokens →
Object Read & Write across the four buckets → set `R2_S3_ACCESS_KEY_ID`, `R2_S3_SECRET_ACCESS_KEY`,
`R2_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com`.

**5. Instatus components.** Create all nine in the Instatus UI and copy each id into the environment:
`INSTATUS_API_KEY`, `INSTATUS_PAGE_ID`, and `INSTATUS_COMPONENT_{DASHBOARD,API,AGENT_REGISTRY,
WEBHOOK_DELIVERY,R2_UPLOADS,FIRESTORE,CORTEX_CHAT}_ID` (required) plus
`INSTATUS_COMPONENT_{ALERT_DELIVERY,TALON_DISPATCH}_ID` (optional — their primary channel is Sentry,
so a missing id must not block the readiness gate). The gate also requires `CRON_SECRET` in the local
shell, which is the usual reason `--env-only` fails on an otherwise-complete Instatus setup. Verify:

```bash
node scripts/check-status-page-ready.mjs --env-only
node scripts/check-status-page-ready.mjs --base-url https://owlette.app
```

**6. Firestore indexes, then rules, then storage rules.** In that order, waiting for `Enabled` between
the first two — see [canonical deploy order](#canonical-deploy-order).

**7. `functions/.env.<projectId>`, then Cloud Functions.** The file is gitignored and lives only on
the deploying machine. Confirm it before every functions deploy:

```bash
ls functions/.env.owlette-prod-90a12   # CORTEX_INTERNAL_SECRET at minimum
firebase deploy --only functions --project prod
```

Other keys read by the functions codebase: `API_BASE_URL` (auto-derived from the project id unless
overridden), `CHUNK_VERIFY_CALLER_UIDS`, `CHUNK_GC_MODE` (must equal `apply` or chunk GC stays
dry-run), and `SECURITY_BOUNDARY_AUDIT_EXPORT_BUCKET` / `_ENV`. This deploy is also what creates the
nine Cloud Scheduler jobs in that project — confirm them:

```bash
gcloud scheduler jobs list --project owlette-prod-90a12 --location us-central1
```

**8. Deploy the web app.** Push to `dev` or merge to `main`; Railway builds. Watch it to completion.

**9. Cortex CLI pin.** Required before any 3.0.0+ installer is promoted into this environment:

```bash
node scripts/upload-cortex-cli.mjs --env=prod \
  --file="C:/ProgramData/Owlette/python/Lib/site-packages/claude_agent_sdk/_bundled/claude.exe" --yes
```

Dry-run first with `--env=dev … --dry-run`. Publish the exact binary that
`pip install -r agent/requirements.txt` produced, never a separately downloaded CLI.

**10. Register the cron jobs — last, once the routes are live.**

`infra/cron-jobs.json` is the **machine-checked** registry: `web/__tests__/infra/cronJobs.test.ts`
fails if a route under `web/app/api/cron/` has no entry (or vice versa), if a declared auth header
stops matching its route source, or if a job does not declare both dev and prod. Add a new
scheduled route there first — that is the entry CI actually enforces.

Two prose tables mirror it, and **neither is enforced by anything**:
`web/content/docs/setup/web-deployment.mdx` (§scheduled endpoints) is the customer-facing one,
and the table below is this runbook's operator-side rendering, carrying the client timeouts the
customer doc does not. Update all three in the same commit.

> **The registry is a declaration of intent, not a live read.** Nothing here queries cron-job.org,
> so a job listed below may simply never have been created — and that failure is silent by design.
> Read a job's own HISTORY in the cron-job.org UI before concluding anything about whether it runs;
> do not infer it from data the job would have written, which can be absent for unrelated reasons
> (a route that shipped after the records in question, for one).

| endpoint | schedule | header | timeout |
|---|---|---|---|
| `GET /api/cron/status-ping` | `* * * * *` | `X-Cron-Secret: <CRON_SECRET>` | default |
| `GET /api/cron/talons` | `* * * * *` | `X-Cron-Secret: <CRON_SECRET>` | **at least 60s** |
| `GET /api/cron/process-alerts` | `*/3 * * * *` | `X-Cron-Secret: <CRON_SECRET>` | default |
| `GET /api/cron/display-alerts` | `*/3 * * * *` | `X-Cron-Secret: <CRON_SECRET>` | default |
| `GET /api/cron/health-check` | `*/5 * * * *` | `X-Cron-Secret: <CRON_SECRET>` | 60s+ recommended |
| `GET /api/hoot/escalation` | `*/5 * * * *` | `Authorization: Bearer <CRON_SECRET>` | default |
| `GET /api/cron/retention` | `0 4 * * *` (or any quiet hour) | `X-Cron-Secret: <CRON_SECRET>` | default |
| `GET /api/cron/api-key-expiry` | `0 8 * * *` (any hour) | `X-Cron-Secret: <CRON_SECRET>` | 30s+ |

Four things to get right:

- **Per environment, always.** Each environment has its own `CRON_SECRET`; a prod secret against
  `dev.owlette.app` correctly returns 401 and fires nothing. A registry that lists one job per path
  under-counts by half.
- **`/api/hoot/escalation` is the odd one out.** It reads `Authorization: Bearer`, not
  `X-Cron-Secret` (`web/app/api/hoot/escalation/route.ts:103`). The wrong header shape is a silent
  401 with no other symptom. Existing jobs pointed at `/api/cortex/escalation` keep working — that
  path is a thin re-export of the same handler — but use the `/api/hoot/` path for anything new.
- **The talons sweep needs a 60s+ client timeout.** It budgets up to ~50s of wall clock
  (`SWEEP_BUDGET_MS = 50_000`, talons/route.ts:74). `/api/cron/health-check` is the genuinely
  unbounded one — it iterates every site, then every machine, with serial Firestore writes and serial
  per-recipient sends — so give it headroom too. No other route defines a time budget.
- **Verify each by hand after registering, and gate on the status code, not the body.** Healthy is
  `200`. The seven `/api/cron/*` routes answer `{"ok":true,…}`, but two bodies differ and will mislead
  you: `/api/cron/status-ping` computes `ok` from component health (`route.ts:262`), so a correctly
  registered job legitimately returns `200` with `"ok":false` while any component is degraded; and
  `/api/hoot/escalation` answers `{"success":true,…}` with no `ok` field at all.

  ```bash
  curl -si -H "X-Cron-Secret: $CRON_SECRET" https://owlette.app/api/cron/talons
  curl -si -H "Authorization: Bearer $CRON_SECRET" https://owlette.app/api/hoot/escalation
  ```

cron-job.org is free-tier with no SLA. If it dies quietly, health alerts and status pings stop until
someone notices by hand — and `/api/cron/status-ping` is the only detector for a stalled
`process-alerts`, `display-alerts`, or `talons` job, so schedule it first and treat it as load-bearing.

**11. Security-boundary audit export and Cloud Monitoring.** Both are prod-unprovisioned today. See
the two command blocks above; neither is required for a functioning environment, and both currently
fail silent rather than loud.

**12. Post-bootstrap verification.**

```bash
node scripts/sync-env.mjs check
node scripts/check-status-page-ready.mjs --base-url https://owlette.app
node scripts/checks/smoke-r2-roundtrip.mjs --base-url https://owlette.app --site <siteId> --api-key owk_...
curl -si https://owlette.app/api/health
```

`/api/health` is unauthenticated and returns 200 only when the origin can reach Firestore — it is the
Cloudflare load balancer's readiness probe and the single best "is prod alive" check. (Note that
[production-deploy.md](production-deploy.md) still says at `:213-214` and `:412` that this route does
not exist; it does — `web/app/api/health/route.ts`.) The API key for the R2 smoke must carry
`site=<siteId>:write` scope.

---

## canonical deploy order

This is the order. It supersedes the step sequence in
[production-deploy.md](production-deploy.md) (`## step-by-step: a normal release`, steps 6-9), which
deploys the web app before the Firestore indexes it queries and collapses rules and indexes into one
`firebase deploy --only firestore`. Both are wrong for the reason spelled out in step 4 below.

1. **Changelog and version bump, committed first.** Add `## [X.Y.Z] - YYYY-MM-DD` to
   `docs/changelog.md` **and** `web/content/docs/changelog.mdx`, run `node scripts/sync-versions.js
   X.Y.Z`, then commit. Nothing downstream is safe to build until this lands, because the installer
   bakes the version into its own filename and binary.
2. **Run any data migration a new rule or index depends on.** Take a Firestore export first —
   `gcloud firestore export gs://owlette-prod-backup/pre-X.Y.Z-$(date +%Y%m%d-%H%M) --project
   owlette-prod-90a12` (the bucket [upgrade-2.12.0.md](upgrade-2.12.0.md) already uses). The role
   migration has no reverse script, and deploying rules before their migration can lock live admins
   out.
3. **Deploy Firestore indexes.** `firebase deploy --only firestore:indexes --project prod`. Indexes
   are additive and harmless ahead of the code that uses them; the reverse is not true.
4. **Wait for every new index to read `Enabled`, not `Building`.** This is a hard gate. A query
   against a still-building index fails with `FAILED_PRECONDITION`, and at least one caller — the
   talon stale-run janitor — swallows that inside its own error boundary and keeps dispatching, so
   you get silent degradation instead of an alarm.
5. **Deploy Firestore rules.** `firebase deploy --only firestore:rules --project prod`. Separate from
   step 3 precisely so the wait in step 4 is possible.
6. **Deploy Storage rules.** `firebase deploy --only storage --project prod`. Same post-migration
   constraint — `storage.rules:19` reads `users/{uid}.role`.
7. **Deploy Cloud Functions.** `firebase deploy --only functions --project prod`, after confirming
   `functions/.env.owlette-prod-90a12` exists on this machine. Functions before web is the safe
   direction: a function deployed early is a Firestore trigger and a scheduled job with no new web
   caller — inert until the app that uses it ships. Web before functions is the dangerous direction —
   the new UI calls a callable or expects a trigger that is not there yet, and the failure lands on
   users. This step also creates or updates the nine Cloud Scheduler jobs in that project.
8. **Deploy the web app.** Merge `dev` into `main` and push; Railway auto-deploys. Watch the build to
   completion before smoke checks. Every backend surface it depends on is now live.
9. **Register or verify the cron-job.org jobs, last.** Once the routes they call are serving, per
   environment, confirming each returns `200` — mind the two response-body exceptions noted in step
   10 of the bootstrap. A job scheduled against a route that does not exist yet just logs 404s nobody
   reads.
10. **Post-deploy.** `node scripts/sync-env.mjs check`; re-run `node scripts/sync-env.mjs sync
    vercel-prod --apply` if any prod secret was rotated; then
    `node scripts/check-status-page-ready.mjs --base-url https://owlette.app` and
    `node scripts/checks/smoke-r2-roundtrip.mjs --base-url https://owlette.app --site <id> --api-key owk_...`.
    Tag the release.

Agent installer releases run on their own track and are **not** part of this sequence — see
[agent-installer-release.md](agent-installer-release.md). The only ordering constraint they share is
step 1, and the cortex CLI pin gate: provision `installer_metadata/cortex_cli` in an environment
*before* promoting a 3.0.0+ installer there.

---

## where the rest lives

Four documents carry the detail this file deliberately does not duplicate. The summaries are here so
a person on call knows what exists without opening `.claude/`.

**`.claude/skills/cf-load-balancing.md` — the `owlette.app` failover load balancer.**
`owlette.app` sits behind a Cloudflare LB with two origins on different clouds: Railway
(`owlette-prod`) as primary, Vercel (`owlette` project) as standby, kept fresh via git-connect. A
monitor polls `GET /api/health` every 60s expecting 200 and sending `Host: owlette.app`; both pools
rewrite the Host header so each origin routes and serves TLS correctly;
`steering_policy = "off"` makes it a pure cascade — all traffic to the first healthy pool, Vercel only
when Railway's monitor fails. It is Terraform in `infra/cloudflare/`, applied by hand with a filled-in
`terraform.tfvars` and `CLOUDFLARE_API_TOKEN` scoped to *Account → Load Balancing: Monitors and Pools
→ Edit* and *Zone → Load Balancers → Edit*. Three traps the skill spells out: state is local and
gitignored, so a second machine applying without it drifts; `railway_origin` must be the underlying
Railway origin hostname, never `owlette.app` itself (the LB would loop back on itself); and the
`~> 4.52` provider pin is deliberate — v5 renamed `default_pool_ids`, `fallback_pool_id`, and the
`header {}` blocks.

**`.claude/skills/env-management.md` — env var parity across three surfaces.**
The three targets are `railway-dev` (serves dev.owlette.app), `railway-prod` (serves owlette.app), and
`vercel-prod` (owlette.app failover). Both Railway services live in the **single environment named
`dev`** — production is a separate *service*, not an environment, so address it as
`-s owlette-prod -e dev`; there is no environment called "production". `railway-prod` and
`vercel-prod` are a mirror pair whose values must be identical; `railway-dev` is independent.
`scripts/env-manifest.json` is the canonical key registry (keys and metadata only, never values) and
`scripts/sync-env.mjs` reconciles live state against it (`status` / `check` / `diff` / `sync`, dry-run
by default, `--apply` to write). There are **four** `must-match` secrets — `SESSION_SECRET`,
`MFA_ENCRYPTION_KEY`, `LLM_ENCRYPTION_KEY`, and `TURNSTILE_SECRET`. Trust the manifest over the skill
here: the skill's prose still says three, having been written before the Turnstile gate shipped. The
limitation that makes all of this dangerous: Vercel stores sensitive vars write-only, so the tool can
prove a key exists but never that its value matches — a green `check` is not proof. Re-running
`sync vercel-prod --apply` (idempotent) after every prod secret rotation is the only guarantee. Never
sync `RAILWAY_*` vars; the tool filters them, and syncing `RAILWAY_PUBLIC_DOMAIN` would break the
`/api/health` origin label.

**[talons.md](talons.md) — the talon scheduler.** The house model for a per-surface runbook: what the
once-a-minute sweep owns, the claim transaction and its 25-per-sweep cap, missed-fire semantics, the
stale-run janitor, the `talon_dispatch` watchdog, and the quick-triage table for "my talon didn't
run". Read it before touching anything under `/api/cron/talons`.

**`web/content/docs/setup/web-deployment.mdx` — the customer-facing deployment guide.** Railway and
Vercel setup, the full env var list, the canonical scheduled-endpoints table (§152-167), and the cron
registration walk-through with example response bodies. It is the public version of parts of this
file; when the two disagree, this one is the operator source of truth and that one should be
corrected — except on the scheduled-endpoints list itself, which is maintained there and rendered
here.

Two more runbooks pair with single rows above rather than with this file as a whole:
[app-check-rollout.md](app-check-rollout.md) for App Check enforcement (including the one rule: never
enforce Cloud Firestore), and [agent-installer-release.md](agent-installer-release.md) for the
installer track.
