/**
 * Screenshot - docs getting-started online machine card.
 *
 * Output: `web/public/docs-screens/machine-card.png`
 * Used by: `web/content/docs/getting-started.mdx`
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

test.use({ ...roleState('admin'), viewport: { width: 1440, height: 1000 } });

test('getting-started machine card docs screenshot', async ({ page }) => {
  const ctx = await seedScreenshotFixtures('dashboard-mixed-states');

  try {
    await pinAdminSiteContext(ctx.siteId);
    await installFixedClock(page);

    await page.goto('/dashboard');

    await expect(page.getByTestId('machine-card')).toHaveCount(10);
    const card = page
      .getByTestId('machine-card')
      .filter({ hasText: 'lobby-display' })
      .first();
    await expect(card).toBeVisible();

    await settleForDocsScreenshot(page);
    await saveDocsScreenshot(card, 'machine-card.png');
  } finally {
    await ctx.cleanup();
  }
});
