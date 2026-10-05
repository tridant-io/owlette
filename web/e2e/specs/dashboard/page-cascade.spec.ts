/**
 * Pages fade in one row after another while they open, and only then.
 *
 * In the first moments after the dashboard mounts (`page-cascade-opening`) its
 * sections and machine cards each wait their turn. After that window a card
 * that arrives, moves or expands fades in at once instead of waiting.
 */

import { test, expect } from '@playwright/test';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { TEST_SITES, seedMachine } from '../../helpers/seed';

const SITE_ID = TEST_SITES[0].id;
const MACHINE_IDS = ['e2e-cascade-machine-a', 'e2e-cascade-machine-b'];

type Seen = { sections: string[]; cards?: string[] };

test.use(roleState('admin'));

test.beforeAll(async () => {
  for (const id of MACHINE_IDS) await seedMachine(SITE_ID, id);
});

test.afterAll(async () => {
  const machines = getAdminDb().collection('sites').doc(SITE_ID).collection('machines');
  for (const id of MACHINE_IDS) await machines.doc(id).delete();
});

test('the dashboard fades in top to bottom while it opens, and later cards do not wait', async ({ page }) => {
  // read the delays as the root and the cards mount: by the time a locator
  // resolves, the opening window may already have closed
  await page.addInitScript(() => {
    const w = window as unknown as { __cascade?: Seen };
    const delay = (el: Element) => getComputedStyle(el).animationDelay;
    new MutationObserver((_, observer) => {
      const root = document.querySelector('.page-cascade-opening');
      if (!root) return;
      w.__cascade ??= { sections: [...root.querySelectorAll(':scope > main > *')].slice(0, 2).map(delay) };
      const cards = document.querySelectorAll('.machines-grid > *');
      if (cards.length >= 2) {
        w.__cascade.cards = [...cards].slice(0, 2).map(delay);
        observer.disconnect();
      }
    }).observe(document, { childList: true, subtree: true });
  });

  await page.goto('/dashboard');
  await expect(page.getByTestId('machine-card').nth(1)).toBeVisible();

  const seen = await page.evaluate(() => (window as unknown as { __cascade?: Seen }).__cascade);
  expect(seen?.sections).toEqual(['0.07s', '0.14s']);
  expect(seen?.cards).toEqual(['0s', '0.07s']);

  await expect(page.locator('.page-cascade')).not.toHaveClass(/page-cascade-opening/);
  const second = page.locator('.machines-grid > *').nth(1);
  await expect(second).toHaveCSS('animation-name', 'page-fade');
  await expect(second).toHaveCSS('animation-delay', '0s');
});
