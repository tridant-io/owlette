/**
 * sites: create a site from admin panel → sites (C2.1)
 *
 * superadmin: the switcher's "manage sites" opens /admin/sites, whose "new site"
 * opens the create dialog. a custom site ID and a name, then submit: the toast, the
 * new site's settings page, and sites/{id} in Firestore with the creator's uid as
 * owner, a populated timezone and `schedulesFollowSiteTime: true`. new sites are born
 * on site time, and this is the only end-to-end proof that the dialog's flag survives
 * the POST body and the create action into the document.
 *
 * edge: a site ID that is already taken flips the availability check to "taken",
 * shows the error, and keeps create site disabled.
 */

import { test, expect, type Page } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { releaseFixtureSite, seedSite } from '../../helpers/seed';

test.use(roleState('superadmin'));

// all lowercase, unlike the baseline's `site-A`: the ID input downcases what is
// typed, so a typed `site-A` would never match the seeded doc
const EXISTING_SITE_ID = 'site-existing';

// a valid slug plus a timestamp, so a rerun never meets an earlier run's site
const stamp = Date.now();
const NEW_SITE_ID = `e2e-new-site-${stamp}`;
const NEW_SITE_NAME = `E2E New Site ${stamp}`;

test.beforeAll(async () => {
  await seedSite({
    id: EXISTING_SITE_ID,
    name: 'Pre-seeded Site',
    owner: 'someone-else',
    timezone: 'UTC',
  });
});

// a superadmin's sites sort by name and both of these sort ahead of site-A, so one
// left behind becomes the current site of later superadmin specs. the create also
// gave super-uid an owner row and a `sites[]` entry, which the release takes back
test.afterEach(async () => {
  await releaseFixtureSite(NEW_SITE_ID, 'super-uid');
});

test.afterAll(async () => {
  await releaseFixtureSite(EXISTING_SITE_ID, 'someone-else');
});

async function openCreateDialog(page: Page) {
  await page.goto('/dashboard');
  await page.getByTestId('site-switcher-trigger').click();
  await page.getByRole('menuitem', { name: 'manage sites', exact: true }).click();

  await expect(page).toHaveURL(/\/admin\/sites$/);
  await expect(page.getByRole('heading', { level: 1, name: 'sites', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'new site', exact: true }).click();
  const createDialog = page.getByRole('dialog', { name: /create new site/i });
  await expect(createDialog).toBeVisible();
  return createDialog;
}

test('superadmin creates a site from the sites page and lands on its settings', async ({ page }) => {
  const createDialog = await openCreateDialog(page);

  // the availability check is debounced 500ms and create site enables only once it
  // answers "available", so the enabled state is the wait
  await createDialog.getByLabel('site name').fill(NEW_SITE_NAME);
  await createDialog.getByRole('button', { name: /customize site id/i }).click();
  await createDialog.locator('#site-id').fill(NEW_SITE_ID);

  // the detected browser timezone shows before anything is written: it is the clock
  // the new site's schedules run on
  await expect(createDialog.getByTestId('create-site-timezone')).not.toBeEmpty();

  const submit = createDialog.getByRole('button', { name: /^create site$/i });
  await expect(submit).toBeEnabled({ timeout: 5_000 });
  await submit.click();

  await expect(page.getByText(/site created/i)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/admin/sites/${NEW_SITE_ID}$`));
  await expect(page.getByRole('heading', { level: 1, name: NEW_SITE_NAME, exact: true })).toBeVisible();

  const snap = await getAdminDb().collection('sites').doc(NEW_SITE_ID).get();
  expect(snap.exists).toBe(true);
  const data = snap.data()!;
  expect(data.name).toBe(NEW_SITE_NAME);
  expect(data.owner).toBe('super-uid');
  expect(typeof data.timezone).toBe('string');
  expect(data.timezone.length).toBeGreaterThan(0);
  // born opted in, and never with the flag alone: `true` without a timezone is the
  // one combination the site-time contract refuses
  expect(data.schedulesFollowSiteTime).toBe(true);
});

test('create site stays disabled when the site ID is already taken', async ({ page }) => {
  const createDialog = await openCreateDialog(page);

  await createDialog.getByLabel('site name').fill('Collision Site');
  await createDialog.getByRole('button', { name: /customize site id/i }).click();
  await createDialog.locator('#site-id').fill(EXISTING_SITE_ID);

  await expect(createDialog.getByText(/already taken/i)).toBeVisible({ timeout: 5_000 });
  await expect(createDialog.getByRole('button', { name: /^create site$/i })).toBeDisabled();
});
