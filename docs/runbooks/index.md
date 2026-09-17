# runbooks

This directory contains operational runbooks for shipping and maintaining Owlette in production.
Each runbook is self-contained - read the one that matches your situation.

## when to read which

| situation | runbook |
|-----------|---------|
| "I'm shipping a normal release of web/functions/rules" | [production-deploy.md](production-deploy.md) |
| "I need to release a new agent installer version" | [agent-installer-release.md](agent-installer-release.md) |
| "prod is broken right now" | [hotfix-rollback.md](hotfix-rollback.md) |
| "how do dev and main branches actually relate?" | [dev-to-prod-workflow.md](dev-to-prod-workflow.md) |
| "I'm turning on Firebase App Check enforcement" | [app-check-rollout.md](app-check-rollout.md) |
| "I'm enabling talons (the automations cron) for an environment" | [talons.md](talons.md) |
| "who owns the cron schedules, the load balancer, or anything else not deployed by a push?" | [manual-infrastructure.md](manual-infrastructure.md) |
| "one site's roost distribution needs stopping right now" | [roost-kill-switch.md](roost-kill-switch.md) |
| "capability or privileged rate-limit enforcement has to be flipped" | [security-boundary-kill-switches.md](security-boundary-kill-switches.md) |
| "a security-boundary alert just fired and I'm first response" | [security-boundary-incident-playbook.md](security-boundary-incident-playbook.md) |
| "what emits the security-boundary metrics, and what alerts on them?" | [security-boundary-monitoring.md](security-boundary-monitoring.md) |
| "I'm new to the repo and need a setup path" | [/docs/maintainer-quickstart.md](../maintainer-quickstart.md) |

## release paths

Use [production-deploy.md](production-deploy.md) for the normal production release path:

- web promotion from `dev` to `main`
- Firebase Functions deploy
- Firestore rules deploy
- Storage rules deploy
- post-deploy checks

Use [agent-installer-release.md](agent-installer-release.md) when the Windows agent installer changes:

- version bump timing
- installer build steps
- 3-step API upload
- signing context
- rollback notes for installer artifacts

Use [hotfix-rollback.md](hotfix-rollback.md) when production is actively unhealthy:

- triage path
- rollback decision tree
- per-surface rollback recipes
- emergency validation
- follow-up cleanup

Use [dev-to-prod-workflow.md](dev-to-prod-workflow.md) when you need the meta-model:

- how `dev` and `main` relate
- what promotion commits look like
- how tags and versions should coordinate
- where branch protection is unknown
- which deployment surfaces are still manual

## containment and security-boundary paths

These four moved here from `docs/ops/` on 2026-09-05 — same genre, one directory.
They are for incidents and planned drills, not for routine releases.

- [roost-kill-switch.md](roost-kill-switch.md) - per-site emergency stop for roost publish, signed-URL, and agent sync.
- [security-boundary-kill-switches.md](security-boundary-kill-switches.md) - the two W9 enforcement switches (capability, privileged rate limit), with the reason/owner/expiry discipline they require.
- [security-boundary-incident-playbook.md](security-boundary-incident-playbook.md) - first response for W9.1-and-later security-boundary incidents.
- [security-boundary-monitoring.md](security-boundary-monitoring.md) - the `[security-boundary-metric]` emissions, their Sentry events, and the alert definitions in `infra/monitoring/security-boundary-alerts.yaml`.

The customer-facing notice drafted for the member-seat rules lockdown lives beside them:
[security-boundary-customer-email.md](security-boundary-customer-email.md) (draft, not sent).

## meta

These runbooks are based on a portability audit, research into actual deploy mechanics,
and historical hotfix patterns observed in git log.
They are intentionally specific, with SHAs and file:line references where useful, so a
maintainer at 3 AM does not have to discover anything they should not.
If you find them stale, update them - these are not sacred.

For the "why" behind some decisions, see:

- [architecture (published docs)](../../web/content/docs/architecture.mdx)
- [/agent/CLAUDE.md](../../agent/CLAUDE.md)
- [/.claude/CLAUDE.md](../../.claude/CLAUDE.md)
- [/docs/README.md](../README.md) - what lives in each docs tree

Those docs cover context such as the custom Firestore REST client, machine-bound
encryption, service state initialization, and repository operating rules.

## known gaps

The runbooks are not exhaustive.
Specific gaps each acknowledges:

- production-deploy: functions/rules/storage deploys are manual.
- agent-installer-release: code-signing cert procedure deferred (business decision; about $300-700/year EV); demote-to-older-version may require re-running 3-step finalize.
- hotfix-rollback: many specific gaps listed inline, including cherry-pick playbook and agent fleet self-update kill switch.
- dev-to-prod-workflow: tag discipline lapsed; branch protection unknown.

If you fill any gap, update both the runbook and the corresponding known gaps section.
