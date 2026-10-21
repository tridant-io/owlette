/**
 * Mobile — sites dialogs (nav drawer → manage sites → create site).
 * Viewport/isMobile/hasTouch come from the `mobile-chromium` project in playwright.config.ts.
 *
 * Below `md` the PageHeader site switcher isn't rendered at all; the breadcrumb collapses
 * into a left nav drawer. The desktop sites specs drive `site-switcher-trigger`, which
 * doesn't exist at 390px, so only this spec proves the dialogs are reachable on a phone.
 *
 * REGRESSION GUARD — inline site edit/delete were unreachable at 390px: ManageSitesDialog's
 * header was a no-wrap flex with a `w-64 shrink-0` filter whose min-content exceeded the
 * dialog's max width, inflating the DialogContent grid column. Every row inherited it, so
 * the fixed 64px actions column and the header ✕ fell outside the viewport with no
 * scroller. Fixed by wrapping the header (`flex-wrap`, `min-w-0 w-full max-w-64`).
 *
 * `assertNoHorizontalOverflow` can't catch this — the dialog is position-fixed, so its
 * overflow never reaches document scroll width; hence the explicit
 * `expectFullyWithinViewport` checks. Never substitute a forced click on an off-screen
 * control: that greens a test for something a thumb cannot do.
 *
 * Isolation: the seeded fixture and every site created here are deleted in `afterAll`.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import { getAdminDb } from '../../helpers/emulator';
import { assertNoHorizontalOverflow, expectFullyWithinViewport } from '../../helpers/mobile';
import { roleState } from '../../helpers/roles';
import { seedSite } from '../../helpers/seed';

/** The baseline's site-A/site-B have uppercase letters and the id input downcases input, so
 * neither can trigger the "already taken" branch — seed an all-lowercase id. */
const TAKEN_SITE_ID = 'site-mobile-taken';
/** Also the row the reachability test drives — owned by this file, and the test only opens
 * the inline editor and cancels. */
const TAKEN_SITE_NAME = 'Mobile Taken Site';

/** Site ids created by this file, deleted in afterAll. */
const createdSiteIds: string[] = [];

test.use(roleState('superadmin'));

/** Open the nav drawer and enter "manage sites". The drawer is plain `md:hidden` markup,
 * not a portalled sheet, so it exists only at this viewport. */
async function openManageSitesViaDrawer(page: Page): Promise<Locator> {
  await page.goto('/dashboard');

  await page.getByRole('button', { name: 'menu', exact: true }).click();
  const drawer = page.getByRole('navigation', { name: /site and page navigation/i });
  await expect(drawer).toBeVisible();

  await drawer.getByRole('button', { name: /manage sites/i }).click();
  const dialog = page.getByRole('dialog', { name: /manage sites/i });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.beforeAll(async () => {
  await seedSite({
    id: TAKEN_SITE_ID,
    name: TAKEN_SITE_NAME,
    owner: 'someone-else',
    timezone: 'UTC',
  });
});

test.afterAll(async () => {
  const db = getAdminDb();
  await Promise.all([
    db.collection('sites').doc(TAKEN_SITE_ID).delete(),
    ...createdSiteIds.map((id) => db.collection('sites').doc(id).delete()),
  ]);
});

test('the nav drawer lists sites and reaches manage-sites', async ({ page }) => {
  await page.goto('/dashboard');
  await assertNoHorizontalOverflow(page);

  await page.getByRole('button', { name: 'menu', exact: true }).click();
  const drawer = page.getByRole('navigation', { name: /site and page navigation/i });
  await expect(drawer).toBeVisible();

  // Drawer order mirrors the desktop breadcrumb: sites, page nav, manage-sites.
  await expect(drawer.getByRole('button', { name: 'Site A (Assigned)' })).toBeVisible();
  await expect(drawer.getByRole('button', { name: /^roost/ })).toBeVisible();
  await assertNoHorizontalOverflow(page);

  await drawer.getByRole('button', { name: /manage sites/i }).click();
  await expect(page.getByRole('dialog', { name: /manage sites/i })).toBeVisible();
  // The drawer closes behind the dialog rather than stacking.
  await expect(drawer).toHaveCount(0);
  await assertNoHorizontalOverflow(page);
});

test('the create-site dialog writes the site from the drawer route', async ({ page }) => {
  const stamp = Date.now();
  const newSiteId = `e2e-mobile-site-${stamp}`;
  const newSiteName = `E2E Mobile Site ${stamp}`;
  createdSiteIds.push(newSiteId);

  const manageDialog = await openManageSitesViaDrawer(page);

  // "new site" closes manage-sites and opens the create dialog.
  await manageDialog.getByRole('button', { name: 'new site', exact: true }).click();
  const createDialog = page.getByRole('dialog', { name: /create new site/i });
  await expect(createDialog).toBeVisible();

  await createDialog.getByLabel('site name').fill(newSiteName);
  // Replace the name-derived slug with a deterministic id so re-runs never collide.
  await createDialog.getByRole('button', { name: /customize site id/i }).click();
  await createDialog.locator('#site-id').fill(newSiteId);
  await assertNoHorizontalOverflow(page);

  // Availability is debounced 500ms; submit enabling is the signal it resolved.
  const submit = createDialog.getByRole('button', { name: /^create site$/i });
  await expect(submit).toBeEnabled({ timeout: 5_000 });
  await submit.click();

  await expect(page.getByText(/created successfully/i)).toBeVisible();
  await expect(createDialog).toBeHidden();

  // Admin SDK read-through: the mobile path wrote the desktop doc shape.
  const snap = await getAdminDb().collection('sites').doc(newSiteId).get();
  expect(snap.exists).toBe(true);
  expect(snap.data()!.name).toBe(newSiteName);
  expect(snap.data()!.owner).toBe('super-uid');

  await assertNoHorizontalOverflow(page);
});

test('inline site edit, its switches and delete are reachable at 390px', async ({ page }) => {
  const dialog = await openManageSitesViaDrawer(page);

  // The filter renders only above one site and is the control that used to inflate the
  // dialog — assert it is on screen before trusting the rows behind it.
  await expect(dialog.getByLabel('filter sites')).toBeVisible();

  const editButton = dialog.getByRole('button', { name: `edit ${TAKEN_SITE_NAME}` });
  // Geometry before interaction: a tap that works only because Playwright scrolled an
  // overflowing container proves nothing about a thumb.
  await expectFullyWithinViewport(page, editButton, 'the row edit button');
  await editButton.tap();

  // The row swaps in place into the inline editor, pre-filled.
  const nameInput = dialog.getByLabel('site name');
  await expect(nameInput).toBeVisible();
  await expect(nameInput).toHaveValue(TAKEN_SITE_NAME);
  await assertNoHorizontalOverflow(page);

  // the site's switches sit below name and timezone in the same panel. they write the
  // moment they move, so here they are only reached, never tapped.
  for (const name of ['swoop', 'keep screens awake']) {
    await expectFullyWithinViewport(
      page,
      dialog.getByRole('switch', { name, exact: true }),
      `the ${name} switch`,
    );
  }

  // Cancel returns the row to view mode without writing.
  await dialog.getByRole('button', { name: 'cancel', exact: true }).tap();
  await expect(nameInput).toBeHidden();
  await expect(editButton).toBeVisible();

  // Delete is the other control in the same fixed 64px actions column; untapped here, but
  // it still has to be on screen.
  await expectFullyWithinViewport(
    page,
    dialog.getByRole('button', { name: `delete ${TAKEN_SITE_NAME}` }),
    'the row delete button',
  );

  // The header ✕ rode the same overflow off-screen.
  const closeButton = dialog.getByRole('button', { name: 'close', exact: true });
  await expectFullyWithinViewport(page, closeButton, 'the dialog close button');
  await closeButton.tap();
  await expect(dialog).toBeHidden();

  // Nothing was written — the seeded site still carries its original name.
  const snap = await getAdminDb().collection('sites').doc(TAKEN_SITE_ID).get();
  expect(snap.data()!.name).toBe(TAKEN_SITE_NAME);

  await assertNoHorizontalOverflow(page);
});

test('the create-site dialog blocks a taken site id at 390px', async ({ page }) => {
  const manageDialog = await openManageSitesViaDrawer(page);
  await manageDialog.getByRole('button', { name: 'new site', exact: true }).click();

  const createDialog = page.getByRole('dialog', { name: /create new site/i });
  await expect(createDialog).toBeVisible();

  await createDialog.getByLabel('site name').fill('Mobile Collision Site');
  await createDialog.getByRole('button', { name: /customize site id/i }).click();
  await createDialog.locator('#site-id').fill(TAKEN_SITE_ID);

  // Debounced check resolves to "taken": inline error, submit stays disabled, all in view.
  await expect(createDialog.getByText(/already taken/i)).toBeVisible({ timeout: 5_000 });
  await expect(createDialog.getByRole('button', { name: /^create site$/i })).toBeDisabled();
  await assertNoHorizontalOverflow(page);
});
