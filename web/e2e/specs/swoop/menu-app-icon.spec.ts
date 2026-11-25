/**
 * swoop — the machine menu's way into owlette swoop. the swoop row of an
 * online machine that can stream has a second half that hands the machine to
 * the desktop app with a sign-in code. nothing takes the link here and the
 * page keeps its focus, so the app is offered instead. inside the app (its ua
 * token) the half is not there: the row itself opens one of its windows.
 */

import { test, expect, devices, type Page, type Locator } from '@playwright/test';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { seedMachine, setSiteSwoop } from '../../helpers/seed';

const SITE_ID = 'site-A';
// cardFor filters on hasText, so this id must share no substring with another seeded id.
const MACHINE_ID = 'e2e-swoop-menu-app-icon';
const APP_LINK_CODE = 'testcodetestcode_1234';
const APP_UA = `${devices['Desktop Chrome'].userAgent} owlette-swoop-viewer/0.0.0`;

const machineDoc = () => getAdminDb().doc(`sites/${SITE_ID}/machines/${MACHINE_ID}`);
let restoreSwoop: () => Promise<void>;

test.beforeAll(async () => {
  // no monitors: the hardware subdoc would outlive the machine doc's delete.
  await seedMachine(SITE_ID, MACHINE_ID, { monitorCount: 0 });
  // seedMachine writes without merge, so the swoop field lands after it.
  await machineDoc().set({ capabilities: { swoop: 1 } }, { merge: true });
  restoreSwoop = await setSiteSwoop(SITE_ID, { enabled: true });
});

test.afterAll(async () => {
  await machineDoc().delete();
  await restoreSwoop();
});

/** the menu portals out of the card, so it is reached by role. */
async function openMachineMenu(page: Page): Promise<Locator> {
  await page.goto('/dashboard');
  const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
  await expect(card).toBeVisible();
  // by keyboard: the menu opens on the press, so a card that moves while the
  // dashboard settles releases a click over one of its items, which picks it.
  await card.getByTestId('machine-context-menu-trigger').focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  return menu;
}

test.describe('in a browser — admin on site-A', () => {
  test.use(roleState('admin'));

  test('the swoop row hands the machine to owlette swoop, signed in, and offers the app when nothing takes it', async ({ page }) => {
    // the link goes to the os, which tells the page nothing back. the navigation
    // api's navigate event is where the page's attempt shows; cancelling it keeps
    // chromium off a scheme it has no handler for.
    await page.addInitScript(() => {
      const w = window as unknown as { __appLinks: string[]; navigation: EventTarget };
      w.__appLinks = [];
      w.navigation.addEventListener('navigate', (event) => {
        const { url } = (event as Event & { destination: { url: string } }).destination;
        if (!url.startsWith('owlette-swoop:')) return;
        w.__appLinks.push(url);
        event.preventDefault();
      });
    });
    const mints: string[] = [];
    await page.route('**/api/auth/app-link', async (route) => {
      mints.push(route.request().method());
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ code: APP_LINK_CODE, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      });
    });

    const menu = await openMachineMenu(page);
    await expect(menu.getByTestId('machine-context-menu-swoop')).toBeVisible();
    const app = menu.getByRole('menuitem', { name: 'open in the owlette swoop desktop app' });
    await expect(app).toBeVisible();
    await test.info().attach('menu', { body: await page.screenshot(), contentType: 'image/png' });
    // by keyboard: the dashboard keeps settling for a while and a mouse click on a
    // moving menu item is retried until it gives up.
    await app.focus();
    await expect(app).toBeFocused();
    await page.keyboard.press('Enter');

    const host = new URL(page.url()).host;
    const next = encodeURIComponent(`/swoop/${SITE_ID}/${MACHINE_ID}`);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __appLinks: string[] }).__appLinks))
      .toEqual([`owlette-swoop://${host}/app-link?code=${APP_LINK_CODE}&next=${next}`]);
    expect(mints).toEqual(['POST']);

    // nothing took the link and the page kept its focus: the app is offered instead.
    await expect(page.getByText("the owlette swoop desktop app isn't installed on this computer")).toBeVisible();
    await expect(page.getByRole('button', { name: 'get it' })).toBeVisible();
  });
});

test.describe('inside owlette swoop — admin on site-A', () => {
  test.use({ ...roleState('admin'), userAgent: APP_UA });

  test('the swoop row has no desktop-app half', async ({ page }) => {
    const menu = await openMachineMenu(page);
    await expect(menu.getByTestId('machine-context-menu-swoop')).toBeVisible();
    await expect(menu.getByTestId('machine-context-menu-swoop-app')).toHaveCount(0);
  });
});
