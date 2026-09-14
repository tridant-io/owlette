# Full-Machine E2E — Spare-Box Runbook

How to stand up the harness on your spare Windows box, run what exists (Wave 0 + Wave 1),
and continue building the remaining waves. Written so either you or an AI coding agent on
that box can follow it step by step.

> **Where things are**: plan/tasks/context = [`dev/completed/full-machine-e2e/`](../dev/completed/full-machine-e2e/) ·
> machine prep = [`docs/internal/gui-automation-machine-setup.md`](../docs/internal/gui-automation-machine-setup.md) ·
> harness code = this directory (`e2e-machine/`).

---

## Part A — one-time spare-box setup

### A1. Pull the repo + install prerequisites

```powershell
git clone https://github.com/tridant-io/owlette.git C:\Owlette-e2e
cd C:\Owlette-e2e
git checkout dev
```

Install (if missing): **Git**, **Node.js ≥ 20** ([`.nvmrc`](../.nvmrc)), **Python 3.x**. Then:

```powershell
cd C:\Owlette-e2e\web
npm ci --legacy-peer-deps      # provides firebase-admin (Wave 0/1) + Playwright (Wave 3)
```

### A2. Drop the two dev credentials (both gitignored — not in the clone)

Obtain from a maintainer / the secret store and place exactly here — never commit copies,
never paste their contents anywhere:

- `agent\config\firebase-creds-dev.json` — dev Firebase service account.
- `web\.env.local` — must contain `NEXT_PUBLIC_FIREBASE_API_KEY` (dev web key). Start from
  `web\env.example` and fill per [docs/setup/firebase.md](../docs/setup/firebase.md), or copy an
  existing dev `.env.local`.

Everything here **hard-pins the dev project** (`owlette-dev-3838a`) and aborts against
anything else, so the harness can never touch prod.

### A3. Provision the machine for GUI automation (needed from Wave 2 on)

```powershell
# validate (exit 1 on any E2eRunner-required gap; doubles as a preflight):
.\scripts\bootstrap-gui-automation.ps1 -Rig E2eRunner
# apply the safe subset (power, screensaver, the pinned pywinauto venv, etc.):
.\scripts\bootstrap-gui-automation.ps1 -Rig E2eRunner -Apply
```

Do the manual steps it prints (autologon, Windows Update deferral, DPI=100%, single
monitor) — full detail in [the machine-setup doc](../docs/internal/gui-automation-machine-setup.md).
**Wave 0 and the install/uninstall part of Wave 1 don't need this**; the GUI tier (Wave 2+)
does.

### A4. Take a golden snapshot (if the box is a VM)

With the machine provisioned and **no Owlette installed**, snapshot it. Snapshot revert is
the only true "back to empty" reset — silent uninstall deliberately preserves user data.
(Physical box: just ensure Owlette is uninstalled between runs.)

---

## Part B — run what exists today

### B1. Wave 0 — headless-auth sanity (~15s, no install, safe anywhere)

```powershell
cd C:\Owlette-e2e
node e2e-machine\wave0\run_spike.mjs
```

Expect `WAVE 0 RESULT: 10/10 stages passed`. This confirms the box can reach dev, the
credentials work, and headless pairing mints tokens. Run it first on any new box.

### B2. Wave 1 — fresh-install smoke (needs a clean, elevated box + an installer)

Get a signed installer EXE (from a GitHub release built by `build-installer.yml`, or the
Firebase Storage copy under `agent-installers/versions/{version}/`) onto the box, then from
an **elevated** PowerShell:

```powershell
cd C:\Owlette-e2e
python e2e-machine\wave1\run_wave1.py --installer C:\path\to\Owlette-Installer-vX.Y.Z.exe
```

It runs: preflight (refuses unless the box is empty + elevated + interactive) → pre-authorize
a phrase → silent install with `/ADD=` → **compound pairing oracle** (service RUNNING +
`.tokens.enc` + config bound to the e2e site + `Pairing exit code: 0` in the setup log —
*installer exit 0 is deliberately NOT trusted*) → service/heartbeat bootstrap → silent
uninstall → clean-removal asserts → cloud teardown. Expect all stages PASS.

Prove the oracle's teeth (exit-0 ≠ paired):

```powershell
python e2e-machine\wave1\run_wave1.py --installer <path> --negative
```

This installs with an invalid phrase; the run PASSES only if the harness correctly detects
that pairing did **not** happen despite the installer exiting 0.

> **First real run may need minor path tuning.** The install/uninstall stages were authored
> against the agent source but have not yet been executed on a clean box. If a stage-2/3
> oracle misfires, verify these against the running install and adjust the constants at the
> top of `run_wave1.py`:
> - `service_status.json` → `owlette_service.py` / `shared_utils.get_data_path('tmp/service_status.json')`
> - `service.log` → `owlette_service.py:LOG_FILE_PATH`
> - `.tokens.enc` → `secure_storage.py` (config dir vs root — both are checked)
> - config `site_id` field → `configure_site.py` `save_config`
> - uninstall registry key GUID → `owlette_installer.iss` `AppId`
>
> These are the exact "tune the oracles" tasks in `tasks.md` Wave 1 (1.6–1.7).

### B3. After a run

Snapshot-revert the VM (or confirm Owlette uninstalled). The harness tears down its dev
cloud state automatically; to wipe the persistent e2e site too: `node e2e-machine\lib\teardown.mjs --full`.

---

## Part C — how to continue the remaining waves

Each wave is a self-contained increment. Build in order; the cloud spine (`e2e-machine/lib/`)
and the Wave 1 controller are reused throughout. Hand an agent one wave at a time with its
`tasks.md` section.

### Wave 1.5 — upgrade-in-place leg
- **Needs**: a second golden snapshot with version **N-1 installed + paired**.
- **Build**: a variant that installs N over the N-1 snapshot and asserts the upgrade path
  (existing-install detected, synchronous service stop reached Stopped, pairing skipped,
  tokens/config preserved, service back on N + heartbeating). Also assert upgrade **with**
  `/ADD=` re-pairs. Exclude the N-1 snapshot's baked-in refresh token from teardown.
- Reuse `run_wave1.py`'s oracles; skip stage 0's empty-machine check.

### Wave 2 — GUI tier (REMOVED 2026-09-06 — it drove the CustomTkinter GUI deleted in 3.0.0; OWL-46)
- **Needs**: Part A3 provisioning done (pywinauto venv, DPI/theme pinned, interactive session).
- **Build**: an env-gated (`OWLETTE_E2E=1`), read-only tk-introspection shim in the GUI that
  writes widget rects to a side file (CustomTkinter widgets are invisible to UIAutomation);
  drive "add a monitored process" via pywinauto (reuse `dev/video-tutorials/capture-native/`
  helpers); assert the config round-trips to dev Firestore via `node probe.mjs`.
- Gate on "GUI pythonw present in the session" first (skip-vs-fail).

### Wave 3 — dashboard observation + command round-trip
- **Needs**: Playwright installed (Part A1).
- **Build**: a Playwright spec with a dev `storageState` fixture (mint it from the e2e owner
  cookie — reuse `lib/admin.mjs mintSessionCookie`) that opens the live dev dashboard, sees
  the machine online + the configured process, dispatches a command, and asserts the **real
  agent** completes it (`commands/completed`, pending cleared, PID changed). Add a
  `probe`-style Node helper for the command docs.

### Wave 4 — CI advisory gate (this is "auto-runs on every release")
- **Needs**: this box registered as a **self-hosted GitHub Actions runner running as the
  interactive autologon user, NOT as a service** (a service runner is Session 0 → no desktop;
  the bootstrap script's E2eRunner check fails loudly on this).
- **Build**: `release-e2e.yml` triggered off the `build-installer.yml` tag flow with
  `needs: [build, release]`, a `concurrency` group, snapshot-revert before/after, and
  artifact resolution by exact version (poll both the GitHub release asset and the Firebase
  Storage copy, fail closed). Wire the full `run_wave1.py` (+ later waves) as the job body;
  upload logs/screenshots. Keep it **advisory** (non-blocking) until flake data over ≥3
  releases justifies promotion.

### Wave 5 — promote to blocking + interactive-wizard leg
- Gate the **prod promotion/publish** step (not the tag build) on a green run. Add a
  visible-wizard leg driven by `capture-native/scenes/install_and_pair.py` against the signed
  installer. Write the runner ops notes (tscon session-preservation, WU pinning, image
  rebuild).

---

## Safety model (unchanged across waves)

- **Dev only.** Everything targets `dev.owlette.app` / `owlette-dev-3838a`; aborts otherwise.
- **Self-cleaning.** Cloud teardown runs in a `finally`; the box is uninstalled on the way out.
- **Empty-machine guard.** Wave 1 refuses to install over an existing agent — never point it
  at a machine you rely on.
- **No alert noise.** The e2e owner is seeded with all alerts OFF and the machine doc is torn
  down before the offline-alert cron's staleness window.
