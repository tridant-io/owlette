/**
 * sites: delete from a site's danger zone (C2.3)
 *
 * superadmin opens /admin/sites/site-to-delete?section=danger and presses delete
 * site. the confirm dialog names the site; confirming deletes it, toasts, and lands
 * on /admin/sites, because a superadmin still administers other sites. cancelling
 * does none of that. the site is re-seeded before every test, so the shared baseline
 * is untouched and the cancel test does not depend on order.
 */

import { test, expect, type Page } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { releaseFixtureSite, seedSite } from '../../helpers/seed';

test.use(roleState('superadmin'));

const DELETEABLE_SITE_ID = 'site-to-delete';
const DELETEABLE_SITE_NAME = 'Original Delete Target';

test.beforeEach(async () => {
  // so a prior delete can't leak into the next test
  await seedSite({
    id: DELETEABLE_SITE_ID,
    name: DELETEABLE_SITE_NAME,
    owner: 'someone-else',
    timezone: 'UTC',
  });
});

// a superadmin's sites sort by name and this one sorts ahead of site-A, so the copy
// the cancel test keeps would become the current site of later superadmin specs
test.afterAll(async () => {
  await releaseFixtureSite(DELETEABLE_SITE_ID, 'someone-else');
});

async function openDangerZone(page: Page) {
  await page.goto(`/admin/sites/${DELETEABLE_SITE_ID}?section=danger`);
  await expect(page.getByRole('heading', { level: 1, name: DELETEABLE_SITE_NAME, exact: true })).toBeVisible();
  return page.getByRole('region', { name: 'danger zone' }).getByRole('button', { name: 'delete site', exact: true });
}

test('superadmin deletes a site from its danger zone', async ({ page }) => {
  const deleteButton = await openDangerZone(page);
  await deleteButton.click();

  const confirmDialog = page.getByRole('dialog', { name: /^delete site$/ });
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog).toContainText(DELETEABLE_SITE_NAME);

  await confirmDialog.getByRole('button', { name: 'delete site', exact: true }).click();

  await expect(page.getByText(/site deleted/i)).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/sites$/);

  const snap = await getAdminDb().collection('sites').doc(DELETEABLE_SITE_ID).get();
  expect(snap.exists).toBe(false);
});

test('cancelling the delete keeps the site', async ({ page }) => {
  const deleteButton = await openDangerZone(page);
  await deleteButton.click();

  const confirmDialog = page.getByRole('dialog', { name: /^delete site$/ });
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByRole('button', { name: 'cancel', exact: true }).click();

  await expect(confirmDialog).toBeHidden();
  await expect(deleteButton).toBeVisible();

  const snap = await getAdminDb().collection('sites').doc(DELETEABLE_SITE_ID).get();
  expect(snap.exists).toBe(true);
  expect(snap.data()!.name).toBe(DELETEABLE_SITE_NAME);
});
