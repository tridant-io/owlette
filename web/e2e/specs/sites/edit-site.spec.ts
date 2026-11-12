/**
 * sites: a site's settings page, its general section and the site's two switches
 *
 * superadmin opens /admin/sites/site-to-rename, renames the site in general and
 * saves: the toast, the new title, and an Admin SDK read of sites/site-to-rename.name.
 * an empty name toasts an error and writes nothing. the site is the spec's own,
 * re-seeded before every test, so the shared site-A / site-B baseline stays untouched.
 *
 * keep screens awake sits in the machines section (?section=machines), and the
 * swoop switch in the site's row on swoop settings (/admin/swoop/settings). both
 * act at once, with no save, so the spec flips each and reads back
 * sites/site-to-rename/settings/{display,swoop}.
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

test.describe("the site's switches", () => {
  const settingsDoc = (name: 'swoop' | 'display') =>
    getAdminDb().collection('sites').doc(RENAMEABLE_SITE_ID).collection('settings').doc(name);

  // the seeded site has neither document, so restoring is removing what the test wrote.
  // seedSite's setDoc rewrites the site doc only, never its subcollections.
  test.afterEach(async () => {
    await settingsDoc('display').delete();
    await settingsDoc('swoop').delete();
  });

  test('keep screens awake, in the machines section, writes its document at once', async ({ page }) => {
    await page.goto(`/admin/sites/${RENAMEABLE_SITE_ID}?section=machines`);

    const screens = page.getByRole('region', { name: 'screens', exact: true });
    const keepAwake = screens.getByRole('switch', { name: 'keep screens awake', exact: true });
    await expect(screens).toContainText('machines on this site never sleep, blank or lock');
    await expect(page.getByRole('region', { name: 'machines', exact: true })).toBeVisible();
    // the swoop switch left the site's page
    await expect(page.getByRole('switch', { name: 'swoop', exact: true })).toHaveCount(0);

    // enabled means the snapshot has answered; with no document, keep screens awake is on.
    // the switch is controlled by its snapshot, so the flip on screen is the document
    // answering, not the click.
    await expect(keepAwake).toBeEnabled();
    await expect(keepAwake).toBeChecked();
    await keepAwake.click();
    await expect(keepAwake).not.toBeChecked();

    expect((await settingsDoc('display').get()).data()?.keepAwake).toBe(false);
    expect((await settingsDoc('swoop').get()).exists).toBe(false);
  });

  test("the site's row on swoop settings writes its switch at once", async ({ page }) => {
    await page.goto('/admin/swoop/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'swoop settings', exact: true })).toBeVisible({
      timeout: 10_000,
    });
    const swoop = page.getByRole('switch', { name: `swoop on ${ORIGINAL_NAME}`, exact: true });

    // with no document, swoop is off
    await expect(swoop).toBeEnabled();
    await expect(swoop).not.toBeChecked();
    await swoop.click();
    await expect(swoop).toBeChecked();

    expect((await settingsDoc('swoop').get()).data()?.enabled).toBe(true);
    expect((await settingsDoc('display').get()).exists).toBe(false);
  });
});
