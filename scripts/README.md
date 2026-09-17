# Scripts

Operational tooling for the Owlette monorepo. Everything here runs from the
repo root (`node scripts/<name>.mjs`) unless noted. One-shot migrations that
have already been executed live in `migrations/`; the Hyper-V capture/e2e VM
pipeline lives in `vm/`.

## Live tooling (recurring use)

| script | purpose |
|---|---|
| `sync-versions.js` | Bump all 9 version surfaces at once (`node scripts/sync-versions.js X.Y.Z`). The only version-sync script — see `docs/internal/version-management.md`. |
| `sync-env.mjs` | Reconcile Railway/Vercel env vars against `env-manifest.json` (`status` / `check` / `diff` / `sync <target>`). See `.claude/skills/env-management.md`. |
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
| `scan-firestore-writes.mjs` | `web/package.json` → `npm run scan:firestore-writes` — the standing lockdown invariant: browser control-plane writes must stay at 0 |
| `check-system-invoker-callers.mjs` | `web/eslint.config.mjs` + a jest twin (`web/__tests__/eslint/system-invoker-allowlist.test.ts`) |
| `check-status-page-ready.mjs` | Deploy runbooks + `infra/cron-jobs.json` (Instatus status-page readiness) |
| `checks/loc.sh` | `.github/workflows/loc-metric.yml` (non-blocking, every PR and every push to `dev`/`main`): prints the tree total and the PR's delta from its merge base. |

## checks/ — on-demand verification

| script | purpose |
|---|---|
| `checks/smoke-r2-roundtrip.mjs` | R2 chunk-pipeline round-trip against a deployed env (used in deploy runbooks). |
| `checks/security-boundary-probe.mjs` | 60s synthetic privileged-read probe against dev (`docs/runbooks/security-boundary-monitoring.md`). |
| `checks/sentinel-emulator.mjs` | Prove Admin SDK writes hit the emulator, not prod. |
| `checks/loc.sh` | Tracked-line metric the tri-platform and swoop plans are budgeted against: bare total, `--per-dir`, `--against <n>`, `--between <baseRef> <headRef>`. |
| `checks/loc-baseline.txt` | The metric's anchor total at commit `a49ed4cc`, the reference point for the tri-platform and swoop ledgers. No script reads it — pass the number to `checks/loc.sh --against` by hand. |
| `check-firebase-admin-namespace.mjs` | Fail on the `firebase-admin` root namespace under `scripts/` and `e2e-machine/` (removed in v14). CI: `.github/workflows/admin-sdk-guard.yml`. Self-tests with `--test`. |

## migrations/ — one-shot, already executed

Historical Firestore/auth migrations and backfills, kept for their `--rollback`
paths and as references. Do not re-run against prod without reading the script
header and `docs/runbooks/upgrade-2.12.0.md` first. Their gitignored
`*.log.json` execution logs (the only rollback input) sit alongside them.

`migrate-roles` · `migrate-profiles` · `migrate-synced-folders-to-roosts` ·
`migrate-manifest-to-version` · `backfill-mfa-factors` ·
`backfill-site-owner-membership` · `audit-legacy-api-keys` ·
`replace-legacy-api-key`

## vm/ — Hyper-V capture & e2e VM pipeline

22 numbered PS1 stages (create → provision → golden checkpoint → drive
installer → record). See `docs/internal/hyper-v-capture-vm.md` and
`e2e-machine/RUNBOOK.md`.
