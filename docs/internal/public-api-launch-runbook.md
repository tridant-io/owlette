# public API launch runbook

**Last updated**: 2026-04-29 | **moved** 2026-09-05 from `docs/api/launch-runbook.md` | **reviewed** 2026-09-05

**INTERNAL — keep inside `docs/internal/`**, which is never published (only
`web/content/docs` is). This page was
written for the MkDocs site that was deleted 2026-05-20 and never reached a published docs
route; it is an operator process, not customer reference material.

> **2026-09-05 accuracy review.** Corrected against HEAD: the validation command list (MkDocs
> is gone), the status-page component count (seven → nine), and hoot's product name in the
> monitoring list. Verified still true: the four launch probe endpoints, the security-boundary
> and roost kill-switch runbook paths, and the k6 SLO gate. Verified changed and flagged inline
> below: no package in the Wave 5.3 gate is published, the billing system that "pricing/signup"
> assumed was removed end to end (`adbfd06f`), and the Wave 5 plan is archived at
> `dev/completed/public-api/`. Not verifiable from the repo: whether a launch ticket, support
> rota, or Instatus page has ever actually been staffed or configured.

This runbook controls the external public API launch window. It covers the launch-state decision, go/no-go checks, support intake, rollback paths, and first-week monitoring.

Developer preview can proceed without this runbook being executed. External launch should not.

This is an operator launch process, not a runtime route unlock. The public API routes are already authenticated and scoped; launch changes public discovery, package distribution, examples, status-page visibility, and support coverage. Do not add or claim an environment-variable launch flag unless a corresponding route enforcement path exists in code.

---

## launch states

Track one launch ticket with exactly one state.

| state | meaning | allowed public posture |
|---|---|---|
| `preview` | Internal consumers can use dev/staging with scoped test keys. | Docs may mention developer preview; no public announcement or registry-live claims. |
| `launch_ready` | All Wave 5 gates are signed off, but the launch has not been announced. | Public pages can be staged; support and monitoring are staffed. |
| `launched` | Public docs, packages, examples, status page, and support channels are active. | Public announcement and external onboarding can proceed. |
| `paused` | Launch communication or onboarding is stopped because a gate regressed or an incident is active. | Existing API auth remains intact; use rollback or incident playbooks as needed. |

Changing state requires the launch owner, support owner, and rollback owner to be recorded on the ticket. `paused` does not disable authentication, scopes, or routes by itself.

---

## launch ticket

Record these fields before moving to `launch_ready`:

| field | required value |
|---|---|
| launch state | `preview`, `launch_ready`, `launched`, or `paused` |
| web commit | deployed commit for `https://owlette.app` |
| docs commit | deployed commit for public docs |
| docs URL | public API overview and rendered reference URLs |
| status URL | Instatus hosted page URL |
| package versions | CLI, Node SDK, and Python SDK versions plus registry URLs |
| load-test report | k6 report location with p95, p99, error rate, runner, base URL, and waivers |
| example workflow | clean consumer workflow run URL or explicit waiver |
| support owner | named owner for first-week support triage |
| rollback owner | named owner who can redeploy, deprecate packages, or pause onboarding |
| incident channel | operator channel for launch-day updates |
| known waivers | package-manager, telemetry, status-domain, or example-repo waivers with approver |

Do not use Slack history or local notes as the only launch record.

---

## go/no-go gate

Move from `preview` to `launch_ready` only after these checks pass or have an explicit launch waiver:

- Wave 5.1 status page: Instatus hosted page exists, the nine components are configured, uptime checks run, and a test incident can be published and resolved.
- Wave 5.2 load testing: k6 launch fixture exists and the final report records p95, p99, error rate, runner, base URL, fixture ids, and waivers.
- Wave 5.3 distribution: `@owlette/cli@rc`, `@owlette/sdk@rc`, and `owlette-sdk` pre-release packages are published and install-smoked, or blocked package-manager channels have approved waivers.
  > **status 2026-09-05:** none of the three is on its registry — `npm view @owlette/cli` and
  > `@owlette/sdk` both return 404, and `sdks/python/pyproject.toml` is still at `1.0.0rc0`
  > locally. Publish workflows exist (`.github/workflows/{cli,node-sdk,py-sdk}-publish.yml`)
  > but have not produced a public release. This gate is open.
- Wave 5.4 launch assets: public site, pricing/signup, docs links, download path, examples, marketplace copy, and one clean consumer workflow run are verified.
- Support: first-week owner, backup owner, inbox, escalation channel, and response targets are staffed.
- Rollback: prior web commit, docs rollback path, package deprecation/dist-tag process, and support messaging template are ready.
- Validation: `npm.cmd run validate:api` and `git diff --check` have run on the launch branch, with new warnings resolved or waived. Docs now build with the app (`npm.cmd run build` runs `fumadocs-mdx && next build`); there is no separate docs build step since MkDocs was removed 2026-05-20.

Move from `launch_ready` to `launched` only after the support owner confirms the monitoring window is open and the status page has no active launch-blocking incident.

---

## launch procedure

### T-48 hours

- Confirm owners, backup owners, launch window, and decision deadline.
- Recheck the public site, signup path, pricing copy, docs path, download path, status page, package links, and example workflow.
  > **stale (2026-09-05):** "pricing copy" was written when a billing system was being built.
  > That system was removed end to end in `adbfd06f` — there is no `web/lib/billing`, no Stripe
  > integration, and the landing page's `PricingSection` quotes post-beta rates from
  > `web/lib/product-facts.ts` while the tiers read "free during beta". Recheck the copy for
  > honesty, not for a live checkout.
- Confirm registry access, package owner 2FA, and rollback permissions.
- Freeze non-launch changes unless they fix a launch gate.

### T-24 hours

- Run the final k6 launch suite or attach the approved report.
- Run clean install smokes for the CLI and both SDKs.
- Run the GitHub Actions roost deploy example against the launch fixture.
- Review support macros and the required support payload below.
- Put the launch ticket in `launch_ready` only if every gate is pass or waived.

### T-2 hours

- Confirm deployed commits match the launch ticket.
- Confirm `GET /api/version`, `GET /api/whoami`, `GET /api/openapi`, and `GET /docs/api` are healthy.
- Confirm the status page components are operational or intentionally marked degraded with an incident.
- Confirm support inbox, operator channel, and escalation path are staffed.

### Launch

- Move the launch ticket to `launched`.
- Publish public links in this order: docs, status page, packages, examples, public site/signup.
- Start the first-week monitoring cadence.
- Keep onboarding controlled until day 2 metrics are reviewed.

---

## support intake

Use these severity levels during the first week:

| severity | examples | target first response |
|---|---|---:|
| P0 | Auth outage, broad 5xxs, data exposure, package install impossible for all users. | 15 minutes |
| P1 | Single critical workflow blocked, webhook delivery broadly degraded, status page incorrect during an incident. | 1 hour |
| P2 | One endpoint regression with workaround, SDK example bug, docs mismatch causing failed setup. | 1 business day |
| P3 | Clarification request, feature request, cosmetic docs issue. | 2 business days |

Ask for this payload before triage unless the incident is already obvious:

- HTTP method and full path.
- Timestamp with timezone.
- HTTP status and problem `code`.
- `requestId` from the body and `X-Request-Id` from the response headers.
- `RateLimit-*`, `Retry-After`, and `Roost-Rate-Limited-Reason` headers when present.
- Package name and version for CLI, Node SDK, or Python SDK issues.
- Base URL, key prefix only (`owk_live` or `owk_test`), site id, machine id, roost id, version id, and workflow run URL when relevant.
- Expected result, actual result, and whether retry changed the outcome.

Never ask for full API keys, Firebase tokens, private package credentials, or customer secrets. If a secret is pasted into support, rotate it before continuing diagnosis.

---

## rollback and containment

Choose the narrowest containment path that protects customers without weakening auth or scope controls.

| issue | first action | rollback path |
|---|---|---|
| Public docs/reference regression | Pause announcement links to the bad page and open a docs incident if setup is blocked. | Revert docs/OpenAPI commit and redeploy docs. |
| CLI or SDK package regression | Pin examples to the last known good version and publish an advisory. | Move npm `rc` dist-tags, deprecate the broken version if needed, yank only if registry policy and impact justify it, and publish a fixed RC. |
| GitHub Action workflow regression | Remove or annotate the template link and direct users to the raw CLI workflow. | Patch the composite action and tag a new release once verified. |
| API 5xx, auth, or route regression | Pause onboarding, collect `requestId`s, and open a status incident when customer-visible. | Redeploy the previous web commit or revert the route commit. Revoke or rotate affected keys if exposure is possible. |
| Site-specific roost distribution incident | Pause new roost work for the affected site if continuing rollout increases risk. | Ask an operator to apply the site distribution kill switch for that site ([roost kill switch runbook](../runbooks/roost-kill-switch.md)), then re-enable after publish/signed-URL and agent sync smokes pass. |
| Capability or privileged rate-limit bug | Use the internal security-boundary kill switch process only for legitimate capability/rate-limit enforcement incidents ([kill switches](../runbooks/security-boundary-kill-switches.md)). | Flip `capability_enforcement` or `rate_limit_enforcement` for the shortest possible window, with reason, owner, expiry, and follow-up fix. |
| Load or latency regression | Pause launch announcements and reduce onboarding volume. | Tune limits, roll back the deployment, or mark impacted components degraded while the fix is validated. |
| Status-page vendor issue | Publish manual updates in the operator-approved channel. | Keep API behavior unchanged; do not hide incidents because the vendor is degraded. |

The security-boundary kill switches do not bypass API-key scope, authentication, audit writes, or Firestore rules. The roost kill switch is per-site distribution containment, not a global public API pause. Do not use either class of switch for missing scopes, bad credentials, broken docs, or package regressions.

---

## stop-expansion criteria

Keep the launch state as `launched`, but stop new onboarding and public promotion until the launch owner reviews the issue when any of these are true:

| signal | stop threshold | first action |
|---|---|---|
| API availability | any broad P0/P1, sustained 5xxs, or auth failures across more than one customer | Open or update status incident, pause onboarding, collect `requestId`s. |
| Latency | p99 exceeds the launch SLO for two consecutive reviews without an understood cause | Pause onboarding and run focused k6 or route-level profiling. |
| Rate limiting | legitimate launch workflows hit unexpected 429s outside documented limits | Check `RateLimit-*` headers, tune limits or docs, and publish workaround if needed. |
| Webhooks | delivery success falls below the launch threshold for customer traffic | Mark component degraded if customer-visible and triage receiver vs platform cause. |
| Packages | current CLI or SDK RC cannot be installed on a clean machine | Pin docs to the last known good path and move/deprecate the broken registry target. |
| Support volume | two or more P1s, any P0, or repeated reports with the same problem `code` | Assign incident owner and convert individual tickets into one tracked incident. |

---

## first-week monitoring

Run a monitoring review at launch, twice daily on days 0 and 1, then daily through day 7. Extend the cadence after any P0 or P1.

Check these signals each time:

- Instatus page and all nine public components (`STATUS_COMPONENTS` in `web/lib/healthChecks.server.ts`).
- Synthetic checks for `GET /api/version`, `GET /api/whoami`, `GET /api/openapi`, and `GET /docs/api`.
- API 4xx and 5xx rates by route and problem `code`.
- Request p95 and p99 against the launch SLO targets.
- Auth failures, `scope_insufficient`, `rate_limited`, and idempotency errors.
- Webhook delivery success rate and retry volume.
- hoot conversation list (`GET /api/cortex/conversations` — the wire path keeps the `cortex` spelling) and request success if hoot is advertised in launch material.
- npm and PyPI install smoke status for the current RC versions.
- GitHub Action example smoke status.
- Support inbox volume by severity, top route, and top problem `code`.
- Active waivers and whether any can be closed.

Append one report per review to the launch ticket:

```text
### YYYY-MM-DD HH:MM TZ - public API launch review

- state: launched / paused
- reviewer:
- status page: operational / degraded / incident URL
- API p95 / p99:
- 5xx rate:
- top 4xx codes:
- webhook delivery:
- package install smoke:
- example workflow:
- support tickets by severity:
- actions taken:
- next review:
```

---

## done criteria

5.5 is foundation-complete when:

- this page is discoverable to operators — as of 2026-09-05 that means `docs/internal/`, not an API docs nav; the original "in the API docs nav" criterion assumed the deleted MkDocs site
- the launch-state model is explicit and does not claim a runtime launch flag
- go/no-go gates link back to the Wave 5 status, load, distribution, and launch-asset work
- rollback and containment steps distinguish route incidents from docs, package, status-page, and support issues
- first-week support payload, severity targets, and monitoring cadence are documented
- operators can decide `preview`, `launch_ready`, `launched`, or `paused` without relying on ad hoc knowledge

External completion still requires executing this runbook during the actual public launch window.

The Wave 5 plan this runbook was written against is archived at `dev/completed/public-api/`
(plan, tasks, and the reference notes explaining why each route is public, internal, or
deferred). The follow-on API work shipped through `dev/completed/api-sprint/` and
`dev/completed/roost-public-api/`.
