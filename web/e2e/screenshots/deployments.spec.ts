/**
 * Screenshot - docs deployments list.
 *
 * Output: `web/public/docs-screens/deployments.png`
 * Used by: `web/content/docs/dashboard/deployments.mdx`
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

test('deployments docs screenshot', async ({ page }) => {
  const ctx = await seedScreenshotFixtures('deploy-roost-rolling');

  try {
    await pinAdminSiteContext(ctx.siteId);
    await installFixedClock(page);

    await page.goto('/deployments');

    const inFlightRow = page.getByText('stage show v4', { exact: false }).first();
    await expect(inFlightRow).toBeVisible();
    await inFlightRow.click();
    await expect(page.getByText('installer url', { exact: true })).toBeVisible();
    await expect(page.getByText('spring content pack', { exact: false })).toBeVisible();

    const deploymentPanel = inFlightRow.locator(
      'xpath=ancestor::div[.//*[contains(normalize-space(.), "installer url")] and .//*[contains(normalize-space(.), "media-server-stage")]][1]',
    );

    await settleForDocsScreenshot(page);
    await saveDocsScreenshot(deploymentPanel, 'deployments.png');
  } finally {
    await ctx.cleanup();
  }
});
