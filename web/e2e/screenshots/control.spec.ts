/**
 * Screenshot for the landing page's control capability card —
 * `web/public/landing-screens/control.png` (api-sprint wave 4.3).
 *
 * Uses the `control-process-restarting` scenario: touchdesigner.exe at
 * status=LAUNCHING so the row shows the launching indicator, with the processes
 * panel pre-expanded by the seeded `processesExpanded` preference.
 */
import { expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { getAdminDb } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import { FIXED_NOW_MS, seedScreenshotFixtures } from './fixtures';
import { test, themedPath } from './docs-helpers';

test.use(roleState('admin'));

test('control capability card preview', async ({ page }) => {
  const ctx = await seedScreenshotFixtures('control-process-restarting');

  try {
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    await page.clock.install({ time: FIXED_NOW_MS });

    await page.goto('/dashboard');

    const card = page
      .getByTestId('machine-card')
      .filter({ hasText: ctx.machineId! });
    await expect(card).toBeVisible();

    // wait for the row so the LAUNCHING badge is in the shot
    await expect(card.getByText('touchdesigner.exe', { exact: false })).toBeVisible();

    // persistent firestore websockets mean the network never idles; wait for paint
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

    await page.waitForTimeout(500);

    await page.screenshot({
      path: themedPath('public/landing-screens/control.png'),
      fullPage: false,
    });
  } finally {
    await ctx.cleanup();
  }
});
