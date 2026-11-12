/**
 * sites — what each per-site role is offered on the site settings pages, end to end.
 *
 * most specs run as a superadmin, for whom `hasCapability` answers before the site is
 * ever considered, which is how two access regressions reached production. these run
 * as the roles that have boundaries. `owner` is a global `member` who owns a site,
 * which is what every self-serve customer is. `admin` administers a site it does not own.
 *
 * one capability separates the two: SITE_DELETE, on the owner row of
 * `SiteRoleCapabilityMatrix` and nowhere else. so an owner gets all four sections and a
 * site admin gets three, with no danger zone. a plain member administers nothing: the
 * header offers them only new site, and the admin panel turns them away. a member who
 * administers another site, on a site they only belong to, is `delete-site-owner.spec.ts`.
 *
 * non-destructive by design: these assert what is offered. deleting is covered by
 * `delete-site-owner.spec.ts` against a site it seeds itself, so nothing here can strip
 * a baseline site out from under a later spec.
 */

import { test, expect, type Page } from '@playwright/test';
import { FieldValue } from 'firebase-admin/firestore';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { grantMembership, revokeMembership, TEST_USERS } from '../../helpers/seed';

/** owned by the `owner` fixture in the baseline. */
const OWNED_SITE_ID = 'site-C';
const OWNED_SITE_NAME = 'Site C (Owned)';

const ADMIN_SECTIONS = ['general', 'members', 'machines'];
const OWNER_SECTIONS = [...ADMIN_SECTIONS, 'danger zone'];

function sectionButtons(page: Page) {
  return page.getByRole('group', { name: 'site settings sections' }).getByRole('button');
}

function gear(page: Page, siteName: string) {
  return page
    .getByRole('list', { name: 'sites' })
    .getByRole('link', { name: `settings for ${siteName}`, exact: true });
}

test.describe('per-site role — owner', () => {
  test.use(roleState('owner'));

  test('an owner has a gear on the site they own, with a global role of member', async ({
    page,
  }) => {
    // the member row is the entire grant. if this ever fails while the row exists,
    // something has started consulting the global role again.
    expect(TEST_USERS.owner.role).toBe('member');

    await page.goto('/admin/sites');
    await expect(gear(page, OWNED_SITE_NAME)).toBeVisible();
  });

  test('an owner gets all four sections, danger zone included', async ({ page }) => {
    await page.goto(`/admin/sites/${OWNED_SITE_ID}`);
    await expect(sectionButtons(page)).toHaveText(OWNER_SECTIONS);
  });
});

test.describe('membership alone grants access', () => {
  test.use(roleState('owner'));

  const OWNER_UID = TEST_USERS.owner.uid;

  // strip the legacy `users/{uid}.sites[]` entry, leaving only the member row, and
  // restore it afterwards so later specs see the baseline they expect
  test.beforeAll(async () => {
    await getAdminDb()
      .collection('users')
      .doc(OWNER_UID)
      .update({ sites: FieldValue.arrayRemove(OWNED_SITE_ID) });
  });

  test.afterAll(async () => {
    await getAdminDb()
      .collection('users')
      .doc(OWNER_UID)
      .update({ sites: FieldValue.arrayUnion(OWNED_SITE_ID) });
  });

  test('the site and its gear are listed with no legacy sites[] entry at all', async ({ page }) => {
    // every other fixture writes both the member row and the legacy array, so the suite
    // would stay green on the array alone, even with the collectionGroup listener broken.
    // here only `useSiteMemberships` resolving the member row can put the site on screen.
    await page.goto('/admin/sites');

    await expect(
      page.getByRole('list', { name: 'sites' }).getByText(OWNED_SITE_NAME, { exact: true })
    ).toBeVisible();
    await expect(gear(page, OWNED_SITE_NAME)).toBeVisible();
  });
});

test.describe('per-site role — site admin', () => {
  test.use(roleState('admin'));

  const ADMIN_UID = TEST_USERS.admin.uid;

  // the admin fixture does not hold site-C in the baseline. a grant left behind makes
  // site auto-selection prefer it in every later spec.
  test.beforeAll(async () => {
    await grantMembership(OWNED_SITE_ID, ADMIN_UID, 'admin');
  });

  test.afterAll(async () => {
    await revokeMembership(OWNED_SITE_ID, ADMIN_UID);
  });

  // site-A is the fixture's own baseline site, owned by someone else: if the danger zone
  // were keyed on anything but the owner row, the two sites would disagree
  for (const site of [
    { id: OWNED_SITE_ID, name: OWNED_SITE_NAME },
    { id: 'site-A', name: 'Site A (Assigned)' },
  ]) {
    test(`a site admin gets three sections and no danger zone on ${site.name}`, async ({ page }) => {
      await page.goto(`/admin/sites/${site.id}`);
      await expect(sectionButtons(page)).toHaveText(ADMIN_SECTIONS);

      // a danger link typed by hand renders general, never the delete
      await page.goto(`/admin/sites/${site.id}?section=danger`);
      await expect(
        page
          .getByRole('region', { name: 'general', exact: true })
          .getByRole('button', { name: 'save', exact: true })
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'delete site', exact: true })).toHaveCount(0);
    });
  }
});

test.describe('per-site role — member', () => {
  // read-only: the shared member fixture only looks, so its auth state is untouched.
  test.use(roleState('member'));

  test('the switcher offers a member new site, and neither site settings nor manage sites', async ({
    page,
  }) => {
    await page.goto('/dashboard');
    await page.getByTestId('site-switcher-trigger').click();

    await expect(page.getByRole('menuitem', { name: 'new site', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'site settings', exact: true })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'manage sites', exact: true })).toHaveCount(0);
  });

  for (const route of ['/admin/sites', '/admin/sites/site-A']) {
    test(`${route} sends a member to the dashboard with access denied`, async ({ page }) => {
      await page.goto(route);

      // the toast before the url: it fires as the guard decides, so a slow navigation
      // can't outlast it
      await expect(
        page.locator('[data-sonner-toast]').filter({ hasText: 'access denied' })
      ).toBeVisible();
      await expect(page).toHaveURL(/\/dashboard$/);
    });
  }
});
