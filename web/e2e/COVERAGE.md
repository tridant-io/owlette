# Exhaustive E2E Coverage Matrix

This matrix is the source of truth for Playwright coverage. A row is complete
when it has an owner spec and either covered coverage targets or an explicit
deferred reason. "API contract owner" means request-level coverage either in
`api-sprint`, Jest, or the new `api-contracts` specs.

A `mobile` entry in the Viewports column means a spec under `e2e/specs/mobile/`
covers that surface. Those specs belong to the `mobile-chromium` project in
`playwright.config.ts` (390x844, `isMobile` + `hasTouch`) and never run at
desktop width. Every one of them ends its assertions with
`assertNoHorizontalOverflow` (`e2e/helpers/mobile.ts`). Note what that helper
does NOT catch: it measures `documentElement`/`body` scroll width, so a
position-fixed surface (dialog, portalled sheet) can overflow the viewport
without failing it — reachability of the controls inside such a surface has to
be asserted directly, via `expectFullyWithinViewport` from the same module.

## Routes

| Surface | Roles | Viewports | Owner | Coverage targets | Status |
|---|---|---:|---|---|---|
| `/` landing | public | desktop | `public/static.spec.ts`, `a11y/route-smoke.spec.ts`, `visual/route-smoke.spec.ts` | page smoke, CTA links, serious/critical a11y, nonblank visual smoke | Covered |
| `/demo` | public | desktop, mobile | `public/static.spec.ts`, `a11y/route-smoke.spec.ts`, `visual/route-smoke.spec.ts`, `mobile/responsive-acceptance.spec.ts` | mounted demo, list/card controls, visual smoke, no 390px overflow | Covered |
| `/privacy` | public | desktop | `public/static.spec.ts`, `a11y/route-smoke.spec.ts` | route smoke and legal copy landmark | Covered |
| `/terms` | public | desktop | `public/static.spec.ts`, `a11y/route-smoke.spec.ts` | route smoke and legal copy landmark | Covered |
| `/legal/dmca` | public | desktop | `public/static.spec.ts`, `api-contracts/public-utility.spec.ts`, `a11y/route-smoke.spec.ts` | required fields, success submit, RFC7807 validation shape | Covered |
| `/unsubscribe` | public | desktop | `public/static.spec.ts`, `api-contracts/public-utility.spec.ts` | success/error states and API validation | Covered |
| `/docs/api` | public | desktop | `public/static.spec.ts`, `api-contracts/public-utility.spec.ts` | docs route load and OpenAPI content type | Covered |
| `/download` | public | request | `public/static.spec.ts` | latest-installer redirect and no-installer fallback | Covered |
| `/login`, `/register` | public | desktop, mobile | existing `auth/*.spec.ts`, `mobile/auth.spec.ts`, `mobile/responsive-acceptance.spec.ts` | signup/login/logout, MFA redirect behavior; mobile: progressive email sign-in through to `/dashboard`, register mismatch validation, no 390px overflow | Covered |
| `/setup` | public/auth | desktop | `onboarding/add-cli.spec.ts` | legacy redirect to `/add` with query preservation | Covered |
| `/add` | member/admin | desktop, mobile | `onboarding/add-cli.spec.ts`, `mobile/add-machine.spec.ts`, `mobile/responsive-acceptance.spec.ts` | query prefill, site selection, authorize success/error via stubbed agent API; mobile: portalled site picker, authorize request body, success card | Covered |
| `/cli/authorize` | member/admin | desktop | `onboarding/add-cli.spec.ts`, `api-contracts/public-utility.spec.ts` | code guard, key options, authorized poll handoff | Covered |
| `/swoop/[siteId]/[machineId]` | admin (control), member | desktop | `swoop/session.spec.ts` | step-up dialog + totp opens a control session, record follows it to its end (DELETE), queued `swoop_session_requested` command, member refused (page always asks for control), site switch + exclusion list refusals; api: two viewers, lease bound to viewer + fingerprint, offline 409, watcher cannot kill, one kill ends every session | Covered (media path: real machines only) |
| `/setup-2fa` | member/admin | desktop, mobile | `mfa/setup-verify.spec.ts`, `mobile/responsive-acceptance.spec.ts` | QR/manual secret, TOTP verification, backup codes; mobile: qr + secret card fits 390px | Covered |
| `/forgot-password`, `/reset-password` | public | desktop, mobile | `auth/password-reset.spec.ts`, `mobile/responsive-acceptance.spec.ts` | branded reset route, oobCode consumption, new password authenticates; mobile: idle + confirmation states and the `ready` form with a long account email fit 390px | Covered |
| `/verify-2fa` | enrolled users | desktop, mobile | `mfa/setup-verify.spec.ts`, `mobile/responsive-acceptance.spec.ts` | TOTP, backup-code toggle, trust-device option, device-trust cookie minted (httpOnly, ~30d), reload keeps the session verified, trusted re-login skips the challenge, trust is user-scoped; mobile: both code modes fit 390px | Covered |
| `/dashboard` | member/admin | desktop, mobile | existing `smoke`, `access-control`, `dispatch`, `time-travel`; `dashboard/process-config-roundtrip.spec.ts`, `dashboard/process-duplicate-names.spec.ts`; `mobile/targeted-shells.spec.ts`, `mobile/machine-detail.spec.ts`, `mobile/responsive-acceptance.spec.ts`; TODO `dashboard/full-controls.spec.ts` | machine card/status/display controls covered; process add/edit/delete plus every editable process parameter and the card launch-mode toggle, each read back from the config doc the agent consumes, and the duplicate-name gate; mobile: expanded card (stats/displays/processes), collapse-all + per-section re-expand, touch-sized context menu, metrics detail panel, display layout panel, card + list overflow; metrics tabs, screenshots, live view, token revocation tracked as dashboard follow-up | Deferred: broad dashboard control sweep needs dedicated full-controls slice to avoid destabilizing existing dispatch specs |
| `/deployments` | member/admin | desktop, mobile | existing `dispatch/*.spec.ts`, `mobile/deployments.spec.ts`, `mobile/responsive-acceptance.spec.ts` | create/retry/cancel/uninstall/rollback dispatch; mobile: row expand to installer url + flags + per-target rows, per-target retry affordance, `pointer-coarse` ≥40px actions trigger, menu items | Covered |
| `/logs` | member/admin | desktop, mobile | `logs/logs.spec.ts`, `mobile/targeted-shells.spec.ts`, `mobile/responsive-acceptance.spec.ts`, `a11y/route-smoke.spec.ts` | action/machine/level/date filters, reset, expand/collapse/all, screenshot modal, clear filtered/all, no-results, pagination seed; mobile filter shell + overflow | Covered |
| `/hoot` | member/admin | desktop, mobile | `hoot/hoot.spec.ts`, `mobile/targeted-shells.spec.ts`, `mobile/responsive-acceptance.spec.ts`, `a11y/route-smoke.spec.ts` | no-key overlay, checkbox target picker, offline warnings, power toggle render, send/stop/error stubs, conversation CRUD/search/category; multi-machine targeting: ticking re-aims the OPEN chat (same id, transcript intact) while a site change starts a new one, the POST body's `target.machineIds` + `target.mentions` + the narrowing legacy `machineId`, and an approval card labelled from its own turn's metadata rather than the header; mobile composer + target selector + overflow | Covered |
| `/admin/presets` | superadmin | desktop, mobile | `access-control/route-guards.spec.ts`, `admin-presets/presets.spec.ts`, `mobile/targeted-shells.spec.ts` | guard, list/category, create/edit/delete, mobile cards + overflow | Covered |
| `/admin/users` | superadmin | desktop | existing `smoke`, `access-control/user-mgmt.spec.ts` | route guard, users list/actions smoke | Covered |
| `/admin/installers`, `/admin/email` | superadmin | desktop | existing `admin/*.spec.ts`, `access-control/route-guards.spec.ts` | CRUD/workflow route coverage | Covered |
| `/admin/members` | admin/superadmin | desktop | `access-control/route-guards.spec.ts`, `access-control/pageheader.spec.ts` | route guard (admin reaches it, member bounced), user-menu entry point | Covered |
| `/admin/webhooks`, `/admin/alerts`, `/admin/tokens`, `/admin/schedules` | admin/superadmin | desktop | existing `admin/*.spec.ts`, `access-control/route-guards.spec.ts` | CRUD/workflow route coverage (specs run as superadmin); the route guard also asserts admins reach them | Covered |
| `/roosts` | member/admin | desktop, mobile | existing `roosts/*.spec.ts`, `mobile/roosts.spec.ts`, `mobile/responsive-acceptance.spec.ts`; TODO `roosts/deep-actions.spec.ts` | create/version/rollback/history covered; mobile: `RoostMobileSheet` detail (version badge, description, version history, targets collapse) + row actions menu + overflow; delete/resync/files/diff/preset/no-target upload tracked | Deferred: remaining roost actions need fixture expansion for version file manifests |
| `/settings/api-keys`, `/settings/webhooks`, `/settings/alerts` | member/admin | desktop, mobile | existing `settings/*.spec.ts`, `account/*.spec.ts`, `mobile/settings-keys-webhooks.spec.ts`, `mobile/responsive-acceptance.spec.ts` | API keys, webhooks, account profile/password/passkeys/preferences; mobile: both create dialogs, one-time reveal + dismiss, list row after reveal, alerts route overflow | Covered |

## API Routes

| API group | Methods | Owner | Required assertions | Status |
|---|---|---|---|---|
| public utility: `/api/version`, `/api/openapi`, `/api/whoami`, `/api/legal/dmca`, `/api/unsubscribe` | GET/POST | `api-contracts/public-utility.spec.ts` | happy path, validation, unauth problem shape where applicable | Covered |
| CLI device-code | POST | `api-contracts/public-utility.spec.ts`, `onboarding/add-cli.spec.ts` | create, missing-field, pending poll, authorized poll | Covered |
| agent auth/device-code/exchange/refresh | POST | existing API tests plus TODO `api-contracts/agent-auth.spec.ts` | validation, expired, unauthorized, refresh | Deferred: happy path depends on Identity Toolkit exchange and stays stubbed in regular CI |
| sites/members/machines/processes/commands/deployments | mixed | existing `api-sprint/*.spec.ts`, `dispatch/*.spec.ts` | auth, validation, representative domain errors | Covered |
| roosts/chunks | mixed | existing `roosts/*.spec.ts`, `api-sprint/*`, TODO `api-contracts/roost-actions.spec.ts` | chunk refs, version addressing, rollback/deploy actions | Deferred: R2 remains Firestore-stubbed in CI |
| v1 project distributions (`/api/sites/{siteId}/project-distributions`) | — | none — was `dispatch/create-deployment-legacy.spec.ts` | — | Removed: the legacy by-URL distribution path was deleted (routes, `project_distributions` rules block, agent `distribute_project` handler). Its owner spec was deleted with it; roost v2 is the only distribution system. |
| admin/platform system presets/installers/email/security | mixed | existing `admin/*.spec.ts`, `admin-presets/presets.spec.ts` | superadmin guard, CRUD, validation | Covered |
| account/passkeys/MFA/settings | mixed | existing `account/*.spec.ts`, `mfa/setup-verify.spec.ts` | user auth, validation, mutation persistence | Covered |
| Hoot APIs | POST | `hoot/hoot.spec.ts`, TODO `api-contracts/hoot.spec.ts` | no-key, message validation, categorize, autonomous/escalation stubs | Deferred: real LLM/tool execution is stubbed; request-contract slice remains needed |

## Shared Components And Dialogs

| Component/dialog | Owner | Status |
|---|---|---|
| PageHeader site picker, account menu, download action (desktop breadcrumb) | existing `access-control/pageheader.spec.ts` | Covered |
| PageHeader mobile nav drawer (site list, page nav, manage-sites entry) | `mobile/sites-dialogs.spec.ts` | Covered |
| Manage-sites dialog + create-site dialog | existing `sites/*.spec.ts`, `mobile/sites-dialogs.spec.ts` | Covered |
| Manage-sites inline edit / delete at mobile widths | `mobile/sites-dialogs.spec.ts` | Covered: taps a row's edit button, asserts the inline editor opens pre-filled, cancels, and asserts the row's delete button plus the header close ✕ sit fully inside the 390x844 viewport by `boundingBox` (`expectFullyWithinViewport`, `e2e/helpers/mobile.ts`). History — this was deferred as an app bug: the dialog header was a no-wrap flex with a `w-64 shrink-0` filter input whose min-content exceeded `max-w-[calc(100%-2rem)]`, inflating the DialogContent grid's single auto column so every row's fixed `64px` actions column landed outside the viewport with no horizontal scroller. Fixed by wrapping the header (`flex-wrap` + `min-w-0 w-full max-w-64` filter), which is desktop-identical at 256px. |
| Account settings tabs: profile, preferences, alerts, hoot/API key, delete account/photo controls | existing `account/*.spec.ts`; TODO `account/full-dialog.spec.ts` | Deferred: destructive delete/photo controls need isolated fixture users/storage stubs |
| Dashboard machine card/process controls/layout/metrics | existing `access-control`, `dispatch`, `time-travel`, `mobile/machine-detail.spec.ts`, `dashboard/process-config-roundtrip.spec.ts`, `dashboard/process-duplicate-names.spec.ts`; TODO `dashboard/full-controls.spec.ts` | Deferred: process dialog, add/delete and the launch-mode toggle are covered end-to-end against the config doc; metrics tabs, screenshots and live view remain the dashboard gap (mobile card expand/collapse + both detail panels are covered) |
| Logs filters/rows/dialogs | `logs/logs.spec.ts` | Covered |
| Hoot sidebar/chat/input/target selector/power toggle | `hoot/hoot.spec.ts` | Covered |
| Hoot multi-machine picker (`MachineTargetPicker`), `@` mention composer (`MentionPopover`), per-turn approval labels | `hoot/hoot.spec.ts`, `a11y/route-smoke.spec.ts` | Covered: tri-state master row and per-machine rows driven as `menuitemcheckbox`, the seeded `targetType:'machines'` chat in `coverageSeed.ts` (two ids, plus an assistant turn whose `metadata.hoot` names only one), and an axe pass with each surface open. The picker's pass is SCOPED to the open menu: a modal Radix menu aria-hides the rest of the document, and /hoot's focusable resize separator then reads as `aria-hidden-focus` for any menu in the app — the unscoped closed-state pass is the row above |
| System preset dialog | `admin-presets/presets.spec.ts` | Covered |
| Deployments uninstall/delete/all dialog options | existing `dispatch/*.spec.ts`; TODO `dispatch/deployment-dialog-options.spec.ts` | Deferred: needs deployment fixture expansion (the mobile row actions menu itself is covered by `mobile/deployments.spec.ts`) |
| Roost upload/version/delete/resync/files/diff dialogs | existing `roosts/*.spec.ts`; TODO `roosts/deep-actions.spec.ts` | Deferred: needs manifest/file-diff fixtures |
| Roost mobile detail sheet (`RoostMobileSheet` — the sub-`lg` replacement for the desktop `<aside>`) | `mobile/roosts.spec.ts` | Covered |

## Cross-Cutting

| Dimension | Owner | Status |
|---|---|---|
| Role gates | existing `access-control/route-guards.spec.ts` plus new `/admin/presets` row | Covered |
| Web↔agent process-config contract (`config/{siteId}/machines/{machineId}.processes[]` — wire field names, wire types, duplicate-name gate) | `dashboard/process-config-roundtrip.spec.ts`, `dashboard/process-duplicate-names.spec.ts` | Covered for the web half. Deferred: the desktop-app half (edits made in the local Tauri UI reaching Firestore — the 3.0.0 regression) needs the full-machine harness at `dev/completed/full-machine-e2e/` |
| Talons — nav entry, list rendering, run-history expansion, create round-trip (normalized doc read-back), enable/disable toggle, empty state without layout shift | `talons/talons.spec.ts` | Covered |
| Serious/critical a11y smoke | `a11y/route-smoke.spec.ts` | Covered: every listed route at rest, plus /hoot with the target picker open and with the `@` mention listbox open |
| Visual nonblank smoke | `visual/route-smoke.spec.ts` | Covered |
| Mobile shells where UI differs | `mobile/targeted-shells.spec.ts` (dashboard/logs/hoot/presets), `mobile/sites-dialogs.spec.ts` (PageHeader nav drawer), `mobile/roosts.spec.ts` (detail sheet) | Covered |
| Responsive layout — no horizontal document overflow at 390x844 | `mobile/responsive-acceptance.spec.ts` (route gate, one test per route) plus an `assertNoHorizontalOverflow` call after each interaction in every other `mobile/*.spec.ts`. `targeted-shells.spec.ts` carries the only overflow assertions for `/admin/presets` and for `/logs` with its filter panel open | Covered |
| Touch hit-areas (`pointer-coarse:` ≥ 40px, live only under `hasTouch`) | `mobile/machine-detail.spec.ts` (machine context menu trigger), `mobile/deployments.spec.ts` (row actions trigger) | Covered |
| External services | N/A | Deferred: real R2, email delivery, LLM calls, Python agent execution, and passkey authenticators stay opt-in outside regular CI |
