---
description: Pre-push gate — security alerts, lint, typecheck, unit tests, firestore rules tests, and the playwright e2e suite locally before pushing web changes
---

Run the same checks CI runs, locally, *before* pushing — so a red "playwright e2e" run on dev/main becomes rare. The local e2e suite is the exact mirror of CI (same Playwright tests against the same Firebase emulators), so green here means green there for everything except cold-cache / ubuntu-vs-Windows quirks.

Run this before any `git push` that touches `web/**`, `firestore.rules`, or `firebase.json`.

## Process

### Step 1: Security alerts (always run — 10s, needs `gh`)
```bash
node scripts/check-security-alerts.mjs
```
Resolves every open GitHub alert against **this branch's** lockfiles. Dependabot
files security alerts against `main`, which trails `dev`, so the raw alert list
is unreadable — this separates "still shipping here" from "already fixed on dev".

- **Exit 1 → DO NOT PUSH.** A `LIVE` or `UNRESOLVED` alert means the vulnerable
  version is pinned in this checkout. Fix it, dismiss it on GitHub with a written
  reason, or get the user's explicit acceptance and re-run with `--ack "<key>=<why>"`
  (a reason is mandatory; `verify:*` keys cannot be acked at all).
- `fixed here, still open on the default branch` warnings are the normal steady
  state on `dev`; report them, don't act on them.

### Step 2: Scope check
Determine whether the pending changes are in the e2e path filter (`web/**`, `firestore.rules`, `firebase.json`, `.github/workflows/e2e.yml`):
```bash
git status --porcelain
git diff --name-only @{u}..HEAD 2>/dev/null   # committed-but-unpushed, if upstream exists
```
- If **nothing** in scope touches web/firestore/firebase → e2e won't run in CI. Skip to Step 3 for lint/typecheck only, then report "no e2e needed".
- Otherwise continue through all steps.

### Step 3: Lint + typecheck (fast — always run)
```bash
cd web && npm run lint
```
```bash
cd web && npx tsc --noEmit
```
Fix every error/warning your changes introduced before proceeding (per CLAUDE.md "lint as you go").

### Step 4: Unit tests (fast)
```bash
cd web && npm test
```

### Step 5: Firestore rules tests (conditional)
Run these when the pending changes touch `firestore.rules` or `web/__tests__/rules/**` — they are the only regression gate on the security rules (115 tests across four files: baseline, denials, wave-hardening, and membership — the last covering per-site roles and the collectionGroup read path). CI runs them too, as the `firestore rules tests` job in `.github/workflows/e2e.yml`.
```bash
cd web && npm run test:rules
```
~2 min (boots its own firestore emulator on :8080, runs jest, tears it down). Run it BEFORE Step 6 and let it finish — it binds the same :8080 the e2e emulators want, so the two must not overlap. If nothing in scope touches the rules, skip it and say so in the report.

### Step 6: E2E suite (the authoritative gate)
This does the production build, spins up the emulators, and runs Playwright (~45s steady-state after the first build; the first run pays for `npm run build`). Run in the BACKGROUND with a generous timeout — don't block the session synchronously:
```bash
cd web && npm run e2e
```
Prereqs (already set up on this machine): JDK 21 on PATH, `firebase-tools@15` global, `npx playwright install chromium` done once. If the emulator ports (Auth :9099, Firestore :8080, Storage :9199) are busy, a stale emulator is the usual culprit — kill it by PID (never by name) and retry.

### Step 7: Report + gate
```
## Preflight
- Security:   [CLEAR/BLOCKED — N live, M warnings]
- Scope:      [e2e-relevant / web-only-no-e2e / out-of-scope]
- Lint:       [PASS/FAIL]
- Typecheck:  [PASS/FAIL]
- Unit tests: [PASS/FAIL — X passed]
- Rules:      [PASS/FAIL — X passed] (or "skipped — firestore.rules untouched")
- E2E:        [PASS/FAIL — X passed, Y failed] (or "skipped — no e2e-relevant changes")

Verdict: [SAFE TO PUSH / DO NOT PUSH]
```
- **All green** → say it's safe to push (don't push unless the user asked).
- **Any red** → DO NOT push. Show the failing output, diagnose the root cause, and propose a fix. The whole point of preflight is to fix it here, where the loop is 45s, instead of after a 6+ min CI round-trip on a branch that auto-deploys.

On failure, the Playwright HTML report + traces land in `web/e2e/.output/` — open `web/e2e/.output/report/` for the post-mortem.
