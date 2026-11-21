/**
 * Metrics detail panel — Escape closes it.
 *
 * The panel used to answer only its icon-only (and unnamed) close button. It now
 * closes on Escape too, except while a field has focus or a radix layer (menu,
 * popover, dialog, tooltip) takes the key first: Escape on an open machine menu
 * closes the menu and leaves the panel open.
 *
 * Opening the panel writes `activeGraphPanel` to the admin's preferences; it is
 * cleared afterwards so no later spec starts with a panel open.
 */

import { test, expect } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { TEST_SITES, TEST_USERS, seedMachine } from '../../helpers/seed';

const SITE_ID = TEST_SITES[0].id;
const MACHINE_ID = 'e2e-metrics-panel-keyboard';
const CPU_PERCENT = 43;

test.beforeAll(async () => {
  await seedMachine(SITE_ID, MACHINE_ID);
  await getAdminDb()
    .collection('sites')
    .doc(SITE_ID)
    .collection('machines')
    .doc(MACHINE_ID)
    .set(
      {
        metrics: {
          schemaVersion: 2,
          timestamp: Timestamp.now(),
          cpus: { CPU0: { percent: CPU_PERCENT } },
          memory: { percent: 48, usedGb: 16 },
          primary: { cpu: 'CPU0' },
        },
      },
      { merge: true },
    );
});

test.afterAll(async () => {
  await getAdminDb()
    .collection('users')
    .doc(TEST_USERS.admin.uid)
    .set({ preferences: { activeGraphPanel: null } }, { merge: true });
  await getAdminDb().collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID).delete();
});

test.describe('metrics panel keyboard — admin on site-A', () => {
  test.use(roleState('admin'));

  test('Escape closes the panel, but a menu over it takes the first press', async ({ page }) => {
    await page.goto('/dashboard');
    const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
    await expect(card).toBeVisible();

    await card.getByText(`${CPU_PERCENT}%`, { exact: true }).click();
    // no metrics_history seeded → deterministic empty-range copy
    const emptyCopy = page.getByText(/no data available for this time range/i);
    await expect(emptyCopy).toBeVisible({ timeout: 15_000 });
    const close = page.getByTestId('metrics-detail-close-button');
    await expect(close).toHaveAccessibleName('close');

    await card.getByTestId('machine-context-menu-trigger').click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(close).toBeVisible();

    // focus went back to the menu trigger, whose tooltip would take the next press;
    // clicking plain text in the panel moves focus off it. the tooltip keeps the
    // escape layer while it fades out, so wait until it has unmounted.
    await emptyCopy.click();
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(close).toBeHidden();
  });
});
