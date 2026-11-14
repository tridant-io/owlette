import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the tutorial VIDEO-capture pipeline.
 *
 * Sibling of `playwright.screenshots.config.ts` — same emulator boot, global-setup,
 * webServer block and seeded demo fleet. Differences: testDir `./e2e/videos` matching
 * `*.video.ts`, a 1920×1080 viewport for a 1080p timeline, and serial with retries:0.
 *
 * Each scene file creates its own context with `recordVideo` (`recordScene()` in
 * `e2e/videos/video-helpers.ts`) and names the .webm after the episode/scene; clean
 * files land in `e2e/.output/videos/`.
 *
 * Triggered explicitly by `npm run videos`; never in CI.
 */

const PORT = Number(process.env.E2E_PORT) || 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const STORAGE_EMULATOR_HOST =
  process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199';
const NEXT_DIST_DIR = process.env.OWLETTE_NEXT_DIST_DIR || '.next-e2e';
const OUTPUT_DIR = process.env.E2E_VIDEOS_OUTPUT_DIR || './e2e/.output/videos-results';

/**
 * WebAuthn RP override for episode 2's passkey beats. Honored by
 * `lib/webauthn.server.ts` only while `OWLETTE_E2E === '1'`; without it the
 * production build signs ceremonies for RP `owlette.app` + https origins and no
 * loopback ceremony can complete. `localhost`, not BASE_URL's `127.0.0.1` — an
 * IP literal is not a valid RP ID, which is also why that scene navigates on
 * `WEBAUTHN_BASE_URL` (`e2e/helpers/webauthn.ts:10-14`).
 *
 * Written back onto THIS process as well as the webServer's: 02-day-zero's
 * precondition guard reads `process.env` in the test runner, so a webServer-only
 * block would still throw before the scene records a frame. Mirrors
 * `playwright.config.ts`'s webServer values so the two suites agree.
 */
const WEBAUTHN_RP_ID = process.env.WEBAUTHN_RP_ID || 'localhost';
const WEBAUTHN_ORIGINS = process.env.WEBAUTHN_ORIGINS || `http://localhost:${PORT}`;
process.env.WEBAUTHN_RP_ID = WEBAUTHN_RP_ID;
process.env.WEBAUTHN_ORIGINS = WEBAUTHN_ORIGINS;

export default defineConfig({
  testDir: './e2e/videos',
  testMatch: /\.video\.ts$/,
  outputDir: OUTPUT_DIR,
  fullyParallel: false,
  forbidOnly: false,
  retries: 0,
  workers: 1,
  // Generous timeout — scenes deliberately dwell (narration gaps) and can run minutes.
  timeout: 5 * 60_000,
  reporter: [['list']],

  globalSetup: require.resolve('./e2e/global-setup'),
  globalTeardown: require.resolve('./e2e/global-teardown'),

  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'off',
    // Scenes record via an external ffmpeg subprocess (see e2e/videos/ffmpeg-recorder.ts);
    // Playwright's built-in video is off so we don't get a parallel downscaled VP8.
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
    // viewport: null — chromium honors the explicit --window-size launch arg below.
    viewport: null,
    colorScheme: 'dark',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        // Explicit viewport: Playwright resizes the window so the page's inner content
        // is EXACTLY 1920×1080 whatever the chrome UI height; recordScene measures the
        // chrome offset at runtime for ffmpeg's ddagrab region, so frames contain page
        // content only. Chromeless via flags isn't reliable — --kiosk lands in an
        // exclusive-presentation path DXGI can't capture, --start-fullscreen is
        // overridden by --window-size, and --app= doesn't compose with newContext().
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
        launchOptions: {
          headless: false,
          // Drop `--enable-automation` so Chromium doesn't paint the "controlled by
          // automation" banner across every frame.
          ignoreDefaultArgs: ['--enable-automation'],
          args: [
            // Room for the chrome UI above the 1080p content; Playwright resizes so
            // inner === 1920×1080, keeping the chrome within the first ~120px.
            '--window-position=0,0',
            '--window-size=1920,1200',
            '--force-device-scale-factor=1',
            '--force-color-profile=srgb',
            '--disable-blink-features=AutomationControlled',
            // Quiet things that would otherwise paint over the page mid-capture:
            '--disable-notifications',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            '--disable-features=TranslateUI',
          ],
        },
      },
    },
  ],

  webServer: {
    command: `node scripts/e2e-next-server.mjs --port ${PORT} --hostname 127.0.0.1`,
    url: BASE_URL,
    reuseExistingServer: false,
    // 3 minutes, not the E2E suite's 60s. Recording sessions run on a
    // workstation that is also driving the capture display (and often the
    // operator's own dev servers), and a cold Next production start there
    // intermittently crosses 60s — four takes in one batch died on the boot
    // budget alone, each costing a full re-run. The timeout only bounds a
    // hang; a healthy server still starts in ~10s and the suite proceeds.
    timeout: 180_000,
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
      WEBAUTHN_RP_ID,
      WEBAUTHN_ORIGINS,
      // The build bakes the always-pass Turnstile TEST sitekey
      // (scripts/e2e-build.mjs), so the SERVER needs the matching test secret
      // or /api/users/bootstrap fails closed with 403 and a fresh signup never
      // gets its requiresMfaSetup gate. Mirrors playwright.config.ts:154-155;
      // the hostname list already admits localhost, which this suite runs on.
      TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
      TURNSTILE_HOSTNAMES: 'example.com,localhost,127.0.0.1',
    },
  },
});
