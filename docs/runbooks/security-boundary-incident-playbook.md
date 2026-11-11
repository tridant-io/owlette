# Security Boundary Incident Playbook

Use this playbook for W9.1 and later. The first response goal is to keep legitimate privileged work moving without widening the trust boundary more than needed.

## Shared First Steps

1. Identify the active deployment commit and Railway deployment id.
2. Open the W8.2 dashboard and note `capability_decision_total`, `audit_write_failures_total`, `rate_limit_hits_total`, `kill_switch_state`, request p95/p99, and Railway restarts.
3. Pull one affected request's correlation id from the response, audit row, or logs.
4. Confirm whether the actor is session, ID-token, API key, or system.
5. Do not change Firestore rules as a first response. Use the narrow switch only when the scenario below calls for it.

## Scenario 1: Legitimate Admin Traffic Denied

Symptoms:

- `capability-denial-rate` pages.
- Admin or superadmin traffic receives 403 from a privileged route.
- Audit rows show `outcome=deny` for a capability that should be allowed.

Triage:

1. Break down denials by `capability`, `role`, `site`, and route.
2. Query `sites/{siteId}/audit_log` by `outcome=deny` and `capability`.
3. Confirm the user's site role from `sites/{siteId}/members/{uid}` (`role`, `status`); `users/{uid}.role` only says whether they are a superadmin, who reaches every site without a membership; no other value of it grants anything on a site.
4. Check the route's configured capability and `web/lib/capabilities.ts`.
5. If only `role=member` is denied for command paths, that is expected for milestone A and is not an incident.

Mitigation:

1. If legitimate admin/superadmin work is blocked and a patch is not immediate, flip:

```json
{
  "flag": "capability_enforcement",
  "enabled": false,
  "reason": "incident: legitimate admin traffic denied by capability matrix",
  "expiresInMinutes": 60
}
```

2. Patch the capability matrix or route capability.
3. Run targeted route tests plus the affected smoke.
4. Deploy the patch.
5. Re-enable `capability_enforcement`.

Expected dashboard values:

- During mitigation: `kill_switch_state{flag='capability_enforcement',enabled='false'}` observed; bypass audit rows appear with `metadata.enforcement_bypassed='capability'`.
- After fix: admin/superadmin denials return below 1 percent; bypass rows stop; no audit-write failures.

Escalate if more than one site has admin/superadmin denials after the switch is enabled again.

## Scenario 2: Cortex 429s From System Bucket

Symptoms:

- `system-rate-limit-exhaustion` pages.
- Cortex autonomous processing returns 429 or stalls.
- `rate_limit_hits_total{bucket='system'}` is sustained.

Triage:

1. Break down hits by `capability` and `site`.
2. Compare `cortex_events_incoming_total` with `cortex_events_processed_total`.
3. Inspect audit rows for `actor.type='system'` and `actor.name='cortex_autonomous'`.
4. Check for runaway event loops or repeated identical tool calls.
5. Compare observed burst size against W8.0 calibration notes.

Mitigation:

1. If the burst is legitimate, flip:

```json
{
  "flag": "rate_limit_enforcement",
  "enabled": false,
  "reason": "incident: legitimate cortex system burst hit system bucket",
  "expiresInMinutes": 60
}
```

2. Patch `SYSTEM_LIMITS` in `web/lib/rateLimit.server.ts` using W8.0 p99 plus headroom.
3. Deploy the patch.
4. Re-enable `rate_limit_enforcement`.

Expected dashboard values:

- During mitigation: system 429s stop; `kill_switch_state{flag='rate_limit_enforcement',enabled='false'}` observed; bypass audit rows appear with `metadata.enforcement_bypassed='rate_limit'`.
- After fix: `rate_limit_hits_total{bucket='system'}` returns to zero while Cortex processed heartbeat continues.

Escalate if Cortex continues processing identical events after rate-limit enforcement is disabled; that points to a loop rather than a limit issue.

## Scenario 3: Account-Deletion Cascade Hangs

Symptoms:

- `DELETE /api/users/me` returns 5xx or times out.
- A user has some owned site data removed but account deletion did not fully finish.
- Audit row has `capability=USER_SELF_DELETE` with `outcome=error`, or no completion response reached the client.

Triage:

1. Identify the `operationId` and `correlationId` from the response, audit row, or logs.
2. Read `users/{uid}/account_deletion/operation`.
3. Check `status`, `operationId`, `startedAtMs`, `completedAtMs`, `sites`, and `deletedCounts`.
4. Re-scan the affected owned sites for remaining `machines`, `deployments`, and `logs`.
5. Do not manually delete the Firebase Auth user until Firestore ownership cleanup is confirmed.

Replay:

1. Re-issue the same request with the same `Idempotency-Key` if available:

```powershell
Invoke-RestMethod `
  -Method Delete `
  -Uri 'https://dev.owlette.app/api/users/me' `
  -Headers @{ Authorization = "Bearer $token"; 'Idempotency-Key' = '<original key>' }
```

2. If this is a preview, use `?dryRun=1` first and compare `deletedCounts`.
3. If the original request completed, replay should return `alreadyCompleted: true` and `performed: false`.
4. If it did not complete, replay resumes by scanning the remaining docs.

Repair:

1. If the progress doc cannot be read, rebuild remaining work from `users/{uid}.sites[]` when the user doc exists.
2. If the user doc is gone, inspect GCS audit exports and Firestore export data for the latest owned-site evidence.
3. Manually remove only the documented remaining owned docs, in this order: site subcollections, site docs, user doc.
4. Record the manual repair in the incident ticket with affected paths and operator. Do not hand-write audit docs unless an incident commander approves the exact repair record.

Expected dashboard values:

- No capability kill switch should be needed for a cascade hang.
- `audit_write_failures_total` must stay zero; if audit writes fail, stop and resolve Firestore/audit availability first.
- After replay, no remaining owned subcollection docs should exist for the deleted user's owned sites.

## Audit Export And Restore Drill

W9 requires managed Firestore export of security-boundary audit data to GCS with retention longer than Firestore's hot audit window.

Export source:

- Site audit rows: collection group `audit_log` under `sites/{siteId}/audit_log`.
- Platform audit rows: collection group `entries` under `global/audit_log/entries`.

Config:

- `infra/monitoring/security-boundary-audit-export.yaml`

Provisioning outline:

1. Create the export bucket with uniform bucket-level access and lifecycle retention of at least 2555 days.
2. Grant the scheduler/export service account Firestore import/export and bucket object-write permissions.
3. Create a Cloud Scheduler HTTP job that calls Firestore Admin `exportDocuments`.
4. Run a one-time export into a dated prefix.
5. Verify the operation completes and objects land in GCS.

Restore drill:

1. Pick one small dated export prefix.
2. Import into a disposable Firebase project, not prod.
3. Query one site audit row by `correlationId` and one platform audit row by `correlationId`.
4. Confirm timestamps, actor, capability, target, outcome, and metadata match the source incident record.
5. Delete the disposable project or database after the drill.

Do not import audit exports back into prod unless an incident commander approves a scoped restore plan.
