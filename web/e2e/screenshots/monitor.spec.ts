/**
 * Screenshot — monitor capability card preview (api-sprint wave 4.3).
 *
 * Output `web/public/landing-screens/monitor.png`, for the landing page's monitor
 * capability card. Drives the `monitor-single-machine` scenario (one machine, a
 * 60-sample historical_metrics series) and opens the inline MetricsDetailPanel via the
 * CPU sparkline, which renders deterministic data from the seeded series.
 */
import { expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { getAdminDb } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import { FIXED_NOW_MS, seedScreenshotFixtures } from './fixtures';
import { test, themedPath } from './docs-helpers';

test.use(roleState('admin'));

test('monitor capability card preview', async ({ page }) => {
  const ctx = await seedScreenshotFixtures('monitor-single-machine');

  try {
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    // Pin the clock BEFORE goto so the historical-metrics sparkline x-axis
    // anchors to FIXED_NOW deterministically.
    await page.clock.install({ time: FIXED_NOW_MS });

    await page.goto('/dashboard');

    const card = page
      .getByTestId('machine-card')
      .filter({ hasText: ctx.machineId! });
    await expect(card).toBeVisible();

    // Open the inline MetricsDetailPanel via the CPU sparkline tile — the same path
    // onMetricClick wires up. Match the exact "cpu" tile label so we don't hit the CPU
    // model text or another "cpu"-containing string on the card.
    await card.getByText('cpu', { exact: true }).first().click();

    // The panel renders at page level above the machines list, not inside the card;
    // scroll back to the top so its header (tabs / time-range selector) is visible.
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));

    // dashboard has persistent firestore websockets — network never idles. wait for paint instead.
    await page.waitForTimeout(1500);

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

    await page.clock.setFixedTime(FIXED_NOW_MS);

    // Recharts mounts its SVGs async after the panel slides open; let the
    // sparkline finish painting before we capture pixels.
    await page.waitForTimeout(500);

    await page.screenshot({
      path: themedPath('public/landing-screens/monitor.png'),
      fullPage: false,
    });
  } finally {
    await ctx.cleanup();
  }
});
