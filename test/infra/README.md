# roost test infrastructure

**Wave 1.6 (piecemeal).** Local + CI stand-ins for the Cloudflare R2 production dependencies. Lets the wave-2a routes (`/api/chunks/*`, `/api/roosts/*/versions`) get wired against real S3-compatible storage without waiting on Cloudflare R2 procurement or service-account keys.

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

Point the web app's S3 client (`web/lib/r2Client.server.ts`) at the gateway via env var:

```bash
# web/.env.local for local dev
R2_S3_ENDPOINT=http://localhost:9000
R2_S3_ACCESS_KEY_ID=minioadmin
R2_S3_SECRET_ACCESS_KEY=minioadmin
ROOST_ENV=dev    # buckets are owlette-<ROOST_ENV>-content and -manifests; region is fixed at "auto"
```

The agent's sync modules read their own names (`OWLETTE_R2_ENDPOINT`, `OWLETTE_R2_ACCESS_KEY_ID`, `OWLETTE_R2_SECRET_ACCESS_KEY`, `OWLETTE_R2_CONTENT_BUCKET`, `OWLETTE_R2_MANIFESTS_BUCKET`); see `agent-runner/README.md`.

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
| firebase emulator wired into test setup | done: the whole Playwright suite runs on the emulators | `web/e2e/` |
| S3-compatible stand-in for R2 mocking (versitygw) | **here** | `test/infra/` |
| k6 load-test scaffold | done (wave 5.5) | `test/load/k6/` |
| containerised agent runner for the roost sync engine | **here** | `test/infra/agent-runner/` |
| pact contract test scaffold | not started | — |

## CI integration

The `sync-pipeline` job in `.github/workflows/agent-tests.yml` starts the stand-in from this compose file (`up -d --wait s3`, then `run --rm init-buckets`) and runs the roost sync engine's tests against it on the runner itself, on every pull request and push to `dev`/`main` that touches `agent/` (outside `agent/host` and `agent/swoop`) or `test/infra/`. `agent-runner/README.md` has the commands.

The web suites do not use the stand-in: the e2e suite stubs R2 in Firestore (`OWLETTE_E2E=1`, `web/lib/r2Client.server.ts`), and the Jest specs mock the R2 client, so running it for them would burn runner minutes for nothing.
