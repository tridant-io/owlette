/**
 * Screenshot — dashboard capability card preview (api-sprint wave 4.3).
 *
 * Output: `web/public/landing-screens/dashboard.png`, used by the landing hero /
 * dashboard capability card (wired up in wave 4.5).
 *
 * Drives the `dashboard-mixed-states` scenario (10 machines: running / alerting /
 * offline), flips to list view — denser and more legible at
 * page-hero scale — and captures.
 */
import { expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { getAdminDb } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import { FIXED_NOW_MS, seedScreenshotFixtures } from './fixtures';
import { test, themedPath } from './docs-helpers';

// Hero shot at 1920×1080 rather than the 1280×720 capability-preview default:
// it is the LCP asset and gets a 3D-tilt treatment in the value-prop section,
// and the wider frame keeps table content near full width without wasted margin.
test.use({ ...roleState('admin'), viewport: { width: 1920, height: 1080 } });

test('dashboard capability card preview', async ({ page }) => {
  const ctx = await seedScreenshotFixtures('dashboard-mixed-states');

  try {
    // Pin lastSiteId so /dashboard auto-selects the screenshot site, not the
    // baseline `site-A` this admin is also assigned to. Collapse the per-machine
    // process panels too — seedUser defaults to `processesExpanded: true`, but the
    // hero shot wants tight, scannable single rows.
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .update({ 'preferences.processesExpanded': false });

    // Pin the clock BEFORE goto so any "x minutes ago" / heartbeat-age text
    // resolves against FIXED_NOW.
    await page.clock.install({ time: FIXED_NOW_MS });

    await page.goto('/dashboard');

    // Wait for the default card grid to render so we know the dashboard is
    // populated, then flip to list view for the hero screenshot.
    await expect(page.getByTestId('machine-card')).toHaveCount(10);
    await page.getByTestId('view-toggle-list').click();
    await expect(page.getByTestId('machine-row')).toHaveCount(10);

    // Let late paint (sparkline series, metric badges) settle. Persistent firestore
    // websockets mean the network never idles — wait for paint, not for idle.
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

    // Re-pin Date.now() after navigation so any hook that captured it at
    // mount has the fixed anchor on its next render tick.
    await page.clock.setFixedTime(FIXED_NOW_MS);

    // Sparkline charts read historical_metrics asynchronously; give them a
    // beat to paint after networkidle.
    await page.waitForTimeout(500);

    await page.screenshot({
      path: themedPath('public/landing-screens/dashboard.png'),
      fullPage: false,
    });
  } finally {
    await ctx.cleanup();
  }
});
