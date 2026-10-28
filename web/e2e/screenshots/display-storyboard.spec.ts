/**
 * Screenshot — display section storyboard. Writes
 * `web/public/landing-screens/displays-frame-{1,2,3}.png`, consumed by
 * `components/landing/DisplaySection.tsx`.
 *
 * The frames must be visually consistent — same site/machine ids, viewport and
 * monitor topology. Only the state differs:
 *   1. drift detected (displayDriftCount=2)
 *   2. apply in flight (remoteApply.scheduledAt = FIXED_NOW + 25s)
 *   3. ack received (lastAppliedAt set, drift cleared)
 *
 * Each `seedScreenshotFixtures` call fully resets and re-seeds the emulator,
 * which is what makes consecutive frames safe in one test; `cleanup()` runs
 * once in `finally` so later specs start clean.
 */
import { expect, type Page } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { getAdminDb } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import {
  FIXED_NOW_MS,
  seedScreenshotFixtures,
  type ScreenshotFixture,
  type ScreenshotScenario,
} from './fixtures';
import { test, themedPath } from './docs-helpers';

test.use(roleState('admin'));

const FRAMES: { scenario: ScreenshotScenario; output: string }[] = [
  { scenario: 'display-storyboard-frame-1', output: 'public/landing-screens/displays-frame-1.png' },
  { scenario: 'display-storyboard-frame-2', output: 'public/landing-screens/displays-frame-2.png' },
  { scenario: 'display-storyboard-frame-3', output: 'public/landing-screens/displays-frame-3.png' },
];

/** Re-applied per frame — navigation drops the previous style tag. */
async function disableAnimations(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
      }
    `,
  });
}

/**
 * Open the display panel via the list-view "view displays" button — the path
 * the access-control display-panel regression spec proves stable.
 */
async function openDisplayPanel(page: Page, machineId: string): Promise<void> {
  await page.getByTestId('view-toggle-list').click();
  const row = page.getByTestId('machine-row').filter({ hasText: machineId });
  await row.getByTestId('open-display-panel').click();
  await expect(page.getByTestId('display-layout-panel')).toBeVisible();
}

test('display section storyboard — three frames', async ({ page }) => {
  // Install BEFORE the first goto so the page's Date.now()/setInterval
  // callsites pick up the fake clock.
  await page.clock.install({ time: FIXED_NOW_MS });

  let ctx: ScreenshotFixture | undefined;

  try {
    for (const { scenario, output } of FRAMES) {
      // Each seed resets the emulator, so no cleanup() between frames.
      ctx = await seedScreenshotFixtures(scenario);

      // Pin lastSiteId so /dashboard picks the storyboard site over the
      // baseline `site-A`. Re-applied per frame — the reset zeroes it.
      await getAdminDb()
        .collection('users')
        .doc(TEST_USERS.admin.uid)
        .set({ lastSiteId: ctx.siteId }, { merge: true });

      await page.goto('/dashboard');
      await openDisplayPanel(page, ctx.machineId!);

      // Dashboard holds persistent firestore websockets, so the network never
      // idles — wait for paint instead (canvas render, banner, countdown).
    await page.waitForTimeout(1500);
      await disableAnimations(page);

      // Re-pin after navigation so hooks that captured Date.now() at mount see
      // the fixed anchor (e.g. the ack-banner countdown vs scheduledAt).
      await page.clock.setFixedTime(FIXED_NOW_MS);

      // Playwright auto-scrolled `open-display-panel` into view to click it and
      // the page stayed there, framing every frame mid-panel with the layout
      // card's header clipped off the top. The panel renders at the top of the
      // dashboard, so scroll back before each capture.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(300);

      await page.screenshot({ path: themedPath(output), fullPage: false });
    }
  } finally {
    if (ctx) {
      await ctx.cleanup();
    }
  }
});
