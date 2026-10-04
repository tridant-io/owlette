import { defineConfig, devices } from '@playwright/test';

/**
 * Live dev smoke suite: a real browser against https://dev.owlette.app and Firebase project
 * owlette-dev-3838a (plan: dev/active/live-smoke/plan.md). Run it with `npm run smoke:dev`
 * (e2e-live/run.mjs), which first waits for dev to serve the commit under test and starts the
 * stub agent.
 *
 * Unlike playwright.config.ts there is no webServer and no emulator env: every request goes to
 * live dev. Global setup seeds the smoke site and users and signs each role in once; global
 * teardown removes what the run created.
 */

/**
 * The only host this config may target. A literal rather than devAdmin.mjs's DEV_ORIGIN: the
 * config loads before build.external (below) applies, so it cannot import an .mjs file. Global
 * setup checks that the two agree before it seeds anything.
 */
const REQUIRED_HOST = 'dev.owlette.app';
const DEV_ORIGIN = `https://${REQUIRED_HOST}`;

const config = defineConfig({
  testDir: './e2e-live/specs',
  // The harness libraries are plain ESM shared with node CLIs (run.mjs, lib/seed.mjs, the stub
  // agent). Playwright's loader would compile them to CommonJS, which Node 22 then runs as ESM
  // and fails on ("exports is not defined in ES module scope"); left alone, Node loads them as-is.
  build: { external: ['**/e2e-live/**/*.mjs'] },
  // Siblings, not nested: Playwright empties outputDir when a run starts, and the html reporter
  // flags a report folder inside it as a clash. run.mjs keeps the stub's command log beside
  // them in e2e-live/.output/, out of both.
  outputDir: './e2e-live/.output/results',
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: './e2e-live/.output/report' }],
    // run.mjs prints its per-test summary from this file, pinning the path with PLAYWRIGHT_JSON_OUTPUT_FILE.
    ['json', { outputFile: './e2e-live/.output/report.json' }],
  ],
  globalSetup: './e2e-live/global-setup.ts',
  globalTeardown: './e2e-live/global-teardown.ts',
  // Shared test users and one stub machine: one test at a time.
  fullyParallel: false,
  workers: 1,
  retries: 1,
  // A release gate: a stray test.only would silently skip every other check.
  forbidOnly: true,
  // A hoot turn runs a real LLM and a tool relay.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: DEV_ORIGIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    // the app follows the os colour scheme; the live smoke pins dark like the e2e suite
    colorScheme: 'dark',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

/** Throws unless every baseURL this config can hand a test is https on REQUIRED_HOST. */
function assertDevOnly(cfg: typeof config): void {
  if (cfg.use?.baseURL === undefined) {
    throw new Error('ABORT: playwright.live.config.ts sets no use.baseURL');
  }
  const baseUrls = [
    { where: 'use.baseURL', value: cfg.use.baseURL },
    // A project that sets none inherits use.baseURL.
    ...(cfg.projects ?? []).map((project, i) => ({ where: `projects[${i}].use.baseURL`, value: project.use?.baseURL })),
  ];
  for (const { where, value } of baseUrls) {
    if (value === undefined) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`ABORT: playwright.live.config.ts ${where} is not an absolute URL`);
    }
    if (url.protocol !== 'https:' || url.host !== REQUIRED_HOST) {
      throw new Error(
        `ABORT: playwright.live.config.ts ${where} is ${url.origin}; the live smoke suite only ever targets https://${REQUIRED_HOST}`,
      );
    }
  }
}

assertDevOnly(config);

export default config;
