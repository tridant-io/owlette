---
name: env-management
description: "Owlette web env vars across Railway dev, Railway prod and the Vercel failover origin: scripts/env-manifest.json plus scripts/sync-env.mjs (status, check, diff, sync), the eight must-match secrets, and the Vercel read-back limit. Use for env vars, secrets, adding, moving or rotating a key, Railway or Vercel variables, env drift, or prod/failover parity."
---

# Env Var Management Guidelines

**Applies To**: Environment variables across Railway (dev + prod) and the Vercel failover origin

---

## Mental Model

Owlette web runs on **three** env-var surfaces:

| Target id | Provider | Where | Serves |
|--|--|--|--|
| `railway-dev` | Railway | project `owlette`, env `dev`, service `owlette-dev` | dev.owlette.app |
| `railway-prod` | Railway | project `owlette`, env `dev`, service `owlette-prod` | owlette.app |
| `vercel-prod` | Vercel | project `owlette`, target `production` | owlette.app (failover) |

> Both Railway services live in the **single `dev` environment** — production is a separate *service* (`owlette-prod`), not a separate environment. Address services by `-s owlette-prod -e dev`, not by an environment named "production" (it doesn't exist).

`railway-prod` and `vercel-prod` are a **mirror pair**: they serve the same domain from two providers, so their values must be identical. `railway-dev` is independent (its own dev values), with one exception: `EDGE_SHARED_SECRET`
is the same value on all three, because one Cloudflare rule serves both hosts, and the tool
does not keep railway-dev in step, so set it there by hand when it rotates.

---

## The System

- **`scripts/env-manifest.json`** — the canonical registry. Lists every var **key** + its class + which targets it belongs to. **Values never live here** — only in the providers.
- **`scripts/sync-env.mjs`** — the tool that reads live state and reconciles it against the manifest.
- This skill — the workflow.

This mirrors the versioning system (`scripts/sync-versions.js` + `docs/internal/version-management.md`).

### Commands

```bash
node scripts/sync-env.mjs                    # status: ✓/✗ coverage grid + drift summary
node scripts/sync-env.mjs check              # exit 1 on any drift (use in CI / pre-deploy)
node scripts/sync-env.mjs diff railway-prod vercel-prod   # key-presence diff
node scripts/sync-env.mjs sync vercel-prod   # DRY RUN — what would sync
node scripts/sync-env.mjs sync vercel-prod --apply        # push railway-prod → vercel-prod
```

`sync` always reads the mirror partner as its source (so `sync vercel-prod` pulls from `railway-prod`). Dry-run is the default; `--apply` writes.

### Var classes

| class | meaning | synced to Vercel as |
|--|--|--|
| `public` | `NEXT_PUBLIC_*`, inlined into the client bundle | `--no-sensitive` (readable) |
| `config` | non-secret config (emails, ids, endpoints, flags) | `--no-sensitive` |
| `secret` | sensitive credential | `--sensitive` |
| `must-match` | sensitive **and** silently catastrophic if it differs across the mirror | `--sensitive` |
| `build` | build-time-only credential (Sentry source maps) | `--sensitive` |

The eight **`must-match`** vars are the ones to never get wrong:
- `SESSION_SECRET` — mismatch logs every user out on failover
- `MFA_ENCRYPTION_KEY` — mismatch locks out every 2FA user
- `LLM_ENCRYPTION_KEY` — mismatch breaks decryption of stored hoot/LLM keys
- `TURNSTILE_SECRET` — mismatch fails every captcha on the failover origin
- `SWOOP_JWT_PRIVATE_KEY` — mismatch means bundles minted on one origin fail to verify at the relay
- `SWOOP_SESSION_MASTER_KEY` — mismatch makes a session's derived keys unreadable across origins
- `SWOOP_SIGNAL_RING_SECRET` — mismatch makes the relay refuse the api's rings and kill broadcasts
- `EDGE_SHARED_SECRET` — the `X-Owlette-Edge` value Cloudflare adds (`infra/cloudflare`); one value on all three targets, and a mismatch makes every request look like it came around the edge, so the origin treats every client as one of unknown network (never a lockout)

---

## Critical Rules

### Do
- **Edit the manifest first**, then sync. Adding a var to Railway? Add it to `env-manifest.json` (with class + targets), then `node scripts/sync-env.mjs sync vercel-prod --apply`.
- **Run `check` before a prod deploy** to catch coverage drift.
- **Re-run `sync vercel-prod --apply` after rotating any prod secret** — it's idempotent (`--force`).
- **Keep `railway-prod` as the source of truth** for prod values; Vercel is a downstream mirror.

### Don't
- **Never put values in the manifest** — keys + metadata only. It's checked into git.
- **Never print secret values.** The tool pipes values through stdin and never echoes them; preserve that. When reading Railway vars manually, extract keys only (e.g. pipe `--json` through a `Object.keys` filter).
- **Never sync `RAILWAY_*` vars** — they're platform-injected. The tool filters them; if you script around it, replicate that filter. Syncing `RAILWAY_PUBLIC_DOMAIN` to Vercel would break the `/api/health` origin label.
- **Never register a `never-set` key under `vars`.** The manifest's `never-set` block lists keys the web reads that must never exist on any target (emulator hosts, `OWLETTE_E2E`, the legacy-key bypass); leaving them out of `vars` is what makes `check` flag one that appears.
- **Don't trust a "values match" signal for Vercel secrets** — see the limitation below.

---

## The Vercel read-back limitation (important)

Vercel stores `--sensitive` vars **write-only** — their values can't be read back via CLI or API. Therefore the tool can detect **coverage drift** (a var present/missing in a target) but **cannot compare secret *values*** across providers.

**Consequence:** the only way to *guarantee* `railway-prod ≡ vercel-prod` for secret values is to **re-run `sync vercel-prod --apply`** (idempotent overwrite). Do this after any prod-secret rotation. Do not assume a green `check` means the values match — `check` only proves the keys exist.

---

## Prereqs

- `railway` CLI authed (`railway login`). Services are addressed by flag, so the linked service doesn't matter for reads.
- `vercel` CLI authed + the `owlette` project linked (`.vercel/` lives in `web/`; scope `tridant-7931a9aa` since 2026-09-24 — `vercel link --yes --project owlette --scope tridant-7931a9aa`).
- `node` (the script is plain Node, no deps).
