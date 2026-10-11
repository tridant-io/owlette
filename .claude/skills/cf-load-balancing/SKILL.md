---
name: cf-load-balancing
description: "The owlette.app failover load balancer: a Cloudflare LB with Railway primary and Vercel standby, kept as Terraform in infra/cloudflare, probing /api/health. Use for failover, the load balancer, Cloudflare, terraform, the Vercel standby or origin, an origin outage, health checks or probe cost, check_regions, the vercel-origin.owlette.app hostname, and the edge headers transform rule (X-Owlette-Asn, X-Owlette-Edge, EDGE_SHARED_SECRET)."
---

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

**Status: live since ~2026-09-24.** There is no shared terraform state; the live pools
were last changed by API (2026-10-04, `check_regions`, since mirrored into `main.tf`).
Verify with a GET on `accounts/{account_id}/load_balancers/pools` before assuming
anything. To plan against the live objects, import them into a local state first (see
"Rebuilding state" below).

**Edge headers rule: in `main.tf` since 2026-10-10, NOT applied.** The token lacks Zone ›
Transform Rules › Edit and `EDGE_SHARED_SECRET` is on no origin yet; the web code that
compares it is `web/lib/network.server.ts` (swoop's network binding, logging only until
`SWOOP_NETWORK_BINDING=enforce`). Until both are done the spoofing hole below is open.
Check whether the rule is live with a GET on
`zones/{zone_id}/rulesets/phases/http_request_late_transform/entrypoint`.

Companion systems: the env-management skill (env var parity across both origins) and the
`/api/health` readiness probe both origins are checked against
(`web/app/api/health/route.ts`).

---

## Topology (infra/cloudflare/main.tf)

1. **monitor** — `GET /api/health` every 60s, expects `200`. `/api/health` returns 200
   only when the origin can read Firestore within 2.5s (503 otherwise), so an origin
   that's up but cut off from its backend is correctly marked unhealthy.
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
   Vercel when Railway's monitor fails. `adaptive_routing { failover_across_pools = true }`
   also retries a request Railway fails mid-flight against Vercel at once, instead of
   waiting for the next health check.
4. **edge headers** — a zone ruleset in phase `http_request_late_transform` that, on
   `owlette.app` and `dev.owlette.app`, sets two request headers before any origin
   fetch: `X-Owlette-Asn` = `to_string(ip.src.asnum)` (the client's network) and
   `X-Owlette-Edge` = `var.edge_shared_secret`. It matches the public host, so requests
   the LB sends to Vercel should carry them too (unverified until the first apply);
   `set` overwrites a client's own copy. The origins compare `X-Owlette-Edge` with
   `EDGE_SHARED_SECRET` (a must-match var, see the env-management skill). Every origin answers around Cloudflare (measured 2026-10-10:
   `curl --resolve owlette.app:443:<railway ip>`, `--resolve dev.owlette.app:443:<railway ip>`
   and `vercel-origin.owlette.app` all return 200, and a spoofed `CF-Connecting-IP`
   picks the rate-limit bucket), so a request without the secret is one of unknown
   network.

---

## Apply workflow

```bash
cd infra/cloudflare
cp terraform.tfvars.example terraform.tfvars   # fill in real values (gitignored)
export CLOUDFLARE_API_TOKEN=...                # scoped token, NEVER in a file
export TF_VAR_edge_shared_secret=...           # EDGE_SHARED_SECRET from .claude/.env.local, NEVER in a file
terraform init       # first time / after provider bumps
terraform plan       # review the diff
terraform apply      # creates monitor + pools + LB + edge headers rule
```

`terraform` is on PATH via winget; if a shell has stale PATH, prepend
`/c/Users/<user>/AppData/Local/Microsoft/WinGet/Links`.

`edge_shared_secret` is a sensitive variable: plan and apply print `(sensitive value)`,
but the local state holds it in plain text (one more reason state stays out of git). It
must equal `EDGE_SHARED_SECRET` on railway-dev, railway-prod and vercel-prod. One value
for dev and prod, since one rule serves both hosts. Rotating it touches five places
together: `.claude/.env.local`, `terraform apply` of the rule, and the three targets
(`sync-env.mjs` keeps only the prod pair in step, so set railway-dev by hand). A mismatch never locks anyone out: the origin treats the request as one of
unknown network. Changing the rule only adds request headers, so it cannot break traffic,
but the plan must show no change to the monitor, pools or LB before you apply it.

### Rebuilding state

With no state, `terraform plan` proposes creating everything. Import the live objects
first (reads only; ids from a GET on the pools, monitors and `zones/{zone_id}/load_balancers`):

```bash
terraform import cloudflare_load_balancer_monitor.health <account_id>/<monitor_id>
terraform import cloudflare_load_balancer_pool.railway   <account_id>/<pool_id>
terraform import cloudflare_load_balancer_pool.vercel    <account_id>/<pool_id>
terraform import cloudflare_load_balancer.owlette        <zone_id>/<lb_id>
terraform import cloudflare_ruleset.edge_headers         zone/<zone_id>/<ruleset_id>  # once it exists
```

After the import the plan still shows `+ adaptive_routing { failover_across_pools = true }`
on the LB: the v4 provider does not read that block back, and the live LB already has it
(checked 2026-10-10). Applying it rewrites the same value. To change only the edge
headers rule, use `terraform plan -target=cloudflare_ruleset.edge_headers` and apply that
plan. If the zone already has an `http_request_late_transform` entrypoint (one made in the
dashboard), creating the ruleset fails: import it and carry its rules into `main.tf`.

Applying moves `owlette.app` behind the load balancer immediately. Prove failover on a
throwaway hostname first (set `lb_host = "lbtest.owlette.app"` for a temporary LB whose
Railway monitor path is deliberately broken, expecting `/api/health` to answer
`origin: vercel` or `vercel:<region>`), then delete it.

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

`CLOUDFLARE_API_TOKEN` must have: **Account › Load Balancing: Monitors and Pools › Edit**,
**Zone › Load Balancers › Edit** and **Zone › Transform Rules › Edit** (for the
owlette.app zone). Pass via env var only. Without Transform Rules, any GET under
`zones/{zone_id}/rulesets` answers `10000 Authentication error`.

---

## Critical Rules

### Do
- **Keep `check_regions = ["ENAM"]` on every pool.** Unset (null) means every Cloudflare
  data center probes `/api/health`: ~12-23 req/s per origin, each a Firestore read, and
  Vercel bills each one. That ran ~$190/cycle on Vercel from 2026-09-24 to 2026-10-04
  unnoticed. Our plan allows one region. Before any LB change, multiply probe count by
  the per-request price of every origin.
- **Keep `vercel-origin.owlette.app` DNS-only** (grey cloud). Proxying it breaks Vercel's
  HTTP-01 certificate renewals.
- **Keep state safe.** Local `*.tfstate` is gitignored. For shared/durable state,
  move to the R2-backed S3 backend stubbed in `versions.tf`.
- **Commit `.terraform.lock.hcl`** (pins provider versions); it's intentionally not ignored.

### Don't
- **Never put `CLOUDFLARE_API_TOKEN` or real `terraform.tfvars` in git.** Nor
  `edge_shared_secret`: pass it as `TF_VAR_edge_shared_secret`, never in tfvars.
- **Don't trust `CF-Connecting-IP` or `X-Owlette-Asn` in web code without a matching
  `X-Owlette-Edge`.** Without it the request came around Cloudflare and both are
  whatever the client sent.
- **Don't point `railway_origin` at `owlette.app`** — it must be the underlying Railway
  origin, or the LB loops back on itself.
- **Don't build absolute URLs from the Host header in web code.** Behind the LB the
  Vercel origin sees `Host: vercel-origin.owlette.app`. Use `publicOrigin(request)`
  (`web/lib/publicOrigin.server.ts`, which prefers `NEXT_PUBLIC_BASE_URL`). Same-origin
  redirects from `web/proxy.ts` are fine — Next sends them as relative `Location` headers.
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
