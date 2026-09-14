# maintainer quickstart

This is the canonical first-time path for a senior engineer cloning Owlette for maintenance work; use [README.md](../README.md) for the product overview. It links to the existing setup and operations docs instead of duplicating their deeper procedures. AI-agent operating notes live in [.claude/CLAUDE.md](../.claude/CLAUDE.md) and [agent/CLAUDE.md](../agent/CLAUDE.md), but those are not a replacement for this human onboarding path.

## prerequisites

| tool | version | required for | doc reference |
|------|---------|--------------|---------------|
| Windows 10/11 64-bit | — | agent dev/build, installer | not portable to Mac/Linux yet |
| Node.js | >=20.9.0 (see [/.nvmrc](../.nvmrc)) | web + cli + functions | [package.json engines field](../package.json) |
| npm | >=10.0.0 | all js packages | [package.json](../package.json) |
| Python | 3.11 | agent dev + SDK dev (SDK requires >=3.10, so 3.11 covers both). The installer bundles its own embedded runtime | [agent/build_installer_full.bat](../agent/build_installer_full.bat), [sdks/python/pyproject.toml](../sdks/python/pyproject.toml) |
| Rust (rustup) + MSVC C++ build tools | stable | desktop app (`desktop/`), compiled by the full installer build | [desktop/README.md](../desktop/README.md) |
| JDK 21 (Temurin) | 21.x | Firebase emulators in e2e | [web/e2e/README.md](../web/e2e/README.md) |
| firebase-tools | @13.x | emulators + rules deploy | [web/e2e/README.md](../web/e2e/README.md) |
| Inno Setup | 6.2.x | installer build | [agent/build_installer_full.bat](../agent/build_installer_full.bat) (set `%ISCC%` or use default path) |
| Rust toolchain (rustup) | stable | desktop app + `owlette-host` service host | [agent/host](../agent/host) — built by the build script |
| Playwright Chromium | (matches @playwright/test) | e2e tests | run `npm run e2e:install` in `/web` |

When available, run `/scripts/bootstrap-windows.ps1` to validate your local toolchain before starting maintainer work.

## day-1: web dev server

Use the setup landing page for the full path: [setup/index.mdx](../web/content/docs/setup/index.mdx) (published at `/docs/setup`). The web dev server needs Firebase credentials from [setup/firebase.mdx](../web/content/docs/setup/firebase.mdx), and `--legacy-peer-deps` is required.

```bash
git clone https://github.com/tridant-io/owlette.git
cd owlette/web
cp env.example env.local  # fill Firebase creds from /docs/setup/firebase
npm ci --legacy-peer-deps
npm run dev
```

## day-2: agent dev + pairing

1. Install the agent installer on a Windows 10/11 64-bit machine.
2. Pair the machine with a device code using [agent/installation.mdx](../web/content/docs/agent/installation.mdx) (published at `/docs/agent/installation`).
3. When running through Claude Code, local agent edits auto-deploy to ProgramData via the `.claude/hooks/deploy-agent.mjs` hook.

## week-1: ship a new installer

Treat [docs/internal/version-management.md](internal/version-management.md) and [docs/changelog.md](changelog.md) as authoritative for releases and release history. The full installer build script discovers Inno Setup and Python through environment variables including `PYTHON311_ROOT` and `ISCC`. Installer release follows the 3-step API upload flow documented in [.claude/CLAUDE.md](../.claude/CLAUDE.md).

## credentials bootstrap order

1. Firebase dev + prod projects (Auth, Firestore, Storage) → [setup/firebase.mdx](../web/content/docs/setup/firebase.mdx)
2. Firestore rules + indexes → [setup/firestore-rules.mdx](../web/content/docs/setup/firestore-rules.mdx)
3. Web env vars (Railway dev + prod) → [setup/web-deployment.mdx](../web/content/docs/setup/web-deployment.mdx) and [setup/environment-variables.mdx](../web/content/docs/setup/environment-variables.mdx)
4. Cloudflare R2 → run `/scripts/provision-r2.mjs` and configure env vars
5. GitHub release secrets (`NPM_TOKEN` for cli publish, etc.)
6. Agent installer code-signing cert (currently incomplete; installer ships unsigned with SmartScreen warnings)

## machine-bound state — do not copy across machines

> The agent's encrypted token store, `/ProgramData/Owlette/.tokens.enc`, is bound to MachineGuid + hostname; see [agent/src/secure_storage.py](../agent/src/secure_storage.py) for reference. On any machine transfer, the agent must be re-paired via device code, not migrated. The same rule applies to the agent's local Cortex LLM key.

## known portability gaps (open work)

- Code signing cert procedure not documented
- Production deploy/hotfix runbooks now live in [/docs/runbooks/](runbooks/).
- Live-looking Firebase service-account JSONs in `/agent/config/firebase-creds-*.json` should be rotated
- Agent docs (`agent/README.md`, `agent/BUILD.md`) may still reference legacy OAuth / `C:\Owlette` in some sections
- See [docs/changelog.md](changelog.md) for completed portability fixes

## runbooks

For specific operational procedures, see the dedicated runbooks:

- [production-deploy.md](runbooks/production-deploy.md) - normal release flow for web + functions + rules + storage
- [agent-installer-release.md](runbooks/agent-installer-release.md) - agent installer build + 3-step API upload
- [hotfix-rollback.md](runbooks/hotfix-rollback.md) - emergency "prod is broken" procedures + rollback decision tree
- [dev-to-prod-workflow.md](runbooks/dev-to-prod-workflow.md) - branching model, promotion patterns, version coordination
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
