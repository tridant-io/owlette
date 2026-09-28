# roost test infrastructure

**Wave 1.6 (piecemeal).** Local + CI stand-ins for the Cloudflare R2 production dependencies. Lets the wave-2a routes (`/api/chunks/*`, `/api/roosts/*/manifests`) get wired against real S3-compatible storage without waiting on Cloudflare R2 procurement or service-account keys.

## versitygw — local R2 stand-in

[versitygw](https://github.com/versity/versitygw) is an Apache-2.0 S3 gateway over a directory. It replaced MinIO on 2026-09-24, the day MinIO withdrew its public images and binaries (anonymous pulls 401 on Docker Hub and quay.io, `dl.min.io` answers 410).

```bash
docker compose -f test/infra/docker-compose.yml up -d

# init-buckets exits once setup is done; wait for it (<10 s):
docker compose -f test/infra/docker-compose.yml logs init-buckets
```

After that:

- **S3 API**: `http://localhost:9000` — point web API clients here in dev/test (credentials `minioadmin` / `minioadmin`, dev-only)
- **Buckets**: `owlette-dev-content`, `owlette-dev-manifests` created; anonymous requests are refused

### Wiring the web API

When wave 2a.1–2a.6 wire up real handlers, point the S3 client at the gateway via env var:

```bash
# web/.env.local for local dev (or CI env for emulator runs)
OWLETTE_R2_ENDPOINT=http://localhost:9000
OWLETTE_R2_ACCESS_KEY_ID=minioadmin
OWLETTE_R2_SECRET_ACCESS_KEY=minioadmin
OWLETTE_R2_BUCKET_CONTENT=owlette-dev-content
OWLETTE_R2_BUCKET_MANIFESTS=owlette-dev-manifests
OWLETTE_R2_REGION=auto    # R2 uses "auto"; the gateway accepts anything
```

The `@aws-sdk/client-s3` library speaks both R2 and the gateway unchanged — no code changes needed to swap between them.

### Bucket policy parity

The gateway refuses unsigned requests on its own, mirroring the R2 `DenyAnonymousAccess` statement in `infra/r2/r2-bucket-policy.json`; the buckets carry no policy. The full R2 policy JSON isn't applied — its resource list names all four buckets — but the functional surface (anonymous → refused, signed → allowed) matches.

The init script (`test/infra/s3/init.sh`, run through the `amazon/aws-cli` image) creates the buckets and smoke-checks that an unsigned listing is refused, exiting non-zero if not.

## Teardown

```bash
# stop containers, keep data
docker compose -f test/infra/docker-compose.yml down

# stop + wipe uploaded chunks
docker compose -f test/infra/docker-compose.yml down -v
```

## What's here vs what isn't

| wave-1.6 target | status | location |
|---|---|---|
| firebase emulator wired into test setup | partial (phase A in commit `cb8d06e`) | `web/e2e/` |
| S3-compatible stand-in for R2 mocking (versitygw) | **here** | `test/infra/` |
| k6 load-test scaffold | done (wave 5.5) | `test/load/k6/` |
| containerised agent runner for e2e | not started | — |
| pact contract test scaffold | not started | — |

The containerised agent runner + pact are the remaining blockers for wave 4c.5 (e2e agent test in CI).

## CI integration (future)

The docker-compose file is CI-friendly — GitHub Actions' `docker compose` action runs it unchanged. Add a job step:

```yaml
- name: start test infra
  run: |
    docker compose -f test/infra/docker-compose.yml up -d
    docker compose -f test/infra/docker-compose.yml run --rm init-buckets
- name: web tests against the s3 stand-in
  env:
    OWLETTE_R2_ENDPOINT: http://localhost:9000
    OWLETTE_R2_ACCESS_KEY_ID: minioadmin
    OWLETTE_R2_SECRET_ACCESS_KEY: minioadmin
  run: cd web && npm test
```

Wiring this into existing workflows is deferred until 2a routes are real — running this setup for a test suite that doesn't actually touch the stand-in is burning runner minutes for nothing.
