# developer-preview release checklist

**Last updated**: 2026-04-28 | **moved** 2026-09-05 from `docs/api/developer-preview-checklist.md` | **reviewed** 2026-09-05

**INTERNAL — keep inside `docs/internal/`**, which is never published (only
`web/content/docs` is). This page was
written for the MkDocs site that was deleted 2026-05-20 and never reached a published docs
route; it is a release gate for operators, not customer reference material.

> **2026-09-05 accuracy review.** This is the stalest of the five orphaned pages. Corrected
> against HEAD: the MkDocs build step is gone, every `docs/api/*.md` consumer link now lives in
> fumadocs at `web/content/docs/api/*.mdx` (published under `/docs/api/`), the sprint reference
> notes moved from `dev/active/public-api/` to `dev/completed/public-api/`, the smoke-spec
> invocation now goes through `npm run e2e`, and Cortex is called hoot in product copy.
> Verified still true: `npm run validate:api`, `web/openapi.yaml` +
> `web/scripts/validate-openapi.ts` as the source of truth, `web/__tests__/api/openapi.test.ts`,
> `web/e2e/specs/api-contracts/public-api-smoke.spec.ts`, and every deferred route call except
> the two flagged inline. Not verifiable from the repo: whether any internal consumer has ever
> been onboarded against this checklist.

This checklist defines the API surface that is safe to point internal consumers at on `dev.owlette.app` (there is no separate staging deployment). It is not the external public launch checklist.

Use this page when cutting a dev push, onboarding an internal integration, or deciding whether a route belongs in the developer-preview docs.

---

## preview status

Developer preview is ready when an internal consumer can:

- create or receive a scoped API key
- verify identity with `/api/whoami`
- discover accessible sites and machines
- queue and poll a safe machine command
- use documented shared behavior for auth, errors, pagination, idempotency, and rate limits
- inspect the rendered reference at `/docs/api`

Preview does not mean the public launch packaging is complete. [Status page](status-page-uptime.md), [public SLOs](public-api-load-testing.md), published SDK/CLI channels (`/docs/api/distribution`), [marketplace/example assets](public-api-launch-assets.md), pricing/signup pages, and the [first-week launch runbook](public-api-launch-runbook.md) remain Wave 5 launch work.

---

## release gate

Before pointing internal consumers at the preview:

- [ ] Deploy from `dev`.
- [ ] Confirm the docs route loads: `GET /docs/api`.
- [ ] Confirm raw OpenAPI loads: `GET /api/openapi`.
- [ ] Confirm the quickstart can run with a scoped key against a real dev site and one online machine.
- [ ] Run `npm.cmd run validate:api` from `web`.
- [ ] Run `npm.cmd test -- --runTestsByPath __tests__/api/openapi.test.ts --runInBand` from `web`.
- [ ] Run `npm.cmd run build` from `web` — docs build with the app now (`fumadocs-mdx && next build`), so a broken docs link or bad MDX fails the same build as the app.
- [ ] Run the public API smoke spec. It lives at `web/e2e/specs/api-contracts/public-api-smoke.spec.ts` and runs inside the standard emulator suite:

```bash
cd web && npm run e2e
```

> Run the whole suite (`/preflight` does), not a hand-rolled `firebase emulators:exec` line —
> PowerShell splats a comma-joined `--only auth,firestore,storage` into three argv entries and
> the emulator starts nothing.

- [ ] Run `git diff --check` before commit.
- [ ] Record any known validation blockers in the sprint log before sharing the preview link.

> **corrected 2026-09-05:** this gate used to require `python -m mkdocs build` and carried a
> caveat about MkDocs strict-mode warnings. MkDocs was deleted 2026-05-20; the docs are
> fumadocs MDX under `web/content/docs/` and build with the Next.js app.

---

## safe to expose on dev

These surfaces are safe for internal developer-preview consumers when accessed with least-privilege keys and test data.

| surface | safe preview scope |
|---|---|
| docs and contract | `/docs/api`, `/api/openapi`, `/api/version`, the quickstart at `/docs/api/quickstart`, and the shared-behavior pages under `/docs/api/` |
| auth and identity | dashboard-created API keys, `POST /api/keys` with user session or Firebase ID token, `/api/whoami`, scoped `owk_live_*` keys (every key is minted `live`; an old `owk_test_*` key is no sandbox) |
| sites | site list/detail/create/update/delete and member add/list/remove where caller role/scope allows it |
| users | platform user management for superadmin-only internal testing |
| machines | list/detail/deployments, generic command queue, command polling, screenshots, reboot schedule, uninstall, agent-token metadata/revoke |
| processes | process list/detail/create/update/delete plus start/stop/kill/schedule/launch-mode |
| classic deployments | `/api/sites/{siteId}/deployments/**` create/list/detail/retry/cancel/uninstall/delete |
| roost and chunks | roost CRUD, version publish/list/detail/files/diff, chunk check/upload/download/mount/referrers, deploy/rollback/resync |
| hoot | canonical `/api/hoot/conversations/**`; `/api/cortex/conversations/**` is a deprecated alias served by the same handler for old CLI and SDK clients, and `/api/chat/**` remains a compatibility alias — neither is the path to promote |
| webhooks and events | webhook CRUD, delivery history/detail, manual retry, secret rotate, and `POST /api/webhooks/probe`; `/api/events/stream` liveness only |
| quota, audit, logs | quota current/history, audit-log reads, site operational log read/detail/clear with documented admin controls |
| installer management | `/api/installer/**` for superadmin/platform internal testing; unauthenticated installer download remains `/download` |
| platform utilities | documented `/api/platform/**` routes for superadmin-only internal diagnostics and operations; do not include these in general consumer handoff |

Use keys minted on dev for preview work; a key's environment is the server that minted it, not its prefix. Keep one key per integration so audit and rate-limit signals stay attributable.

---

## keep internal or deferred

Do not advertise these as developer-preview public APIs:

- `/api/admin/**` — the flat compatibility namespace this bullet described was removed in `644c57f`; what remains (`issues`, the issue triage routes) is superadmin tooling and still stays out of the preview contract.
- `/api/agent/**` agent writeback/auth routes, except where the rendered reference explicitly documents an agent-compatible operation.
- `/api/cron/**` scheduler routes.
- Routes on the OpenAPI validator's internal allowlist, including session auth, MFA/passkeys, settings/setup helpers, bug/test-email helpers, legal/unsubscribe helpers, and dashboard-only support utilities, unless the rendered reference explicitly documents the route.
- `/api/webhooks/test`; use `POST /api/webhooks/probe` for public receiver checks.
- `/api/hoot/autonomous`, `/api/hoot/escalation`, `/api/hoot/provision-key`, and `/api/hoot/categorize`, and their `/api/cortex/*` aliases.
- Site-nested hoot paths. The `/api/sites/{siteId}/cortex/conversations/**` shape this bullet named was never built; what exists today is `/api/sites/{siteId}/cortex-settings` and `/api/sites/{siteId}/hoot-settings`, both internal.
- Dedicated display enumeration/capture paths and site-level display-layout library routes; use machine-level display layout plus generic machine commands for preview.
- Public WebRTC/live-view session APIs.
- Machine pairing UX as a general public API; current CLI/agent device-code routes are implementation surfaces.
- Machine alert mute/unmute and machine rename/edit.
- Log live-tail and bulk export.
- Production event fanout through `/api/events/stream`; current stream validates auth/filters and emits liveness events only.
- New path aliases such as `/api/installers`, `/api/sites/{siteId}/installer-deploys`, or `/api/sites/{siteId}/cortex/...`.
- New `X-Owlette-Api-Version` request header; no Owlette-wide version header is required for preview.
- External package publication, Homebrew/Scoop/winget distribution, status page, public uptime checks, launch marketing, and support SLAs. Use the distribution gate at `/docs/api/distribution` (`web/content/docs/api/distribution.mdx`) before claiming SDK or CLI packages are live — as of 2026-09-05 none of them is published.

If an internal consumer asks for one of these, record it as a follow-up instead of expanding the preview contract ad hoc.

The source of truth for the exposed route set is `web/openapi.yaml` plus the internal allowlist in `web/scripts/validate-openapi.ts`. Historical sprint references under `dev/completed/public-api/reference` explain why a route is included, renamed, internal, or deferred; they are not consumer-facing docs.

---

## consumer handoff

Send internal consumers this minimal set:

- Base URL: `https://dev.owlette.app`
- Docs: `https://dev.owlette.app/docs/api`
- Quickstart: `https://dev.owlette.app/docs/api/quickstart`
- Auth: `https://dev.owlette.app/docs/api/authentication`
- Shared behavior: `/docs/api/pagination`, `/docs/api/idempotency`, `/docs/api/errors`, `/docs/api/rate-limits`
- Required setup: account, accessible site, online machine, scoped API key minted on dev
- Scope reminder: use exact permissions; `write` does not imply `read`
- Support payload: method, URL, status, problem `code`, `requestId`, `X-Request-Id`, and any `RateLimit-*` / `Retry-After` headers
- External launch support payload and severity targets live in the [public API launch runbook](public-api-launch-runbook.md).

Those consumer pages are fumadocs MDX under `web/content/docs/api/`; the `docs/api/*.md` files this list used to point at no longer exist.

Recommend the 10-minute quickstart as the first smoke test before SDK or CLI workflows.

---

## rollback and containment

If a preview consumer hits a release-blocking issue:

- For docs/reference drift, revert the docs/OpenAPI commit and redeploy docs.
- For an over-scoped key, revoke it or create a narrower replacement from the dashboard.
- For a route rejecting legitimate callers because of role or membership bugs, fix or roll back the route instead of weakening enforcement.
- For legitimate capability-matrix or privileged rate-limit enforcement bugs, use the security kill switch only as a short-lived superadmin mitigation and record the reason, expiry, and follow-up fix.
- For an unsafe mutation surface, remove the route from preview docs/OpenAPI or mark it internal/deferred, then rerun `validate:api`.
- For persistent server errors, capture `requestId` and affected route before rolling back the deployment.

Never work around preview issues by sharing broader production keys or undocumented internal routes.

---

## done criteria

4.4 is done when:

- this page is discoverable to operators — as of 2026-09-05 that means `docs/internal/`, not an API docs nav; the original "in the API docs nav" criterion assumed the deleted MkDocs site
- safe and deferred preview surfaces are explicit
- validation gates are listed with runnable commands
- consumer handoff links point at current Owlette API docs
- rollback and containment steps do not rely on ad hoc operator knowledge
