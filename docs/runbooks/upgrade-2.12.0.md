# Upgrade to 2.12.x — Full Procedure

> **Historical.** Prod took this promotion in `073e031f` (2026-05-19) and has moved on since. Do not rerun its migrations: `migrate-roles.mjs` (step 2.2) now refuses to run, because the per-site role model replaced the values it writes.

Self-contained runbook for promoting the 2.12.x hardening release from
`dev` to `main` (production). Owns the entire chain: legacy key handling,
env-var provisioning, R2 keys, migrations, Firebase + Railway deploys,
agent installer release, post-deploy verification, and rollback.

> The shipping version is **2.12.1** = 2.12.0 hardening pass + display
> hash patch + CSP style-src relaxation + UX copy-button. This file
> originally targeted 2.12.0 — version labels updated throughout.
>
> This is a coordinated security release with a staged agent rollout. It
> is **not** a normal small-feature release — the generic
> `docs/runbooks/production-deploy.md` does not cover all the steps
> needed for 2.12.x. Use this file end-to-end.

---

## 0 — What's shipping

Version: **2.11.3 → 2.12.1** (semver minor + patch — security hardening,
no intentional user-visible breaking changes).

11 commits on `dev`:

| sha (recent → old) | what |
|---|---|
| `0a771c7` | feat(ui): copy button with check confirmation + clipboard error handling |
| `f3f6ecc` | fix(csp): allow 'unsafe-inline' for style-src so login page hydrates (script-src stays nonce + strict-dynamic) |
| `c5d643e` | fix(display): stop flagging connected monitors as "not connected" after RDP / virtual-display events (v2.12.1) |
| `5e14437` | docs(runbooks,scripts): self-contained 2.12.0 upgrade procedure + key audit tools |
| `09e2880` | fix(security,audit): post-review fixes for 6 issues (C1–C6) |
| `b87ebf8` | docs(claude): add review discipline section |
| `bb181a9` | feat(agent-auth): version-gate refresh-token rotation |
| `1acb6f8` | fix(security): add missed deviceCodeCrypto.ts source |
| `df615e7` | chore: bump version to 2.12.0 + changelog |
| `ccc32be` | test: update auth tests + add wave hardening coverage |
| `395838f` | feat(security): comprehensive 2.12.0 hardening pass |

Full per-item details live in `docs/changelog.md [2.12.0]`. The
headline:

- 5 unauthenticated Cloud Functions now gated on `x-internal-secret`
- MFA server-enforced via session-cookie flags (was bypassable)
- Firestore rules: user-doc field constraints, `deletedAt` gating, new
  rule blocks for `cortex/{docId}`, per-machine logs, `cortex-events`
- `apiAuth.server.ts`: `revokedAt` check, legacy unscoped keys rejected,
  query-string deprecation warning
- Passkey UV → `'required'`, backup-code race fixed, refresh-token
  rotation (version-gated for safe rollout), device-code credentials
  HKDF+AES-GCM encrypted
- Account self-delete preserves shared sites + revokes Firebase Auth user
- Roost kill switch wired into 17 web routes
- Cloud Functions perf: hourly metrics buckets, fanout state-tx split,
  conditional deployment sweeper
- Web perf: bounded historical fetch, hardware-profile listener cap
- CSP nonce + strict-dynamic (no `'unsafe-inline'` for script-src)

---

## 1 — Pre-flight (T-1 day)

### 1.1 Confirm `dev` build + tests are clean

```bash
cd c:/Users/admin/Documents/Git/Owlette/web
npx tsc --noEmit                            # expect: clean
npm run lint                                # expect: 0 errors
npm test -- --runInBand                     # expect: 2384 passing
npm run build                               # expect: clean
cd ../functions
npx tsc --noEmit                            # expect: clean
npm test                                    # expect: 220 passing
```

If any of these fail, **stop**. Don't deploy with broken tests.

### 1.2 Decide on legacy-API-key handling

Run the audit against both environments to see the full picture:

```bash
cd c:/Users/admin/Documents/Git/Owlette
node scripts/migrations/audit-legacy-api-keys.mjs --env=dev
node scripts/migrations/audit-legacy-api-keys.mjs --env=prod
```

Output: console summary + CSV at `dev/scratch/key-audit-{env}-{ts}.csv`.

Any key with `status=will_be_rejected` needs handling **before** the
2.12.x web hits its environment. Three options per key:

**A. Replace with scoped key (recommended).** Use the helper:

```bash
# Dry-run first:
OWLETTE_API_KEY=$(grep '^OWLETTE_API_KEY=' .claude/.env.local | head -1 | cut -d= -f2-) \
node scripts/migrations/replace-legacy-api-key.mjs \
  --env=dev \
  --old-key="$OWLETTE_API_KEY" \
  --scopes='installer=*:write,installer=*:read,installer=*:admin' \
  --name='Installer mgmt key'

# When the dry-run looks right, re-run with --apply:
OWLETTE_API_KEY=$(grep '^OWLETTE_API_KEY=' .claude/.env.local | head -1 | cut -d= -f2-) \
node scripts/migrations/replace-legacy-api-key.mjs \
  --env=dev \
  --old-key="$OWLETTE_API_KEY" \
  --scopes='installer=*:write,installer=*:read,installer=*:admin' \
  --name='Installer mgmt key' \
  --apply
```

The new raw key is printed once. Paste into `.claude/.env.local`:

```
OWLETTE_API_KEY=owk_test_xxx          # dev
OWLETTE_API_KEY_PROD=owk_live_xxx     # prod
```

For prod keys you don't own, use the dashboard's API-keys UI (or have
the owner do it). The replace script is per-key — run once per key
flagged by the audit.

**B. Allowlist (grace period only).** Set in Railway env:

```
LEGACY_API_KEY_BYPASS_ENABLED=true
LEGACY_API_KEY_ALLOW_HASH_LIST=<sha256(key1)>,<sha256(key2)>,...
```

Note: allowlisted keys resolve with `scopes:[]` — they still fail any
`requireScope()` check. Only useful if the routes those keys hit
don't enforce scope (mostly auth-bypass routes — unlikely to apply).

**C. Revoke + notify.** For keys you can't replace (third-party
integrators), set `revokedAt` on the lookup + subcollection docs and
notify the owner via email.

### 1.3 Provision Railway prod env vars

Open Railway prod service settings. Required:

| Var | Notes / verification |
|---|---|
| `ROOST_ENV=prod` | **HARD.** Without this, R2 silently routes to dev bucket. |
| `R2_S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `R2_S3_ACCESS_KEY_ID` | See §1.5 |
| `R2_S3_SECRET_ACCESS_KEY` | See §1.5 |
| `NEXT_PUBLIC_BASE_URL=https://owlette.app` | Otherwise Cortex callbacks fall back to localhost |
| `MFA_ENCRYPTION_KEY` | MFA flow throws if unset |
| `LLM_ENCRYPTION_KEY` | Falls back to MFA key; set separately to decouple rotation |
| `CRON_SECRET` (≥32 chars) | All `/api/cron/*` routes |
| `SESSION_SECRET` (≥32 chars) | iron-session |
| `UPSTASH_REDIS_REST_URL` + `_TOKEN` | Rate limiter falls back to per-instance in-memory if missing |
| `RESEND_API_KEY` + `RESEND_FROM_EMAIL` | Transactional email |
| `CORTEX_INTERNAL_SECRET` | **HARD (new).** Web ↔ Functions internal-only routes fail-closed without it. Same value as `functions/.env` (§1.4). |
| Firebase prod creds (`FIREBASE_PROJECT_ID=owlette-prod-90a12`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`) | Server-side admin SDK |
| All `NEXT_PUBLIC_FIREBASE_*` | Public web config |
| `LEGACY_API_KEY_BYPASS_ENABLED` + `_ALLOW_HASH_LIST` | Only if §1.2 option B chosen |

Optional (but recommended):
- `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`
- All `INSTATUS_*` (8 vars) for status-page integration

### 1.4 Provision Cloud Functions env (`functions/.env`)

Set in the deployment environment (Functions runtime — NOT Railway):

```
CORTEX_INTERNAL_SECRET=<same value as Railway prod>
CHUNK_VERIFY_CALLER_UIDS=<comma-separated UIDs allowed to call verifyChunk>
CHUNK_GC_MODE=dry-run                    # keep dry-run for first 30 days
SECURITY_BOUNDARY_AUDIT_EXPORT_BUCKET=<GCS bucket for audit export>
SECURITY_BOUNDARY_AUDIT_EXPORT_ENV=prod
AUDIT_LOG_REGION=us-central1             # if functions deploy outside us-central1
API_BASE_URL=https://owlette.app
```

`CORTEX_INTERNAL_SECRET` is the single most important new var — its
absence breaks the 5 internal-only HTTPS functions AND breaks web-side
audit logging (the `auditLogClient` posts to `recordAuditEvent` with this
header).

### 1.5 Mint R2 production S3 keys

(One-time setup; skip if already done.)

```bash
node scripts/provision-r2.mjs --verify-only   # check existing buckets
node scripts/provision-r2.mjs                  # idempotent — only creates missing
```

Then mint S3-compatible access keys via the Cloudflare R2 dashboard
(the script can't do this — only the dashboard or CF API can). Scope
the key to:
- `owlette-prod-content` (read+write)
- `owlette-prod-manifests` (read+write)

Set `R2_S3_ACCESS_KEY_ID` + `R2_S3_SECRET_ACCESS_KEY` in Railway prod
env (§1.3). Re-verify:

```bash
node scripts/provision-r2.mjs --verify-only
```

### 1.6 Verify prod cron jobs

The scheduled endpoints run on **cron-job.org**, not Railway. Registration is per
environment: a job pointed at prod carrying the dev `CRON_SECRET` answers 401 and
fires nothing.

Do not maintain a second list here. The canonical table of every scheduled
endpoint — schedule, auth header, purpose — is the scheduled-endpoints section of
`web/content/docs/setup/web-deployment.mdx`, and the operator-side wiring is in
[manual-infrastructure.md](manual-infrastructure.md).

For this upgrade specifically, the only new job is `/api/cron/display-alerts`
(every 3 min, `X-Cron-Secret`) — add it if missing, in each environment.

### 1.7 Maintenance window pre-announcement

If you use Instatus or another status page, post a maintenance window
~2 hours before the merge. The deploy itself is zero-downtime, but
the migration window has a ~minute where pre-migration users may see
denied reads.

---

## 2 — Migrations (T-0, BEFORE rules deploy)

### 2.1 Production Firestore export (irreversible-migration insurance)

```bash
gcloud firestore export gs://owlette-prod-backup/pre-2.12.1-$(date +%Y%m%d-%H%M) \
  --project owlette-prod-90a12
```

Wait for completion before continuing. The role migration has no reverse
script — this export is your only recovery path if something goes wrong.

### 2.2 Role migration (CRITICAL — must run before rules deploy)

```bash
# Dry-run — use bare --dry-run (NOT --dry-run=true; the parser bug
# rejects =true and would silently write live):
node scripts/migrations/migrate-roles.mjs --env=prod --dry-run

# Review the printed counts. Then live:
node scripts/migrations/migrate-roles.mjs --env=prod
```

Maps `role: 'user' → 'member'` and `role: 'admin' → 'superadmin'`.
Idempotent — re-running after success is a no-op.

### 2.3 Synced folders → roosts (if any v1 distributions exist in prod)

```bash
# Default IS dry-run for this script. Inspect output, then:
node scripts/migrations/migrate-synced-folders-to-roosts.mjs --env=prod --apply --keep-source
```

`--keep-source` preserves the original `synced_folders/*` docs for a
soak period. Delete them later when you're confident.

### 2.4 Manifest → version (after synced-folders migration)

```bash
# This script defaults to APPLY mode — pass --dry-run explicitly first:
node scripts/migrations/migrate-manifest-to-version.mjs --project prod --dry-run
node scripts/migrations/migrate-manifest-to-version.mjs --project prod
```

Has `--rollback` if needed (uses `scripts/migration-log.json`).

### 2.5 Profile bootstrap (optional but recommended)

```bash
node scripts/migrations/migrate-profiles.mjs --env=prod --dry-run
node scripts/migrations/migrate-profiles.mjs --env=prod
```

Backfills `hardware/profile` from legacy `metrics.*` so the dashboard
has hardware data for legacy machines that haven't run 2.11+ yet.

---

## 3 — Deploy sequence

Order matters. Each step has its own rollback in §5.

### 3.1 Indexes first (build time can be minutes)

```bash
firebase use prod
firebase deploy --only firestore:indexes
```

2 new composite indexes ship in 2.12.0:
- `webhook_deliveries(state, nextAttemptAt)` — retry queue
- `api_keys(expiresAt, expiredMarkedAt)` — bounded expire query

Watch the Firebase Console → Firestore → Indexes panel until build
status = "Enabled" for both. Don't proceed until indexes are live or
queries depending on them will 500 with `failed-precondition`.

### 3.2 Cloud Functions

```bash
firebase deploy --only functions
```

This deploys ~24 functions including the new reconcilers and the
5 gated HTTPS endpoints. Expected error states on first invocation
(non-blocking, by design):
- `verifyChunk` requires `CHUNK_VERIFY_CALLER_UIDS` (set in §1.4)
- `chunkGcNightly` is in `dry-run` mode initially
- Audit-log functions fail-closed without `CORTEX_INTERNAL_SECRET`

### 3.3 Firestore rules

```bash
firebase deploy --only firestore:rules
```

**Must come AFTER §2.2 role migration** or legacy `admin` users lose
god-mode access (rule now requires `superadmin`).

### 3.4 Storage rules

```bash
firebase deploy --only storage
```

Same constraint — must come after role migration. `storage.rules:18-20`
reads `users/{uid}.role == 'superadmin'`.

### 3.5 Web (Railway auto-deploys on merge to `main`)

```bash
# From repo root:
git checkout main
git pull --ff-only origin main
git merge dev --no-ff -m "chore: merge dev for v2.12.1 production release"
git push origin main
```

Watch Railway build through completion. The `proxy.ts` change means
landing is now server-rendered on every request — first request after
deploy may be ~1s slower than cached pre-2.12.0 state.

### 3.6 Tag the release

```bash
git tag v2.12.1
git push origin v2.12.1
```

Triggers `.github/workflows/build-installer.yml` if you want to publish
the installer via CI. (We've already built + uploaded to dev manually
in §4 — only run this if you also want a CI-built artifact.)

---

## 4 — Agent installer release (separate, after web is stable)

The 2.12.0 installer is live on **dev** Firebase (sha256
`ed4240890cfb06836426c71a95d23e778b5d0f3484edf14fa6aa3363d17f955b`) but
is now STALE — the `c5d643e` display fix bumped to 2.12.1 and that's
what should ship to prod. Rebuild the dev installer at 2.12.1 first
(and re-upload to dev Firebase) so the dev environment matches what
prod will get, then build + upload for prod:

```bash
# 1. Verify version files first
cat VERSION agent/VERSION web/package.json | grep -i version  # all 2.12.1

# 2. Full build (~5 min, non-interactive — the .bat ends with `pause`
#    which hangs unless stdin is redirected from NUL)
cd c:/Users/admin/Documents/Git/Owlette
cmd /c "C:\Users\admin\Documents\Git\Owlette\agent\build_installer_full.bat < NUL > C:\Users\admin\AppData\Local\Temp\installer-build.log 2>&1"
# Or from bash:
#   cd c:/Users/admin/Documents/Git/Owlette/agent && cmd //c "build_installer_full.bat" < /dev/null > /tmp/installer-build.log 2>&1
# Output: agent/build/installer_output/Owlette-Installer-v2.12.1.exe

# 3. Compute checksum
sha256sum agent/build/installer_output/Owlette-Installer-v2.12.1.exe

# 4. Three-step upload to PROD
cd ..
API_KEY=$(grep '^OWLETTE_API_KEY_PROD=' .claude/.env.local | head -1 | cut -d= -f2-)
TS=$(date +%s)

# Step 4a: request signed URL
RESP=$(curl -s -X POST "https://owlette.app/api/installer/upload" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -H "Idempotency-Key: installer-upload-2.12.1-$TS" \
  -d '{"version":"2.12.1","fileName":"Owlette-Installer-v2.12.1.exe","releaseNotes":"2.12.1 — security hardening + display hash + CSP fixes. See docs/changelog.md","setAsLatest":true}')
UPLOAD_URL=$(echo "$RESP" | python -c "import sys,json; print(json.load(sys.stdin).get('uploadUrl',''))")
UPLOAD_ID=$(echo "$RESP" | python -c "import sys,json; print(json.load(sys.stdin).get('uploadId',''))")

# Step 4b: PUT binary to GCS
curl -X PUT "$UPLOAD_URL" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @agent/build/installer_output/Owlette-Installer-v2.12.1.exe

# Step 4c: finalize
SHA=$(sha256sum agent/build/installer_output/Owlette-Installer-v2.12.1.exe | cut -d' ' -f1)
curl -s -X PUT "https://owlette.app/api/installer/upload" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -H "Idempotency-Key: installer-finalize-2.12.1-$(date +%s)" \
  -d "{\"uploadId\":\"$UPLOAD_ID\",\"checksum_sha256\":\"$SHA\"}"

# 5. Verify
curl -s -H "x-api-key: $API_KEY" "https://owlette.app/api/installer/latest" | head -c 400
```

### Refresh-token rotation rollout note

The refresh route gate (commit `bb181a9`) decides per-request based on
`X-Owlette-Agent-Version`:
- Agents on **2.11.x or older** → server keeps the legacy non-rotation
  path; their existing refresh token stays valid indefinitely
- Agents on **2.12.0+** → server rotates the refresh token on every
  refresh; agent client (`auth_manager.py:441+`) persists the new
  token from the response

So no operational coordination is needed — agents auto-update on their
own schedule and start getting rotation when they reach 2.12.0.

---

## 5 — Post-deploy verification

Run within 10 minutes of the merge.

### 5.1 Functional smoke

- [ ] Sign in as a previously-`admin` (now `superadmin`) user. Dashboard
      loads, user management works, installer upload from /admin works.
- [ ] Sign in as a previously-`user` (now `member`) user. Can read
      assigned sites, can't access /admin.
- [ ] **MFA gate**: with an MFA-enrolled account, sign out + sign in
      with password only, then try navigating directly to `/dashboard`.
      You should be redirected to `/verify-2fa`. Complete MFA →
      `/dashboard` loads. **This is the critical MFA-bypass fix; verify
      it works.**
- [ ] **MFA re-enrollment block**: with an MFA-enrolled account, try
      POSTing to `/api/mfa/verify-setup`. Expect `409 mfa_already_enrolled`.
- [ ] Look at a previously-`admin` user record in Firebase Console —
      role should now be `superadmin`.

### 5.2 Cloud Functions sanity

```bash
# emitWebhook should reject without x-internal-secret
curl -X POST \
  "https://us-central1-owlette-prod-90a12.cloudfunctions.net/emitWebhook" \
  -H "content-type: application/json" \
  -d '{"event":"test","siteId":"x"}'
# Expect: 401 unauthorized (or 503 not_configured if CORTEX_INTERNAL_SECRET unset — go fix that)
# NEVER: 200 (would mean the gate isn't working)
```

Watch Firebase Console → Functions → Logs for ~10 min:
- `distributionFanout.onRoostWritten`, `onTargetStateWritten`: silent unless rollouts active
- `webhookDispatch.processRetryQueue`: runs every minute; should log delivery counts
- `auditLog.recordAuditEvent`: should log accepts (from web `auditLogClient`)
- `chunkVerify`, `chunkGcNightly`, `reconcileQuota`: expected to error if R2 wiring stubs aren't implemented yet — that's accepted-risk

### 5.3 Smoke scripts

```bash
node scripts/check-status-page-ready.mjs --base-url https://owlette.app
# Only run if Instatus is configured; otherwise skip

node scripts/checks/smoke-r2-roundtrip.mjs \
  --base-url https://owlette.app \
  --site <site-id> \
  --api-key $OWLETTE_API_KEY_PROD
# Requires a key with site=<id>:write scope
```

### 5.4 Index build verification

```bash
# Submit a DMCA test:
curl -X POST "https://owlette.app/api/legal/dmca" -H "content-type: application/json" \
  -d '{"complainant":{"name":"test","email":"test@example.com"},"workInfo":"test","infringement":"test","sourceIp":"1.1.1.1"}'
# Expect: 200 (NOT 500 failed-precondition — that would mean indexes still building)
```

### 5.5 Watch Railway prod logs 1 hour

Filter for:
- `permission-denied` — anyone hitting a Firestore rule denial
- `failed-precondition` — query without a built index
- `500` — any unhandled server error
- `localhost:3000` — any code path falling back to localhost (would
  indicate `NEXT_PUBLIC_BASE_URL` not set in Railway)
- `[apiAuth] DEPRECATED` — any legacy keys still being used (handle per §1.2)

---

## 6 — Rollback playbook

### 6.1 Web rollback

```bash
git revert <merge-sha>
git push origin main
# Railway auto-redeploys
```

### 6.2 Firestore rules rollback

Firebase Console → Firestore → Rules → History → Restore previous version.

**HAZARD:** If §2.2 role migration ran, rolling rules back to pre-migration
assumes pre-migration data shape. The §2.1 backup is your recovery
path; rolling rules back without restoring data may leave admin users
locked out.

### 6.3 Cloud Functions rollback

```bash
git checkout <prev-sha> functions/
firebase use prod && firebase deploy --only functions
```

### 6.4 Migration rollbacks

- **Roles**: no automatic reverse. Manual reverse via direct Firestore
  writes if absolutely needed:
  ```
  superadmin → admin
  member → user
  ```
  (Indistinguishable from pre-existing same-named values.)
- **Profiles**: no reverse script.
- **Synced folders → roosts**: source preserved if you used `--keep-source`.
- **Manifest → version**: `--rollback` flag works if `scripts/migration-log.json`
  is intact AND no new versions wrote post-migration.

### 6.5 Refresh-token rotation

The version-gate means rollback is trivial — just revert the web. Old
agents were on the legacy path already; new agents revert to
unconditional rotation behaviour (which is what they were already doing
before the gate landed).

### 6.6 Legacy API key replacement

If the `replace-legacy-api-key.mjs` script ran, the old key is
revoked. To roll back: manually clear `revokedAt` on both the
subcollection and lookup-table docs via Firebase Console. The old raw
key is still cached locally (in your prior `.claude/.env.local`).

---

## 7 — Communications

### 7.1 Pre-deploy

- Pre-announce maintenance window on Instatus (if configured)
- Notify any external API-key holders flagged in §1.2 audit who you're
  revoking (give them notice + a path to mint a new scoped key)

### 7.2 Post-deploy

- Confirm status page back to operational
- Customer-facing release announcement (draft below). Highlights:
  - **Server-enforced MFA** — existing sessions may re-prompt once
  - **Passkey logins now require user verification** (PIN/biometric).
    Users with FIDO keys without UV configured will need to re-enroll
    or configure UV on their key
  - **Agents update automatically** to 2.12.1 (refresh-token rotation
    + device-code encryption + display IPC hardening + display-hash
    monitor-presence fix)
  - **No action required for normal users**

### 7.3 Draft release email

> Subject: Owlette 2.12.1 — security hardening release
>
> Hi all,
>
> We've just shipped Owlette 2.12.1 — a comprehensive security
> hardening release. Highlights:
>
> - Multi-factor authentication is now enforced server-side. If you're
>   enrolled in MFA, your next session may prompt you to re-verify
>   once. After that, normal operation.
>
> - Passkey logins now require user verification (PIN, fingerprint, or
>   on-device biometric). If you use a FIDO security key without UV
>   configured, please re-enroll your passkey or configure UV on the
>   key.
>
> - Owlette agents will auto-update to 2.12.1 in the background — no
>   action needed.
>
> - API keys with no explicit scopes (legacy pre-scope-system keys)
>   are no longer accepted. If you have an API key created before
>   {date}, you'll need to create a new one with explicit scopes in
>   the dashboard. We've directly emailed anyone affected.
>
> Full changelog: https://owlette.app/docs/changelog#2.12.1
>
> Questions? Reply to this email.

---

## 8 — Known gaps + accepted risk

Items not addressed in this release but worth tracking:

- `web/lib/idempotency.ts:138` — no transactional reservation; two
  concurrent same-key requests can both execute. Test added with
  `it.skip`. Architectural fix needed in a separate pass.
- 3 functions modules (`metricsHistory`, `distributionFanout`,
  `emitWebhook`) use module-scope `db = admin.firestore()` which blocks
  unit-testing the orchestration paths. DI refactor needed.
- Rules tests (`web/__tests__/rules/wave-hardening.test.ts`) require
  the Firestore emulator (`npm run test:rules`). Not run as part of
  default `npm test`.
- E2E suite not exercised during the hardening pass. Run before merge
  if there's time.
- `requireInternalSecret` length-check short-circuits before
  `timingSafeEqual` — leaks fixed secret length via timing. Low impact
  since the secret length is configuration-shaped, but worth a fix in
  a follow-up.
- 82 inline React `style={{...}}` attributes still require
  `style-src-attr 'unsafe-inline'` in the CSP. Migrate to classes for
  full CSP lockdown.

---

## 9 — Quick reference

### Scripts introduced in 2.12.0

| Script | Purpose |
|---|---|
| `scripts/migrations/audit-legacy-api-keys.mjs` | Inventory API keys, flag empty-scope keys that will be rejected |
| `scripts/migrations/replace-legacy-api-key.mjs` | Replace one empty-scope key with a fresh scoped key |
| `scripts/migrations/migrate-roles.mjs` | (existing) `user → member`, `admin → superadmin` |
| `scripts/migrations/migrate-synced-folders-to-roosts.mjs` | (existing) Rename collection |
| `scripts/migrations/migrate-manifest-to-version.mjs` | (existing) Subcollection rename |
| `scripts/migrations/migrate-profiles.mjs` | (existing) Hardware profile backfill |
| `scripts/provision-r2.mjs` | (existing) R2 bucket setup |
| `scripts/checks/smoke-r2-roundtrip.mjs` | (existing) R2 roundtrip smoke |
| `scripts/check-status-page-ready.mjs` | (existing) Instatus readiness |

### File paths for verification

- Dev installer: `agent/build/installer_output/Owlette-Installer-v2.12.1.exe` (96 MB, sha256 `ed4240890cfb06836426c71a95d23e778b5d0f3484edf14fa6aa3363d17f955b`)
- Dev installer (live on dev Firebase): `https://dev.owlette.app/api/installer/latest`
- Changelog: `docs/changelog.md` `[2.12.0]`
- Plan history: `dev/scratch/PROD-PUSH-FINAL.md` (pre-hardening review), `dev/scratch/PROD-PUSH-READY.md` (mid-hardening plan)
