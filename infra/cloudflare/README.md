# infra/cloudflare

Terraform for the owlette.app zone on Cloudflare (provider v4, `~> 4.52`):

- **failover load balancer** on `owlette.app`: a `/api/health` monitor, a Railway primary
  pool and a Vercel standby pool (`vercel-origin.owlette.app`). Live since 2026-09-24. See
  ADR 0010.
- **edge headers** (`cloudflare_ruleset.edge_headers`, phase
  `http_request_late_transform`): on `owlette.app` and `dev.owlette.app` the edge adds
  `X-Owlette-Asn` (the client's ASN, `ip.src.asnum`) and `X-Owlette-Edge` (a shared secret
  the origins compare with `EDGE_SHARED_SECRET`) to every request. Without a match the
  request came around Cloudflare, so its `CF-Connecting-IP` and `X-Owlette-Asn` are
  whatever the client sent. **In code since 2026-10-10, not applied yet.** The origin
  compares the secret in `web/lib/network.server.ts`, for swoop's network binding
  (`SWOOP_NETWORK_BINDING`); the skill's status line says what is still owed.

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

State is local and gitignored, with no shared copy: import the live objects before
planning or the plan proposes creating everything. Token scope, the secret's handling and
rotation, the import commands and the gotchas are in
`.claude/skills/cf-load-balancing/SKILL.md`.
