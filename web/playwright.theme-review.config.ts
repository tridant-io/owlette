import { defineConfig, devices } from '@playwright/test';
import screenshots from './playwright.screenshots.config';

/**
 * Theme review: captures every route in dark and light at desktop and phone width
 * for an eye review (light-mode plan, task 6.2). Review-only: not part of
 * `npm run e2e` or CI. Run with `npm run theme-review`; output lands in
 * e2e/.output/theme-review/<project>/<slug>.<theme>.png.
 */
export default defineConfig({
  ...screenshots,
  testDir: './e2e/theme-review',
  outputDir: './e2e/.output/theme-review-results',
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } },
    },
  ],
});
