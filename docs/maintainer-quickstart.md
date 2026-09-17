# maintainer quickstart

This is the canonical first-time path for an engineer cloning Owlette to develop or self-host it; use [README.md](../README.md) for the product overview. It links to the existing setup and operations docs instead of duplicating their deeper procedures. AI-agent operating notes live in [.claude/CLAUDE.md](../.claude/CLAUDE.md) and [agent/CLAUDE.md](../agent/CLAUDE.md), but those are not a replacement for this human onboarding path.

## prerequisites

| tool | version | required for | doc reference |
|------|---------|--------------|---------------|
| Windows 10/11 64-bit | — | agent dev/build, installer | not portable to Mac/Linux yet |
| Node.js | 22.x (see [/.nvmrc](../.nvmrc)) | web, desktop, functions, cli, sdks | [package.json engines field](../package.json) |
| npm | >=10.0.0 | all js packages | [package.json](../package.json) |
| Python | 3.11 | agent venv + tests, SDK dev (SDK requires >=3.10). The installer build downloads its own embedded 3.11.8 | [scripts/bootstrap-windows.ps1](../scripts/bootstrap-windows.ps1), [sdks/python/pyproject.toml](../sdks/python/pyproject.toml) |
| Rust (rustup) + MSVC C++ build tools + WebView2 | stable | desktop app (`desktop/`) and the `owlette-host` service host (`agent/host`), both compiled by the full installer build | [desktop/README.md](../desktop/README.md) |
| JDK 21 (Temurin) | 21.x | Firebase emulators in rules tests and e2e | [web/e2e/README.md](../web/e2e/README.md) |
| firebase-tools | 15.x (global) | emulators + rules/functions deploy (13.x cannot run the functions emulator) | [web/e2e/README.md](../web/e2e/README.md) |
| Inno Setup | 6.x | installer build | [agent/build_installer_full.bat](../agent/build_installer_full.bat) (set `%ISCC%`, put `iscc` on PATH, or use the default install path) |
| Playwright Chromium | (matches @playwright/test) | e2e tests | installed by the bootstrap script, or `npm run e2e:install` in `/web` |

## step 1: bootstrap the toolchain and dependencies

```powershell
git clone https://github.com/tridant-io/owlette.git
cd owlette
powershell -File scripts\bootstrap-windows.ps1 -InstallWebDeps -InstallAgentDeps
```

The script validates the prerequisites above (it does not install system tools or change PATH), then:

- `-InstallWebDeps` runs `npm ci --legacy-peer-deps` and the Playwright Chromium install in `web/`.
- `-InstallAgentDeps` creates the agent venv at `agent/.venv` with `py -3.11` and installs `agent/requirements.txt` + `agent/requirements-dev.txt` into it. Rerunning it brings an existing venv up to the current pins.

Install the remaining JS packages yourself:

```bash
npm ci                       # repo root: cli + sdks/node workspaces
cd desktop && npm ci
cd ../functions && npm ci
```

The agent venv is what everything Python runs on: the Claude Code pre-commit hook (`.claude/hooks/pre-commit-check.mjs`) runs `py_compile` and pytest with `agent/.venv`'s interpreter and blocks the commit if the venv is missing, and the committed [.vscode/settings.json](../.vscode/settings.json) points VS Code's Python extension at it. Do not rely on a bare `python` — Windows puts the machine PATH ahead of the user PATH, so an older system Python can shadow 3.11.

## step 2: local env files

None of these are committed. Create the ones for the work you are doing; files with an example start as a copy of it.

| file | start from | needed for |
|------|-----------|------------|
| `web/.env.local` | `web/.env.example` | web dev server — Firebase creds from [setup/firebase.mdx](../web/content/docs/setup/firebase.mdx); the full key registry is [scripts/env-manifest.json](../scripts/env-manifest.json) |
| `.claude/.env.local` | `.claude/.env.example` | Owlette API calls and installer uploads. The example only lists `OWLETTE_API_KEY`; also set `OWLETTE_API_KEY_PROD` (installer-scoped), `OWLETTE_DEV_API_URL`, `OWLETTE_PROD_API_URL`, and for R2 provisioning `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_R2_API_TOKEN` |
| `functions/.env.<projectId>` — one per project in [.firebaserc](../.firebaserc) (`owlette-dev-3838a`, `owlette-prod-90a12`) | `functions/.env.example` | Cloud Functions deploys. A missing file still deploys "successfully" with the functions silently broken — see [manual-infrastructure.md](runbooks/manual-infrastructure.md) |
| `test/integration/.env.test` | `test/integration/.env.test.example` | integration tests |
| `scripts/.env.local` | none | `scripts/upload-cortex-cli.mjs` and `scripts/migrations/audit-legacy-api-keys.mjs`: `FIREBASE_PROJECT_ID_{DEV,PROD}`, `FIREBASE_CLIENT_EMAIL_{DEV,PROD}`, `FIREBASE_PRIVATE_KEY_{DEV,PROD}` (falls back to the unsuffixed trio in `web/.env.local`) |
| `.claude/.env.tridant` | none | `scripts/dev/rotate-tridant-env.sh` and `rotate-functions-env.sh`: `R2_S3_ENDPOINT`, `R2_APP_S3_ACCESS_KEY_ID`, `R2_APP_S3_SECRET_ACCESS_KEY`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY_TRIDANT`, `TURNSTILE_SECRET_TRIDANT` |
| `infra/cloudflare/terraform.tfvars` | `infra/cloudflare/terraform.tfvars.example` | Cloudflare load balancer — see [.claude/skills/cf-load-balancing.md](../.claude/skills/cf-load-balancing.md) |
| `dev/video-tutorials/voiceover/.env` | `.env.example` in that folder | tutorial voiceover generation only |

## step 3: CLI logins

Only needed for the operations named; day-to-day dev needs none beyond `gh`.

| CLI | how it authenticates | used for |
|-----|---------------------|----------|
| `gh` | `gh auth login` | `/preflight` security-alert gate (`scripts/check-security-alerts.mjs`), watching CI runs |
| `firebase` | `firebase login` | rules, indexes, and functions deploys ([setup/firebase.mdx](../web/content/docs/setup/firebase.mdx)); the local emulators need no login |
| `railway` | `railway login` | `scripts/sync-env.mjs` and the rotation scripts ([.claude/skills/env-management.md](../.claude/skills/env-management.md)) |
| `vercel` | `vercel login`, then `vercel link` in `web/` | `scripts/sync-env.mjs` against the Vercel failover project |
| `gcloud` | `gcloud auth login` | one-time infrastructure bootstrap in [manual-infrastructure.md](runbooks/manual-infrastructure.md) |
| `terraform` | no login — export `CLOUDFLARE_API_TOKEN` in the shell (never in a file) | `infra/cloudflare` |

`railway`, `vercel`, `gcloud`, and `terraform` are not checked by the bootstrap script; install them when you need them.

## day-1: web dev server

Use the setup landing page for the full path: [setup/index.mdx](../web/content/docs/setup/index.mdx) (published at `/docs/setup`). With `web/.env.local` filled in:

```bash
cd web
npm run dev                  # http://localhost:3000
```

`web/.npmrc` sets `legacy-peer-deps`, so a plain `npm ci` in `web/` works; CI and the bootstrap script pass `--legacy-peer-deps` explicitly as well.

## day-2: agent + desktop dev

1. Install the agent with the installer on a Windows 10/11 64-bit machine and pair it with a device code using [agent/installation.mdx](../web/content/docs/agent/installation.mdx) (published at `/docs/agent/installation`). The service is hosted by `owlette-host`; do not run `python owlette_service.py install`, which registers a second, competing service.
2. To run the agent from source in the foreground (admin shell): `cd agent/src && ..\.venv\Scripts\python owlette_service.py debug`.
3. Under Claude Code, edits to `agent/src/*.py` are mirrored to `C:\ProgramData\Owlette\agent\src\` and the service is restarted by the `.claude/hooks/deploy-agent.mjs` hook. The restart order for doing it by hand is in [.claude/CLAUDE.md](../.claude/CLAUDE.md) under "Agent Dev Testing Workflow".
4. The local UI is the Tauri app in `desktop/`: `npm run tauri dev` for development, and the command list is in [desktop/README.md](../desktop/README.md). Desktop changes are not mirrored by the hook — rebuild with `npx tauri build --no-bundle` and copy the exe into `C:\ProgramData\Owlette\app\`.

## before you open a PR

Run the checks for what you changed:

| changed | run |
|---------|-----|
| `web/`, `firestore.rules`, `firebase.json` | `/preflight` in Claude Code (security alerts, lint, typecheck, unit, rules, and e2e — mirrors CI), or by hand in `web/`: `npm run lint`, `npm test`, `npm run e2e` |
| `agent/` | `agent\.venv\Scripts\python -m pytest agent/tests/` from the repo root |
| `desktop/` | `npm run typecheck`, `npm test`, `npm run lint` in `desktop/` |
| `functions/` | `npm run build`, `npm test` in `functions/` |
| `cli/`, `sdks/node/` | `npm test` at the repo root |

## week-1: ship a new installer

Treat [docs/internal/version-management.md](internal/version-management.md) and [docs/changelog.md](changelog.md) as authoritative for releases and release history. The full installer build downloads its own embedded Python 3.11.8, finds Inno Setup through `%ISCC%`, PATH, or the default install path, and needs Rust for the desktop app and `owlette-host`. The build, the 3-step API upload, and the release ordering rules are in [agent-installer-release.md](runbooks/agent-installer-release.md).

## credentials bootstrap order

1. Firebase dev + prod projects (Auth, Firestore, Storage) → [setup/firebase.mdx](../web/content/docs/setup/firebase.mdx)
2. Firestore rules + indexes → [setup/firestore-rules.mdx](../web/content/docs/setup/firestore-rules.mdx)
3. Web env vars (Railway dev + prod, Vercel failover) → [setup/web-deployment.mdx](../web/content/docs/setup/web-deployment.mdx), [setup/environment-variables.mdx](../web/content/docs/setup/environment-variables.mdx), and `scripts/sync-env.mjs`
4. Cloudflare R2 → run `/scripts/provision-r2.mjs` (buckets + CORS), mint the S3 access keys in the Cloudflare dashboard, and configure the env vars
5. Cloud Functions secrets → `functions/.env.<projectId>` per [manual-infrastructure.md](runbooks/manual-infrastructure.md)
6. npm publishing needs no token — `cli-publish.yml` and `node-sdk-publish.yml` use npm OIDC trusted publishing
7. Agent installer code signing — not in place; installers ship unsigned with SmartScreen warnings (see "code signing context" in [agent-installer-release.md](runbooks/agent-installer-release.md))

## machine-bound state — do not copy across machines

> The agent's encrypted token store, `/ProgramData/Owlette/.tokens.enc`, is bound to MachineGuid + hostname; see [agent/src/secure_storage.py](../agent/src/secure_storage.py) for reference. On any machine transfer, the agent must be re-paired via device code, not migrated. The same rule applies to the agent's local Cortex LLM key.

## known portability gaps (open work)

- Code signing is deferred as a business decision ([runbooks/index.md](runbooks/index.md))
- See [docs/changelog.md](changelog.md) for completed portability fixes

## runbooks

For specific operational procedures, see the dedicated runbooks:

- [production-deploy.md](runbooks/production-deploy.md) - normal release flow for web + functions + rules + storage
- [agent-installer-release.md](runbooks/agent-installer-release.md) - agent installer build + 3-step API upload
- [hotfix-rollback.md](runbooks/hotfix-rollback.md) - emergency "prod is broken" procedures + rollback decision tree
- [dev-to-prod-workflow.md](runbooks/dev-to-prod-workflow.md) - branching model, promotion patterns, version coordination
- [manual-infrastructure.md](runbooks/manual-infrastructure.md) - infrastructure that lives outside the repo's automation, and how to verify it
- [runbooks/index.md](runbooks/index.md) - runbook directory

## further reading

- [docs/README.md](README.md) - what lives in this tree vs. the published one
- [architecture.mdx](../web/content/docs/architecture.mdx) (published at `/docs/architecture`)
- [setup/environment-variables.mdx](../web/content/docs/setup/environment-variables.mdx)
- [agent/installation.mdx](../web/content/docs/agent/installation.mdx)
- [web/e2e/README.md](../web/e2e/README.md)
- [docs/internal/version-management.md](internal/version-management.md)
- GUI automation machine setup (internal, unpublished): [docs/internal/gui-automation-machine-setup.md](internal/gui-automation-machine-setup.md) — provisioning a Windows box for native GUI automation (video capture + the full-machine e2e gate); executable form: `scripts/bootstrap-gui-automation.ps1`
- Full-machine e2e harness (install→pair→GUI→uninstall release gate): [e2e-machine/README.md](../e2e-machine/README.md) — setting up e2e testing on a new computer; Wave 0 auth spike is runnable today
