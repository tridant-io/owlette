/**
 * Screenshot — display capability card preview.
 * Output: `web/public/landing-screens/preview-displays.png`
 * Used by: `components/landing/UseCaseSection.tsx`.
 *
 * Drives the display layout panel into a 4-monitor 2×2 mosaic and captures it.
 * The UI flow (list view → "view displays" → panel) mirrors
 * `e2e/specs/access-control/display-panel.spec.ts` because that path is already
 * proven stable by the regression suite.
 */
import { expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { getAdminDb } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import { FIXED_NOW_MS, seedScreenshotFixtures } from './fixtures';
import { test, themedPath } from './docs-helpers';

test.use(roleState('admin'));

test('display capability card preview', async ({ page }) => {
  const ctx = await seedScreenshotFixtures('display-layout-editor');

  try {
    // Pin `lastSiteId` (the dashboard auto-selects it) to the seeded site so
    // /dashboard loads the right machine list without the site switcher.
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    // Pin the clock so relative-time text is stable. Must install BEFORE goto so
    // the page's own Date.now() picks up the fake.
    await page.clock.install({ time: FIXED_NOW_MS });

    await page.goto('/dashboard');

    // Same "view displays" path as the access-control display-panel regression.
    await page.getByTestId('view-toggle-list').click();
    const row = page
      .getByTestId('machine-row')
      .filter({ hasText: ctx.machineId! });
    await row.getByTestId('open-display-panel').click();

    const panel = page.getByTestId('display-layout-panel');
    await expect(panel).toBeVisible();

    // The dashboard holds persistent firestore websockets, so the network never
    // idles — wait for paint instead of networkidle.
    await page.waitForTimeout(1500);

    // Kill animations/transitions so panel slide + card fade-ins can't jitter.
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

    // Re-pin after navigation so hooks that captured Date.now() at mount get the
    // fixed anchor on their next tick.
    await page.clock.setFixedTime(FIXED_NOW_MS);

    // Playwright auto-scrolls `open-display-panel` into view to click it, and the
    // page stays where that left it — which framed the shot mid-panel, clipping
    // the layout card's header and the first monitor row off the top. The panel
    // renders at the top of the dashboard, so scroll back before capturing.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);

    await page.screenshot({
      path: themedPath('public/landing-screens/preview-displays.png'),
      fullPage: false,
    });
  } finally {
    await ctx.cleanup();
  }
});
