/**
 * Screenshot - docs hoot chat panel.
 *
 * Output: `web/public/docs-screens/cortex-chat.png`
 * Used by: `web/content/docs/dashboard/hoot.mdx`
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

test('hoot chat docs screenshot', async ({ page }) => {
  const ctx = await seedScreenshotFixtures('diagnose-cortex-chat');
  const conversationId = `screenshot-cortex-${ctx.siteId}`;

  try {
    await pinAdminSiteContext(ctx.siteId);
    await installFixedClock(page);

    await page.goto(`/hoot/${conversationId}`);

    await expect(
      page.getByText('03:14 incident', { exact: false }).first(),
    ).toBeVisible();
    await expect(page.getByText('access violation', { exact: false })).toBeVisible();
    await expect(page.getByText('low risk for tonight', { exact: false })).toBeVisible();

    const chatPanel = page
      .locator('main')
      .filter({ has: page.getByText('access violation', { exact: false }) })
      .first();

    await settleForDocsScreenshot(page);
    await saveDocsScreenshot(chatPanel, 'cortex-chat.png');
  } finally {
    await ctx.cleanup();
  }
});
