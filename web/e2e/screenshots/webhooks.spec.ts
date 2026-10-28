/**
 * Screenshot - docs webhook subscription configuration.
 *
 * Output: `web/public/docs-screens/webhooks.png`
 * Used by: `web/content/docs/dashboard/admin/webhooks.mdx`
 */
import { expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { getAdminDb } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import { seedScreenshotFixtures } from './fixtures';
import {
  disableAnimations,
  installFixedClock,
  saveDocsScreenshot,
  settleForDocsScreenshot,
  test,
} from './docs-helpers';

test.use({ ...roleState('superadmin'), viewport: { width: 1440, height: 1000 } });

async function pinSuperadminSiteContext(siteId: string): Promise<void> {
  await getAdminDb()
    .collection('users')
    .doc(TEST_USERS.superadmin.uid)
    .set({ lastSiteId: siteId }, { merge: true });
}

test('webhooks docs screenshot', async ({ page }) => {
  const ctx = await seedScreenshotFixtures('dashboard-mixed-states');

  try {
    await pinSuperadminSiteContext(ctx.siteId);
    await installFixedClock(page);

    await page.goto('/admin/webhooks');
    await disableAnimations(page);

    await expect(page.getByRole('heading', { name: 'webhooks' })).toBeVisible();
    await page.getByRole('button', { name: /add webhook/i }).click();

    const dialog = page.getByRole('dialog', { name: /add webhook/i });
    await expect(dialog).toBeVisible();
    await dialog.locator('#webhook-add-name').fill('production incident relay');
    await dialog
      .locator('#webhook-add-url')
      .fill('https://hooks.slack.com/owlette');
    await expect(dialog.getByText('HMAC-SHA256 signatures')).toBeVisible();
    await expect(dialog.getByText('machine offline')).toBeVisible();

    await settleForDocsScreenshot(page);
    await saveDocsScreenshot(dialog, 'webhooks.png');
  } finally {
    await ctx.cleanup();
  }
});
