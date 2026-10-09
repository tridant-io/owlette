---
name: codebase-map
description: "Where things live in the Owlette web app: page routes, API route areas and the OpenAPI spec, shared components, hooks, lib helpers and the auth context, plus pointers to the agent, desktop and infra trees. Use before creating a new file, or when asked where a page, route, endpoint, component, hook or helper is, or whether something already exists."
---

# Owlette Codebase Map

Check here before creating a file — reuse what's already built. This map names the
areas and the landmarks; the directories are the full list (`ls web/hooks`,
`ls web/components`), so look there before concluding something is missing.

---

## Web Pages (`web/app/**/page.tsx`, 39 of them)

- **Public**: `/`, `/demo` (backed by `web/contexts/DemoContext.tsx`), `/for-ai`, `/privacy`, `/terms`, `/legal/dmca`, `/unsubscribe`, `/share/[token]` (public chat share). Route handlers, not pages: `/download`, `/llms.txt`, `/for-ai.json`.
- **Auth**: `/login`, `/register`, `/forgot-password`, `/reset-password`, `/setup-2fa`, `/verify-2fa`, `/cli/authorize`, `/add` (machine pairing; `/setup` only redirects here).
- **App**: `/dashboard`, `/deployments`, `/roosts`, `/logs`, `/talons`, `/hoot`, `/hoot/[chatId]`, `/swoop/[siteId]/[machineId]`, `/settings/alerts`, `/settings/api-keys`, `/settings/webhooks`.
- **Admin**: `/admin/alerts`, `/admin/email`, `/admin/installers`, `/admin/members`, `/admin/presets`, `/admin/schedules`, `/admin/swoop`, `/admin/tokens` (per-site agent tokens, not API keys), `/admin/users`, `/admin/webhooks`.
- **Docs**: `/docs/[[...slug]]` (MDX in `web/content/docs`), `/docs/api` (API reference).

Redirects: `web/next.config.ts` sends `/cortex` → `/hoot` and `/owlette/*` → `/docs/*`;
`web/proxy.ts` rewrites `/api/folders/*` → `/api/roosts/*`.

---

## API Routes (`web/app/api/`, ~200 `route.ts`)

The contract is `web/openapi.yaml`, served at `GET /api/openapi` and rendered at
`/docs/api` — read it rather than walking the tree. The shape:

- **Site-scoped resources** live under `/api/sites/[siteId]/...`: machines, machine detail, commands, logs, agent tokens. There is no `/api/admin/*` any more (removed in 644c57f2).
- **API keys**: `/api/keys` (per user), `/api/account/api-keys` (superadmin account keys). **Webhooks**: `/api/webhooks`, `/api/webhooks/[webhookId]`, `/api/webhooks/test`, `/api/webhooks/probe`.
- **Auth**: `/api/auth/session` (iron-session), `/api/mfa/*`, `/api/passkeys/*`.
- **Products**: roost `/api/roosts/*` + `/api/chunks/*`; hoot `/api/hoot/*` + `/api/cortex/*`; installers `/api/installer/*`.
- **Called by the agent**: `/api/agent/auth/device-code` + `/poll` (pairing), `/api/agent/auth/refresh`, `/api/agent/alert`, `/api/agent/site`, `/api/agent/swoop/*`, `/api/bug-report`, plus roost and hoot routes. `/api/agent/auth/exchange` (registration-code exchange) still exists, but no agent code path calls it.

---

## Web Components

- `web/components/ui/` — shadcn/ui primitives, ours to edit; `button.tsx` variants are the single source of truth for button styling (frontend-dev-guidelines skill).
- `web/components/` — shared app components: dialogs (`ConfirmDialog`, `DeploymentDialog`, `ScreenshotDialog`, `WebhookSettingsDialog`, ...), `RequireAdminAccess` (admin guard), `PageHeader`, `ThemeProvider`, `LazyAuthProvider`. Subfolders: `admin`, `auth`, `charts`, `hoot`, `icons`, `landing`, `mdx`, `roost`, `swoop`.
- `web/app/dashboard/components/` — `MachineCardView`, `MachineListView`, `AddMachineButton`, `SiteTimeConfirmBanner`. The process add/edit dialog state lives in `web/app/dashboard/page.tsx`.

---

## Custom Hooks (`web/hooks/`, 59 of them)

Every Firestore read from a component goes through one. Landmarks:

| Hook | Key Exports |
|------|-------------|
| `useFirestore.ts` | `useSites()`, `useMachines(siteId)` (returns `setLaunchMode` among its actions), `useSiteMemberships()`, `useMachineHardware()`, `isMachineOnline()`; interfaces `Site`, `Machine`, `Process` |
| `useDeployments.ts` | `useDeployments(siteId)`, `useDeploymentTemplates`, `useDeploymentManager` |
| `useMachineOperations.ts` | `useMachineOperations(siteId)` — remove machine, send commands |
| `useSparklineData.ts` / `useHistoricalMetrics.ts` | `useSparklineData(siteId, machineId, metricType)`, `useHistoricalMetrics(siteId, machineId, timeRange)` |
| `useOwletteUpdates.ts` | `useOwletteUpdates(machines)` — remote agent updates |
| `useInstallerVersion.ts` / `useInstallerManagement.ts` | latest version; installer upload/management |
| `usePasskeys.ts` | `usePasskeys(userId)` — `registerPasskey`, `deletePasskey`, `renamePasskey`, `supported` |
| `useUserManagement.ts` | `useUserManagement(enabled)` |

---

## Lib Utilities (`web/lib/`)

`*.server.ts` is server-only. Subfolders: `actions`, `alerts`, `display`, `hoot`, `jobs`, `swoop`, `talons`, `workers`.

| File | Purpose |
|------|---------|
| `firebase.ts` | Client Firebase init (`app`, `auth`, `db`, `storage`), `getLatestOwletteVersion()`, `sendOwletteUpdateCommand()` |
| `firebase-admin.ts` | Admin SDK: `getAdminDb()`, `getAdminAuth()`, `getAdminStorage()` |
| `apiAuth.server.ts` | Route auth: `resolveAuth`, `requireSession`, `requireAdminOrIdToken`, `requireScope`, `assertUserHasSiteAccess`, `assertUserHasSiteCapability`, `ApiAuthError` |
| `sitePolicy.server.ts`, `capabilities.ts`, `membership.server.ts` | Site access and per-site roles (firebase-integration skill) |
| `sessionManager.server.ts` | HTTPOnly session via iron-session, including session MFA state |
| `rateLimit.ts` / `rateLimit.server.ts` / `withRateLimit.ts` | Upstash limiters (`authRateLimit`, `apiRateLimit`, ...) / Firestore-sharded per-capability limiter / route wrapper |
| `webhookSender.server.ts` | `fireWebhooks(siteId, siteName, eventType, data)`, `testWebhook(url, secret)` |
| `resendClient.server.ts`, `adminUtils.server.ts` | Email client; alert-recipient lookup |
| `publicOrigin.server.ts` | Public origin for outbound URLs (never the Host header) |
| `errorHandler.ts`, `validators.ts`, `logger.ts`, `versionUtils.ts`, `timeUtils.ts`, `temperatureUtils.ts`, `storageUtils.ts`, `utils.ts` (`cn()`) | Shared helpers |

---

## Context (`web/contexts/AuthContext.tsx`)

Mounted in `app/layout.tsx` through `LazyAuthProvider`. `useAuth()` returns:

```typescript
{ user, loading, role, isSuperadmin, isSiteAdmin(siteId), isSiteOwner(siteId),
  administersAnySite, userSites, lastSiteId, lastMachineIds, requiresMfaSetup,
  mfaFactors, userPreferences, signIn, signUp, signInWithGoogle, signOut,
  updateUserProfile, updateUserPhoto, updatePassword, sendPasswordReset,
  updateUserPreferences, updateLastSite, updateLastMachine, deleteAccount }

type UserRole = 'member' | 'admin' | 'superadmin'   // GLOBAL role; site authority comes from membership
```

`UserPreferences` carries the alert toggles (`healthAlerts`, `processAlerts`,
`thresholdAlerts`, `cortexAlerts`, `displayAlerts`, `talonAlerts`, `apiKeyAlerts`), display
settings (`temperatureUnit`, `timezone`, `timeFormat`, `timeDisplayMode`, `theme`) and UI state.

---

## Outside `web/`

- `agent/src/` — the Python agent: module map in the backend-dev-guidelines skill ([SKILL.md](../backend-dev-guidelines/SKILL.md), [agent-architecture.md](../backend-dev-guidelines/agent-architecture.md)).
- `agent/host/` (Rust service host), `agent/swoop/` (Rust streamer), `desktop/` (Tauri app — `desktop/README.md`).
- `infra/` (Cloudflare terraform, R2), `scripts/` (`scripts/README.md`), `cli/`, `sdks/`, `functions/`, `test/integration/`, `docs/`.
