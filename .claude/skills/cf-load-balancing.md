# Cloudflare Load Balancing (owlette.app failover) Guidelines

**Applies To**: The `owlette.app` failover load balancer — Railway primary, Vercel standby

---

## What this is

Terraform (IaC) in `infra/cloudflare/` for a Cloudflare load balancer that fails
`owlette.app` over between two origins on different clouds, so a provider-level outage
(e.g. Railway losing GCP egress) doesn't take the app down:

- **Railway** (`owlette-prod` service) — primary
- **Vercel** (`owlette` project in the `tridant-7931a9aa` team since 2026-09-24; the
  Experiential scope it started in is blocked) — standby; builds production from `main`
  only (its Ignored Build Step cancels every other deployment)

**Status: not live.** As of 2026-09-10 no load balancer, pool, or monitor exists —
`owlette.app` is a plain proxied CNAME to Railway, and the May 2026 apply was destroyed
the same day. Verify with a GET on `zones/{zone_id}/load_balancers` before assuming
otherwise.

Companion systems: [[env-management]] (env var parity across both origins) and the
`/api/health` readiness probe both origins are checked against.

---

## Topology (infra/cloudflare/main.tf)

1. **monitor** — `GET /api/health` every 60s, expects `200`. `/api/health` returns 200
   only when the origin can reach Firestore, so an origin that's up but cut off from
   its backend is correctly marked unhealthy.
2. **two pools** — `owlette-railway-primary`, `owlette-vercel-standby`. Each origin sends
   its own Host header, which Cloudflare also uses for that origin's health checks (an
   endpoint override beats the monitor's):
   - Railway: `Host: owlette.app`.
   - Vercel: `Host: vercel-origin.owlette.app` — a DNS-only A record → `76.76.21.21`,
     added to the Vercel project, which issues and renews its certificate. Vercel
     can't hold a cert for `owlette.app` itself: its HTTP-01 renewals would land on
     Railway.
3. **load balancer** on `owlette.app` — `steering_policy = "off"` = cascade: send all
   traffic to the first healthy pool in `default_pool_ids` (Railway), fall back to
   Vercel only when Railway's monitor fails.

---

## Apply workflow

```bash
cd infra/cloudflare
cp terraform.tfvars.example terraform.tfvars   # fill in real values (gitignored)
export CLOUDFLARE_API_TOKEN=...                # scoped token, NEVER in a file
terraform init       # first time / after provider bumps
terraform plan       # review the diff
terraform apply      # creates monitor + pools + LB
```

`terraform` is on PATH via winget; if a shell has stale PATH, prepend
`/c/Users/<user>/AppData/Local/Microsoft/WinGet/Links`.

Applying moves `owlette.app` behind the load balancer immediately. Prove failover on a
throwaway hostname first (e.g. a temporary LB on `lbtest.owlette.app` whose Railway
monitor path is deliberately broken, expecting `/api/health` to answer `origin: vercel`),
then delete it.

### Required inputs (terraform.tfvars)

- `account_id`, `zone_id` — Cloudflare dashboard → owlette.app → **Overview** →
  right sidebar **API** box. Or, once `CLOUDFLARE_API_TOKEN` is set, via API:
  `GET https://api.cloudflare.com/client/v4/zones?name=owlette.app` returns both
  the zone `id` and `account.id`.
- `railway_origin` — **NOT** `RAILWAY_PUBLIC_DOMAIN` (that's `owlette.app` itself —
  pointing the pool at it is circular). Use the hostname `owlette.app` currently
  CNAMEs to in Cloudflare DNS (the target Railway issued for the custom domain).
  Find it: Cloudflare DNS record for owlette.app, or Railway → owlette-prod →
  Settings → Networking. Hostname only, no scheme.
- `vercel_origin` — `vercel-origin.owlette.app`. Hostname only, no scheme.

### Token scope

`CLOUDFLARE_API_TOKEN` must have: **Account › Load Balancing: Monitors and Pools › Edit**
and **Zone › Load Balancers › Edit** (for the owlette.app zone). Pass via env var only.

---

## Critical Rules

### Do
- **Keep `vercel-origin.owlette.app` DNS-only** (grey cloud). Proxying it breaks Vercel's
  HTTP-01 certificate renewals.
- **Keep state safe.** Local `*.tfstate` is gitignored. For shared/durable state,
  move to the R2-backed S3 backend stubbed in `versions.tf`.
- **Commit `.terraform.lock.hcl`** (pins provider versions); it's intentionally not ignored.

### Don't
- **Never put `CLOUDFLARE_API_TOKEN` or real `terraform.tfvars` in git.**
- **Don't point `railway_origin` at `owlette.app`** — it must be the underlying Railway
  origin, or the LB loops back on itself.
- **Don't build absolute URLs from the Host header in web code.** Behind the LB the
  Vercel origin sees `Host: vercel-origin.owlette.app`. Use `publicOrigin(request)`
  (`web/lib/publicOrigin.server.ts`). Same-origin redirects from `proxy.ts` are fine —
  Next sends them as relative `Location` headers.
- **Don't bump the cloudflare provider to v5** without migrating — the module targets
  the v4 schema (`default_pool_ids`/`fallback_pool_id`, `header {}` blocks). v5 renamed
  these. The `~> 4.52` pin in `versions.tf` is deliberate.
- **Don't change `steering_policy`** from `"off"` unless you intend to stop pure
  failover — `"off"` is what makes it cascade by pool order.

---

## Prereqs

- Terraform >= 1.5 (`winget install Hashicorp.Terraform`).
- Load Balancing add-on — enabled on the Cloudflare account.
- owlette.app DNS already on Cloudflare (it is).
