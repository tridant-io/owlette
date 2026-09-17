# Owlette Codebase Map

**Last Updated**: 2026-03-21

Quick reference of everything that exists. Check here before creating new files — reuse what's already built.

---

## Web Pages (`web/app/`)

| Route | File | Purpose | Auth |
|-------|------|---------|------|
| `/` | `app/page.tsx` | Landing page | No |
| `/login` | `app/login/page.tsx` | Email/password + Google OAuth + Passkey | No |
| `/register` | `app/register/page.tsx` | Account creation + 2FA prompt | No |
| `/setup-2fa` | `app/setup-2fa/page.tsx` | TOTP authenticator setup (QR) + optional passkey registration | Yes |
| `/verify-2fa` | `app/verify-2fa/page.tsx` | TOTP code verification | Partial |
| `/setup` | `app/setup/page.tsx` | Admin first-time setup | Admin |
| `/dashboard` | `app/dashboard/page.tsx` | Main dashboard (machines, processes) | Yes |
| `/deployments` | `app/deployments/page.tsx` | Remote deployment management | Yes |
| `/projects` | `app/projects/page.tsx` | Project distributions | Yes |
| `/logs` | `app/logs/page.tsx` | Activity logs | Yes |
| `/admin/users` | `app/admin/users/page.tsx` | User management | Admin |
| `/admin/installers` | `app/admin/installers/page.tsx` | Installer management | Admin |
| `/admin/presets` | `app/admin/presets/page.tsx` | System presets | Admin |
| `/admin/tokens` | `app/admin/tokens/page.tsx` | API token management | Admin |
| `/admin/webhooks` | `app/admin/webhooks/page.tsx` | Webhook notification management | Admin |
| `/admin/test-email` | `app/admin/test-email/page.tsx` | Email delivery testing | Admin |
| `/privacy` | `app/privacy/page.tsx` | Privacy policy | No |
| `/terms` | `app/terms/page.tsx` | Terms of service | No |

---

## API Routes (`web/app/api/`)

| Endpoint | Method | Purpose | Auth | Agent Calls? |
|----------|--------|---------|------|-------------|
| `/api/auth/session` | GET/POST/DELETE | HTTPOnly session management (iron-session) | Session | No |
| `/api/agent/auth/exchange` | POST | Exchange registration code for OAuth tokens | None (code-based) | Yes: `auth_manager.py` |
| `/api/agent/auth/refresh` | POST | Refresh expired access token | Refresh token | Yes: `auth_manager.py` |
| `/api/agent/generate-installer` | POST | Generate dynamic installer config | Session | No |
| `/api/mfa/setup` | POST | Generate TOTP secret + QR code | Session | No |
| `/api/mfa/verify-setup` | POST | Confirm TOTP setup with code | Session | No |
| `/api/mfa/verify-login` | POST | Verify TOTP during login | Partial | No |
| `/api/passkeys/register/options` | POST | Generate WebAuthn registration challenge | Session | No |
| `/api/passkeys/register/verify` | POST | Verify registration + store credential | Session | No |
| `/api/passkeys/authenticate/options` | POST | Generate WebAuthn auth challenge (pre-login) | None | No |
| `/api/passkeys/authenticate/verify` | POST | Verify passkey login + create session/token | None | No |
| `/api/passkeys/list` | GET | List user's registered passkeys | Session | No |
| `/api/passkeys/{credentialId}` | PATCH/DELETE | Rename or delete a passkey | Session | No |
| `/api/admin/tokens/list` | POST | List API tokens | Admin | No |
| `/api/admin/tokens/revoke` | POST | Revoke API token | Admin | No |
| `/api/setup/generate-token` | POST | Generate admin setup token | Admin | No |
| `/api/agent/alert` | POST | Agent health + process crash email alerts (Resend) | Agent token | Yes: `firebase_client.py` |
| `/api/webhooks/user-created` | POST | Signup notification email (Resend) | Webhook | No |
| `/api/test-email` | POST | Test email delivery | Admin | No |
| `/api/admin/keys/create` | POST | Create API key (`owk_` prefix) | Session (admin) | No |
| `/api/admin/keys` | GET | List user's API keys | Session (admin) | No |
| `/api/admin/keys/revoke` | DELETE | Revoke an API key | Session (admin) | No |
| `/api/admin/sites` | GET | List all sites the user has access to | Admin or API key | No |
| `/api/admin/webhooks` | GET/POST/DELETE | CRUD for site webhooks | Admin or API key | No |
| `/api/admin/machines` | GET | List machines for a site | Admin or API key | No |
| `/api/admin/machines/status` | GET | Get detailed machine status | Admin or API key | No |
| `/api/admin/commands/send` | POST | Send command to machine (with optional polling) | Admin or API key | No |
| `/api/admin/logs` | GET | Read activity logs with filters | Admin or API key | No |
| `/api/admin/events/simulate` | POST | Simulate events (process_crash, machine_offline, connection_failure) + fire webhooks | Admin or API key | No |
| `/api/webhooks/test` | POST | Test webhook delivery for a specific webhook | Site membership + `WEBHOOK_MANAGE` (site admin or superadmin); API keys also need `site=<id>:write` | No |

---

## Web Components

### Dashboard Components (`web/app/dashboard/components/`)
| Component | Purpose |
|-----------|---------|
| `MachineCardView.tsx` | Card grid view of machines with metrics |
| `MachineListView.tsx` | Table list view of machines |
| `ProcessDialog.tsx` | Add/edit process configuration dialog |

### App Components (`web/components/`)
| Component | Purpose |
|-----------|---------|
| `ScheduleEditor.tsx` | Schedule block editor for process scheduled launch mode (days + time ranges) |
| `AccountSettingsDialog.tsx` | User profile, password, preferences (healthAlerts, processAlerts toggles) |
| `ConfirmDialog.tsx` | Generic confirmation dialog |
| `CreateSiteDialog.tsx` | Create new site |
| `DeploymentDialog.tsx` | Create/manage deployments |
| `DownloadButton.tsx` | Download installer button |
| `ErrorBoundary.tsx` | React error boundary wrapper |
| `Footer.tsx` | App footer with version |
| `MachineContextMenu.tsx` | Right-click menu: reboot, shutdown, screenshot, remove, revoke token. Admin-only actions with confirmation dialogs. |
| `ScreenshotDialog.tsx` | Modal to capture/view machine screenshots via Firestore command + real-time listener |
| `ManageSitesDialog.tsx` | Admin site management |
| `ManageUserSitesDialog.tsx` | Assign users to sites |
| `PageHeader.tsx` | Consistent page header |
| `ProjectDistributionDialog.tsx` | Project distribution config |
| `RemoveMachineDialog.tsx` | Remove machine from site |
| `RequireAdmin.tsx` | Auth guard (redirects non-admins) |
| `SystemPresetDialog.tsx` | System preset configuration |
| `UninstallDialog.tsx` | Remote uninstall confirmation |
| `UpdateOwletteButton.tsx` | Trigger remote agent update |
| `PasskeyManager.tsx` | Register, rename, delete passkeys (WebAuthn) |
| `WebhookSettingsDialog.tsx` | CRUD + test for site webhook notifications |

### Chart Components (`web/components/charts/`)
| Component | Purpose |
|-----------|---------|
| `MetricsDetailPanel.tsx` | Expanded metrics panel with time-series charts |
| `SparklineChart.tsx` | Mini inline sparkline charts (Recharts) |
| `ChartTooltip.tsx` | Custom Recharts tooltip |
| `TimeRangeSelector.tsx` | 24h / 7d / 30d selector |

### Landing Page (`web/components/landing/`)
| Component | Purpose |
|-----------|---------|
| `LandingHeader.tsx` | Navigation header |
| `HeroSection.tsx` | Hero with TypewriterText |
| `UseCaseSection.tsx` | Use case cards |
| `FeatureGrid.tsx` | Feature grid layout |
| `CTASection.tsx` | Call-to-action |
| `LandingFooter.tsx` | Landing page footer |
| `TypewriterText.tsx` | Animated typing effect |
| `InteractiveBackground.tsx` | Animated background |

### Admin Components (`web/components/admin/`)
| Component | Purpose |
|-----------|---------|
| `UploadInstallerDialog.tsx` | Upload new installer version |

### UI Primitives (`web/components/ui/`) — shadcn/ui
`alert`, `avatar`, `badge`, `button`, `card`, `checkbox`, `collapsible`, `dialog`, `dropdown-menu`, `input`, `label`, `select`, `separator`, `sonner` (toasts), `switch`, `table`, `textarea`, `tooltip`

---

## Custom Hooks (`web/hooks/`)

| Hook | Purpose | Key Exports |
|------|---------|-------------|
| `useFirestore.ts` | Real-time Firestore listeners | `useSites()`, `useMachines(siteId)`, `setLaunchMode()` — interfaces: `Site`, `Machine` (includes `lastScreenshot`), `Process` (includes `launch_mode`, `schedules`) |
| `useDeployments.ts` | Deployment CRUD + templates | `useDeployments(siteId)` — `Deployment`, `DeploymentTemplate` |
| `useMachineOperations.ts` | Machine actions (remove, commands) | `useMachineOperations()` |
| `useInstallerVersion.ts` | Fetch latest Owlette version | `useInstallerVersion()` |
| `useInstallerManagement.ts` | Installer upload/management | `useInstallerManagement()` |
| `useSparklineData.ts` | Historical metrics for sparklines | `useSparklineData(machineId)` |
| `useHistoricalMetrics.ts` | Detailed historical metrics | `useHistoricalMetrics(machineId)` |
| `useSystemPresets.ts` | System preset CRUD | `useSystemPresets()` |
| `useUninstall.ts` | Remote uninstall operations | `useUninstall()` |
| `useOwletteUpdates.ts` | Remote agent update operations | `useOwletteUpdates()` |
| `usePasskeys.ts` | Passkey registration, management | `usePasskeys(userId)` — `registerPasskey()`, `deletePasskey()`, `renamePasskey()`, `supported` |
| `useUserManagement.ts` | Admin user CRUD | `useUserManagement()` |

---

## Lib Utilities (`web/lib/`)

| File | Purpose |
|------|---------|
| `firebase.ts` | Client-side Firebase init (singleton), `getLatestOwletteVersion()`, `sendOwletteUpdateCommand()` |
| `firebase-admin.ts` | Server-side Admin SDK init (token verification, custom tokens) |
| `sessionManager.server.ts` | HTTPOnly session via iron-session (create/extend/destroy) |
| `errorHandler.ts` | Firebase error code → user-friendly message mapping |
| `validators.ts` | Form validation: email, password, siteId |
| `logger.ts` | Structured logging with Firestore operation tracking |
| `mfaSession.ts` | MFA verification state management |
| `totp.ts` | TOTP generation for 2FA |
| `temperatureUtils.ts` | Celsius ↔ Fahrenheit conversion |
| `storageUtils.ts` | GB/TB formatting |
| `timeUtils.ts` | Timezone + time format (12h/24h) handling |
| `usageColorUtils.ts` | CPU/memory percentage → color coding |
| `dashboardConstants.ts` | Color scales, thresholds, metric constants |
| `rateLimit.ts` | Upstash Redis rate limiting (exports: `authRateLimit`, `agentAlertRateLimit`, `processAlertRateLimit`, `checkRateLimit`) |
| `withRateLimit.ts` | Rate limit wrapper for API routes |
| `versionUtils.ts` | Version string comparison |
| `encryption.server.ts` | Server-side encryption utilities |
| `webauthn.server.ts` | WebAuthn (passkey) config, challenge management, credential CRUD |
| `adminUtils.server.ts` | Server-side admin utils: `getSiteAdminEmails()`, `getSiteProcessAlertEmails()`, `getSiteAlertRecipients()` |
| `resendClient.server.ts` | Shared Resend email client singleton (`getResend()`, `FROM_EMAIL`, `ENV_LABEL`) |
| `webhookSender.server.ts` | Webhook dispatch utility: `fireWebhooks(siteId, siteName, event, data)`, `testWebhook(url, secret)` — HMAC-SHA256 signed, auto-disable after 10 failures |
| `apiAuth.server.ts` | API authentication: `requireAdminOrIdToken()`, `resolveApiKey()`, `assertUserHasSiteAccess()` |
| `userUtils.ts` | User data utilities |
| `validateEnv.ts` | Environment variable validation |
| `utils.ts` | General utilities (cn() for class merging) |

---

## Context (`web/contexts/`)

### `AuthContext.tsx`
**Provider**: Wraps entire app in `app/layout.tsx`

**Exports**:
```typescript
{ user, loading, role, isAdmin, userSites, requiresMfaSetup, mfaFactors,
  userPreferences, signIn, signUp, signInWithGoogle, signOut,
  updateUserProfile, updatePassword, updateUserPreferences, deleteAccount }

type UserRole = 'user' | 'admin'
interface UserPreferences { temperatureUnit: 'C' | 'F'; healthAlerts: boolean; processAlerts: boolean }
```

---

## Agent Modules (`agent/src/`)

### Core Service
| Module | Purpose |
|--------|---------|
| `owlette_service.py` | Main Windows service — process monitoring, command handling, metrics |
| `owlette_runner.py` | The process owlette-host supervises — bridges the host → service main loop |
| `shared_utils.py` | Config management, system metrics, logging, file paths, version |

### Firebase / Cloud
| Module | Purpose |
|--------|---------|
| `firebase_client.py` | Firestore sync — presence, metrics, commands, config, offline cache, process alerts |
| `connection_manager.py` | State machine + circuit breaker + thread watchdog |
| `auth_manager.py` | OAuth two-token system (access + refresh tokens) |
| `secure_storage.py` | Encrypted token file (Fernet AES, machine-specific key) |
| `firestore_rest_client.py` | Firestore REST API wrapper (get/set/update/listen) |

### Installation / Updates
| Module | Purpose |
|--------|---------|
| `configure_site.py` | Browser-based OAuth registration flow (localhost:8765) |
| `owlette_updater.py` | Self-update bootstrap (download + silent install) |
| `installer_utils.py` | Download/execute/cancel remote installers |
| `registry_utils.py` | Windows registry queries (installed software detection) |

### GUI / UX
The local UI is the Tauri desktop app in `desktop/`, not python. It ships as
`{app}\app\owlette-desktop.exe` and the service launches it (`--tray`,
`--restart-prompt`). See `desktop/README.md`.

| Module | Purpose |
|--------|---------|
| `session_exec.py` | User-session executor — runs Python/cmd/PowerShell in the desktop session (launched via CreateProcessAsUser) |
| `owlette_scout.py` | Process responsiveness checker (WM_NULL) |
| `configure_site.py` | Also the desktop app's CLI back end — pairing, join/leave, report-issue, reboot-now/dismiss (`--json-progress`) |
