# Owlette - Cloud-Connected Process Management System

Owlette is a cloud-connected Windows process management and remote deployment system for managing TouchDesigner installations, digital signage, kiosks, and media servers. Monorepo: Python Windows service (agent) + Next.js web dashboard (web) + Firebase/Firestore backend.

**Version**: 4.0.0 | **License**: FSL-1.1-Apache-2.0

---

## Critical Guardrails (non-negotiable — read first)

**Files you must not touch:**
- `firestore.rules` — don't modify without explicit request
- `.tokens.enc` / credential files — never read, log, or commit
- `owlette_installer.iss` — only modify if you understand the full build pipeline (see `.claude/skills/build-system.md`)

**Agent landmines:**
- **Never import `firebase_admin`** — we use a custom REST client
- **Never log OAuth tokens** — not even in debug, not even partially
- **Never modify the `firebase` section** of `config.json` during remote config updates — breaks agent registration
- **Never use blocking operations** in the 5-second main service loop (`SLEEP_INTERVAL = 5`) — stalls all monitoring
- **Never spawn reconnection logic** outside `ConnectionManager` — it has circuit breaker and backoff
- **Never raise a UAC prompt unattended.** No path that runs without a deliberate click (service, silent installer, desktop auto-start, scheduled task) may `runas` / ShellExecute-elevate. Elevation is only ever the response to an explicit user click. This has shipped to the fleet twice (3.2.0, and again on every 3.2.0→3.3.x upgrade).
- **A fleet-behavior fix must cover the upgrade path from every version still in the field.** During a self-update the OLD desktop app and OLD service are what run on the box. A fix that lives only in the new build does nothing for that upgrade; the installer is the only new code that executes on an old machine, so the upgrade-path half of the fix belongs there. Verify by upgrading from the oldest fielded version, not from dev.

**Web landmines:**
- **Never call Firestore directly from components** — use hooks in `web/hooks/`
- **Never hardcode colors** — use CSS variables / Tailwind theme tokens
- **Never add icon libraries** beyond `lucide-react`

**Workflow:**
- **Don't push to `main` directly** — all work through `dev`, then PR
- **Don't create new `docs/*.md` files** without being asked
- **Don't install new npm/pip packages** without confirming first
- **Don't modify `.claude/hooks/` or `.claude/settings.json`** without explicit request

---

## In-Flight Major Initiative: roost (project distribution v2)

A multi-quarter rewrite of project distribution into a content-addressed sync platform (Cloudflare R2, immutable manifests, atomic deploy, rollback). Branded as "roost" (always lowercase). Plan + tasks live at `dev/active/project-distribution-v2/`. Memory: `project_roost.md`.

**Key decisions** (do not relitigate):
- No `/api/v2/` URL prefix — the new routes ARE the API (`/api/chunks/`, `/api/roosts/`).
- No backwards compatibility with v1 agents — clean cutover, v3.0.0 agent is required to consume new uploads.
- No header-based version negotiation (no `Accept: application/vnd.owlette.v2+json`).
- v3-deferred (do NOT rebuild in v2): bidirectional sync, LAN swarm, Ed25519 manifest signing, FastCDC. (Public CLI was originally on this list but shipped via the api-sprint + roost-public-api waves — now `@owlette/cli` v1.0.0-rc.0; see `project_npm_packages.md`.)
- Nav label `projects` → `roost`. `verify_files` field dropped (manifest is authoritative).

---

## Tech Stack

- **Web** (`web/`): Next.js 16 (App Router, React 19), TypeScript, Tailwind CSS 4, shadcn/ui, Firebase Auth + Firestore
- **Agent** (`agent/`): Python 3.11 (bundled 3.11.8 ships; a fresh dependency install needs ≥3.10 — Pillow 12.x) hosted as a Windows service by `owlette-host` (`agent/host`, Rust — replaced NSSM in 3.0.0), Firestore REST API (not Admin SDK), psutil, pywin32, Inno Setup installer
- **Database**: Cloud Firestore (real-time NoSQL), Firebase Auth (Email/Password, Google OAuth, Passkey/WebAuthn)
- **Package Managers**: Web: npm (not pnpm/yarn) | Agent: pip

---

## Build Commands

```bash
# Web
cd web && npm install && npm run dev     # Dev server (localhost:3000)
cd web && npm run build                  # Production build
cd web && npm test                       # Jest unit tests
cd web && npm run e2e                    # Playwright E2E suite (requires JDK 21 + firebase-tools@15 globally)
cd web && npm run lint                   # Lint

# Agent
powershell -File scripts/bootstrap-windows.ps1 -InstallAgentDeps   # agent/.venv (Python 3.11) + requirements*.txt
agent/.venv/Scripts/python -m pytest agent/tests/                  # Agent tests (what the commit hook runs)
cd agent/src && ../.venv/Scripts/python owlette_runner.py --debug  # Debug mode (requires admin)
cd agent && build_installer_full.bat              # Full build (~5-10 min)
cd agent && build_installer_quick.bat             # Quick build (~30 sec)

# Version bump (all files at once)
node scripts/sync-versions.js X.Y.Z
```

Version files: `/VERSION`, `agent/VERSION`, `web/package.json`, `firestore.rules` (independent). See `docs/internal/version-management.md`.

**E2E prereqs**: JDK 21 on PATH (Temurin), `npm i -g firebase-tools@15`, `npx playwright install chromium --with-deps` (once). Emulator ports: Auth :9099, Firestore :8080, Storage :9199. App runs on :3100 during E2E (not :3000). Report output: `web/e2e/.output/report/`. Full guide: `web/e2e/README.md`.

---

## Git Workflow

**Two-Branch Model**: `dev` (deploys to dev.owlette.app) → `main` (deploys to owlette.app)

**Commit Messages**: Conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`)

**Pre-Commit Code Review**: Before every commit, perform a thorough code review of all staged changes. Every line must meet production quality standards — no duct-tape fixes, no "good enough for now" shortcuts, no patchy logic. Specifically:
- Verify correctness: no off-by-one errors, race conditions, resource leaks, or missed edge cases
- Ensure consistency: naming conventions, error handling patterns, and code style match the surrounding codebase
- Check for completeness: if a pattern is introduced (e.g. lazy init), verify it's wired up end-to-end (references stored, cleanup handled, state updates propagated)
- No dead code, no commented-out code, no placeholder TODOs that won't be addressed in this commit
- All changes must be self-contained and fully functional — never commit something that "works but will need a follow-up fix"

**Lint as you go — don't let errors accumulate.** After editing any web file, run `npx eslint <file>` on that file (or `npm run lint` for a broader change) and fix every error and warning you introduced before moving on. Never commit new lint errors, and never rationalise them as "pre-existing" if your edit touched the same file. The repo has historical lint debt — your job is to not add to it, and to clean up any issues in lines you modified. Same principle for TypeScript: if `tsc` / IDE diagnostics flag your change, fix it before the next edit, not at commit time.

**Security alerts are a release gate, not a notification.** Run `node scripts/check-security-alerts.mjs` before any release build and as part of `/preflight`. It resolves every open GitHub alert against *this branch's* lockfiles, because Dependabot files security alerts and PRs against `main` (`target-branch` does not apply to them) and `main` trails `dev` — so the raw alert list mixes live vulnerabilities with ones fixed on `dev` weeks ago. Exit 1 means a vulnerable version is still pinned here: fix it, dismiss it on GitHub with a written reason, or get explicit user acceptance and re-run with `--ack "<key>=<why>"` — every ack needs a written reason, `verify:*` keys are refused outright (a check that could not run must be fixed, not waived), and acked items go in the release commit body so the decision is on record. Never ack on your own judgment. The `security preflight` workflow runs the same check daily and on every push to `dev`/`main`. Security PRs land on `dev` by hand; a Dependabot PR open past 30 days is itself a blocker.

**E2E verification (two layers).** The `playwright e2e` GitHub Action ([.github/workflows/e2e.yml](../.github/workflows/e2e.yml)) gates pushes to `dev`/`main` that touch `web/**`, `firestore.rules`, or `firebase.json`.
- **Proactive (preferred):** before pushing such changes, run `/preflight` — it runs lint, typecheck, unit tests, and the local e2e suite (the exact mirror of CI, ~45s steady-state). Fix reds locally; don't ship them to a branch that auto-deploys.
- **Reactive (safety net):** after a `git push` to `dev`/`main` in e2e scope, the `post-push-e2e.mjs` hook reminds you to watch the triggered run with `gh run watch <id> --exit-status` (run it in the background). On failure: `gh run view <id> --log-failed`, diagnose, and **propose** a fix — never auto-fix-and-repush (`dev` auto-deploys, `main` is protected).

---

## Agent Authentication (Device Code Pairing)

Agents authenticate via a device code flow — no browser login on the target machine.

**3 Ways to Add a Machine:**

1. **Browser** (single machine): Run installer → pairing phrase appears → browser auto-opens owlette.app/add → select site → authorize
2. **Dashboard** (manual): Run installer → note 3-word phrase → dashboard "+" button → "Enter Code" → authorize
3. **Silent Install** (bulk deploy): Dashboard "+" → "Generate Code" → copy phrase → `Owlette-Installer.exe /ADD=silver-compass-drift /SILENT`

**Key files:**
- `web/app/api/agent/auth/device-code/` — generate phrase, poll, authorize endpoints
- `web/app/add/page.tsx` — pairing page (phrase pre-filled via URL param)
- `web/app/dashboard/components/AddMachineButton.tsx` — dashboard "+" button + modal
- `agent/src/configure_site.py` — agent-side pairing flow (browser open + polling)
- `agent/src/auth_manager.py` — token exchange, refresh, device code polling
- `web/lib/pairPhrases.ts` — pairing-phrase word list (web-canonical)

**Token lifecycle (unchanged):** Access token (1h, Firebase ID token) + refresh token (never expires, admin-revocable). Stored encrypted in `C:\ProgramData\Owlette\.tokens.enc` with machine-bound Fernet key.

---

## Deployment

**Web**: Push to `dev`/`main` triggers Railway auto-deploy. A Vercel project (`owlette` in the `tridant-7931a9aa` team; the Experiential scope it lived in until 2026-09-24 is blocked) is configured as a failover origin for owlette.app behind Cloudflare Load Balancing.

**Env vars** (Railway dev/prod + Vercel prod): managed via `scripts/env-manifest.json` (canonical key registry — keys + metadata, never values) and `node scripts/sync-env.mjs` (`status` / `check` / `diff` / `sync <target>`). Full workflow + the `must-match` secret rules + the Vercel read-back caveat: `.claude/skills/env-management.md`.

**Failover load balancer**: `owlette.app` is fronted by a Cloudflare LB (Railway primary, Vercel standby) defined as Terraform in `infra/cloudflare/`. Health probe is `/api/health`. Apply workflow, token scope, and the origin-hostname gotchas: `.claude/skills/cf-load-balancing.md`.

**Confirm live state against the API — don't infer it from the repo.** When the question is what is actually deployed or true on dev/prod (is this route shipped, what version is the latest installer, is a machine online, does this key carry that scope), query the running API. Keys are in `.claude/.env.local`: `OWLETTE_API_KEY` (dev — broad scopes) against `$OWLETTE_DEV_API_URL`, `OWLETTE_API_KEY_PROD` (**installer-scoped only** — 403 `scope_insufficient` on site/machine routes) against `$OWLETTE_PROD_API_URL`. Auth header is `x-api-key`. Use `curl`, not python `urllib` — Cloudflare bot-blocks the latter with `error code: 1010`. No-auth reads: `GET /api/health`, `GET /api/openapi` (interactive reference at `/docs/api`). Status codes alone settle "is it deployed": 401 = deployed and gated, 403 = authed but wrong scope, 404 = not deployed.

- **Read-only by default.** GETs and other non-mutating calls need no approval — prefer one over asking the user to check for you.
- **Mutating calls need an explicit ask.** Installer finalize / `setAsLatest`, remote commands to agents, config pushes, key revocation, deletes — never fire these off to confirm something. Get the user's go-ahead first, prod especially.

**IMPORTANT — installer release order (do not reorder):** bump the version (`node scripts/sync-versions.js X.Y.Z`) **and** add the `## [X.Y.Z] - YYYY-MM-DD` entry to `docs/changelog.md`, then commit — *before* building. `build_installer_full.bat` bakes the version into the exe filename and binary, and an installer must never ship without a matching changelog entry.

**Full release recipe** — the non-interactive build invocation (the `pause`-hang gotcha) plus the 3-step signed-URL upload → finalize API flow — lives in `.claude/skills/build-system.md` → "Agent Installer Release". That skill auto-activates on installer/release/version work.

---

## Dependency Currency (standing policy)

We fell 83 minor versions behind on `claude-agent-sdk` because a single `pywin32==306`
pin transitively froze it, and nothing ever failed — pip backtracked to a satisfiable set
and exited 0. Hoot ran on a Claude CLI 138 releases old for months. **A dependency that is
silently stuck looks identical to one that is deliberately pinned.** This section exists so
that stops being true.

### Rules

- **Every pin that holds a package BACK carries a written reason and an exit condition.**
  Not "pinned for stability" — name the constraint, and name what would let us move. A pin
  whose comment no longer matches reality is a bug; `agent/requirements.txt` carried one for
  a month saying "pywin32 310, not higher" after the cap it described had lifted.
- **Pin transitive dependencies you actually care about, explicitly.** `mcp` is pinned even
  though it arrives through `claude-agent-sdk`, precisely because under a range pip picks
  whatever the rest of the tree allows and never tells you.
- **Review dependency currency every release cycle**, not when something breaks. Check the
  gap, not just the CVEs — Dependabot raises security PRs and will happily leave you years
  behind on a package with no advisories.
- **A major-version bump is a task with waves, not a line edit.** Plan it, land it on `dev`,
  let e2e prove it.
- **Never bump a dependency you have not established is actually used.** The `openai` package
  sat as a direct dependency that nothing imported and nothing depended on; the real provider
  is `@ai-sdk/openai`. Upgrading dead weight is worse than leaving it — removing it is the fix.

### Coupled versions — moving one MUST move the others

| if you bump | you must also |
| --- | --- |
| `claude-agent-sdk` | re-run `scripts/upload-cortex-cli.mjs` once per environment, for **dev AND prod**, passing every platform's binary in the one run — the SDK vendors the Claude CLI and the per-platform pins in `installer_metadata/cortex_cli_<osfamily>_<arch>` move with it. That run also rewrites the legacy `installer_metadata/cortex_cli`, the only id a pre-3.4 agent reads; keep it until the fleet floor is 3.4. Agents keep fetching the old CLI until you do |
| `mcp` to 2.x | `pywin32>=311` (mcp 1.11.0+ already needs `>=310`) |
| `ai` / `@ai-sdk/*` | re-check the hoot test fixtures — `ai>=6.0.280` runs tools only on `finishReason.unified`, and string mock chunks silently skip tool calls |
| `pywin32` | full agent suite **and** a real machine test — it is how the agent does services and COM, not an incidental dep |

### The check that makes it visible

Agent-side surface guards live in `agent/tests/unit/test_claude_agent_sdk_surface.py`: they
assert the symbols and `ClaudeAgentOptions` fields `agent/src` actually uses, against the real
installed SDK. The rest of the suite stubs the SDK out, so without them a breaking upgrade
passes every test and fails on a real machine the first time someone opens a hoot chat.

---

## Conventions & Review Discipline

### UI Copy Style
- **All user-facing copy is lowercase** — page titles, buttons, dialog headings, labels, descriptions, tooltips, placeholder text, empty-state copy, toasts. Match the voice of the rest of the UI.
- Exceptions (keep normal casing): proper nouns/product names in external contexts, acronyms (`LLM`, `API`, `URL`, `GPU`, `OAuth`), code identifiers, machine IDs / site IDs / user-entered strings, and legal/compliance text where casing is load-bearing.
- When adding new copy, default to lowercase. When editing existing strings, match the surrounding casing — don't mix sentence case into a lowercase screen or vice versa.

### Design System (shadcn/ui)
- `web/components/ui/*` are shadcn primitives **copied into the repo — we own them.** Editing them for theming, variants, hover/focus states, and standardization is the *intended* shadcn workflow (they're scaffolding you customize, not auto-generated black boxes — they've been hand-tuned before).
- Caveats when editing: changes are **app-wide**, so verify broadly; re-running `npx shadcn add <component>` **overwrites** that file, so port upstream fixes by hand; prefer CSS-variable tokens (`web/app/globals.css`) over hardcoded values.
- **`button.tsx` variants are the single source of truth for button styling.** Standardize there — don't sprinkle per-instance `hover:*`/`bg-*` overrides on individual `<Button>`s (that's how the styling diverged).

### Review Discipline (code review, security review, audits)
Reviews are judged on calibration, not volume. Three accurate findings are more valuable than twenty marginal ones, and inflated severities devalue every subsequent review on this codebase. Apply the following standard on every pass.

- **Establish current state before reviewing.** Read the last ~10 commits — particularly anything tagged `feat(security)`, `fix(security)`, or part of a hardening pass — and the diff for the branch under review. An issue already resolved upstream is not a finding; surfacing it as one signals that the review wasn't grounded in the current code.
- **Severity is a claim that must be substantiated.** A "critical" finding requires a written exploit path in three parts: the actor (unauthenticated attacker, authenticated user, insider with role X), the mechanism (specific request, payload, or sequence), and the outcome (RCE, data exfiltration, auth bypass, privilege escalation, integrity violation). If the path cannot be stated plainly, the finding is not critical — reclassify it.
- **Use the full severity ladder.** *Critical*: exploitable now with material impact. *High*: exploitable under realistic conditions or with a credible chain. *Medium*: defense-in-depth gap with no direct exploit. *Low*: hardening, style, or best-practice deviation. When uncertain between two rungs, choose the lower one and explain the uncertainty.
- **A clean review is a valid result.** When the change is sound, state that and stop. Padding a report with speculative or low-value findings to demonstrate effort is a quality failure, not thoroughness.
- **Theoretical risks belong in the backlog, not the report.** "An attacker could in principle…" without a concrete path is at most a low-severity hardening note, and frequently not worth filing. It is never critical.
- **Separate new findings from settled decisions.** If an issue has been triaged previously as accepted risk, won't-fix, or already-resolved, do not refile it as a discovery. If new evidence warrants revisiting the decision, say so explicitly, cite the prior commit or comment, and argue the reversal — don't present continuity as novelty.
- **Every finding cites evidence.** Reference the file and line, the specific code or config, and (where relevant) the call site that makes the path reachable. Findings without evidence are not actionable and should not be filed.

---

## Agent Dev Testing Workflow

The `deploy-agent.mjs` hook auto-copies edited `agent/src/*.py` files to `C:\ProgramData\Owlette\agent\src\`. Service files (`owlette_service.py`, `shared_utils.py`, `firebase_client.py`, `connection_manager.py`, `auth_manager.py`) require a restart. **Do this automatically** — don't wait for the user to ask.

The hook copies unelevated, so after each agent install it needs `powershell -File scripts/bootstrap-windows.ps1 -DevGrant` from an elevated prompt (the installer resets `agent\src`), which grants only the developer's own account Modify on `agent\src` and `app` (`-RemoveDevGrant` reverts it). While the grant is in place, the service logs a DevMode warning at every start.

### Restart sequence (order matters):
1. **Close the desktop app** (it holds the tray icon): kill the `owlette-desktop.exe` PID from `C:\ProgramData\Owlette\tmp\tray.pid` — by PID, never by image name.
2. **Restart service**: `powershell -Command "Start-Process cmd -ArgumentList '/c net stop OwletteService && net start OwletteService' -Verb RunAs -Wait"`
3. The service relaunches the desktop app itself on its next status check (`launch_desktop_app_as_user`) — only start it manually (`C:\ProgramData\Owlette\app\owlette-desktop.exe --tray`) if you don't want to wait.

The local UI is the Tauri app in `desktop/`, not python — `agent/src` has no GUI modules since 3.0.0. Desktop changes need a rebuild (`cd desktop && npx tauri build --no-bundle`) and a copy of the exe into `C:\ProgramData\Owlette\app\`; the deploy hook only mirrors `agent/src/*.py`.

---

## Task Workflow (GSD-Inspired)

For non-trivial features, use the wave-based planning and execution system. Each task runs in a fresh agent context to prevent context rot on long sessions.

### Planning
- `/plan` — Research codebase → create wave-based plan → write task files to `dev/active/`

### Execution (pick one)
- `/execute` — Run next wave of tasks in **parallel** (each task gets a fresh agent context — prevents context rot)
- `/next` — Execute the next single task in the current context (for smaller features or when you want to review each step)

### Verification & Lifecycle
- `/verify` — Check completed work against plan's success criteria + build check
- `/save` — Save progress to dev docs before context compaction
- `/resume` — Restore context in a new session from dev docs

### Debugging
- `/debug` — Scientific method debugging: observe → hypothesize → test → diagnose → fix → verify

### Build
- `/build-and-fix` — Build web + agent, fix all errors, repeat until clean

Skip `/plan` for single-file tweaks or small fixes. Use `/debug` for any non-obvious bug.

---

## Brevity

Write as if reporting to a supervisor who has two minutes. Lead with the answer, then only the
detail that changes a decision.

- No performance reviews, no ratings, no coaching.
- No preamble, no recap of what was just asked, no summary of what you are about to say.
- Bad news first and plainly: what broke, what is unverified, what you assumed.
- Prose over tables unless the data is genuinely tabular. Cut every sentence that does not carry
  new information.
- Length follows the question. A yes/no question gets a yes/no and one line of why.

---

**Last Updated**: 2026-09-25
