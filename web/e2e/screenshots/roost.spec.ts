/**
 * Screenshot - docs roost list and detail panel.
 *
 * Output: `web/public/docs-screens/roost.png`
 * Used by: `web/content/docs/dashboard/roost.mdx`
 */
import { expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { seedScreenshotFixtures } from './fixtures';
import {
  installFixedClock,
  pinAdminSiteContext,
  saveDocsScreenshot,
  settleForDocsScreenshot,
  test,
} from './docs-helpers';

test.use({ ...roleState('admin'), viewport: { width: 1440, height: 1200 } });

test('roost docs screenshot', async ({ page }) => {
  const ctx = await seedScreenshotFixtures('deploy-roost-rolling');

  try {
    await pinAdminSiteContext(ctx.siteId);
    await installFixedClock(page);

    await page.goto('/roosts?roost=stage-show');

    await expect(page.locator('[data-roost-row="stage-show"]')).toBeVisible();
    await expect(page.locator('#roost-detail-panel')).toBeVisible();
    await expect(page.getByTestId('roost-version-row').first()).toBeVisible();

    const roostRegion = page.locator('#roost-detail-panel');

    await settleForDocsScreenshot(page);
    await saveDocsScreenshot(roostRegion, 'roost.png');
  } finally {
    await ctx.cleanup();
  }
});
