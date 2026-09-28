/**
 * Screenshot - docs add machine modal.
 *
 * Output: `web/public/docs-screens/add-machine-modal.png`
 * Used by: `web/content/docs/agent/installation.mdx`
 */
import { test, expect } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { roleState } from '../helpers/roles';
import { getAdminDb } from '../helpers/emulator';
import { FIXED_NOW_MS, seedScreenshotFixtures } from './fixtures';
import {
  disableAnimations,
  installFixedClock,
  pinAdminSiteContext,
  saveDocsScreenshot,
  settleForDocsScreenshot,
} from './docs-helpers';

test.use({ ...roleState('admin'), viewport: { width: 1440, height: 900 } });

test('add machine modal docs screenshot', async ({ page }) => {
  const ctx = await seedScreenshotFixtures('dashboard-mixed-states');

  try {
    await pinAdminSiteContext(ctx.siteId);

    await getAdminDb().collection('installer_metadata').doc('latest').set({
      version: '2.12.3',
      download_url: 'https://owlette.app/download/Owlette-Installer-v2.12.3.exe',
      file_size: 47_185_920,
      release_date: Timestamp.fromMillis(FIXED_NOW_MS),
      release_notes: 'latest release',
    });

    await installFixedClock(page);
    await page.goto('/dashboard');
    await disableAnimations(page);

    await expect(page.getByTestId('machine-card')).toHaveCount(10);
    await page.getByRole('button', { name: /add machine/i }).click();

    const dialog = page.getByRole('dialog', { name: 'add machine' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'enter code' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'generate code' })).toBeVisible();
    // the download row is disabled until the version loads; never frame the spinner
    await expect(dialog.getByLabel('download owlette agent')).toBeEnabled();
    await expect(dialog.getByLabel('choose installer platform')).toBeEnabled();

    await settleForDocsScreenshot(page);
    await saveDocsScreenshot(dialog, 'add-machine-modal.png');
  } finally {
    await ctx.cleanup();
  }
});
