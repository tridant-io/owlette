/**
 * swoop — the machine this browser is on. a machine cannot be watched from
 * itself: its streamer ends such a session with `same_machine`, the page
 * records it in this browser, and from then on the dashboard greys swoop out
 * for that machine and says why. every other machine keeps it.
 */

import { test, expect, type Page, type Locator } from '@playwright/test';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { seedMachine } from '../../helpers/seed';

const SITE_ID = 'site-A';
// cardFor filters on hasText, so these ids must share no substring with another seeded id.
const SELF_ID = 'e2e-swoop-self-machine';
const OTHER_ID = 'e2e-swoop-peer-machine';

const machineDoc = (id: string) => getAdminDb().doc(`sites/${SITE_ID}/machines/${id}`);

test.beforeAll(async () => {
  for (const id of [SELF_ID, OTHER_ID]) {
    // no monitors: the hardware subdoc would outlive the machine doc's delete.
    await seedMachine(SITE_ID, id, { monitorCount: 0 });
    // seedMachine writes without merge, so the swoop capability lands after it.
    await machineDoc(id).set({ capabilities: { swoop: 1 } }, { merge: true });
  }
});

test.afterAll(async () => {
  for (const id of [SELF_ID, OTHER_ID]) await machineDoc(id).delete();
});

async function swoopRow(page: Page, machineId: string): Promise<Locator> {
  const card = page.getByTestId('machine-card').filter({ hasText: machineId });
  await expect(card).toBeVisible();
  await card.getByTestId('machine-context-menu-trigger').click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  return menu.getByTestId('machine-context-menu-swoop');
}

test.describe('swoop on the machine this browser is on — admin on site-A', () => {
  test.use(roleState('admin'));

  test('is greyed out there and nowhere else', async ({ page }) => {
    // what the swoop page records when the streamer answers `same_machine`
    await page.addInitScript(
      ([site, machine]) => localStorage.setItem('owlette.swoop.thisMachine', `${site}/${machine}`),
      [SITE_ID, SELF_ID],
    );
    await page.goto('/dashboard');

    const self = await swoopRow(page, SELF_ID);
    await expect(self).toHaveAttribute('aria-disabled', 'true');
    await expect(self).toContainText("you're on this machine");
    await page.keyboard.press('Escape');

    const other = await swoopRow(page, OTHER_ID);
    await expect(other).not.toHaveAttribute('aria-disabled', 'true');
    await expect(other).not.toContainText("you're on this machine");
  });
});
