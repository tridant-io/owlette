/**
 * swoop — the viewer count on a machine's menu. the agent writes
 * `swoopViewers` onto the machine doc; an online machine that can swoop shows
 * it twice: a pill on the ⋮ trigger and a count on the swoop row. zero shows
 * neither.
 */

import { test, expect, type Page, type Locator } from '@playwright/test';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { seedMachine, setSiteSwoop } from '../../helpers/seed';

const SITE_ID = 'site-A';
// cardFor filters on hasText, so this id must share no substring with another seeded id.
const MACHINE_ID = 'e2e-swoop-viewer-badge';

const machineDoc = () => getAdminDb().doc(`sites/${SITE_ID}/machines/${MACHINE_ID}`);
let restoreSwoop: () => Promise<void>;

test.beforeAll(async () => {
  // no monitors: the hardware subdoc would outlive the machine doc's delete.
  await seedMachine(SITE_ID, MACHINE_ID, { monitorCount: 0 });
  // seedMachine writes without merge, so the swoop fields land after it.
  await machineDoc().set({ capabilities: { swoop: 1 }, swoopViewers: 2 }, { merge: true });
  restoreSwoop = await setSiteSwoop(SITE_ID, { enabled: true });
});

test.afterAll(async () => {
  await machineDoc().delete();
  await restoreSwoop();
});

async function cardFor(page: Page, machineId: string): Promise<Locator> {
  await page.goto('/dashboard');
  const card = page.getByTestId('machine-card').filter({ hasText: machineId });
  await expect(card).toBeVisible();
  return card;
}

/** the menu portals out of the card, so it is reached by role. */
async function openContextMenu(page: Page, scope: Locator): Promise<Locator> {
  await scope.getByTestId('machine-context-menu-trigger').click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  return menu;
}

test.describe('swoop viewer badge — admin on site-A', () => {
  test.use(roleState('admin'));

  test('two viewers show on the trigger and the swoop row; zero shows neither', async ({ page }) => {
    let card = await cardFor(page, MACHINE_ID);
    const pill = card
      .getByTestId('machine-context-menu-trigger')
      .getByTestId('machine-context-menu-swoop-pill');
    await expect(pill).toBeVisible();
    await expect(pill).toHaveText('2');

    let menu = await openContextMenu(page, card);
    // the sr-only suffix is what a screen reader hears; the pill is aria-hidden.
    await expect(menu.getByTestId('machine-context-menu-swoop-count')).toHaveText('2 watching');

    await machineDoc().set({ swoopViewers: 0 }, { merge: true });
    card = await cardFor(page, MACHINE_ID);
    await expect(card.getByTestId('machine-context-menu-swoop-pill')).toHaveCount(0);

    menu = await openContextMenu(page, card);
    // the row itself stays: the count is what goes.
    await expect(menu.getByTestId('machine-context-menu-swoop')).toBeVisible();
    await expect(menu.getByTestId('machine-context-menu-swoop-count')).toHaveCount(0);
  });
});
