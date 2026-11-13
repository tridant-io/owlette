# status page and uptime checks

**Last updated**: 2026-04-29 | **moved** 2026-09-05 from `docs/api/status-uptime.md` | **reviewed** 2026-09-05

**INTERNAL — keep inside `docs/internal/`**, which is never published (only
`web/content/docs` is). This page was
written for the MkDocs site that was deleted 2026-05-20 and never reached a published docs
route. Most of it is operator wiring — cron secrets, vendor component ids, readiness drills —
that must stay internal. The customer-facing slice (what the status page promises and when an
incident is published) is a **publish candidate**, but extracting it is a separate decision.

> **2026-09-05 accuracy review.** Corrected against HEAD: the component set (seven → nine),
> the API component's health signal (it now probes four endpoints, not two), and hoot's product
> name. Verified still true: `scripts/check-status-page-ready.mjs` and its `--env-only` /
> `--base-url` flags, `/api/cron/status-ping`, the `web/content/docs/setup/*` operator-wiring
> pages, the Firestore `system_status/heartbeat` probe and its 500 ms limit, and the deferred
> custom domain — `https://status.owlette.app` still does not resolve. Not verifiable from the
> repo: whether the Instatus hosted page has been created, and whether the 60-second uptime
> check is registered on cron-job.org.

External public launch requires a customer-visible status page. The first launch target is an Instatus Starter hosted page, which is free and has enough monitor capacity for the initial component set. The custom domain `https://status.owlette.app` is deferred until a paid custom-domain plan or alternate provider path is approved.

The status page is launch packaging. Developer preview can proceed without it, but external public launch should not.

---

## customer surface

| surface | purpose |
|---|---|
| Instatus hosted page URL | public status page for current health, active incidents, and incident history |
| `https://status.owlette.app` | later custom-domain alias for the public status page |
| `GET /api/version` | unauthenticated API liveness check |
| `GET /api/whoami` | auth-path liveness check; unauthenticated `401` is healthy |
| `GET /api/openapi` | public contract availability check for docs/reference monitoring |
| `GET /docs/api` | rendered API reference availability check |

Do not expose cron routes or vendor credentials to API consumers. Status-ping infrastructure is internal operator tooling and stays out of OpenAPI.

---

## status components

The status page tracks nine components. `STATUS_COMPONENTS` in `web/lib/healthChecks.server.ts` is the source of truth for the set; `INSTATUS_COMPONENT_ENV` in `web/lib/instatusClient.ts` maps each one to its vendor component-id env var.

| component | health signal | status-page id |
|---|---|---|
| dashboard | `GET /` returns 2xx/3xx within 3 seconds | required |
| API | `GET /api/version` 2xx, `GET /api/whoami` 401-or-2xx, `GET /api/openapi` 2xx, and `GET /docs/api` 2xx, each within 2 seconds | required |
| agent registry | latest machine heartbeat is less than 5 minutes old | required |
| webhook delivery | last-hour delivery success rate is at least 95 percent when delivery samples exist (up to 500 sampled) | required |
| alert delivery | no `pending_process_alerts` or `pending_display_alerts` entry has sat undelivered for more than 15 minutes — a stalled digest cron | optional |
| talon dispatch | no enabled talon has been due and unclaimed for more than 15 minutes — a dead `/api/cron/talons` sweep | optional |
| R2 uploads | placeholder healthy until route-level R2 5xx telemetry is instrumented | required |
| Firestore | server-side read of `system_status/heartbeat` completes within 500 ms | required |
| hoot chat | placeholder healthy until hoot SSE success-rate telemetry is instrumented (component key stays `cortex_chat` on the wire) | required |

"optional" means only that a missing Instatus component id must not flip the whole page to unconfigured or fail the readiness gate (`OPTIONAL_STATUS_PAGE_COMPONENTS` in `web/lib/instatusClient.ts`). Both checks still run, and `alert_delivery` alerts through Sentry regardless.

The placeholder components are explicit so the page can launch with the intended component taxonomy without inventing false precision. Replace each placeholder with real telemetry before publishing SLOs.

> **status 2026-09-05:** `scripts/env-manifest.json` targets only `INSTATUS_PAGE_ID` and
> `INSTATUS_COMPONENT_DASHBOARD_ID` at railway-prod and vercel-prod. Every other component id
> is unset on every target, so `status-ping` skips those components and
> `validateInstatusConfig` reports the page unconfigured. Promote each id as its Instatus
> component is created.

---

## operator setup

Synthetic checks run from internal cron infrastructure and publish component state to the hosted status-page vendor after repeated failures or recovery. That operator wiring is documented in `web/content/docs/setup/web-deployment.mdx` (published at `/docs/setup/web-deployment`) and `web/content/docs/setup/environment-variables.mdx`.

Do not put cron URLs, vendor API keys, component ids, or Firestore collection names in customer handoff material.

Before marking 5.1 live, run the operator readiness check from a shell that has the prod or dev status-page variables loaded:

```powershell
node scripts/check-status-page-ready.mjs --env-only
node scripts/check-status-page-ready.mjs --base-url https://owlette.app
```

The command reports only variable names and component health. It does not print secret values.

Run the degraded/recovery drill on dev before using it on the public page: temporarily point `OWLETTE_STATUS_BASE_URL` at an intentionally invalid target, call `/api/cron/status-ping` twice with `X-Cron-Secret`, restore the real base URL, call the route again, then verify the API component degraded and recovered in Instatus. Record the hosted page URL and screenshots or incident links in the launch ticket.

---

## incident policy

Operators publish incidents manually. A synthetic check can degrade a component, but it should not create an incident by itself.

Publish an incident when a customer would reasonably notice the issue:

- API 5xxs, auth failures, or severe latency affect more than one customer
- docs/reference outage blocks integration work
- webhook delivery drops below the launch threshold
- agent registry or Firestore degradation makes machine status unreliable
- hoot chat is unavailable for public API users

Use this update template:

```text
We are currently investigating <issue>.
Impact: <who/what is affected>.
Next update: <time, usually 15 minutes from now>.
```

Mark the incident resolved when the underlying issue is fixed. Monitoring can remain elevated while the incident is in `monitoring`.

During the public API launch window, pair incidents with the [public API launch runbook](public-api-launch-runbook.md) so support ownership, rollback ownership, and first-week monitoring are recorded in the launch ticket.

---

## launch gate

5.1 is externally complete when:

- an Instatus Starter hosted page URL is live and customer-visible
- the nine components exist on the status page (the two optional ones can be waived — see the component table)
- the 60-second uptime checks are running
- the API component flips degraded after two consecutive `/api/version` or `/api/whoami` failures
- the API component flips operational after recovery
- an operator can publish and resolve a test incident from the vendor UI

The custom domain `status.owlette.app` remains a later launch-polish task because Instatus Starter does not include custom domains. Until the hosted page and vendor setup are complete, treat status-page work as launch-blocked but not developer-preview-blocked.
