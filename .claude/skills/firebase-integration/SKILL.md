---
name: firebase-integration
description: "Owlette's Firestore data and access model: sites, members, machines, commands, config, users and api_keys paths, firestore.rules helpers and membership-based site access, web client SDK vs the agent's REST client, command flow, alert email and webhook flows. Use for firestore rules, permissions, site access, roles, data paths, collections, schema, commands, webhooks, alerts, or Firebase auth questions."
---

# Firebase Integration Guidelines

**Applies To**: Both web dashboard and Python agent

---

## Firestore Data Structure

The main paths (`firestore.rules` has every collection):

```
firestore/
├── sites/{siteId}/                # name, timezone, owner (legacy), createdAt
│   ├── members/{uid}/             # THE site-access grant. { uid, role, status, addedAt, addedBy }
│   │   # role: 'owner' | 'admin' | 'member'. Written by lib/membership.server.ts and the
│   │   # ownership transfer (lib/actions/transferSiteOwnership.server.ts).
│   │   # `uid` is duplicated as a field so the client can run
│   │   # collectionGroup('members').where('uid','==',me) — rules cannot prove a doc id.
│   ├── machines/{machineId}       # ONE doc the agent heartbeats into — these are fields, not subdocs:
│   │   ├── online, lastHeartbeat  # written with every metrics upload (adaptive: 5s / 30s / 120s)
│   │   ├── metrics: { schemaVersion: 2, cpus, memory, disks, gpus, nics, processes, ... }
│   │   ├── rebooting, shuttingDown          # Set before remote reboot / shutdown
│   │   ├── rebootPending: { active, processName, reason, timestamp }  # When relaunch limit exceeded
│   │   ├── lastScreenshot: { url, timestamp, sizeKB }   # Written by the screenshots/finalize route
│   │   ├── commands/pending       # ONE doc, one map field per command id (Web → Agent)
│   │   ├── commands/completed     # ONE doc: { [cmdId]: { status, result|error, completedAt, type } } (Agent → Web)
│   │   └── screenshots/, installed_software/, hardware/, logs/, metrics_history/, cortex/
│   ├── deployments/{deploymentId} # name, installer_url, silent_flags, targets: [{ machineId, status }], status, createdBy
│   ├── roosts/{roostId}/          # target_state/{machineId}, versions/{versionId}
│   ├── webhooks/{webhookId}       # url, hostname, events[], description?, paused, deletedAt, failureCount, lastDelivery*
│   ├── webhook_secrets/{webhookId}  # Signing secret — server-only, rules deny every client
│   └── logs/, audit_log/, cortex-events/, talons/, talon_runs/, settings/, installer_templates/, ...
├── config/{siteId}/
│   ├── machines/{machineId}/      # Process configuration (version, processes[])
│   │   # Each process has: name, exe_path, launch_mode ("off"/"always"/"scheduled"),
│   │   #   schedules?: [{ name?, colorIndex?, days: string[], ranges: [{ start, stop }] }],
│   │   #   autolaunch (derived, backward compat), check_responsive, relaunch_attempts, ...
│   └── schedule_presets/, reboot_presets/, project_distribution_presets/, talon_presets/
├── users/{userId}/                # email, role (GLOBAL), createdAt, preferences (map: alert toggles, temperatureUnit, timezone, theme, ...)
│   # `role` is GLOBAL and grants nothing on a site: only 'superadmin' carries authority.
│   # `sites[]` is LEGACY: no rule reads it and it grants nothing, but it is still written
│   # (site create, ownership transfer) and read server-side — alert recipients in
│   # lib/adminUtils.server.ts still come from it. Never gate access on it.
│   └── api_keys/{keyId}/          # API key metadata (name, keyHash, keyPrefix, environment, scopes, createdAt, expiresAt, lastUsedAt)
├── api_keys/{keyHash}/            # Top-level API key lookup (userId, keyId, environment, scopes, expiresAt) — O(1) resolution
└── installer_metadata/, system_presets/, chats/, agent_tokens/, agent_refresh_tokens/, device_codes/, ...
```

---

## Two Different Firebase Clients

This is the most important architectural distinction:

| | Web Dashboard | Python Agent |
|---|---|---|
| **SDK** | Firebase Client SDK (`firebase/firestore`) for reads; Admin SDK in API routes for writes | Custom REST client (`firestore_rest_client.py`) |
| **Auth** | Firebase Auth (email/password, Google OAuth, passkeys) | OAuth two-token system (`auth_manager.py`) |
| **Real-time** | `onSnapshot` listeners | Adaptive polling (`listen_to_document`; commands every 2-5s) |
| **Timestamps** | `serverTimestamp()` | `{"timestampValue": "..."}` REST format |

### Agent: Do NOT

- Do NOT import `firebase_admin` — the agent uses a custom REST client
- Do NOT use `google.cloud.firestore` client libraries
- Do NOT use `firestore.SERVER_TIMESTAMP` — REST API uses different format
- Do NOT bypass `ConnectionManager` for reconnection logic
- Do NOT log OAuth tokens, even in DEBUG mode

### Web: Key Patterns

- Firebase init is in `web/lib/firebase.ts` (singleton)
- Auth state lives in `web/contexts/AuthContext.tsx`
- Firestore reads go through hooks in `web/hooks/` (not direct calls from components)
- Client writes are banned by ESLint (`noClientFirestoreWritesRule`); writes go through API routes and `web/lib/actions/*.server.ts`. A user may update only their own `preferences`, `displayName`, `photoURL`, `timezone`, `lastSiteId`, `lastMachineIds` from the client.
- Always scope queries to user's site: `sites/{siteId}/...`

---

## Command Flow (Web → Agent)

```
Web API writes a map field into:  sites/{siteId}/machines/{machineId}/commands/pending
Agent poller picks it up → executes → writes completed[cmdId] and deletes the pending field
Web listener sees completion → updates UI
```

Command types the web sends: process control (`restart_process`, `start_process`, `stop_process`, `kill_process`, `set_launch_mode`), machine (`reboot_machine`, `shutdown_machine`, `cancel_reboot`, `dismiss_reboot_pending`, `capture_screenshot`, `start_live_view`, `stop_live_view`, `update_owlette`, display topology), deployments (`install_software`, `cancel_installation`, `uninstall_software`, `cancel_uninstall`), roost (`sync_pull`), swoop (`swoop_*`), hoot (`mcp_tool_call`, `cancel_mcp_tool`, `provision_cortex_key`). The allowlist for the machine-command API is `ALLOWED_COMMAND_TYPES` in `web/lib/actions/executeMachineCommand.server.ts`.

---

## Alert Flow (Agent → Web API → Email)

```
Agent detects crash → firebase_client.send_process_alert()
  → daemon thread POSTs to /api/agent/alert with the agent's bearer token
  → API checks the agent token (role 'agent', site/machine claims) and the per-process
    rate limit (3/hr per machineId:processName)
  → queues the event in pending_process_alerts
  → /api/cron/process-alerts (every 3 min) emails a per-site digest via Resend
    to recipients with processAlerts !== false
```

`/api/agent/alert` also takes:
- **Connection failure** (`eventType: 'connection_failure'`): emailed immediately, filtered by `healthAlerts` preference
- **Display events** (`display_*`) and `exe_missing`, with their own routing and rate limits

User preferences (`users/{userId}.preferences`, a map field):
- `healthAlerts` (default: true) — machine offline email alerts
- `processAlerts` (default: true) — process crash/start failure email alerts
- `thresholdAlerts`, `cortexAlerts`, `displayAlerts`, `talonAlerts`, `apiKeyAlerts` (default: true)
- `temperatureUnit` ('C' | 'F'), `timezone`, `theme`, ... — display preferences

---

## Webhook Flow (Web API → External URLs)

Two senders write to the same `sites/{siteId}/webhooks` docs:

```
roost / API events (the subscribable catalog, ROOST_WEBHOOK_EVENTS in lib/webhookEvents.ts)
  → emitRoostWebhook() queues to webhook_deliveries
  → functions/src/webhookDispatch.ts pumps them with backoff and auto-disable
  → headers Roost-Event / Roost-Delivery / Roost-Signature

legacy alert path
  → fireWebhooks(siteId, siteName, eventType, data) in lib/webhookSender.server.ts (fire-and-forget fetch)
  → sites/{siteId}/webhooks where events array-contains eventType, then drops deleted/paused/disabled docs
  → generic URLs get X-owlette-Signature: sha256=<hmac>, X-owlette-Event, User-Agent owlette-Webhooks/1.0;
    Slack/Discord URLs get a platform-formatted body, unsigned
  → auto-disables a webhook after 10 consecutive failures
```

Subscribable events: `version.published`, `version.rolled_back`, `deployment.started/completed/failed`, `machine.online/offline`, `chunk.garbage_collected`, `chunk.verify_failed`, `quota.warning/exceeded`, `api_key.used/expired`. `machine.online` and `deployment.completed/failed` are not fired anywhere yet (the settings dialog labels them "future").

The legacy path fires `machine.offline` (health-check cron + agent connection failure), `process.crashed` / `process.restarted` (agent alert; `process.restarted` is what `process_start_failed` maps to), `display.*` and `threshold.breached`. `POST /api/webhooks` rejects the `process.*` events, so only legacy subscriptions receive them. `/api/webhooks/test` and `/api/webhooks/probe` send test deliveries.

---

## Security Rules

Site access is MEMBERSHIP, resolved from `sites/{siteId}/members/{uid}` — not from
`users/{uid}.sites[]` and not from `sites/{siteId}.owner`. No rule reads either legacy
field; server code still reads them for alert recipients and a few listings, never as a
grant.

- `canAccessSite(siteId)` — superadmin, or an ACTIVE membership row.
- `isSiteAdmin(siteId)` — superadmin, or a membership role of `owner` / `admin`.
- A GLOBAL `users/{uid}.role == 'admin'` grants **nothing** on a site it holds no row for.
  This is the escalation the per-site-roles migration closed; do not reintroduce it.
- `isActiveMember` + `siteMemberRole` share one document read, and `isNotDeletedUser` +
  `isSuperadmin` share another, so the auth path costs 2 document reads.
  `get(sites/{siteId})` is deliberately absent from it.
- The recursive `match /{path=**}/members/{memberUid}` block is what makes the client's
  `collectionGroup('members')` query legal — a rule nested under `match /sites/{siteId}`
  does not authorize a collection-group query, however permissive.

That query ALSO needs a single-field index exemption (`members.uid`, COLLECTION_GROUP scope)
in `firestore.indexes.json`. Automatic single-field indexing does NOT extend to
collection-group scope, and neither the emulator nor the Admin SDK will tell you —
`scripts/check-membership-read-path.mjs` is the only check that catches it.

Server-side the same decision lives in `lib/sitePolicy.server.ts` (`resolveSiteAccess`), with
the capability matrix in `lib/capabilities.ts` keyed on the PER-SITE role.

Deployments: any site member can read; only the server (`isServiceAccount()`) creates, updates or deletes. Webhook docs are site-admin read only.

Rules file: `firestore.rules` (version managed independently from product version). Its tests: `cd web && npm run test:rules`.
