# Env-var gap analysis: `origin/dev` → `origin/main` (production promotion)

Delegated research, 2026-09-22 (read-only; no secret values read or printed; no `sync` run). Branch tips:
`origin/dev` = `723fc344`, `origin/main` = `73f5d512`. Companion to `main-vs-dev.md`.

## Headlines

1. **Ten new keys** on dev, all declared for `railway-dev`, `railway-prod`, `vercel-prod`; the manifest delta is
   pure addition (no key removed, no metadata changed); a `process.env` diff across `web/ functions/ scripts/
   infra/` confirms nothing is read that the manifest omits: `CLOUDFLARE_TURN_KEY_API_TOKEN` (secret),
   `CLOUDFLARE_TURN_KEY_ID` (config), `SWOOP_JWT_KID` (config), `SWOOP_JWT_KID_PREVIOUS` (config),
   `SWOOP_JWT_PRIVATE_KEY` (**must-match**), `SWOOP_JWT_PUBLIC_KEY` (config), `SWOOP_JWT_PUBLIC_KEY_PREVIOUS`
   (config), `SWOOP_SESSION_MASTER_KEY` (**must-match**), `SWOOP_SIGNAL_RING_SECRET` (**must-match**),
   `SWOOP_SIGNAL_URL` (config).
2. **🚩 The `_PREVIOUS` pair makes `sync-env.mjs check` permanently red.** `SWOOP_JWT_KID_PREVIOUS` and
   `SWOOP_JWT_PUBLIC_KEY_PREVIOUS` are declared on all three targets but their steady state is *unset*
   (`web/.env.example:196-200`, `infra/swoop-signal/README.md:64`); `missing = declared − live`
   (`scripts/sync-env.mjs:93`) so `check` exits 1 forever. Fix: set both to **empty strings** on all three
   targets (the consumer is falsy-guarded, `web/app/api/agent/swoop/bundle/route.ts:73`), or move them to
   `targets: []` with a note (the manifest test `web/__tests__/infra/envManifest.test.ts:48-57` covers only the
   other eight keys).
3. **Failure modes if a key is absent in prod** (no key is `NEXT_PUBLIC_*`; none is read at module scope):
   - `SWOOP_JWT_PRIVATE_KEY`, `SWOOP_JWT_KID`, `SWOOP_JWT_PUBLIC_KEY`, `SWOOP_SESSION_MASTER_KEY`: **500 at
     request time** via `requiredEnv()` (`web/lib/swoop/tokens.server.ts:113-120,149,159`;
     `keys.server.ts:44`) — and in the session-create route the Firestore writes happen *first*
     (`createSwoopSession` at `…/swoop/sessions/route.ts:308`, `upsertSwoopViewer` `:316`, mint `:323`,
     master key `:382`), so each attempt leaves an **orphaned session document**, plus a real doorbell ring.
   - `SWOOP_SIGNAL_RING_SECRET`: **fail-soft** (`signal.server.ts:39-49` returns `not_configured`); the
     doorbell is never rung (agent falls back to polling) and, worse, the <2 s **kill broadcast silently does
     not happen**. A mirror mismatch logs `'[swoop/signal] control route refused our secret'`.
   - `SWOOP_SIGNAL_URL`: **clean 503** `swoop_not_configured` on the viewer API (`…/swoop/_shared.ts:63-76`)
     and `503 signal_not_configured` on the agent bundle/doorbell routes; in `web/proxy.ts:65-80` an unset
     value silently omits the signalling origin from CSP `connect-src` (the wss dial is then blocked
     client-side with only a console violation).
   - `CLOUDFLARE_TURN_KEY_ID` / `_API_TOKEN`: degraded, never fatal (`turn.server.ts:53-55,93`): STUN-only
     ice servers; sessions behind symmetric NAT silently fail to connect.
   - `_PREVIOUS` pair: silent feature-off by design (a kid rotation becomes a flag day).
4. **Build-time caveat (undetermined):** if `web/proxy.ts` (Next 16's `middleware.ts`) compiles to the Edge
   runtime, `process.env.SWOOP_SIGNAL_URL` is inlined at build; no `runtime` export or `nodeMiddleware`
   setting exists and no doc says. **Mitigation: set all 10 keys on `railway-prod` and `vercel-prod` before the
   promotion deploy so the shipped build sees them.**
5. **Cloudflare Worker secrets are a separate surface** (`wrangler secret put … -e prod`): `SWOOP_JWT_KID`,
   `SWOOP_JWT_PUBLIC_KEY`, `SWOOP_JWT_KID_PREV`, `SWOOP_JWT_PUBLIC_KEY_PREV` (**`_PREV`, not `_PREVIOUS`**),
   `SWOOP_SIGNAL_RING_SECRET` (byte-identical to the API's, on both `railway-prod` and `vercel-prod`).
   `infra/swoop-signal/README.md:149-152`: first-time prod setup **never executed, workflow never run**. A
   worker missing the ring secret answers every ring `500 ring_secret_unconfigured` while `/health` is 200 —
   the workflow's smoke check (`swoop-signal-deploy.yml:116-136`) deliberately sends no secret and cannot
   catch it. The deploy token needs `zone → workers routes → edit` on `owlette.app` or the deploy fails at the
   route after uploading the script; `vars.SWOOP_SIGNAL_PROD_URL` unset fails the smoke step by design.
6. **Vercel mirror:** all 10 keys are declared on `vercel-prod`; sensitive values are write-only there, so
   `check`/`status`/`diff` prove coverage only — the sole guarantee of value equality for the three
   `must-match` keys is `node scripts/sync-env.mjs sync vercel-prod --apply` after setting `railway-prod`
   (and after any rotation). The Vercel CLI is not linked in this checkout (`web/.vercel` absent).
7. **Adjacent:** `cron-swoop-retention` (`infra/cron-jobs.json`, daily 04:30, `/api/cron/swoop-retention`)
   reuses `CRON_SECRET` but needs a new cron-job.org entry for prod; its failure mode is silent.

## Housekeeping the promotion should carry

- Stale text claiming the `_PREVIOUS` rows do not exist: `infra/swoop-signal/README.md:72-80` and
  `web/app/api/agent/swoop/bundle/route.ts:62-67`.
- `must-match` count "three" → seven: `.claude/skills/env-management.md:53-56`, `scripts/env-manifest.json:35`.
- `web/playwright.config.ts:34-61` (`auditEnvLocalForUnclassifiedSecrets`, invoked at `:106`) throws on any
  `*_KEY|_SECRET|_TOKEN|_DSN` in `web/.env.local` not in its two lists: `CLOUDFLARE_TURN_KEY_API_TOKEN`,
  `R2_S3_SECRET_ACCESS_KEY` and `CLOUDFLARE_API_TOKEN` are newly documented in `web/.env.example` yet
  unclassified → a developer following the example cannot run e2e. Classify them (TURN + R2 reach third
  parties ⇒ `THIRD_PARTY_CREDENTIALS`).
- `web/.env.example` adds bare `CLOUDFLARE_ACCOUNT_ID=` / `CLOUDFLARE_API_TOKEN=` lines that are in neither
  the manifest's `vars` nor its `never-set` inventory; copied into Railway they read as undeclared drift.

## Ordered checklist (env surface only)

1. Prod worker secrets via `wrangler secret put … -e prod` (before any prod Worker deploy; the smoke check
   cannot detect their absence).
2. Repo secrets `CLOUDFLARE_API_TOKEN` (with the zone-routes permission) + `CLOUDFLARE_ACCOUNT_ID`; repo
   variable `SWOOP_SIGNAL_PROD_URL=https://signal.owlette.app`.
3. All 10 keys on `railway-prod` (`SWOOP_SIGNAL_URL=https://signal.owlette.app`; ring secret byte-identical
   to the worker's; the `_PREVIOUS` pair as empty strings).
4. `node scripts/sync-env.mjs sync vercel-prod --apply` (needs the Vercel CLI linked).
5. `node scripts/sync-env.mjs check` — expect clean; do not waive.
6. Make sure the promotion deploy *rebuilds* after 3–4 (the proxy-inlining caveat).
7. Housekeeping above.

## Explicitly undetermined

- Whether `web/proxy.ts` is Edge-compiled (build-time inlining of `SWOOP_SIGNAL_URL`).
- Live provider coverage (`status`/`check` not run here; see `main-vs-dev.md` §2 for the live diff).
- Whether the prod worker secrets are already set (README says not; not verifiable against Cloudflare from
  here).
