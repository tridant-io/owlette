/**
 * sites — delete as the role a real self-serve customer has.
 *
 * every signup is born a global `member` (`lib/actions/bootstrapUser.server.ts`) and
 * `POST /api/sites` has no capability gate, so whoever creates a site is a member who
 * owns it. SITE_DELETE sits on the `owner` row of `SiteRoleCapabilityMatrix` and
 * nowhere else, so only the member row can grant it. `delete-site.spec.ts` cannot
 * catch a break here: it runs as a superadmin, for whom `hasCapability` answers before
 * the site is considered. an owner's delete failed on production that way on 2026-09-04.
 *
 * the member owns `site-owned-by-member` and only belongs to `Site A (Assigned)`, so
 * deleting the owned site leaves them administering nothing. the page then sends them
 * to /dashboard, because /admin/sites would turn them away, and the admin panel lets
 * them go without an access denied.
 */

import { test, expect, type Page } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { grantMembership, releaseFixtureSite, seedSite, TEST_USERS } from '../../helpers/seed';

test.use(roleState('member'));

const MEMBER_UID = TEST_USERS.member.uid;
const OWNED_SITE_ID = 'site-owned-by-member';
const OWNED_SITE_NAME = 'Member Owned Site';
/** seeded baseline site: the member belongs to it, someone else owns it. */
const ASSIGNED_SITE_NAME = 'Site A (Assigned)';

/** a sonner toast, so page copy with the same words can't match. */
function toast(page: Page, title: string) {
  return page.locator('[data-sonner-toast]').filter({ hasText: title });
}

test.beforeEach(async () => {
  await seedSite({
    id: OWNED_SITE_ID,
    name: OWNED_SITE_NAME,
    owner: MEMBER_UID,
    timezone: 'UTC',
  });
  await grantMembership(OWNED_SITE_ID, MEMBER_UID, 'owner');
});

test.afterEach(async () => {
  // the member row as well as the site: a row that outlives its site still counts as administering it
  await releaseFixtureSite(OWNED_SITE_ID, MEMBER_UID);
});

test('the sites page has a gear on the site they own and none on one they only belong to', async ({
  page,
}) => {
  await page.goto('/admin/sites');
  const list = page.getByRole('list', { name: 'sites' });

  await expect(
    list.getByRole('link', { name: `settings for ${OWNED_SITE_NAME}`, exact: true })
  ).toBeVisible();
  await expect(list.getByText(ASSIGNED_SITE_NAME, { exact: true })).toBeVisible();
  await expect(
    list.getByRole('link', { name: `settings for ${ASSIGNED_SITE_NAME}`, exact: true })
  ).toHaveCount(0);
});

test('deleting the only site a member administers lands them on the dashboard', async ({ page }) => {
  await page.goto(`/admin/sites/${OWNED_SITE_ID}?section=danger`);
  await page.getByRole('button', { name: 'delete site', exact: true }).click();

  const confirmDialog = page.getByRole('dialog', { name: /^delete site$/ });
  await expect(confirmDialog).toContainText(OWNED_SITE_NAME);
  await confirmDialog.getByRole('button', { name: 'delete site', exact: true }).click();

  await expect(toast(page, 'site deleted')).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard$/);
  // toasts drain one at a time, so a refusal fired on the way out would still be here
  await expect(toast(page, 'access denied')).toHaveCount(0);

  const snap = await getAdminDb().collection('sites').doc(OWNED_SITE_ID).get();
  expect(snap.exists).toBe(false);
});

test('a member is refused the settings of a site they only belong to', async ({ page }) => {
  await page.goto('/admin/sites/site-A');

  await expect(
    page.getByText(
      `you're a member of ${ASSIGNED_SITE_NAME}. ask its owner or an admin to change its settings.`,
      { exact: true }
    )
  ).toBeVisible();
  await expect(page.getByRole('group', { name: 'site settings sections' })).toHaveCount(0);
});
