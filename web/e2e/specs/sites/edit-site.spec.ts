/**
 * sites: a site's settings page, its general and swoop & screens sections
 *
 * superadmin opens /admin/sites/site-to-rename, renames the site in general and
 * saves: the toast, the new title, and an Admin SDK read of sites/site-to-rename.name.
 * an empty name toasts an error and writes nothing. the site is the spec's own,
 * re-seeded before every test, so the shared site-A / site-B baseline stays untouched.
 *
 * swoop & screens (?section=swoop) holds the site's two switches, swoop and keep
 * screens awake. they act at once, with no save, so the spec flips each and reads
 * back sites/site-to-rename/settings/{swoop,display}.
 */

import { test, expect, type Page } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { releaseFixtureSite, seedSite } from '../../helpers/seed';

test.use(roleState('superadmin'));

const RENAMEABLE_SITE_ID = 'site-to-rename';
const ORIGINAL_NAME = 'Original Rename Target';

test.beforeEach(async () => {
  // setDoc overwrites, so a rename never leaks into the next test
  await seedSite({
    id: RENAMEABLE_SITE_ID,
    name: ORIGINAL_NAME,
    owner: 'someone-else',
    timezone: 'UTC',
  });
});

// a superadmin's sites sort by name and this one sorts ahead of site-A, so left
// behind it becomes the current site of later superadmin specs
test.afterAll(async () => {
  await releaseFixtureSite(RENAMEABLE_SITE_ID, 'someone-else');
});

async function openGeneralSection(page: Page) {
  await page.goto(`/admin/sites/${RENAMEABLE_SITE_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: ORIGINAL_NAME, exact: true })).toBeVisible();
  const nameInput = page.getByLabel('site name');
  await expect(nameInput).toHaveValue(ORIGINAL_NAME);
  return nameInput;
}

test('superadmin renames a site from its general section', async ({ page }) => {
  const newName = `Renamed ${Date.now()}`;
  const nameInput = await openGeneralSection(page);

  await nameInput.fill(newName);
  await page.getByRole('button', { name: 'save', exact: true }).click();

  await expect(page.getByText(/site updated/i)).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: newName, exact: true })).toBeVisible();

  const snap = await getAdminDb().collection('sites').doc(RENAMEABLE_SITE_ID).get();
  expect(snap.exists).toBe(true);
  expect(snap.data()!.name).toBe(newName);
});

test('saving an empty name shows an error and writes nothing', async ({ page }) => {
  const nameInput = await openGeneralSection(page);

  // whitespace only, which the save trims to nothing
  await nameInput.fill('   ');
  await page.getByRole('button', { name: 'save', exact: true }).click();

  await expect(page.getByText(/site name cannot be empty/i)).toBeVisible();

  const snap = await getAdminDb().collection('sites').doc(RENAMEABLE_SITE_ID).get();
  expect(snap.data()!.name).toBe(ORIGINAL_NAME);
});

test.describe('the swoop & screens switches', () => {
  const settingsDoc = (name: 'swoop' | 'display') =>
    getAdminDb().collection('sites').doc(RENAMEABLE_SITE_ID).collection('settings').doc(name);

  // the seeded site has neither document, so restoring is removing what the test wrote.
  // seedSite's setDoc rewrites the site doc only, never its subcollections.
  test.afterEach(async () => {
    await settingsDoc('display').delete();
    await settingsDoc('swoop').delete();
  });

  test('swoop and keep screens awake write their documents at once', async ({ page }) => {
    await page.goto(`/admin/sites/${RENAMEABLE_SITE_ID}?section=swoop`);

    const swoop = page.getByRole('switch', { name: 'swoop', exact: true });
    const keepAwake = page.getByRole('switch', { name: 'keep screens awake', exact: true });

    // enabled means the snapshot has answered; with no documents, swoop is off and
    // keep screens awake is on.
    await expect(keepAwake).toBeEnabled();
    await expect(keepAwake).toBeChecked();
    await expect(swoop).toBeEnabled();
    await expect(swoop).not.toBeChecked();

    // each switch is controlled by its snapshot, so the flip on screen is the
    // document answering, not the click.
    await keepAwake.click();
    await expect(keepAwake).not.toBeChecked();
    await swoop.click();
    await expect(swoop).toBeChecked();

    const [display, swoopSettings] = await Promise.all([
      settingsDoc('display').get(),
      settingsDoc('swoop').get(),
    ]);
    expect(display.data()?.keepAwake).toBe(false);
    expect(swoopSettings.data()?.enabled).toBe(true);
  });
});
