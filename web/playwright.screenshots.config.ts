import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the marketing screenshot pipeline. Separate from the
 * regression suite's config because:
 *   - testDir `./e2e/screenshots`
 *   - workers 1 — every scenario calls resetAndReseedBaseline, which clears the
 *     emulators, so parallel workers wipe each other's seed data
 *   - retries 0 — screenshot output must be deterministic
 *   - chromium-only, 1280×720 (previews sit in the landing card grid);
 *     `dashboard.spec.ts` overrides to 1920×1080 for the hero
 *   - one project per theme: `dark` writes `<name>.png`, `light` writes
 *     `<name>-light.png` beside it (`e2e/screenshots/themes.ts`)
 *
 * Specs write PNGs themselves into `web/public/landing-screens/` and
 * `web/public/docs-screens/`; `outputDir` below is only for incidental failure
 * artifacts. Reuses the regression suite's emulator boot + global-setup +
 * webServer, so the same fixtures apply.
 *
 * Run via its own npm script; not in CI by default.
 */

const PORT = Number(process.env.E2E_PORT) || 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const STORAGE_EMULATOR_HOST =
  process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199';
const NEXT_DIST_DIR = process.env.OWLETTE_NEXT_DIST_DIR || '.next-e2e';
const OUTPUT_DIR = process.env.E2E_SCREENSHOTS_OUTPUT_DIR || './e2e/.output/screenshots-results';

export default defineConfig({
  testDir: './e2e/screenshots',
  // Failure artifacts only — the PNGs go to public/landing-screens/ and public/docs-screens/.
  outputDir: OUTPUT_DIR,
  fullyParallel: false,
  forbidOnly: false,
  // Deterministic output: a silent retry with different pixels is worse than a
  // loud failure.
  retries: 0,
  workers: 1,
  reporter: [['list']],

  globalSetup: require.resolve('./e2e/global-setup'),
  globalTeardown: require.resolve('./e2e/global-teardown'),

  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    // Off: Playwright's failure screenshots would pollute the output dir.
    screenshot: 'off',
    video: 'off',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    viewport: { width: 1280, height: 720 },
  },

  // the project name is the theme the specs pin and the file suffix they write
  projects: (['dark', 'light'] as const).map((theme) => ({
    name: theme,
    use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 }, colorScheme: theme },
  })),

  webServer: {
    command: `node scripts/e2e-next-server.mjs --port ${PORT} --hostname 127.0.0.1`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      NEXT_PUBLIC_USE_FIREBASE_EMULATOR: 'true',
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-playwright-e2e',
      NEXT_PUBLIC_FIREBASE_API_KEY: 'demo-api-key',
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'demo-playwright-e2e.firebaseapp.com',
      NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: 'demo-playwright-e2e.firebasestorage.app',
      NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: '000000000000',
      NEXT_PUBLIC_FIREBASE_APP_ID: 'demo-app-id',
      NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: AUTH_EMULATOR_HOST,
      NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: FIRESTORE_EMULATOR_HOST,
      NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_HOST: STORAGE_EMULATOR_HOST,
      FIREBASE_AUTH_EMULATOR_HOST: AUTH_EMULATOR_HOST,
      FIRESTORE_EMULATOR_HOST,
      FIREBASE_STORAGE_EMULATOR_HOST: STORAGE_EMULATOR_HOST,
      FIREBASE_PROJECT_ID: 'demo-playwright-e2e',
      OWLETTE_NEXT_DIST_DIR: NEXT_DIST_DIR,
      SESSION_SECRET: 'demo-session-secret-for-emulator-playwright-tests-32chars',
      MFA_ENCRYPTION_KEY: 'demo-mfa-encryption-secret-for-playwright-only',
      NEXT_PUBLIC_SENTRY_DSN: '',
      UPSTASH_REDIS_REST_URL: '',
      UPSTASH_REDIS_REST_TOKEN: '',
      E2E_DISABLE_RATE_LIMIT: 'true',
      OWLETTE_E2E: '1',
    },
  },
});
