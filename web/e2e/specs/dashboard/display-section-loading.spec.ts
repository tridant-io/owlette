/**
 * machine card — an open displays section holds its room while the layout loads.
 *
 * each card subscribes to its own `hardware/display` doc, which lands after the
 * card's first render. the section said "no display data reported" until then
 * and grew by the canvas when the layout arrived, so on a site of open cards
 * each one jumped once on load and pushed the cards below it down. a menu opened
 * from a lower card went with its button, past the bottom of the window, where
 * nothing could scroll it back (dashboard/screenshot-history.spec.ts failed on
 * exactly that, late in a full run).
 *
 * the section is recorded from the page's first mutation, so the one frame with
 * the old message cannot slip between two polls.
 */

import { test, expect } from '@playwright/test';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { TEST_SITES, TEST_USERS, seedMachine } from '../../helpers/seed';

const SITE_ID = TEST_SITES[0].id;
const MACHINE_ID = 'e2e-display-loading-machine';

function adminDoc() {
  return getAdminDb().collection('users').doc(TEST_USERS.admin.uid);
}

let displaysExpandedBefore: unknown;

test.use(roleState('admin'));

test.beforeAll(async () => {
  await seedMachine(SITE_ID, MACHINE_ID);
  displaysExpandedBefore = (await adminDoc().get()).data()?.preferences?.displaysExpanded;
  await adminDoc().set({ preferences: { displaysExpanded: true } }, { merge: true });
});

test.afterAll(async () => {
  // unset reads as open (AuthContext), so an unset preference goes back to unset
  await adminDoc().set(
    { preferences: { displaysExpanded: displaysExpandedBefore ?? FieldValue.delete() } },
    { merge: true },
  );
  const machine = getAdminDb().collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID);
  await machine.collection('hardware').doc('display').delete();
  await machine.delete();
});

test('the open displays section keeps its height from the first frame and never claims no data', async ({ page }) => {
  await page.addInitScript((machineId) => {
    const seen: string[] = [];
    (window as unknown as { displaySection: string[] }).displaySection = seen;
    new MutationObserver(() => {
      const card = [...document.querySelectorAll('[data-testid="machine-card"]')].find((c) =>
        c.textContent?.includes(machineId),
      );
      if (!card) return;
      const panes = card.querySelector('[data-testid="display-panes"]');
      const state = panes
        ? `panes ${Math.round(panes.getBoundingClientRect().height)}px`
        : card.textContent?.includes('no display data reported')
          ? 'no display data reported'
          : 'closed';
      if (seen[seen.length - 1] !== state) seen.push(state);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  }, MACHINE_ID);

  await page.goto('/dashboard');
  const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
  await expect(card.getByText('Test Monitor 1')).toBeVisible();

  const seen = await page.evaluate(() => (window as unknown as { displaySection: string[] }).displaySection);
  expect(seen).not.toContain('no display data reported');
  expect(new Set(seen.filter((s) => s.startsWith('panes'))).size, seen.join(' → ')).toBe(1);
});
