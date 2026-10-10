# infra/cloudflare

Terraform for the owlette.app zone on Cloudflare (provider v4, `~> 4.52`):

- **failover load balancer** on `owlette.app`: a `/api/health` monitor, a Railway primary
  pool and a Vercel standby pool (`vercel-origin.owlette.app`). See ADR 0010.
- **edge headers** (`cloudflare_ruleset.edge_headers`, phase
  `http_request_late_transform`): on `owlette.app` and `dev.owlette.app` every request
  reaches the origin with `X-Owlette-Asn` (the client's ASN, `ip.src.asnum`) and
  `X-Owlette-Edge` (a shared secret). The origins compare `X-Owlette-Edge` with
  `EDGE_SHARED_SECRET`; without a match the request came around Cloudflare, so its
  `CF-Connecting-IP` and `X-Owlette-Asn` are whatever the client sent.

The full workflow, the gotchas and the rules are in
`.claude/skills/cf-load-balancing/SKILL.md`.

## Run it

```bash
cd infra/cloudflare
cp terraform.tfvars.example terraform.tfvars    # real ids, gitignored
export CLOUDFLARE_API_TOKEN=...                 # never in a file
export TF_VAR_edge_shared_secret=...            # EDGE_SHARED_SECRET, never in a file
terraform init
terraform plan
terraform apply
```

- **Token scope**: Account › Load Balancing: Monitors and Pools › Edit, Zone › Load
  Balancers › Edit, Zone › Transform Rules › Edit (owlette.app zone).
- **The secret** lives in the main checkout's `.claude/.env.local` as
  `EDGE_SHARED_SECRET` and on railway-dev, railway-prod and vercel-prod under the same
  name (`scripts/env-manifest.json`, class `must-match`). Rotate all four together. It is
  marked sensitive, so plans print `(sensitive value)`, but local state holds it in plain
  text.
- **State** is local and gitignored, and there is no shared copy. Import the live objects
  before planning, or the plan proposes creating everything; the commands are in the skill
  under "Rebuilding state".
