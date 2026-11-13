# Owlette public API k6 load tests

k6 scripts for the latency-critical public API launch paths. The scripts are plain ES modules and do not add npm dependencies.

## Requirements

- [k6](https://k6.io/docs/getting-started/installation/) installed locally or in CI.
- A scoped Owlette API key for the target environment. Prefer `K6_API_KEY` over `K6_FIREBASE_ID_TOKEN` so the run mirrors SDK/CLI traffic; the API refuses an ID token for an account that has a second factor (`403 mfa_challenge_required`) or still has to set one up (`403 mfa_setup_required`).
- A dedicated load-test site, machine, and Roost on the target environment:
  - `K6_SITE_ID`
  - `K6_MACHINE_ID`
  - `K6_ROOST_ID`

Do not run mutation scripts against a customer site. Use fixture data that can be reset after the run.

## Running

```bash
export K6_BASE_URL=https://dev.owlette.app
export K6_API_KEY=owk_live_...
export K6_SITE_ID=owlette-load-site
export K6_MACHINE_ID=owlette-load-machine
export K6_ROOST_ID=roost-load-folder
export K6_VERSION_CHUNK_HASHES=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef

# smoke: 1 VU, 10 seconds
k6 run --env SCENARIO=smoke test/load/k6/sites-list.js

# sustained: ramp to normal launch load
k6 run --env SCENARIO=sustained test/load/k6/sites-list.js

# spike: short burst for read-heavy routes
k6 run --env SCENARIO=spike test/load/k6/sites-list.js
```

PowerShell:

```powershell
$env:K6_BASE_URL = 'https://dev.owlette.app'
$env:K6_API_KEY = 'owk_live_...'
$env:K6_SITE_ID = 'owlette-load-site'
$env:K6_MACHINE_ID = 'owlette-load-machine'
$env:K6_ROOST_ID = 'roost-load-folder'
$env:K6_VERSION_CHUNK_HASHES = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
k6 run --env SCENARIO=smoke test/load/k6/sites-list.js
```

## SLO targets

Targets are p99 latency gates in milliseconds and are enforced in `lib/config.js`. The k6 summary also reports p95 for launch-report tracking.

| script | endpoint | p99 target |
|---|---|---:|
| `sites-list.js` | `GET /api/sites` | 300 ms |
| `machines-list.js` | `GET /api/sites/{siteId}/machines` | 500 ms |
| `sites-deployments-list.js` | `GET /api/sites/{siteId}/deployments` | 250 ms |
| `process-list.js` | `GET /api/sites/{siteId}/machines/{machineId}/processes` | 250 ms |
| `cortex-conversations-list.js` | `GET /api/cortex/conversations` | 300 ms |
| `users-list.js` | `GET /api/users` | 300 ms |
| `dispatch-machine-command.js` | `POST /api/sites/{siteId}/machines/{machineId}/commands` | 400 ms |
| `process-create.js` | `POST /api/sites/{siteId}/machines/{machineId}/processes` | 400 ms |
| `chunks-check.js` | `POST /api/chunks/check` | 200 ms |
| `upload-urls.js` | `POST /api/chunks/upload-urls` | 500 ms |
| `download-urls.js` | `GET /api/chunks/download-urls` | 400 ms |
| `publish-version.js` | `POST /api/roosts/{roostId}/versions` | 800 ms |

Base reliability gate: `http_req_failed < 0.01`.

`publish-version.js --env SCENARIO=race` is a contention guard, not a reliability SLO. It deliberately allows 412 responses; exactly one request should win the compare-and-swap. Set `K6_EXPECTED_CURRENT_VERSION_ID` to the Roost head immediately before running the race scenario.

## Scripts

Read-oriented scripts that support `smoke`, `sustained`, and `spike`:

- `sites-list.js`
- `machines-list.js`
- `sites-deployments-list.js`
- `process-list.js`
- `cortex-conversations-list.js`
- `users-list.js`
- `chunks-check.js`

Signed-URL scripts support `smoke`, `sustained`, and `burst`:

- `upload-urls.js`
- `download-urls.js`

Mutation scripts support `smoke` and `sustained` unless noted:

- `dispatch-machine-command.js`
- `process-create.js`
- `publish-version.js` (`smoke`, `sustained`, `race`)

Mutation scripts use a per-VU per-iteration `Idempotency-Key` from `lib/config.js` so the run benchmarks the handler instead of idempotency-cache hits.

## Mutation cleanup

`dispatch-machine-command.js` and `process-create.js` write Firestore data on every iteration. Recommended hygiene:

1. Use a dedicated load-test machine.
2. Delete or reset `sites/{K6_SITE_ID}/machines/{K6_MACHINE_ID}/commands` after command-dispatch runs.
3. Reset the load-test machine's process config after process-create runs.
4. Run Roost upload/publish scripts only against a disposable load-test Roost with pre-uploaded chunk hashes in `K6_VERSION_CHUNK_HASHES`.

## CI wiring

Public launch should use:

- PR smoke runs for scripts touched by a change.
- Nightly sustained runs against `dev.owlette.app`.
- A pre-production sustained run before the external launch flag is flipped.

A non-zero k6 exit code means a latency or reliability threshold failed and should block launch until the run is explained or the regression is fixed.

Record real run results in [API load testing and SLOs](../../../docs/internal/public-api-load-testing.md).
