/**
 * Screenshot - docs getting-started add process dialog.
 *
 * Output: `web/public/docs-screens/add-process-dialog.png`
 * Used by: `web/content/docs/getting-started.mdx`
 */
import { expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { seedScreenshotFixtures } from './fixtures';
import {
  disableAnimations,
  installFixedClock,
  pinAdminSiteContext,
  saveDocsScreenshot,
  settleForDocsScreenshot,
  test,
} from './docs-helpers';

test.use({ ...roleState('admin'), viewport: { width: 1440, height: 1000 } });

test('getting-started add process dialog docs screenshot', async ({ page }) => {
  const ctx = await seedScreenshotFixtures('dashboard-mixed-states');

  try {
    await pinAdminSiteContext(ctx.siteId);
    await installFixedClock(page);

    await page.goto('/dashboard');
    await disableAnimations(page);

    await expect(page.getByTestId('machine-card')).toHaveCount(10);
    const card = page
      .getByTestId('machine-card')
      .filter({ hasText: 'lobby-display' })
      .first();
    await expect(card).toBeVisible();

    await card.getByRole('button', { name: 'add process' }).click();

    const dialog = page.getByRole('dialog', { name: 'add process' });
    await expect(dialog).toBeVisible();

    await settleForDocsScreenshot(page);
    await saveDocsScreenshot(dialog, 'add-process-dialog.png');
  } finally {
    await ctx.cleanup();
  }
});
