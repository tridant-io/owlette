# Playwright E2E Test Suite

End-to-end tests for the Owlette web dashboard, running against Firebase emulators.

## Prerequisites

| Dependency | Version | Why |
|---|---|---|
| JDK 21 | exact pin | Firestore emulator requires JVM; 21 matches the CI pin |
| Node.js | 22.x | matches `engines` in `web/package.json` and CI |
| firebase-tools | 15.x | `npm i -g firebase-tools@15` — invoked bare from the repo root. 13.x CANNOT run the functions emulator against firebase-functions 7: its runtime shim calls the removed `functions.config()` and the worker is killed on every invocation |
| Playwright | managed by `npm ci` | browsers installed separately (see below) |

Install Playwright's Chromium browser once (re-run after any `@playwright/test` version bump):

```bash
cd web && npx playwright install chromium --with-deps
```

## Running locally

```bash
cd web
npm run e2e
```

This single command:
1. Runs `next build` (production build required for `next start`)
2. Starts the Firebase emulators (Auth :9099, Firestore :8080, Storage :9199)
3. Starts the Next.js server on :3100 (not :3000, so it coexists with `npm run dev`)
4. Runs global-setup (reset emulators → seed users + sites → capture storageState fixtures)
5. Runs all specs in serial (single worker, shared emulator state)
6. Shuts everything down and writes the HTML report to `e2e/.output/report/`

Cold run (including build): ~5–6 min. Warm rerun (skipping build via `reuseExistingServer`): ~2–3 min.

To open the HTML report after a run:

```bash
cd web && npx playwright show-report e2e/.output/report
```

## Fixtures

The three role fixtures (`e2e/fixtures/member.json`, `admin.json`, `superadmin.json`) are
captured by `global-setup` at the start of every run and are **gitignored**. They hold
Firebase client auth state (cookies + IndexedDB). They are never committed.

To regenerate without running the full suite:

```bash
cd web && npx next build && npx firebase emulators:exec --project demo-playwright-e2e \
  "npx playwright test --list" 2>/dev/null || true
```

Or just run `npm run e2e` — global-setup always regenerates them fresh (it resets the
emulators first, then re-seeds, then re-captures).

**Do not share fixture files between machines.** They contain emulator session tokens valid
only for the local process that generated them.

## Structure

```
web/e2e/
├── global-setup.ts        — emulator reset + seed + storageState capture
├── global-teardown.ts     — cleanup
├── helpers/
│   ├── emulator.ts        — Admin SDK init, emulator URLs, resetEmulators()
│   ├── roles.ts           — roleState() helper (storageState per role)
│   ├── seed.ts            — seedUser(), seedMachine(), seedBaseline(), TEST_USERS
│   └── stubAgent.ts       — stubCommand(), completeCommand(), stubDeploymentTarget()
├── fixtures/              — gitignored; captured per-run by global-setup
└── specs/
    ├── smoke.spec.ts
    ├── access-control/    — route guards, page header, machine card, display panel
    ├── auth/              — login, logout, signup
    ├── sites/             — CRUD + access defaults
    ├── admin/             — installers, webhooks, schedules, alerts, tokens, email
    ├── account/           — profile, passkeys, preferences, password
    ├── dispatch/          — reboot, shutdown, kill-process, recall-layout, deployment, rollback
    └── time-travel/       — page.clock specs (clock-smoke, reboot-countdown, apply-deadline, heartbeat)
```

## Spec conventions

### Role setup

```ts
import { roleState } from '../../helpers/roles';
test.use(roleState('admin')); // pre-authenticated as admin
```

Or for unauthenticated:

```ts
test.use({ storageState: { cookies: [], origins: [] } });
```

### Seeding test data

```ts
import { seedMachine } from '../../helpers/seed';
await seedMachine('site-A', 'machine-id');
```

### Stubbing the agent

```ts
import { stubCommand, completeCommand } from '../../helpers/stubAgent';
const cmdId = await stubCommand('site-A', 'machine-id', { type: 'reboot', ... });
await completeCommand('site-A', 'machine-id', cmdId);
```

### page.clock (time-travel specs)

Always install the clock **before** `page.goto()`, anchored to the real `Date.now()`:

```ts
await page.clock.install({ time: Date.now() });
await page.goto('/dashboard');
await page.clock.fastForward(30_000);
```

Never use `pauseAt`. Never use a fixed past timestamp as the anchor — Firebase Auth's
`onAuthStateChanged` relies on real wall-clock timing and will stall if the fake clock
is in the distant past.

## Common failures

### "timed out waiting for Auth emulator"

JDK is missing or not on PATH. Verify: `java -version`. Install Temurin 21 from
[adoptium.net](https://adoptium.net) and ensure `java` is on your PATH.

### "timed out waiting for web server"

A previous `next build` is stale or broken. Run `cd web && npm run build` manually
to see the build error, fix it, then re-run `npm run e2e`.

### Port already in use (:9099, :8080, :3100)

A previous run didn't clean up. Kill orphan processes:

```bash
# Firestore / Auth emulators (Java)
taskkill /F /FI "IMAGENAME eq java.exe"

# Next.js server on :3100
npx kill-port 3100
```

### Login timed out in global-setup

global-setup logs screenshots + HTML to `e2e/debug/login-failure-{role}.png` on failure.
Common causes:
- Rate limiter still active (ensure `E2E_DISABLE_RATE_LIMIT=true` is threaded through `playwright.config.ts`)
- Auth emulator not yet seeded (global-setup runs `seedBaseline` before sign-in — check the emulator console)

### Fixtures corrupt / "user-menu-trigger" timeout across many specs

This is the password-spec fixture-isolation failure mode. One spec changed the shared
fixture user's password, revoking Firebase tokens globally. The fix is already in place:
`specs/account/password.spec.ts` uses a dedicated `password-test-user` and never touches
`TEST_USERS.member`. If you see this pattern again, grep for `TEST_USERS.member` in any
spec that mutates auth state.

### "valid body lands on the not-implemented stub (503)" — rollback spec

`specs/dispatch/rollback-manifest.spec.ts` has one case marked partial (`[~]`) pending
roost wave 2a.6 implementation. The handoff note is at
`dev/active/project-distribution-v2/handoff-rollback-e2e.md`. All other cases in that
file pass.

### Concurrent-agent port collision

If two Claude Code agents run `npm run e2e` simultaneously, the emulators try to bind
the same ports and one will fail to start. There is no lockfile guard yet (A3.6 deferred).
Run E2E from one agent at a time.

## CI

The suite runs in GitHub Actions via `.github/workflows/e2e.yml` on every PR and push
to `dev`/`main` that touches `web/**`, `firestore.rules`, `firebase.json`, or the
workflow itself. On failure, the HTML report + traces are uploaded as an artifact
(`playwright-report`, 14-day retention).
