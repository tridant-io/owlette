/**
 * sites — the site list at admin panel → sites, and the site switcher's entries.
 *
 * the list shows the sites you belong to, with a gear on each one you
 * administer. a superadmin sees every site, each with a gear and its owner. the
 * switcher offers site settings to the current site's admins, manage sites to
 * anyone who administers a site, and new site only to someone who administers
 * none.
 *
 * the member's new site is released after the test and their lastSiteId
 * deleted: the suite runs one worker, so a site left behind would be the
 * member's current site in every later spec.
 */

import { test, expect, type Page } from '@playwright/test';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { releaseFixtureSite, TEST_SITES, TEST_USERS } from '../../helpers/seed';

const SITE_A_NAME = 'Site A (Assigned)';
const SITE_B_NAME = 'Site B (Unassigned)';
const SITE_C_NAME = 'Site C (Owned)';

const siteRows = (page: Page) =>
  page.getByRole('list', { name: 'sites', exact: true }).getByRole('listitem');

const gearFor = (page: Page, siteName: string) =>
  page.getByRole('link', { name: `settings for ${siteName}`, exact: true });

async function openSwitcher(page: Page) {
  await page.goto('/dashboard');
  await page.getByTestId('site-switcher-trigger').click();
}

test.describe('admin on site-A', () => {
  test.use(roleState('admin'));

  test('the list shows site-A with a gear to its settings, and not site-B', async ({ page }) => {
    await page.goto('/admin/sites');

    await expect(siteRows(page).filter({ hasText: SITE_A_NAME })).toHaveCount(1);
    await expect(siteRows(page).filter({ hasText: SITE_B_NAME })).toHaveCount(0);

    const gear = gearFor(page, SITE_A_NAME);
    await expect(gear).toHaveAttribute('href', '/admin/sites/site-A');
    await gear.click();

    await expect(page).toHaveURL(/\/admin\/sites\/site-A$/);
    await expect(page.getByRole('heading', { level: 1, name: SITE_A_NAME })).toBeVisible();
  });

  test("the switcher's site settings opens site-A's settings", async ({ page }) => {
    await openSwitcher(page);
    await page.getByRole('menuitem', { name: 'site settings', exact: true }).click();

    await expect(page).toHaveURL(/\/admin\/sites\/site-A$/);
    await expect(page.getByRole('heading', { level: 1, name: SITE_A_NAME })).toBeVisible();
  });

  test("the switcher's manage sites opens the list, and it offers no new site", async ({ page }) => {
    await openSwitcher(page);
    const manageSites = page.getByRole('menuitem', { name: 'manage sites', exact: true });
    await expect(manageSites).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'new site', exact: true })).toHaveCount(0);

    await manageSites.click();

    await expect(page).toHaveURL(/\/admin\/sites$/);
    await expect(page.getByRole('heading', { level: 1, name: 'sites', exact: true })).toBeVisible();
  });
});

test.describe('superadmin', () => {
  test.use(roleState('superadmin'));

  test('every seeded site has a gear', async ({ page }) => {
    await page.goto('/admin/sites');

    for (const site of TEST_SITES) {
      await expect(gearFor(page, site.name)).toHaveAttribute('href', `/admin/sites/${site.id}`);
    }
  });

  test('the filter narrows the list to site-B, says so, and escape clears it', async ({ page }) => {
    // a superadmin's list is every site, and a full run holds more than the baseline's three
    const { count: total } = (await getAdminDb().collection('sites').count().get()).data();
    await page.goto('/admin/sites');
    const rows = siteRows(page);
    await expect(rows).toHaveCount(total);

    const filter = page.getByRole('textbox', { name: 'filter sites', exact: true });
    await filter.fill('site-b');

    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(SITE_B_NAME);
    await expect(page.getByText(`showing 1 of ${total} sites`, { exact: true })).toBeVisible();

    await filter.press('Escape');

    await expect(filter).toHaveValue('');
    await expect(rows).toHaveCount(total);
    await expect(page.getByText(/^showing \d+ of \d+ sites$/)).toHaveCount(0);
  });

  test("the owner column shows site-C's owner", async ({ page }) => {
    await page.goto('/admin/sites');

    await expect(siteRows(page).filter({ hasText: SITE_C_NAME })).toContainText(TEST_USERS.owner.email);
  });
});

test.describe('member on site-A', () => {
  test.use(roleState('member'));

  const MEMBER_UID = TEST_USERS.member.uid;
  const memberDoc = () => getAdminDb().collection('users').doc(MEMBER_UID);
  let createdSiteId: string | undefined;

  test.afterEach(async () => {
    if (createdSiteId) await releaseFixtureSite(createdSiteId, MEMBER_UID);
    createdSiteId = undefined;
    await memberDoc().update({ lastSiteId: FieldValue.delete() });
  });

  test("the switcher's new site creates a site the member owns, and switches to it", async ({ page }) => {
    const stamp = Date.now();
    createdSiteId = `e2e-header-site-${stamp}`;
    const siteName = `E2E Header Site ${stamp}`;

    await openSwitcher(page);
    await page.getByRole('menuitem', { name: 'new site', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: 'create new site' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('site name').fill(siteName);
    await dialog.getByRole('button', { name: 'customize site ID' }).click();
    await dialog.locator('#site-id').fill(createdSiteId);

    const submit = dialog.getByRole('button', { name: 'create site', exact: true });
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(page.getByText(/site created/i)).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('site-switcher-trigger')).toContainText(siteName);

    const snap = await getAdminDb().collection('sites').doc(createdSiteId).get();
    expect(snap.exists).toBe(true);
    expect(snap.get('name')).toBe(siteName);
    expect(snap.get('owner')).toBe(MEMBER_UID);

    // the header saves the new site as the last site, unawaited, from the browser:
    // wait for that write, or it can land after the afterEach deletes it
    await expect.poll(async () => (await memberDoc().get()).get('lastSiteId')).toBe(createdSiteId);
  });
});
