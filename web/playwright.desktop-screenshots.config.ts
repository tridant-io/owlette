import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the desktop-app documentation screenshots
 * (`npm run screenshots:desktop`). Sibling to `playwright.config.ts` and
 * `playwright.screenshots.config.ts`, and the only one that never runs the web
 * app: no webServer, no emulators, no seeded users, and no browser launched —
 * the specs `connectOverCDP` to the installed `owlette-desktop.exe`'s WebView2
 * debug port and never touch the `page` / `browser` fixtures.
 *
 * workers: 1 and serial specs because there is one window and each scenario
 * overwrites the previous one's fixtures. retries: 0 — a screenshot that only
 * works on the second attempt is not reproducible.
 *
 * PNGs go straight to `web/public/docs-screens/` (referenced by
 * `content/docs/agent/*.mdx`); `outputDir` is only for failure artifacts.
 *
 * One project per theme, run against the same window: `dark` writes
 * `agent-*.png`, `light` switches the app to light and writes `agent-*-light.png`.
 *
 * Needs a real installed agent, so this is a release-time step, not CI — see
 * `.claude/skills/build-system/SKILL.md` → "Agent Installer Release".
 */

const OUTPUT_DIR =
  process.env.E2E_DESKTOP_SCREENSHOTS_OUTPUT_DIR || './e2e/.output/desktop-screenshots-results';

export default defineConfig({
  testDir: './e2e/desktop-screenshots',
  outputDir: OUTPUT_DIR,
  fullyParallel: false,
  forbidOnly: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],

  globalSetup: require.resolve('./e2e/desktop-screenshots/global-setup'),
  globalTeardown: require.resolve('./e2e/desktop-screenshots/global-teardown'),

  // Global setup does the slow part: launch, kill the old tray, await the port.
  globalTimeout: 10 * 60_000,
  timeout: 90_000,
  expect: { timeout: 15_000 },

  use: {
    trace: 'retain-on-failure',
    // Off: a failure screenshot would land among the deliberate captures.
    screenshot: 'off',
    video: 'off',
    actionTimeout: 15_000,
  },

  // the project name is the theme the spec switches the app to
  projects: [{ name: 'dark' }, { name: 'light' }],
});
