/**
 * Screenshot - docs getting-started create site dialog.
 *
 * Output: `web/public/docs-screens/create-site-dialog.png`
 * Used by: `web/content/docs/getting-started.mdx`
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

test.use({ ...roleState('admin'), viewport: { width: 1440, height: 900 } });

test('getting-started create site dialog docs screenshot', async ({ page }) => {
  const ctx = await seedScreenshotFixtures('dashboard-mixed-states');
  const userRef = getAdminDb().collection('users').doc(TEST_USERS.admin.uid);
  // a member row, not `sites[]`, is what grants a site, so the empty state
  // needs the admin's rows gone too; `finally` puts them back
  const memberRows = (await getAdminDb().collectionGroup('members').get()).docs.filter(
    (row) => row.id === TEST_USERS.admin.uid,
  );

  try {
    // Force the authenticated admin into the first-run empty state so the
    // real dashboard "create your first site" trigger opens CreateSiteDialog.
    await Promise.all(memberRows.map((row) => row.ref.delete()));
    await userRef.set(
      {
        sites: [],
        lastSiteId: null,
        preferences: {
          activeGraphPanel: null,
          statsExpanded: true,
          processesExpanded: true,
          displaysExpanded: true,
        },
      },
      { merge: true },
    );

    await installFixedClock(page);
    await page.goto('/dashboard');
    await disableAnimations(page);

    const createSiteTrigger = page.getByRole('button', {
      name: /create your first site/i,
    });
    await expect(createSiteTrigger).toBeVisible();
    await createSiteTrigger.click();

    const dialog = page.getByRole('dialog', { name: /create new site/i });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('site name').fill('NYC Gallery');
    await dialog.getByRole('button', { name: /customize site ID/i }).click();
    await dialog.getByPlaceholder('e.g., nyc-office').fill('nyc-gallery');
    await expect(dialog.getByRole('button', { name: 'create site' })).toBeEnabled();

    await settleForDocsScreenshot(page);
    await saveDocsScreenshot(dialog, 'create-site-dialog.png');
  } finally {
    await userRef.set(
      {
        sites: [ctx.siteId],
        lastSiteId: ctx.siteId,
        preferences: {
          activeGraphPanel: null,
          statsExpanded: true,
          processesExpanded: true,
          displaysExpanded: true,
        },
      },
      { merge: true },
    );
    await Promise.all(memberRows.map((row) => row.ref.set(row.data())));
    await ctx.cleanup();
  }
});
