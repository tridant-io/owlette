/**
 * the sites page and a site's settings on a phone: 390x844 with touch, from the
 * `mobile-chromium` project in playwright.config.ts.
 *
 * below md the header's site switcher is not rendered, and its site entries
 * (site settings, manage sites, new site) move into the nav drawer, so only this
 * spec proves a phone reaches them.
 *
 * every control is measured with `expectFullyWithinViewport` before it is tapped.
 * `assertNoHorizontalOverflow` measures the document, and the places a control
 * clips here never widen it: a dialog or popover is position-fixed, and the admin
 * pane (`main`) and the members table scroll on their own. never substitute a
 * forced click for an off-screen control: that greens a test for something a
 * thumb cannot do.
 *
 * isolation: the seeded site, its member row and every site created here are
 * released in afterAll.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import { getAdminDb } from '../../helpers/emulator';
import { assertNoHorizontalOverflow, expectFullyWithinViewport } from '../../helpers/mobile';
import { roleState } from '../../helpers/roles';
import { TEST_USERS, grantMembership, releaseFixtureSite, seedSite } from '../../helpers/seed';

// all lowercase: the create dialog downcases what is typed, so the baseline's
// site-A and site-B can never collide
const TAKEN_SITE_ID = 'site-mobile-taken';
const TAKEN_SITE_NAME = 'Mobile Taken Site';
// someone-else, the seeded owner, has no account, so the members list skips their
// row. the owner fixture gets a plain member row to measure instead: no test here
// signs in as it, and a fixture that did could open the dashboard on this site,
// which sorts first by name
const ROW_USER = TEST_USERS.owner;
const SECTIONS = ['general', 'members', 'machines', 'swoop & screens', 'danger zone'];

/** site ids created by this file, released in afterAll. */
const createdSiteIds: string[] = [];

test.use(roleState('superadmin'));

test.beforeAll(async () => {
  await seedSite({ id: TAKEN_SITE_ID, name: TAKEN_SITE_NAME, owner: 'someone-else', timezone: 'UTC' });
  await grantMembership(TAKEN_SITE_ID, ROW_USER.uid, 'member');
});

test.afterAll(async () => {
  await Promise.all([
    releaseFixtureSite(TAKEN_SITE_ID, ROW_USER.uid),
    ...createdSiteIds.map((id) => releaseFixtureSite(id, TEST_USERS.superadmin.uid)),
  ]);
});

/** the header's nav drawer: plain `md:hidden` markup, so it exists only at this width. */
async function openDrawer(page: Page): Promise<Locator> {
  await page.goto('/dashboard');
  const menu = page.getByRole('button', { name: 'menu', exact: true });
  await expectFullyWithinViewport(page, menu, 'the header menu');
  await menu.tap();
  const drawer = page.getByRole('navigation', { name: 'site and page navigation' });
  await expect(drawer).toBeVisible();
  await assertNoHorizontalOverflow(page);
  return drawer;
}

/** the sites page's new site, an icon alone below sm. */
async function openCreateSite(page: Page): Promise<Locator> {
  const newSite = page.getByRole('button', { name: 'new site', exact: true });
  await expectFullyWithinViewport(page, newSite, 'new site');
  await newSite.tap();
  const dialog = page.getByRole('dialog', { name: 'create new site' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** names the site, and swaps the generated ID for a known one. */
async function fillCreateSite(page: Page, dialog: Locator, name: string, siteId: string): Promise<void> {
  await dialog.getByLabel('site name', { exact: true }).fill(name);
  const customize = dialog.getByRole('button', { name: 'customize site ID', exact: true });
  await expectFullyWithinViewport(page, customize, 'customize site ID');
  await customize.tap();
  await dialog.locator('#site-id').fill(siteId);
}

test('the drawer offers manage sites, which opens the sites page', async ({ page }) => {
  const drawer = await openDrawer(page);
  const manageSites = drawer.getByRole('button', { name: 'manage sites', exact: true });
  await expectFullyWithinViewport(page, manageSites, 'the drawer manage sites');
  await manageSites.tap();

  await expect(page).toHaveURL(/\/admin\/sites$/);
  await expect(page.getByRole('heading', { level: 1, name: 'sites', exact: true })).toBeVisible();
  await expect(drawer).toHaveCount(0);
  await assertNoHorizontalOverflow(page);
});

test('the sites page fits, and its new site creates a site', async ({ page }) => {
  const stamp = Date.now();
  const newSiteId = `e2e-mobile-site-${stamp}`;
  const newSiteName = `E2E Mobile Site ${stamp}`;
  createdSiteIds.push(newSiteId);

  await page.goto('/admin/sites');
  // the filter renders only above one site, so it is also the sign the list loaded
  await expectFullyWithinViewport(page, page.getByRole('textbox', { name: 'filter sites' }), 'the site filter');
  await assertNoHorizontalOverflow(page);

  const dialog = await openCreateSite(page);
  await fillCreateSite(page, dialog, newSiteName, newSiteId);
  await assertNoHorizontalOverflow(page);

  // availability is debounced 500ms; submit enabling is the signal it resolved
  const submit = dialog.getByRole('button', { name: 'create site', exact: true });
  await expect(submit).toBeEnabled();
  await expectFullyWithinViewport(page, submit, 'create site');
  await submit.tap();

  await expect(page.getByText(/site created/i)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/admin/sites/${newSiteId}$`));
  await expect(page.getByRole('heading', { level: 1, name: newSiteName, exact: true })).toBeVisible();
  await assertNoHorizontalOverflow(page);

  const snap = await getAdminDb().collection('sites').doc(newSiteId).get();
  expect(snap.exists).toBe(true);
  expect(snap.data()!.name).toBe(newSiteName);
  expect(snap.data()!.owner).toBe(TEST_USERS.superadmin.uid);
});

test("a site's settings fit, section by section", async ({ page }) => {
  await page.goto(`/admin/sites/${TAKEN_SITE_ID}`);
  const title = page.getByRole('heading', { level: 1, name: TAKEN_SITE_NAME, exact: true });
  await expect(title).toBeVisible();

  // in main: the admin drawer's own sites link has the same name
  const back = page.getByRole('main').getByRole('link', { name: 'sites', exact: true });
  await expectFullyWithinViewport(page, back, 'the back link');
  await expectFullyWithinViewport(page, title, 'the site name heading');
  const sections = page.getByRole('group', { name: 'site settings sections' });
  for (const name of SECTIONS) {
    await expectFullyWithinViewport(page, sections.getByRole('button', { name, exact: true }), `the ${name} button`);
  }
  await assertNoHorizontalOverflow(page);

  await expectFullyWithinViewport(page, page.getByLabel('site name', { exact: true }), 'the site name input');
  await expectFullyWithinViewport(page, page.getByRole('button', { name: 'save', exact: true }), 'save');

  // the switches write the moment they move, so here they are only reached, never tapped
  await sections.getByRole('button', { name: 'swoop & screens', exact: true }).tap();
  for (const name of ['swoop', 'keep screens awake']) {
    await expectFullyWithinViewport(page, page.getByRole('switch', { name, exact: true }), `the ${name} switch`);
  }
  await assertNoHorizontalOverflow(page);

  await sections.getByRole('button', { name: 'members', exact: true }).tap();
  await expectFullyWithinViewport(page, page.getByRole('button', { name: 'add member', exact: true }), 'add member');
  const row = page.getByRole('row').filter({ hasText: ROW_USER.email });
  await expectFullyWithinViewport(
    page,
    row.getByRole('button', { name: `options for ${ROW_USER.email}`, exact: true }),
    'the row options button',
  );
  // a member with no mode of their own, on a site whose members watch by default
  await expectFullyWithinViewport(page, row.getByText('watch', { exact: true }), 'the row swoop label');
  await assertNoHorizontalOverflow(page);

  await sections.getByRole('button', { name: 'danger zone', exact: true }).tap();
  await expectFullyWithinViewport(page, page.getByRole('button', { name: 'delete site', exact: true }), 'delete site');
  await assertNoHorizontalOverflow(page);
});

test('the add-member dialog and its list fit', async ({ page }) => {
  await page.goto(`/admin/sites/${TAKEN_SITE_ID}?section=members`);
  const addMember = page.getByRole('button', { name: 'add member', exact: true });
  await expectFullyWithinViewport(page, addMember, 'add member');
  await addMember.tap();
  const dialog = page.getByRole('dialog', { name: 'add member', exact: true });
  await expect(dialog).toBeVisible();

  // every fixture's name or email holds e2e, so the list fills
  await dialog.getByLabel('name or email', { exact: true }).fill('e2e');
  // portalled, so outside the dialog
  const list = page.getByRole('listbox', { name: 'people you can add' });
  const options = list.getByRole('option');
  await expect(options.first()).toBeVisible();
  await expectFullyWithinViewport(page, list, 'the people you can add list');
  const count = await options.count();
  for (let i = 0; i < count; i++) {
    await expectFullyWithinViewport(page, options.nth(i), `option ${i + 1} of ${count}`);
  }
  await expectFullyWithinViewport(page, dialog.getByRole('combobox', { name: 'role', exact: true }), 'the role select');
  await expectFullyWithinViewport(page, dialog.getByRole('combobox', { name: 'swoop', exact: true }), 'the swoop select');
  await expectFullyWithinViewport(page, dialog.getByRole('button', { name: 'cancel', exact: true }), 'cancel');
  await expectFullyWithinViewport(
    page,
    dialog.getByRole('button', { name: 'add member', exact: true }),
    'the dialog add member',
  );
  await assertNoHorizontalOverflow(page);
});

test('new site on the sites page blocks a taken site ID', async ({ page }) => {
  await page.goto('/admin/sites');
  const dialog = await openCreateSite(page);
  await fillCreateSite(page, dialog, 'Mobile Collision Site', TAKEN_SITE_ID);

  // the debounced check resolves to taken: an inline error, and submit stays disabled
  const taken = dialog.getByText(/already taken/i);
  await expect(taken).toBeVisible();
  await expectFullyWithinViewport(page, taken, 'the taken site ID error');
  const submit = dialog.getByRole('button', { name: 'create site', exact: true });
  await expect(submit).toBeDisabled();
  await expectFullyWithinViewport(page, submit, 'create site');
  await assertNoHorizontalOverflow(page);
});

test.describe('a member', () => {
  test.use(roleState('member'));

  test('the drawer offers new site and no admin entries, and its dialog fits', async ({ page }) => {
    const drawer = await openDrawer(page);
    const newSite = drawer.getByRole('button', { name: 'new site', exact: true });
    await expectFullyWithinViewport(page, newSite, 'the drawer new site');
    // after new site renders: the entries render together, once the sites have loaded
    await expect(drawer.getByRole('button', { name: 'site settings', exact: true })).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: 'manage sites', exact: true })).toHaveCount(0);
    await newSite.tap();

    const dialog = page.getByRole('dialog', { name: 'create new site' });
    await expect(dialog).toBeVisible();
    await expectFullyWithinViewport(page, dialog, 'the create-site dialog');
    await assertNoHorizontalOverflow(page);

    const cancel = dialog.getByRole('button', { name: 'cancel', exact: true });
    await expectFullyWithinViewport(page, cancel, 'cancel');
    await cancel.tap();
    await expect(dialog).toBeHidden();
    await assertNoHorizontalOverflow(page);
  });
});
