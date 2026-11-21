import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * Bidirectional desktop↔web config sync (`npm run e2e:desktop-sync`).
 *
 * Unlike every other config here, a REAL AGENT PROCESS runs for the whole
 * session: `python owlette_runner.py` against a scratch `%PROGRAMDATA%` in the
 * OS temp dir, holding an Auth-emulator token with agent claims and writing
 * through the real `firestore.rules`. That is the point — this is the only suite
 * where the agent is a participant rather than a mock.
 *
 * `webServer` and `use` are taken from `playwright.config.ts` rather than
 * restated: the emulator env block there is long, load-bearing, and must not
 * fork. Everything else differs, so nothing else is inherited.
 *
 * Two projects:
 * - `tier0` runs headless and proves the loop closes. It needs no desktop binary.
 * - `tier1-desktop` drives the app itself and SKIPS unless OWLETTE_DESKTOP_EXE
 *   names a build. it refuses to run beside a process with that build's image
 *   name that it did not start — see `e2e/desktop-sync/README.md`.
 *
 * workers: 1 and retries: 0 — one agent, one window, one emulator, and a sync
 * that only works on the second attempt is a bug worth seeing.
 */

const OUTPUT_DIR = process.env.E2E_DESKTOP_SYNC_OUTPUT_DIR || './e2e/.output/desktop-sync-results';
const REPORT_DIR = process.env.E2E_DESKTOP_SYNC_REPORT_DIR || './e2e/.output/desktop-sync-report';

export default defineConfig({
  testDir: './e2e/desktop-sync',
  outputDir: OUTPUT_DIR,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: REPORT_DIR }]],

  globalSetup: require.resolve('./e2e/desktop-sync/global-setup'),
  globalTeardown: require.resolve('./e2e/desktop-sync/global-teardown'),

  // Global setup does the slow part: base seed, sandbox, token, agent connect.
  globalTimeout: 15 * 60_000,
  timeout: 120_000,
  // Specs poll with their own budgets (see fixtures.ts BUDGET); this is only the
  // ceiling for the ordinary assertions around them.
  expect: { timeout: 15_000 },

  use: {
    ...base.use,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  // Same production build, same emulator env as the main suite. Required even
  // for tier0: the agent's health probe and network gate dial `api_base`, which
  // points at this server.
  webServer: base.webServer,

  projects: [
    {
      name: 'tier0',
      testMatch: /tier0-.*\.spec\.ts/,
    },
    {
      name: 'tier1-desktop',
      testMatch: /(desktop-to-web|web-to-desktop|missing-path-warning)\.spec\.ts/,
      dependencies: ['tier0'],
    },
  ],
});
