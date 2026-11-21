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
1. Runs `e2e:build` (`scripts/e2e-build.mjs`): a fresh `next build` into `.next-e2e` with the emulator config baked in
2. Starts the Firebase emulators (Auth :9099, Firestore :8080, Storage :9199)
3. Starts the Next.js server on :3100 (not :3000, so it coexists with `npm run dev`), and a second on :3101 with swoop network binding set to enforce
4. Runs global-setup (reset emulators → seed users + sites → capture storageState fixtures)
5. Runs the `chromium` project and the `mobile-chromium` project (`specs/mobile/` only, at 390x844) in serial (single worker, shared emulator state); `specs/functions/` and `specs/security-boundary/` are left out
6. Shuts everything down and writes the HTML report to `e2e/.output/report/`

Every run rebuilds: `e2e:build` clears `.next-e2e` first and `reuseExistingServer` is off. On a GitHub-hosted runner the suite alone takes about 27 minutes.

To open the HTML report after a run:

```bash
cd web && npx playwright show-report e2e/.output/report
```

## Fixtures

The four role fixtures (`e2e/fixtures/member.json`, `admin.json`, `superadmin.json`, `owner.json`) are
captured by `global-setup` at the start of every run and are **gitignored**. They hold
Firebase client auth state (cookies + IndexedDB). They are never committed.

To regenerate without running the full suite, run one spec the way `npm run e2e` does:

```bash
cd web && npm run e2e:build && cd .. && firebase emulators:exec --only auth,firestore,storage \
  --project demo-playwright-e2e "cd web && npx playwright test e2e/specs/smoke.spec.ts --project=chromium"
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
├── helpers/               — among them:
│   ├── emulator.ts        — Admin SDK init, emulator URLs, resetEmulators()
│   ├── roles.ts           — roleState() helper (storageState per role)
│   ├── seed.ts            — seedUser(), seedSite(), seedMachine(), seedRoost(), seedBaseline(), TEST_USERS
│   ├── stubAgent.ts       — completeCommand(), failCommand(), getPendingCommandIds(), stubRebootSuccess(), stubDeploymentTarget()
│   ├── mobile.ts          — assertNoHorizontalOverflow(), expectFullyWithinViewport()
│   └── swoopHost.ts       — a fake machine for swoop's media path
├── fixtures/              — gitignored; captured per-run by global-setup
├── specs/                 — COVERAGE.md maps each surface to its specs
│   ├── smoke.spec.ts
│   ├── a11y/              — serious/critical axe smoke per route, keyboard paths
│   ├── access-control/    — route guards, page header, machine card, display panel, user management
│   ├── account/           — profile, passkeys, preferences, password, theme, hoot model
│   ├── admin/             — installers, webhooks, schedules, alerts, tokens, email, issues, swoop
│   ├── admin-presets/     — system presets
│   ├── api-contracts/     — public API smoke and the public utility routes
│   ├── api-sprint/        — public API: chat, installers, machine commands, processes, members, users
│   ├── auth/              — signup, logout, password reset, app links
│   ├── dashboard/         — cards, list, metrics, process config round trip, release notes, submit issue
│   ├── dispatch/          — reboot, shutdown, kill-process, layouts, deployments, active hours
│   ├── functions/         — Cloud Functions triggers (`npm run e2e:functions` only)
│   ├── hoot/              — chat, machine menu, share
│   ├── landing/           — the landing page's sections
│   ├── logs/              — activity logs
│   ├── mfa/               — second-factor setup and verify, passkey factor, factor change, API gate
│   ├── mobile/            — the `mobile-chromium` project at 390x844
│   ├── onboarding/        — `/add`, CLI authorize, generate code
│   ├── plans/             — owlette free and billing
│   ├── public/            — public pages, docs links
│   ├── roosts/            — roosts, versions, rollback
│   ├── security-boundary/ — checks against live dev (`playwright.security-boundary.config.ts`, not part of `npm run e2e`)
│   ├── settings/          — API keys and webhooks
│   ├── sites/             — site pages, members, machine scope, hoot mcp settings
│   ├── swoop/             — sessions through the fake host, viewer, keys, network binding
│   ├── talons/
│   ├── time-travel/       — page.clock specs (clock-smoke, reboot-countdown, apply-deadline, heartbeat)
│   └── visual/            — nonblank visual smoke, button hover
├── screenshots/, videos/, theme-review/            — docs screenshots, docs videos, theme review (own configs)
└── desktop-screenshots/, desktop-videos/, desktop-sync/ — suites that drive the desktop app (own READMEs)
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
import { getPendingCommandIds, completeCommand } from '../../helpers/stubAgent';
// after the page has queued a command
const [cmdId] = await getPendingCommandIds('site-A', 'machine-id');
await completeCommand('site-A', 'machine-id', cmdId, { ok: true }, { cmdType: 'reboot' });
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

### Port already in use (:9099, :8080, :9199, :3100, :3101)

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

### Concurrent-agent port collision

If two Claude Code agents run `npm run e2e` simultaneously, the emulators try to bind
the same ports and one will fail to start. There is no lockfile guard yet (A3.6 deferred).
Run E2E from one agent at a time.

## CI

The suite runs in GitHub Actions via `.github/workflows/e2e.yml` on every PR and push
to `dev`/`main` that touches `web/**`, `functions/**`, `firestore.rules`,
`firestore.indexes.json`, `storage.rules`, `firebase.json`, the few files outside `web/`
its tests read (swoop's protocol vectors and keymap, `infra/cron-jobs.json`,
`scripts/env-manifest.json`), or the workflow itself. The same job then runs the Cloud
Functions trigger suite (`npm run e2e:functions:nobuild`), and a separate job runs the
Firestore rules tests. On failure, everything under `e2e/.output/` (HTML report, traces,
screenshots, videos) is uploaded as an artifact (`playwright-report`, 14-day retention).
