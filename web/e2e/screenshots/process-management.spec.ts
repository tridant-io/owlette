/**
 * Screenshot - docs process management controls.
 *
 * Output: `web/public/docs-screens/process-management.png`
 * Used by: `web/content/docs/dashboard/process-management.mdx`
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

test('process management docs screenshot', async ({ page }) => {
  const ctx = await seedScreenshotFixtures('control-process-restarting');

  try {
    await pinAdminSiteContext(ctx.siteId);
    await installFixedClock(page);

    await page.goto('/dashboard');

    await expect(page.getByTestId('machine-card')).toHaveCount(4);
    await page.getByTestId('view-toggle-list').click();
    await expect(page.getByTestId('machine-row')).toHaveCount(4);

    const touchDesigner = page.getByText('touchdesigner.exe', { exact: true });
    await expect(touchDesigner).toBeVisible();
    await expect(page.getByText('obs64.exe', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'edit' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'restart' }).first()).toBeVisible();

    const processPanel = touchDesigner.locator('xpath=ancestor::td[1]');

    await page.addStyleTag({ content: 'footer { display: none !important; }' });
    await settleForDocsScreenshot(page);
    await saveDocsScreenshot(processPanel, 'process-management.png');
  } finally {
    await ctx.cleanup();
  }
});
