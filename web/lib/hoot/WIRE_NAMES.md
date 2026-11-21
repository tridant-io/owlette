# hoot — surviving `cortex` names

The assistant is **hoot**. Every route, file, component, hook, type, function and
comment a human or a developer reads says `hoot`. The `cortex` spellings below
are the ones that could not follow, because changing them would change data
already at rest, a credential already deployed, or a URL already published.

`grep -ric cortex web/app web/components web/lib web/hooks`
**before: 563 matching lines / 82 files → after: 151 / 56** (188 / 57 counting
this file, which necessarily spells every survivor). Every survivor is one of
the five classes below; there are no unexplained occurrences.

---

## A — Firestore field / document / collection names (data at rest)

Renaming any of these orphans every existing document. Each also has an agent or
cloud-function writer that would have to ship in the same release.

| name | where | retire cost |
|---|---|---|
| `cortexEnabled` | `machines/{id}.cortexEnabled` — `lib/actions/setHootEnabled.server.ts`, `lib/hoot-utils.server.ts`, `hooks/useFirestore.ts`, `app/hoot/components/HootPowerToggle.tsx` | agent release (the flag gates tool dispatch) + backfill of every machine doc |
| `cortexStatus.*` | `machines/{id}.cortexStatus.{online,lastHeartbeat}` — `lib/hootStream.server.ts`, `app/api/agent/alert/route.ts` | agent release: the agent is the sole writer |
| `settings/cortex` | `sites/{siteId}/settings/cortex` (`.requireTier3Approval`, `.autonomousEnabled`) — `lib/hoot-utils.server.ts`, `lib/actions/setHootRequireTier3Approval.server.ts`, `hooks/useHootApprovalSetting.ts`, `app/api/hoot/autonomous/route.ts`, `app/api/agent/alert/route.ts` | doc-id migration per site + a `firestore.rules` change |
| `cortex-events`, `cortex-nonces`, `cortex-state` | `sites/{siteId}/cortex-*` — `app/api/hoot/autonomous/route.ts`, `app/api/hoot/escalation/route.ts` | collection migration + `firestore.rules` + index rebuild |
| `cortex-followups` | `cortex-followups/{id}`, scheduled follow-ups — `lib/hoot/followupStore.server.ts`, `lib/hoot/followupSweep.server.ts`, `hooks/useHoot.ts` | collection migration + `firestore.rules` + index rebuild |
| `machines/{id}/cortex/*` | active-chat subcollection — `lib/hootStream.server.ts` | agent release + `firestore.rules` (`__tests__/rules/wave-hardening.test.ts` pins the path) |
| `cortexAlerts` | user preference key — `components/AccountSettingsDialog.tsx`, `components/AlertEmailToggles.tsx`, `app/api/unsubscribe/route.ts`, `lib/adminUtils.server.ts`, `lib/hoot-escalation.server.ts` | backfill every `users/{uid}.preferences`; unsubscribe links already in inboxes carry the key |
| `cortexSidebarOpen`, `cortexCollapsedGroups` | `users/{uid}/devicePrefs/global` — `hooks/useHootSidebarPrefs.ts` | backfill, or accept every user's sidebar state resetting once |
| `cortexChatId`, `cortexEventId` | audit-entry metadata — `lib/hoot/dispatch.server.ts` | historical audit rows keep the old keys; `e2e/specs/security-boundary/hoot-autonomous-burst.spec.ts` reads `metadata.cortexEventId` |
| `cortex:user_<uid>` | talon `auditActor` string — `lib/hoot-utils.server.ts`, `lib/talons/store.server.ts` | rewrite of stored talon provenance |
| `cortex_autonomous`, `cortex_provisioning` | `SystemActorName`, written into every audit row — `lib/capabilities.ts`, `lib/auditLog.server.ts`, `lib/systemInvoker.server.ts`, `lib/hoot/dispatch.server.ts` | audit history rewrite; the capability matrix is keyed on the same strings |
| `set_cortex_enabled`, `set_cortex_require_tier3_approval`, `endpoint: 'cortex-enabled' / 'cortex-settings'` | audit verbs + endpoint labels — `lib/actions/setHootEnabled.server.ts`, `lib/actions/setHootRequireTier3Approval.server.ts` | audit-log taxonomy migration; dashboards filter on the verb |

## B — talon output wire type (`type: 'cortex'`)

`TalonOutputType` includes the literal `'cortex'`, `TalonCreatedVia` includes
`'cortex'`, and both are persisted on every talon and every talon-run summary:
`lib/talons/types.ts`, `validation.ts`, `outputs.server.ts`, `store.server.ts`,
`engine.server.ts`, `hootOutput.server.ts`, `app/talons/components/OutputsCard.tsx`,
`TalonCard.tsx`, `TalonEditorDialog.tsx`, `lib/mcp-tools.ts` (the tool schema the
LLM sees, and the `enum` in `openapi.yaml`). The label rendered to a human is
already `hoot`. Retiring it needs a talon-document migration plus a `@owlette/cli`
major, and the MCP tool schema is a published contract in its own right.

## C — published API paths (back-compat aliases)

`/api/hoot/*` is canonical. Every old path still exists as a thin re-export
route file that adds no logic:

`app/api/cortex/{,autonomous,cancel-tool,categorize,conversations,conversations/[conversationId],escalation,provision-key,stop}/route.ts`,
`app/api/sites/[siteId]/cortex-settings/route.ts`,
`app/api/sites/[siteId]/machines/[machineId]/cortex-enabled/route.ts`.

`openapi.yaml` documents the hoot paths as canonical and marks the cortex twins
`deprecated: true`; their `operationId`s and the `CortexConversation` /
`CortexConversationSummary` schemas are unchanged because generated clients
depend on them (`HootConversation*` are `$ref` aliases). `lib/openapiReference.ts`
matches both prefixes. `e2e/specs/api-sprint/chat.spec.ts` deliberately drives
the alias — that is the regression gate on the published surface.

Retire cost: a `@owlette/cli` + SDK major, a deprecation window, and confidence
that no fleet agent is pinned to the old paths.

Two other legacy alias families predate this rename and are untouched:
`/api/chat`, `/api/chat/new`, `/api/chat/{conversationId}`.

## D — deployed secrets and third-party component ids

| name | where | retire cost |
|---|---|---|
| `CORTEX_INTERNAL_SECRET` | `lib/hootInternalSecret.ts` — the **only** place in `web/` that reads it. Every reader goes through `hootInternalSecret()` | simultaneous rotation on Railway dev + Railway prod + Vercel + the Firebase Functions config (`functions/src/lib/requireInternalSecret`) |
| `x-cortex-secret` | the request header that carries it — `app/api/hoot/autonomous/route.ts`, `app/api/hoot/escalation/route.ts`, `app/api/agent/alert/route.ts` | same release as the callers above |
| `cortex_chat` / `INSTATUS_COMPONENT_CORTEX_CHAT_ID` | status-page component id — `lib/healthChecks.server.ts`, `lib/instatusClient.ts`, `scripts/check-status-page-ready.mjs` | rename the component in Instatus and re-point the env var |
| `cortex_events_incoming_total`, `cortex_events_processed_total` | security-boundary metric names — `lib/securityBoundaryMetrics.server.ts`, `app/api/hoot/autonomous/route.ts` | breaks historical metric continuity in the monitoring stack |
| `provision_cortex_key` | machine command type — `app/api/hoot/provision-key/route.ts`; dispatched by `agent/src/owlette_service.py` | agent release, and queued commands drain first |
| `cortex_unavailable` | problem+json error code — `app/api/hoot/conversations/[conversationId]/route.ts`, `app/api/chat/[conversationId]/route.ts` | SDK/CLI major (clients branch on the code) |
| `cortex_escalation` | email-template id — `app/admin/email/page.tsx`, `app/api/test-email/route.ts`; documented at `web/content/docs/dashboard/admin/email-alerts.mdx` | a docs edit, which is a separate task |

## E — `data-testid` values

None. The audit found **zero** `data-testid="cortex-*"` attributes in the app;
the e2e suite selects by role and accessible name. The class is listed only so
future readers know it was checked.

---

## Renamed on purpose (not survivors)

`.cortex-markdown` → `.hoot-markdown`. Verified first that nothing stored
references it: the class is applied at render time by
`components/hoot/HootMarkdown.tsx` and is never embedded in persisted chat
content. `desktop/`'s design-system test and README (which assert the block is
*absent* from the desktop port) were updated in the same pass.

## Deliberately out of scope

The agent's Python surface (`agent/src/cortex_*.py`, `owlette_cortex.py`) and
`scripts/upload-cortex-cli.mjs` keep their names: they are coupled to the
`cortex-cli/` storage prefix and the `installer_metadata/cortex_cli*` documents,
so renaming them is an agent-release task, not a web one. e2e fixture document
ids (`e2e-cortex-*`, `screenshot-cortex-*`) and the docs screenshot asset
`cortex-chat.png` are likewise left alone — the first are seeded Firestore ids,
the second is referenced from `web/content/docs`, which is a separate task.
