import { defineConfig, devices } from '@playwright/test';

/**
 * Runs the web app against Firebase emulators (Auth + Firestore + Storage) on
 * non-default ports so it coexists with `npm run dev` on :3000.
 * Strategy: dev/active/playwright-e2e/plan.md.
 */

const PORT = Number(process.env.E2E_PORT) || 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const IS_CI = !!process.env.CI;
const AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const STORAGE_EMULATOR_HOST =
  process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199';
const NEXT_DIST_DIR = process.env.OWLETTE_NEXT_DIST_DIR || '.next-e2e';
const OUTPUT_DIR = process.env.E2E_OUTPUT_DIR || './e2e/.output/results';
const REPORT_DIR = process.env.E2E_REPORT_DIR || './e2e/.output/report';

export default defineConfig({
  testDir: './e2e/specs',
  // security-boundary probes need real dev credentials; keep this suite emulator-only
  // `functions/**` needs the functions emulator, which only `npm run
  // e2e:functions` starts — the main suite deliberately runs without it.
  testIgnore: ['**/security-boundary/**', '**/functions/**'],
  // keeps Playwright's two default output dirs out of the top of web/
  outputDir: OUTPUT_DIR,
  fullyParallel: false, // shared emulator state; serial keeps seeding deterministic
  forbidOnly: IS_CI,
  retries: IS_CI ? 2 : 0,
  workers: 1, // emulator-seeded state can't be parallel-shared yet
  reporter: IS_CI
    ? [['list'], ['html', { open: 'never', outputFolder: REPORT_DIR }], ['github']]
    : [['list'], ['html', { open: 'never', outputFolder: REPORT_DIR }]],

  globalSetup: require.resolve('./e2e/global-setup'),
  globalTeardown: require.resolve('./e2e/global-teardown'),

  // Must match actionTimeout: left at Playwright's 5s default, hydration races on
  // auth-gated pages tripped the ceiling in ~40 specs that had action headroom.
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // cold-emulator auth + Firestore roundtrips need more than the default
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      // A project-level testIgnore REPLACES the config-level one rather than
      // merging, so security-boundary must be repeated here.
      testIgnore: ['**/security-boundary/**', '**/mobile/**', '**/functions/**'],
    },
    {
      // Chromium, not an iPhone device entry: those pin webkit and CI installs
      // chromium only. An explicit 390x844 touch viewport covers the same surface.
      name: 'mobile-chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
      },
      // Scoped so workers:1 doesn't pay for a second full pass. Playwright
      // normalizes to forward slashes, so this matches on Windows too.
      testMatch: /mobile\/.*\.spec\.ts/,
    },
    {
      // Cloud Functions trigger integration. Separate project because these
      // are the only specs that need the `functions` emulator, and enabling it
      // for the whole suite is not free: onMetricsWrite fires on EVERY machine
      // doc write, so metrics_history accretes across all ~346 specs and the
      // emulator slows as the run proceeds. That pushed
      // time-travel/apply-ack-before-deadline past its 10s action timeout —
      // a spec that passes in 7-8s alone. Isolating them keeps the main gate
      // unperturbed and this run down to ~40s.
      name: 'functions-triggers',
      use: { ...devices['Desktop Chrome'] },
      // A project-level testIgnore REPLACES the config-level one (same gotcha
      // the chromium project documents). Without this override the project
      // inherits the config's '**/functions/**' ignore and matches nothing,
      // which playwright reports as a bare "No tests found".
      testIgnore: ['**/security-boundary/**'],
      testMatch: /functions\/.*\.spec\.ts/,
    },
  ],

  // Env vars here drive the emulator branches in web/lib/firebase.ts and
  // firebase-admin.ts — without them the app hits real Firebase.
  webServer: {
    // Not `next dev`: Next 16 + Turbopack refuses a second `next dev` in the same
    // project dir even on another port. The wrapper serves the production build,
    // with .next/static served directly to dodge rare Windows long-suite 500s.
    command: `node scripts/e2e-next-server.mjs --port ${PORT} --hostname 127.0.0.1`,
    url: BASE_URL,
    // a reused server can serve HTML referencing chunks the last e2e:build deleted
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      // client-side: gates connectXEmulator() in web/lib/firebase.ts
      NEXT_PUBLIC_USE_FIREBASE_EMULATOR: 'true',
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-playwright-e2e',
      NEXT_PUBLIC_FIREBASE_API_KEY: 'demo-api-key', // emulator accepts anything non-empty
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'demo-playwright-e2e.firebaseapp.com',
      NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: 'demo-playwright-e2e.firebasestorage.app',
      NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: '000000000000',
      NEXT_PUBLIC_FIREBASE_APP_ID: 'demo-app-id',
      NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: AUTH_EMULATOR_HOST,
      NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: FIRESTORE_EMULATOR_HOST,
      NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_HOST: STORAGE_EMULATOR_HOST,
      // server-side: emulator branch in web/lib/firebase-admin.ts
      FIREBASE_AUTH_EMULATOR_HOST: AUTH_EMULATOR_HOST,
      FIRESTORE_EMULATOR_HOST,
      FIREBASE_STORAGE_EMULATOR_HOST: STORAGE_EMULATOR_HOST,
      FIREBASE_PROJECT_ID: 'demo-playwright-e2e',
      OWLETTE_NEXT_DIST_DIR: NEXT_DIST_DIR,
      // iron-session needs 32+ chars
      SESSION_SECRET: 'demo-session-secret-for-emulator-playwright-tests-32chars',
      MFA_ENCRYPTION_KEY: 'demo-mfa-encryption-secret-for-playwright-only',
      NEXT_PUBLIC_SENTRY_DSN: '',
      // Empty strings short-circuit the init block in web/lib/rateLimit.ts. Without
      // this the webServer inherits UPSTASH_* from .env.local and global-setup's
      // three back-to-back sign-ins blow the 10/min per-IP auth-session limit.
      UPSTASH_REDIS_REST_URL: '',
      UPSTASH_REDIS_REST_TOKEN: '',
      // In-memory limiter too (15/min per IP): back-to-back admin-API specs hit it
      // and 429 on contracts unrelated to the test. Production ignores this var.
      E2E_DISABLE_RATE_LIMIT: 'true',
      // Makes r2Client.server.ts:hasChunk() read the seeded Firestore
      // `siteChunks/{digest}` rows instead of a real R2 HeadObject — required by
      // any spec that runs POST /versions through the real finalize handler.
      OWLETTE_E2E: '1',
      // RP override honored by webauthn.server.ts only when OWLETTE_E2E==='1':
      // the production build would otherwise use RP 'owlette.app' + https origins
      // and no loopback ceremony could complete. 'localhost', not BASE_URL's
      // 127.0.0.1 — an IP literal is not a valid RP ID (see e2e/helpers/webauthn.ts).
      WEBAUTHN_RP_ID: 'localhost',
      WEBAUTHN_ORIGINS: `http://localhost:${PORT}`,
      // Cloudflare's always-pass test keys, so specs run the REAL
      // verifyTurnstileToken() path rather than a bypass flag. The dummy secret
      // answers hostname "example.com" and omits `action` — hence the allowlist
      // entry and the `result_with_testing_key` branch in lib/turnstile.server.ts.
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
      TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
      TURNSTILE_HOSTNAMES: 'example.com,localhost,127.0.0.1',
      // Neutralised, not inherited. A developer's .env.local carries a REAL
      // Resend key; without this the suite builds a live client and
      // /api/auth/forgot-password actually tries to mail
      // password-reset-test@e2e.test, which Resend rejects -> 500 -> two tests
      // fail locally while CI (no .env.local, so no key) stays green. Empty is
      // the CI shape: getResend() returns null and the route still answers 200.
      RESEND_API_KEY: '',
    },
  },
});
