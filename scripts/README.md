# Scripts

Operational tooling for the Owlette monorepo. Everything here runs from the
repo root (`node scripts/<name>.mjs`) unless noted. One-shot Firestore
migrations live in `migrations/`; the Hyper-V capture/e2e VM pipeline lives in
`vm/`.

## Live tooling (recurring use)

| script | purpose |
|---|---|
| `sync-versions.js` | Bump every version surface at once (`node scripts/sync-versions.js X.Y.Z`). The only version-sync script — see `docs/internal/version-management.md`. |
| `upload-installer.mjs` | Publish a release's installers (one file per platform) through the 3-step API upload, `--set-latest` to promote, `--notes-only` to correct notes. See `docs/runbooks/agent-installer-release.md`. |
| `check-security-alerts.mjs` | Grade every open GitHub alert against this branch's lockfiles; the release gate (`.github/workflows/security-gate.yml`, `security-preflight.yml`). |
| `refresh-docs-screens.mjs` | Release-time recapture of the agent docs screenshots from the build being shipped (`--check` compares the record against `VERSION`). |
| `sign.ps1` | Sign Windows files with Azure Artifact Signing; run by `agent/build_installer_full.bat` and the `package-windows` CI job. |
| `setup-ci-signing.sh` | One-time setup of the Entra app CI signs with (git bash, repo admin). Safe to re-run. |
| `sync-env.mjs` | Reconcile Railway/Vercel env vars against `env-manifest.json` (`status` / `check` / `diff` / `sync <target>`). See `.claude/skills/env-management/SKILL.md`. |
| `env-manifest.json` | Canonical env-key registry (keys + metadata, never values). Data file — must stay beside `sync-env.mjs`. |
| `sync-repo-refs.mjs` | Propagate the GitHub owner/repo from root `package.json` into Cargo.toml, the installer, and docs. |
| `provision-r2.mjs` | Create the roost R2 buckets + CORS (idempotent). Sole source of truth for R2 CORS; bucket policy lives at `infra/r2/r2-bucket-policy.json`. |
| `upload-cortex-cli.mjs` | Publish the pinned Claude CLI blobs + one `installer_metadata/cortex_cli_<osFamily>_<arch>` per platform (and the legacy `cortex_cli` that pre-3.4 agents read). One run per environment takes every platform. Re-run on every claude-agent-sdk bump. |
| `bootstrap-windows.ps1` | Validate the Windows dev toolchain on a new machine. |
| `bootstrap-gui-automation.ps1` | Validate/apply GUI-automation rig config (capture rig + e2e runner). Also executed inside guests by `vm/05-prep-guest.ps1`. |

## CI / hook-wired gates (do not move or rename)

| script | wired into |
|---|---|
| `check-no-token-logs.mjs` | `.github/workflows/no-token-logs.yml` |
| `check-claude-hooks.mjs` | `.github/workflows/claude-hooks.yml`: every `.claude/hooks` file parses, writes stdout only through `lib/hook-output.mjs`, and emits valid hook JSON; every skill, agent and command has frontmatter Claude Code will load |
| `check-firebase-admin-namespace.mjs` | `.github/workflows/admin-sdk-guard.yml`: fail on the `firebase-admin` root namespace under `scripts/` (removed in v14). Self-tests with `--test`. |
| `scan-firestore-writes.mjs` | `web/package.json` → `npm run scan:firestore-writes`, run by hand; no workflow runs it. The standing lockdown invariant: browser control-plane writes must stay at 0 |
| `check-system-invoker-callers.mjs` | run by hand; no workflow runs it. CI enforces the same allowlist through the lint rule in `web/eslint.config.mjs` and its jest twin (`web/__tests__/eslint/system-invoker-allowlist.test.ts`) |
| `check-status-page-ready.mjs` | Deploy runbooks + `infra/cron-jobs.json` (Instatus status-page readiness) |
| `checks/loc.sh` | `.github/workflows/loc-metric.yml` (non-blocking, every PR and every push to `dev`/`main`): prints the tree total and the PR's delta from its merge base. |

## checks/ — on-demand verification

| script | purpose |
|---|---|
| `checks/smoke-r2-roundtrip.mjs` | R2 chunk-pipeline round-trip against a deployed env (used in deploy runbooks). |
| `checks/security-boundary-probe.mjs` | 60s synthetic privileged-read probe against dev (`docs/runbooks/security-boundary-monitoring.md`). |
| `checks/loc.sh` | Tracked-line metric the tri-platform and swoop plans are budgeted against: bare total, `--per-dir`, `--against <n>`, `--between <baseRef> <headRef>`. |
| `checks/loc-baseline.txt` | The metric's anchor total at commit `a49ed4cc`, the reference point for the tri-platform and swoop ledgers. No script reads it — pass the number to `checks/loc.sh --against` by hand. |
| `check-membership-read-path.mjs` | Read-only check that the deployed rules and index serve the dashboard's membership queries, signed in as an ordinary user. |

## migrations/ — one-shot Firestore migrations

Kept for their `--rollback` paths and as references. Read a script's header
before running it; a `Status:` line at its top says nothing reads what the
script migrates any more. Their gitignored `*.log.json` execution logs (the
only rollback input) sit alongside them.

- written for the 2.12.x promotion, nothing left for them to migrate:
  `migrate-profiles`, `migrate-synced-folders-to-roosts`,
  `migrate-manifest-to-version`
- retired, refuses to run: `migrate-roles` (superseded by
  `migrate-global-role-values`)
- the 2.12.x legacy-key pair: `audit-legacy-api-keys` (read-only) and
  `replace-legacy-api-key`
- the per-site membership cutover (2026-09): `census-site-membership`
  (read-only), `backfill-site-owner-membership`, `backfill-per-site-membership`,
  `migrate-global-role-values`, `strip-legacy-membership`
- `move-webhook-secrets`, `backfill-mfa-factors`
- not yet run on prod: `backfill-issue-numbers` (numbers unnumbered issues from
  `counters/bug_reports`; dry run unless `--write --confirm-project=<id>`, safe
  to re-run; prod needs it when 4.x web is promoted)

## vm/ — Hyper-V capture & e2e VM pipeline

25 numbered PS1 stages, `18b` to `18d` included (create → provision → golden
checkpoint → drive installer → verify → record), plus `vm/ubuntu/` for the
Linux kiosk VM. See `docs/internal/hyper-v-capture-vm.md`.
