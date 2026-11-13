# Security Boundary Monitoring

W8.2 adds the scaffolding required before wave 9.1 enforcement/prod work. The web app emits structured metric lines prefixed with `[security-boundary-metric]`; alert-worthy events also go to Sentry as `security_boundary.<metric_name>`.

## Sources

- Security-boundary app metrics: Railway log drain parsing `[security-boundary-metric]`.
- Sentry: error and warning metric events from `web/lib/securityBoundaryMetrics.server.ts`.
- Railway: service CPU, memory, restart, deployment status.
- Firestore: Cloud Monitoring QPS for `audit_log`, `rate_limits/*/shards`, `rate_limit_observations`, and `chat_conversations`.
- Synthetic probe: `node scripts/checks/security-boundary-probe.mjs` every 60s from outside Railway.

## Metrics

| metric | meaning | primary alert |
| --- | --- | --- |
| `capability_decision_total{outcome,capability,role,site}` | One authorization decision after the audit write commits. | denial rate |
| `audit_write_failures_total{capability,outcome,role,site}` | Audit write failed. Allow paths fail closed. | audit-write-failures |
| `authorization_enforcement_bypass_total{capability,outcome,role,site,bypass}` | A kill switch allowed a bypassed decision. | kill-switch-flipped |
| `rate_limit_hits_total{bucket,capability,site,actorType,source}` | User/system bucket rejected or would reject. | system-rate-limit-exhaustion |
| `kill_switch_state{flag,enabled,changed}` | Gauge for capability/rate-limit enforcement. | kill-switch-flipped |
| `system_invoker_unexpected_caller_total{actorName,capability,site}` | Runtime import-boundary bypass signal. | page immediately |
| `request_duration_seconds{route,method}` | Sentry request duration for privileged routes. | latency ticket/page |
| `railway_memory_bytes`, `railway_cpu_seconds`, `railway_restart_total` | Railway service health. | railway-restarts |
| `firestore_qps{collection,op}` | Firestore read/write health. | audit-qps-drop |
| `cortex_events_processed_total{site}` | Autonomous hoot event heartbeat. | cortex-events-stalled |

## Alert Wiring

The alert definitions live in `infra/monitoring/security-boundary-alerts.yaml`. Wire them into the active backend as follows:

1. Attach a Railway log drain for `owlette-dev` and parse JSON payloads following `[security-boundary-metric]`.
2. Configure Sentry issue alerts for `security_boundary.audit_write_failures_total`, `security_boundary.authorization_enforcement_bypass_total`, `security_boundary.kill_switch_state`, and `security_boundary.system_invoker_unexpected_caller_total`.
3. Import Railway service metrics for `owlette-dev`.
4. Import Firestore QPS metrics from `owlette-dev-3838a`.
5. Run the synthetic probe outside Railway with a read-only API key:

```powershell
$env:OWLETTE_PROBE_BASE_URL='https://dev.owlette.app'
$env:OWLETTE_PROBE_TOKEN='<read-only token>'
$env:OWLETTE_PROBE_SITE_ID='<site id>'
$env:OWLETTE_PROBE_MACHINE_ID='<machine id>'
node scripts/checks/security-boundary-probe.mjs
```

For one-shot CI/smoke use, add `OWLETTE_PROBE_ONCE=1`.

## Dev Staging Status

As of 2026-04-29, W8.2 is live in dev only:

- Railway dev service: `owlette-dev`
- Sentry mirror: `SECURITY_BOUNDARY_SENTRY_METRICS=true`
- Firestore indexes: deployed to `owlette-dev-3838a`
- Authenticated probe target: `https://dev.owlette.app/api/sites/default_site/machines/TEC-A4D`
- Cloud Monitoring uptime check: `projects/owlette-dev-3838a/uptimeCheckConfigs/w8-2-security-boundary-dev-probe-OrT11yV2nz4`
- Cloud Monitoring alert policy: `projects/owlette-dev-3838a/alertPolicies/7104635980783343496`
- Notification channel: `projects/owlette-dev-3838a/notificationChannels/1048804608000008252`
- Local staging probe log: `test-results/security-boundary-probe-dev.jsonl`

The uptime check masks the `Authorization` header in Cloud Monitoring. Treat the probe API key as temporary because it was created for staging; revoke or rotate it after the migration window.

## Capability Denial Rate

Alert: `capability-denial-rate`

Trigger: more than 1% of authorization decisions are `outcome=deny` over 5 minutes.

Triage:

1. Break down by `capability`, `role`, and `site`.
2. Check whether the spike is isolated to `role=member`; member control-plane writes are expected to deny in milestone A.
3. Query recent audit rows by `outcome=deny` and `capability` using the W8.2 composite indexes.
4. If legitimate admin traffic is denied, inspect `web/lib/capabilities.ts` and the affected route's `capability`.
5. Only flip `capability_enforcement=false` if legitimate production work is blocked and the patch is not immediate.

Escalate when denial rate affects admins or superadmins across more than one site.

## Audit Write Failures

Alert: `audit-write-failures`

Trigger: audit write failures exceed 0.5% of decisions over 5 minutes.

Triage:

1. Check Firestore status and quota for writes to `sites/*/audit_log`.
2. Inspect web logs for `audit log write failed` or `allow-audit write failed`.
3. Confirm privileged allow routes are returning 503 rather than mutating without audit.
4. Do not disable Firestore rules for this. Audit failure is intentionally fail-closed.

Escalate immediately if allow-path writes are failing for multiple routes.

## System Rate-Limit Exhaustion

Alert: `system-rate-limit-exhaustion`

Trigger: any sustained `rate_limit_hits_total{bucket='system'}` for 5 minutes.

Triage:

1. Break down by `capability` and `site`.
2. Check autonomous hoot event volume and whether a runaway loop is dispatching repeated commands.
3. If the burst is legitimate, flip `rate_limit_enforcement=false` temporarily and patch `SYSTEM_LIMITS` with W8.0 calibration data.
4. Re-enable the flag after the patch deploys and verify no new system hits.

Escalate if `cortex_autonomous` is blocked on machine command dispatch.

## Kill Switch Flipped

Alert: `kill-switch-flipped`

Trigger: `kill_switch_state{changed='true'}`.

Triage:

1. Confirm who flipped the flag in `global/audit_log/entries`.
2. Check the reason and expiry on `global/security_config`.
3. Verify bypass audit rows include `metadata.enforcement_bypassed`.
4. Start the re-enable timer immediately. Flags should not remain off longer than the documented incident window.

Escalate immediately for any unexpected flip.

## Privileged Route Latency

Alert: `privileged-route-latency`

Trigger: p95 request duration above 2s for 10 minutes.

Triage:

1. Break down by route and method.
2. Check whether latency is Firestore audit writes, rate-limit shards, or the action core.
3. For rate-limit shard pressure, inspect `sites/{siteId}/rate_limits/*/subjects/*/capabilities/*/shards`.
4. For audit pressure, check `audit_log` write QPS and Firestore latency.

Escalate if latency coincides with 5xx or audit write failures.

## Railway Restarts

Alert: `railway-restarts`

Trigger: any restart in 10 minutes.

Triage:

1. Check latest deployment status and commit.
2. Inspect Railway logs around the restart for OOM, process crash, or health failure.
3. Compare memory/CPU to W8.1 Railway drill baseline.
4. Roll back the deployment if crashes continue after one restart-policy cycle.

## Firestore Audit QPS Drop

Alert: `firestore-audit-qps-drop`

Trigger: privileged decisions continue but `audit_log` write QPS is zero for 15 minutes.

Triage:

1. Verify the log drain is parsing `capability_decision_total`.
2. Check Firestore write errors in Sentry.
3. Run a single privileged route smoke and confirm an audit row lands.
4. If audit rows are missing, stop the rollout and investigate before prod.

## Cortex Events Stalled

Alert: `cortex-events-stalled`

Trigger: incoming autonomous hoot events exist but processed events are zero for 15 minutes.

Triage:

1. Check `/api/hoot/autonomous` (old path `/api/cortex/autonomous`) and `/api/agent/alert` logs.
2. Confirm the internal `x-cortex-secret` gate has not changed.
3. Check system bucket rate-limit hits.
4. Verify audit rows for `actor.type=system`, `actor.name=cortex_autonomous`.

## Synthetic Probe 5xx

Alert: `synthetic-probe-5xx`

Trigger: the external read-only probe fails for 2 minutes.

Triage:

1. Check probe status code and latency.
2. If 401/403, rotate or re-scope the probe key.
3. If 5xx, inspect Railway and Sentry for the route.
4. Verify `GET /api/whoami` separately to distinguish auth from route failure.

## Firestore Indexes

W8.2 adds composite indexes for:

- `chat_conversations`: `(siteId ASC, updatedAt DESC, __name__ DESC)` and `(siteId ASC, ownerUid ASC, updatedAt DESC, __name__ DESC)`.
- `audit_log` collection group: capability, actor user id, actor type, outcome, and target lookup shapes ordered by `timestamp DESC`.

Deploy to dev:

```powershell
firebase deploy --only firestore:indexes --project owlette-dev-3838a --config firebase.json --non-interactive
```

After deployment, rerun the W8.1 hoot member-list read if needed; the missing-index failure should be gone once Firestore finishes building indexes.
