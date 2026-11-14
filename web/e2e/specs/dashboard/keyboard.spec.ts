/**
 * Dashboard — the machine list and cards are operable from the keyboard.
 *
 * A list row expanded only on a mouse click on the <tr>, with a decorative
 * chevron, and every metric cell / card tile opened the metrics panel from an
 * onClick on a <td> or <div>: nothing there was focusable, so a keyboard user
 * could neither see a machine's processes nor open its history.
 *
 * The seed opens every card section; `processesExpanded` is turned off here so
 * list rows start collapsed, and every preference touched is put back.
 * Tabbing to a control, rather than focusing it, is the point: it proves the
 * control is in the tab order.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { TEST_SITES, TEST_USERS, seedMachine } from '../../helpers/seed';

const SITE_ID = TEST_SITES[0].id;
const MACHINE_ID = 'e2e-keyboard-machine';
const PROCESS_NAME = 'TouchDesigner.exe';

function machineDoc() {
  return getAdminDb().collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID);
}

async function setPrefs(preferences: Record<string, unknown>): Promise<void> {
  await getAdminDb()
    .collection('users')
    .doc(TEST_USERS.admin.uid)
    .set({ preferences }, { merge: true });
}

/** Tab forward until `target` holds focus; fails if it is not in the tab order. */
async function tabTo(page: Page, target: Locator, maxPresses = 150): Promise<void> {
  for (let i = 0; i < maxPresses; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

test.beforeAll(async () => {
  await seedMachine(SITE_ID, MACHINE_ID);
  await machineDoc().set(
    {
      metrics: {
        schemaVersion: 2,
        timestamp: Timestamp.now(),
        cpus: { CPU0: { percent: 33, temperature: 50 } },
        memory: { percent: 44, usedGb: 14 },
        primary: { cpu: 'CPU0' },
        processes: {
          'e2e-keyboard-proc': { name: PROCESS_NAME, status: 'RUNNING', pid: 4242 },
        },
      },
    },
    { merge: true },
  );
});

// opening the panel persists `activeGraphPanel`; without the reset the next
// test would load with the panel already open
test.beforeEach(async () => {
  await setPrefs({ statsExpanded: true, processesExpanded: false, activeGraphPanel: null });
});

test.afterAll(async () => {
  await setPrefs({ statsExpanded: true, processesExpanded: true, activeGraphPanel: null });
  await machineDoc().delete();
});

test.describe('dashboard keyboard — admin on site-A', () => {
  test.use(roleState('admin'));

  test('list view: a row expands from its disclosure button and a metric cell opens the panel', async ({ page }) => {
    await page.goto('/dashboard');
    const listToggle = page.getByRole('button', { name: 'list view' });
    await listToggle.click();
    await expect(listToggle).toHaveAttribute('aria-pressed', 'true');

    const row = page.getByTestId('machine-row').filter({ hasText: MACHINE_ID });
    await expect(row).toBeVisible();
    await expect(page.getByTestId('metrics-detail-close-button')).toHaveCount(0);
    const disclosure = row.getByRole('button', { name: `processes for ${MACHINE_ID}` });
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');

    await tabTo(page, disclosure);
    await page.keyboard.press('Enter');
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText(PROCESS_NAME, { exact: true })).toBeVisible();

    const cpuCell = row.getByRole('button', { name: `open cpu history for ${MACHINE_ID}` });
    await tabTo(page, cpuCell, 10);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('metrics-detail-close-button')).toBeVisible({ timeout: 15_000 });
  });

  test('card view: a metric tile opens the panel from the keyboard', async ({ page }) => {
    await page.goto('/dashboard');
    const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
    await expect(card).toBeVisible();
    await expect(page.getByTestId('metrics-detail-close-button')).toHaveCount(0);

    // start inside the card, then tab: the tile has to be in the tab order
    await card.getByTestId('open-display-panel').focus();
    const cpuTile = card.getByRole('button', { name: `open cpu history for ${MACHINE_ID}` });
    await tabTo(page, cpuTile, 10);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('metrics-detail-close-button')).toBeVisible({ timeout: 15_000 });
  });
});
