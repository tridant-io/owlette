/**
 * Screenshot -> `web/public/landing-screens/preview-deploy.png`, used by the
 * landing page's deploy capability card.
 *
 * Drives the deployments page into `deploy-roost-rolling`: a 4-version roost
 * mid-rollout (3 of 10 targets done, 1 installing) alongside completed, failed
 * and scheduled siblings, so the list reads as an active surface. The in-flight
 * row is expanded before capture.
 */
import { expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { getAdminDb } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import { FIXED_NOW_MS, seedScreenshotFixtures } from './fixtures';
import { test, themedPath } from './docs-helpers';

test.use(roleState('admin'));

test('deploy capability card preview', async ({ page }) => {
  const ctx = await seedScreenshotFixtures('deploy-roost-rolling');

  try {
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    // BEFORE goto, so "started Xm ago" copy resolves against FIXED_NOW.
    await page.clock.install({ time: FIXED_NOW_MS });

    await page.goto('/deployments');

    // The deployment name renders as plain text inside the row.
    const inFlightRow = page.getByText('stage show v4', { exact: false });
    await expect(inFlightRow).toBeVisible();

    // Expanded so per-target progress (3 done, 1 at 64%, 6 pending) shows.
    await inFlightRow.click();

    // Persistent firestore websockets mean the network never idles; wait for paint.
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

    // Progress bars and status pills paint a frame after the row mounts.
    await page.waitForTimeout(500);

    await page.screenshot({
      path: themedPath('public/landing-screens/preview-deploy.png'),
      fullPage: false,
    });
  } finally {
    await ctx.cleanup();
  }
});
