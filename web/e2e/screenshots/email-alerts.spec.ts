/**
 * Screenshot - docs email alert rule configuration.
 *
 * Output: `web/public/docs-screens/email-alerts.png`
 * Used by: `web/content/docs/dashboard/admin/email-alerts.mdx`
 */
import { expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { getAdminDb } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import { seedScreenshotFixtures } from './fixtures';
import {
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
    .set(
      {
        lastSiteId: siteId,
        preferences: {
          displayAlertsBannerDismissed: true,
          statsExpanded: true,
          processesExpanded: true,
          displaysExpanded: true,
          activeGraphPanel: null,
          timeDisplayMode: 'site',
          timeFormat: '12h',
          timezone: 'America/Los_Angeles',
        },
      },
      { merge: true },
    );
}

async function seedAlertRules(siteId: string): Promise<void> {
  await getAdminDb()
    .collection('sites')
    .doc(siteId)
    .collection('settings')
    .doc('alerts')
    .set({
      rules: [
        {
          id: 'rule-gpu-overheating',
          name: 'GPU Overheating',
          metric: 'gpu_temp',
          operator: '>',
          value: 85,
          severity: 'warning',
          channels: ['email', 'webhook'],
          enabled: true,
          cooldownMinutes: 30,
        },
        {
          id: 'rule-high-cpu-stage',
          name: 'High CPU on stage machines',
          metric: 'cpu_percent',
          operator: '>',
          value: 95,
          severity: 'critical',
          channels: ['email'],
          enabled: true,
          cooldownMinutes: 15,
        },
      ],
    });
}

async function cleanupAlertRules(siteId: string): Promise<void> {
  await getAdminDb()
    .collection('sites')
    .doc(siteId)
    .collection('settings')
    .doc('alerts')
    .delete()
    .catch(() => undefined);
}

test('email alerts docs screenshot', async ({ page }) => {
  const ctx = await seedScreenshotFixtures('dashboard-mixed-states');

  try {
    await seedAlertRules(ctx.siteId);
    await pinSuperadminSiteContext(ctx.siteId);
    await installFixedClock(page);

    await page.goto('/admin/alerts');

    await expect(page.getByText('GPU Overheating', { exact: true })).toBeVisible();
    await page.getByText('GPU Overheating', { exact: true }).click();

    const dialog = page.getByRole('dialog', { name: /edit rule/i });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('email')).toBeVisible();
    await expect(dialog.getByLabel('webhook')).toBeVisible();

    await settleForDocsScreenshot(page);
    await saveDocsScreenshot(dialog, 'email-alerts.png');
  } finally {
    await cleanupAlertRules(ctx.siteId);
    await ctx.cleanup();
  }
});
