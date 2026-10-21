/**
 * Screenshot — the landing page's automate capability card.
 * Output: `web/public/landing-screens/preview-automate.png`.
 *
 * Drives `/talons` into the `automate-talons-list` scenario (seven talons
 * spanning schedule / threshold / event triggers, a visual-check condition, and
 * every output family) and captures the list, which is where the card's copy —
 * trigger, condition, outputs — is actually visible.
 */
import { expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { getAdminDb } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import { FIXED_NOW_MS, seedScreenshotFixtures } from './fixtures';
import { test, themedPath } from './docs-helpers';

// /talons is open to any site member; admin owns the seeded site, matching the
// other capability-card specs.
test.use(roleState('admin'));

test('automate capability card preview', async ({ page }) => {
  const ctx = await seedScreenshotFixtures('automate-talons-list');

  try {
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    // Pin the clock BEFORE goto so "last run Xh ago" resolves against FIXED_NOW.
    await page.clock.install({ time: FIXED_NOW_MS });

    await page.goto('/talons');

    // Proves the useTalons listener resolved against the screenshot site.
    await expect(page.getByTestId('talon-row')).toHaveCount(7);
    await expect(page.getByText('doors open — lobby wall is live')).toBeVisible();

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

    // The scope column resolves only once the machines listener lands.
    await page.waitForTimeout(500);

    await page.screenshot({
      path: themedPath('public/landing-screens/preview-automate.png'),
      fullPage: false,
    });
  } finally {
    await ctx.cleanup();
  }
});
