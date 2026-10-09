# owlette docs

two trees, one rule. **published product docs live in `web/content/docs/`** — that tree is app source. it is edited like code, it rides the web build, and a change there triggers CI and an auto-deploy to dev.owlette.app or owlette.app. treat it as shipping code, never as a scratchpad.

**everything in this directory is maintainer-facing and is never published** — `docs/internal/`, `docs/runbooks/`, `docs/changelog.md`, `docs/roadmap.md`, and the quickstart. one rule binds the two trees: the **dual-changelog rule** — every release updates BOTH `docs/changelog.md` (here) and `web/content/docs/changelog.mdx` (published). they are separate files and staying in sync is manual. code-adjacent READMEs (`agent/`, `web/e2e/`, `scripts/`, `infra/`, `e2e-machine/`, `test/`) stay next to their code; they are the sanctioned exception to "all maintainer docs live in `docs/`".

## start here

- [maintainer-quickstart.md](maintainer-quickstart.md) — first-time path for an engineer cloning the repo: toolchain versions, day-1 web dev server, day-2 agent pairing, week-1 installer ship.
- [roadmap.md](roadmap.md) — living, roughly-prioritized list of what's next. not a commitment.
- [changelog.md](changelog.md) — release history; an installer must never ship without a matching `## [X.Y.Z]` entry here.

## runbooks/ — operational procedures

- [runbooks/index.md](runbooks/index.md) — situation-to-runbook lookup table; read this first when something is on fire.
- [runbooks/production-deploy.md](runbooks/production-deploy.md) — the normal release: web promotion, functions, firestore and storage rules, docs, post-deploy checks.
- [runbooks/agent-installer-release.md](runbooks/agent-installer-release.md) — installer build (local or CI with SLSA provenance) plus the 3-step API upload and `setAsLatest`.
- [runbooks/hotfix-rollback.md](runbooks/hotfix-rollback.md) — "prod is broken right now": triage, rollback decision tree, per-surface recipes.
- [runbooks/dev-to-prod-workflow.md](runbooks/dev-to-prod-workflow.md) — how `dev` and `main` relate, promotion commits, tag and version coordination.
- [runbooks/manual-infrastructure.md](runbooks/manual-infrastructure.md) — the artifacts no `git push` deploys: cron schedules, firestore indexes, functions, load balancer.
- [runbooks/app-check-rollout.md](runbooks/app-check-rollout.md) — turning on firebase app check enforcement without locking out the real app.
- [runbooks/talons.md](runbooks/talons.md) — the once-a-minute talon sweep, missed-fire grace, and stale-run janitor; written for "my talon didn't run".
- [runbooks/upgrade-2.12.0.md](runbooks/upgrade-2.12.0.md) — the self-contained 2.12.x promotion chain (legacy keys, env vars, R2, migrations); kept for the procedure.
- [runbooks/roost-kill-switch.md](runbooks/roost-kill-switch.md) — per-site emergency stop for roost publish, signed-URL, and agent sync.
- [runbooks/security-boundary-kill-switches.md](runbooks/security-boundary-kill-switches.md) — the two W9 enforcement switches (capability, privileged rate limit); incident or drill only.
- [runbooks/security-boundary-incident-playbook.md](runbooks/security-boundary-incident-playbook.md) — first response for security-boundary incidents from W9.1 onward.
- [runbooks/security-boundary-monitoring.md](runbooks/security-boundary-monitoring.md) — the `[security-boundary-metric]` lines, their sentry events, and the alert definitions in `infra/monitoring/`.
- [runbooks/security-boundary-customer-email.md](runbooks/security-boundary-customer-email.md) — draft (unsent) customer notice for the member-seat rules lockdown.

## internal/ — design docs, specs, and internal-only procedures

- [internal/threat-model.md](internal/threat-model.md) — canonical security design constraint for roost, reconciled against the code that actually shipped.
- [internal/manifest-format.md](internal/manifest-format.md) — roost manifest format spec v1 (approved).
- [internal/v1-v2-migration.md](internal/v1-v2-migration.md) — canonical v1 → v2 (roost) migration design.
- [internal/architecture-decisions.md](internal/architecture-decisions.md) — the owlette 2.0 architecture decision record.
- [internal/version-management.md](internal/version-management.md) — independent component versioning and `scripts/sync-versions.js`.
- [internal/slsa-build-l3.md](internal/slsa-build-l3.md) — hermetic CI installer build with signed in-toto provenance, verifiable with `slsa-verifier`.
- [internal/cortex-cli-provisioning.md](internal/cortex-cli-provisioning.md) — publishing and refreshing the sha256-pinned `claude.exe` that agents fetch on demand.
- [internal/dmca-takedown-sop.md](internal/dmca-takedown-sop.md) — 17 U.S.C. § 512(c) safe-harbor operator SOP for roost user content.
- [internal/public-api-launch-runbook.md](internal/public-api-launch-runbook.md) — the public API launch sequence, go/no-go gates, and incident table.
- [internal/public-api-developer-preview-checklist.md](internal/public-api-developer-preview-checklist.md) — the developer-preview release checklist.
- [internal/public-api-launch-assets.md](internal/public-api-launch-assets.md) — inventory of the public launch assets and who owns each.
- [internal/public-api-load-testing.md](internal/public-api-load-testing.md) — load-test method and the API SLOs it validates.
- [internal/status-page-uptime.md](internal/status-page-uptime.md) — status page components and the uptime checks behind them.
- [internal/gui-automation-machine-setup.md](internal/gui-automation-machine-setup.md) — canonical recipe for provisioning a windows GUI-automation box (capture machine and e2e runner).
- [internal/hyper-v-capture-vm.md](internal/hyper-v-capture-vm.md) — building the windows 11 hyper-v guest that the setup doc then configures.
- [internal/claude-system.md](internal/claude-system.md) — how the `.claude/` agent harness loads and is checked (skills, commands, agents, hooks).
- [internal/oauth-migration-testing.md](internal/oauth-migration-testing.md) — deprecated v2.1.0 OAuth browser-flow testing guide, kept as history; device code pairing replaced it in v2.4.1.

## api reference

there is no api reference in this tree. the interactive reference is served at `/docs/api` (source: `web/content/docs/api/reference.mdx`, rendered from `web/openapi.yaml`), and the machine-readable spec is at `/api/openapi`.
