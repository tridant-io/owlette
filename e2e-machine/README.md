# Owlette Full-Machine E2E Harness

End-to-end testing of the **whole product on a real Windows machine** — empty box →
install → pair → drive the native GUI → observe on the live dashboard → send a command →
uninstall → assert clean removal. This is the slow, real-cloud, real-binary **release
gate**, complementary to (not a replacement for) the fast emulator-backed web suite in
[`web/e2e/`](../web/e2e/).

- **Why it exists**: some bug classes are invisible to every other layer. The `/ADD=`
  silent-pairing flow was broken for two months (a placeholder `machine_id` claim → rules
  403'd everything) and no emulator/unit test could catch it — only a real agent with a
  real token against real Firestore rules manifests it. That's what this gate runs.
- **Plan / tasks / context**: [`dev/completed/full-machine-e2e/`](../dev/completed/full-machine-e2e/)
  (`plan.md`, `tasks.md`, `context.md`).
- **Machine prep (canonical)**: [`docs/internal/gui-automation-machine-setup.md`](../docs/internal/gui-automation-machine-setup.md),
  with `scripts/bootstrap-gui-automation.ps1` as its executable validator.

## Status (2026-07-03)

| Wave | What | State |
|---|---|---|
| **0** | Headless-auth spike (prove pairing needs no human/browser) | ✅ **done — 10/10** (`wave0/RESULTS.md`) |
| **1** | Install + service + auth smoke (no GUI) | 🟡 **code built** (`wave1/run_wave1.py`) — awaiting first run on a clean, elevated box |
| 1.5 | Upgrade-in-place leg | ⏳ not started |
| 2 | GUI tier | ✗ removed 2026-09-06 — drove the CustomTkinter GUI deleted in 3.0.0 (OWL-46); Tauri-app coverage is a future CDP-based fleet leg |
| 3 | Dashboard observation + command round-trip | ⏳ not started |
| 4 | CI advisory gate on release tags | ⏳ not started |
| 5 | Promote to blocking + interactive-wizard leg | ⏳ not started |

**To run it all on your spare box, follow [`RUNBOOK.md`](RUNBOOK.md)** — clone, credentials,
provisioning, running Wave 0 + Wave 1, and how to continue the remaining waves. Wave 0 runs
anywhere today; Wave 1's controller is written (cloud helpers proven against dev) but its
install/uninstall stages await a first run on a clean box, which may need minor path tuning
(the runbook says exactly where).

## Setting up e2e testing on a new computer

### 1. Prerequisites

| Tool | Why |
|---|---|
| Git | clone the repo |
| Node.js ≥ 20 (see [`.nvmrc`](../.nvmrc)) | `firebase-admin` (seed/assert/teardown) + Playwright (Wave 3) |
| Python 3.x with `requests` | the agent-faithful poll (Wave 0) and the pytest controller (Wave 1+) |
| Windows 11 Pro x64 | the GUI tiers need a real interactive Windows desktop |

The agent's bundled Python (`C:\ProgramData\Owlette\python`) is the *preferred* interpreter
for the poll because it reproduces the agent's exact `requests`/User-Agent against
Cloudflare. If the agent isn't installed, the spike falls back to the capture-native venv
or system `python` (set `OWLETTE_AGENT_PY` to override).

### 2. Clone + install Node deps

```powershell
git clone https://github.com/tridant-io/owlette.git
cd owlette\web
npm ci --legacy-peer-deps    # provides firebase-admin (+ Playwright for later waves)
```

### 3. Prepare the machine (GUI-automation rigs)

For the GUI/install tiers (Wave 1+), provision the box per the canonical checklist and
validate it with the bootstrap script:

```powershell
# validate only (exit 1 on any rig-required failure -> usable as a run preflight):
.\scripts\bootstrap-gui-automation.ps1 -Rig E2eRunner
# apply the safe subset (power, screensaver, pinned venv, Defender exclusion):
.\scripts\bootstrap-gui-automation.ps1 -Rig E2eRunner -Apply
```

Manual steps it can't automate (autologon, Windows Update deferral, DPI, snapshots, runner
registration) are printed at the end and detailed in
[`docs/internal/gui-automation-machine-setup.md`](../docs/internal/gui-automation-machine-setup.md).
**Wave 0 alone does not need any of this** — it's pure HTTP + Firestore.

### 4. Credentials

Two dev credentials the spike reads at runtime. **Both are gitignored — a fresh clone does
NOT contain them; obtain them out-of-band** (from a maintainer / the secret store) and drop
them at these paths (never commit copies, never paste their contents):

- `agent/config/firebase-creds-dev.json` — dev Firebase service account (seed/assert/teardown).
- `web/.env.local` — supplies `NEXT_PUBLIC_FIREBASE_API_KEY` (dev web key). `cp web/env.example
  web/.env.local` and fill it per [docs/setup/firebase.md](../docs/setup/firebase.md), or copy an
  existing dev `.env.local`.

The spike **hard-pins** the dev project (`owlette-dev-3838a`) and aborts if the service
account resolves to anything else, so it can never touch prod.

### 5. Run the Wave 0 spike

```powershell
node e2e-machine\wave0\run_spike.mjs
```

Expected: `WAVE 0 RESULT: 10/10 stages passed`. It seeds a throwaway site-owner + e2e site
in dev, mints a `__session` cookie, generates + authorizes a pairing phrase, polls with the
agent's real Python to mint tokens, asserts the `agent_refresh_tokens` doc, then tears
everything down. See `wave0/RESULTS.md` for a full read of what each stage proves.

## Layout

```
e2e-machine/
├── README.md            ← you are here
├── RUNBOOK.md           ← spare-box setup + how to run/continue every wave
├── lib/                 ← shared cloud spine (Node + firebase-admin), reused by all waves
│   ├── admin.mjs        ← dev-pinned init, __session cookie mint, seed/probe/teardown
│   ├── preauthorize.mjs ← CLI: authorize a pairing phrase for the e2e site -> JSON
│   ├── probe.mjs        ← CLI: machine heartbeat + token state -> JSON (oracle source)
│   └── teardown.mjs     ← CLI: remove per-run (or --full) e2e cloud state
├── wave0/
│   ├── run_spike.mjs    ← headless-auth spike: cookie -> generate -> authorize -> poll -> assert -> teardown
│   ├── poll_agent.py    ← runs on the agent's Python; the faithful requests poll
│   └── RESULTS.md       ← the 2026-07-03 run (10/10) + verified contract facts
└── wave1/
    └── run_wave1.py     ← install controller: preflight -> preauth -> silent install -> compound
                            pairing oracle -> bootstrap/heartbeat -> uninstall -> clean-removal
```

Later waves add Playwright dashboard specs (Wave 3) and
the CI gate (Wave 4) — all reusing `lib/`. See `RUNBOOK.md` Part C.

## Safety model

- **Dev only.** Everything targets `dev.owlette.app` / `owlette-dev-3838a`; the spike aborts
  if the service account resolves to any other project.
- **Self-cleaning.** Every run tears down its seeded user, site, and token docs in a
  `finally` — verified clean after the 2026-07-03 run.
- **No live-agent impact.** The spike polls with a synthetic `machineId`; it never runs
  `configure_site.py`, so a paired agent's `.tokens.enc` on the same box is untouched.
