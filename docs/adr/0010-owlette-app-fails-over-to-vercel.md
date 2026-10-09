# owlette.app runs on Railway with a Vercel standby behind a Cloudflare load balancer

On 2026-05-19 a Railway platform outage took owlette.app and dev.owlette.app down together: every API route returned 404, agents fell into deep token-refresh backoff and customers had no dashboard. owlette.app now sits behind a Cloudflare load balancer (Terraform in `infra/cloudflare/`) that probes `/api/health` and cascades from Railway to a standby Vercel deployment on another cloud. `/api/health` answers 200 only when the origin can reach Firestore, so an origin that is up but cut off from its backend fails out too.

## Consequences

- Railway prod and Vercel prod are a mirror pair: their environment variables must be identical, managed through `scripts/env-manifest.json` and `scripts/sync-env.mjs`. A secret set on one only breaks the failover silently.
- Vercel builds production from `main` only and serves as `vercel-origin.owlette.app`, because it cannot hold a certificate for `owlette.app`: its renewal challenges would land on Railway.
- dev.owlette.app has no standby. Pushes to `dev` deploy to dev.owlette.app, merges to `main` to owlette.app.
