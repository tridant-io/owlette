# Security Boundary Kill Switches

This runbook covers the two W9 security-boundary enforcement switches. Use these only during an active incident or a planned drill.

These switches are not public API launch flags. They do not enable or disable routes, hide docs, change package distribution, or pause public onboarding. For the public API launch process, use the [API launch runbook](../internal/public-api-launch-runbook.md). For site-specific Roost distribution containment, use the [Roost kill switch runbook](roost-kill-switch.md).

## Switches

| flag | normal value | when to disable |
| --- | --- | --- |
| `capability_enforcement` | `true` | A capability matrix or route capability bug is denying legitimate admin/superadmin traffic. |
| `rate_limit_enforcement` | `true` | Rate limits are blocking legitimate hoot/system bursts or other privileged traffic. |

Both flags live in Firestore at `global/security_config`. The web process reads the document through `securityConfig.read()` with a 5 second cache. If Firestore is unavailable, the reader falls back to `ENABLE_CAPABILITY_ENFORCEMENT` and `ENABLE_RATE_LIMIT_ENFORCEMENT`, defaulting to enabled.

## Security Impact

Disabling either switch is narrow:

- API-key scope is still enforced.
- Identity is still resolved.
- Firestore rules remain locked down.
- Audit writes still run, and bypassed decisions include `metadata.enforcement_bypassed`.
- Direct browser writes remain denied by rules after lockdown.

Do not flip a switch for missing API-key scope, failed authentication, direct Firestore client-write denials, or audit-write failures. Audit failure is intentionally fail-closed.

## Flip A Switch

Use a superadmin's dashboard session that has passed its second factor, or a superadmin's API key with the `user=*:admin` scope (`owk_…`, sent as the bearer below). A Firebase ID token for an account with a second factor is refused with `403 mfa_challenge_required`.

Policy for W9 incidents: keep `expiresInMinutes <= 240` even though the route accepts longer values for exceptional manual recovery.

```powershell
$token = '<superadmin api key, owk_...>'
$body = @{
  flag = 'capability_enforcement'
  enabled = $false
  reason = 'incident: legitimate admin deployment denied by capability matrix'
  expiresInMinutes = 60
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri 'https://dev.owlette.app/api/platform/security/kill-switch' `
  -Headers @{ Authorization = "Bearer $token"; 'Content-Type' = 'application/json' } `
  -Body $body
```

Use `rate_limit_enforcement` for system/user rate-limit incidents.

The route writes:

- `<flag>`: boolean
- `<flag>_flippedBy`: caller uid
- `<flag>_reason`: operator reason
- `<flag>_expiresAt`: auto re-enable deadline
- `lastUpdated`: server timestamp

Expired flags are treated as enabled by the reader even if the stored boolean still says `false`.

## Re-Enable

```powershell
$token = '<superadmin api key, owk_...>'
$body = @{
  flag = 'capability_enforcement'
  enabled = $true
  reason = 'incident resolved: patched and verified'
  expiresInMinutes = 240
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri 'https://dev.owlette.app/api/platform/security/kill-switch' `
  -Headers @{ Authorization = "Bearer $token"; 'Content-Type' = 'application/json' } `
  -Body $body
```

## Verification

After any flip:

1. Confirm the API response includes `success: true`, the expected `flag`, and `enabled`.
2. Read `global/security_config` and confirm the flag, reason, actor, and expiry.
3. Check W8.2 metrics for `kill_switch_state{flag,changed='true'}`.
4. Confirm bypassed allow rows include `enforcementBypassed: true`.
5. Confirm no unexpected API-key scope bypass occurred.
6. Start a timer for the expiry window and assign an owner to re-enable.

After re-enable:

1. Confirm `kill_switch_state{flag,enabled='true'}` is observed.
2. Run one privileged route smoke.
3. Verify denial/audit/rate-limit metrics return to baseline.
4. Close the incident only after bypass audit rows stop.

## Alert Wiring

The W8.2 monitoring config defines:

- `kill-switch-flipped`: pages on first observed switch change.
- `capability-denial-rate`: pages when denials exceed 1 percent over 5 minutes.
- `system-rate-limit-exhaustion`: pages on sustained system bucket hits.
- `audit-write-failures`: pages when audit writes exceed 0.5 percent of decisions.

Keep this runbook linked from those alert destinations.
