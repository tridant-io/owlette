/**
 * swoop — finding the switch. while a site has swoop off, a machine that can
 * stream sends an admin from its menu to the site's settings and tells a member
 * who can turn swoop on, with live view in the meantime. the site switcher opens
 * the current site's settings in one click, and `/dashboard?settings=<siteId>`,
 * the viewer's link when swoop is off, lands on them too.
 */

import { test, expect, type Page } from '@playwright/test';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { seedMachine, setSiteSwoop } from '../../helpers/seed';

const SITE_ID = 'site-A';
// cardFor filters on hasText, so this id must share no substring with another seeded id.
const MACHINE_ID = 'e2e-swoop-switch-finder';

const machineDoc = () => getAdminDb().doc(`sites/${SITE_ID}/machines/${MACHINE_ID}`);
let restoreSwoop: () => Promise<void>;

test.beforeAll(async () => {
  // no monitors: the hardware subdoc would outlive the machine doc's delete.
  await seedMachine(SITE_ID, MACHINE_ID, { monitorCount: 0 });
  // seedMachine writes without merge, so the swoop capability lands after it.
  await machineDoc().set({ capabilities: { swoop: 1 } }, { merge: true });
  restoreSwoop = await setSiteSwoop(SITE_ID, { enabled: false });
});

test.afterAll(async () => {
  await machineDoc().delete();
  await restoreSwoop();
});

/** the menu portals out of the card, so it is reached by role. */
async function openMachineMenu(page: Page) {
  await page.goto('/dashboard');
  const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
  await expect(card).toBeVisible();
  await card.getByTestId('machine-context-menu-trigger').click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  return menu;
}

/** site settings is manage sites, opened on the current site's editor. */
async function expectSiteSettings(page: Page) {
  const dialog = page.getByRole('dialog', { name: /manage sites/i });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('switch', { name: 'swoop' })).toHaveAttribute('aria-checked', 'false');
}

test.describe('admin on site-A', () => {
  test.use(roleState('admin'));

  test('the machine menu leads to the swoop switch', async ({ page }) => {
    const menu = await openMachineMenu(page);
    await expect(menu.getByTestId('machine-context-menu-swoop')).toHaveCount(0);
    await expect(menu.getByTestId('machine-context-menu-live-view')).toBeVisible();

    await menu.getByTestId('machine-context-menu-swoop-off').click();

    await expectSiteSettings(page);
  });

  test('the site switcher opens site settings', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByTestId('site-switcher-trigger').click();
    await page.getByRole('menuitem', { name: 'site settings' }).click();

    await expectSiteSettings(page);
  });

  test('the viewer link lands on site settings and leaves a clean url', async ({ page }) => {
    await page.goto(`/dashboard?settings=${SITE_ID}`);

    await expectSiteSettings(page);
    await expect(page).toHaveURL(/\/dashboard$/);
  });
});

test.describe('member on site-A', () => {
  test.use(roleState('member'));

  test('the machine menu says who can turn swoop on', async ({ page }) => {
    const menu = await openMachineMenu(page);

    await expect(menu.getByTestId('machine-context-menu-swoop-off')).toContainText(
      'ask a site owner or admin to turn it on',
    );
    await expect(menu.getByTestId('machine-context-menu-live-view')).toBeVisible();
  });
});
