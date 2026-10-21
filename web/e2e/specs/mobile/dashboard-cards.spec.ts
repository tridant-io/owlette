/**
 * Mobile — machine cards at 390px (the `mobile-chromium` project: touch, and
 * `pointer: coarse`).
 *
 * Three things a phone could not do:
 * - The metrics panel opens ABOVE the machine list, so tapping a metric on any
 *   card but the first opened it off-screen, with nothing to say it had.
 * - The card hid the launch mode below md and offered nothing in its place:
 *   no way to read it, let alone change it.
 * - The restart countdown's "cancel" only showed on hover, which a touch screen
 *   does not have.
 *
 * The expand flags and the open panel are user preferences, so they are reset
 * around every test; every machine and config doc seeded here is removed after.
 */

import { test, expect, type Page } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '../../helpers/emulator';
import { assertNoHorizontalOverflow } from '../../helpers/mobile';
import { roleState } from '../../helpers/roles';
import { TEST_SITES, TEST_USERS, seedMachine } from '../../helpers/seed';
import {
  configProcessById,
  readConfigProcesses,
  seedMachineWithProcesses,
  toasts,
} from '../../helpers/processConfig';

const SITE_ID = TEST_SITES[0].id;
// sorted by id on the dashboard: -a is drawn first, then -b below it
const FIRST_MACHINE = 'e2e-mobile-cards-a';
const SECOND_MACHINE = 'e2e-mobile-cards-b';
const PROCESS_MACHINE = 'e2e-mobile-cards-c';
const RESTARTING_MACHINE = 'e2e-mobile-cards-d';
const SECOND_CPU_PERCENT = 41;
const PROCESS_ID = 'e2e-mobile-cards-proc';
const PROCESS_NAME = 'alpha.exe';
/** WCAG 2.5.8 minimum target. */
const MIN_TARGET_PX = 24;

function machineDoc(machineId: string) {
  return getAdminDb().collection('sites').doc(SITE_ID).collection('machines').doc(machineId);
}

/** A v2 metric shape so the card draws its cpu and ram tiles. */
async function addMetrics(machineId: string, cpuPercent: number): Promise<void> {
  await machineDoc(machineId).set(
    {
      metrics: {
        schemaVersion: 2,
        timestamp: Timestamp.now(),
        cpus: { CPU0: { percent: cpuPercent, temperature: 52 } },
        memory: { percent: 63, usedGb: 20 },
        primary: { cpu: 'CPU0' },
      },
    },
    { merge: true },
  );
}

async function resetPrefs(): Promise<void> {
  await getAdminDb()
    .collection('users')
    .doc(TEST_USERS.admin.uid)
    .set(
      {
        preferences: {
          statsExpanded: true,
          processesExpanded: true,
          displaysExpanded: true,
          activeGraphPanel: null,
        },
      },
      { merge: true },
    );
}

function cardFor(page: Page, machineId: string) {
  return page.getByTestId('machine-card').filter({ hasText: machineId });
}

test.describe('mobile machine cards — admin on site-A', () => {
  test.use(roleState('admin'));

  test.beforeAll(async () => {
    // two monitors each, so the first card is tall enough to push the second
    // well below the fold
    await seedMachine(SITE_ID, FIRST_MACHINE);
    await addMetrics(FIRST_MACHINE, 12);
    await seedMachine(SITE_ID, SECOND_MACHINE);
    await addMetrics(SECOND_MACHINE, SECOND_CPU_PERCENT);
    await seedMachineWithProcesses(SITE_ID, PROCESS_MACHINE, [
      { id: PROCESS_ID, name: PROCESS_NAME, launch_mode: 'off', status: 'INACTIVE' },
    ]);
    await seedMachine(SITE_ID, RESTARTING_MACHINE, { monitorCount: 0, rebootingInSec: 600 });
  });

  test.beforeEach(async () => {
    await resetPrefs();
  });

  test.afterAll(async () => {
    await resetPrefs();
    for (const machineId of [FIRST_MACHINE, SECOND_MACHINE, PROCESS_MACHINE, RESTARTING_MACHINE]) {
      await machineDoc(machineId).delete();
    }
    await getAdminDb()
      .collection('config')
      .doc(SITE_ID)
      .collection('machines')
      .doc(PROCESS_MACHINE)
      .delete();
  });

  test('tapping a metric on the second card brings the opened panel into view', async ({ page }) => {
    await page.goto('/dashboard');
    const second = cardFor(page, SECOND_MACHINE);
    await expect(second).toBeVisible();

    await second.getByText(`${SECOND_CPU_PERCENT}%`, { exact: true }).click();

    await expect(page.getByTestId('metrics-detail-close-button')).toBeInViewport({ timeout: 15_000 });
    await assertNoHorizontalOverflow(page);
  });

  test('a card shows the launch mode and changes it from a menu', async ({ page }) => {
    await page.goto('/dashboard');
    const card = cardFor(page, PROCESS_MACHINE);
    await expect(card).toBeVisible();

    const trigger = card.getByRole('button', { name: `launch mode for ${PROCESS_NAME}: off` });
    await expect(trigger).toBeVisible();
    await assertNoHorizontalOverflow(page);

    await trigger.click();
    await page.getByRole('menuitemradio', { name: 'always on' }).click();

    await expect(
      toasts(page).filter({ hasText: `launch mode set to always on for "${PROCESS_NAME}"` }),
    ).toBeVisible();
    await expect(
      card.getByRole('button', { name: `launch mode for ${PROCESS_NAME}: always on` }),
    ).toBeVisible();
    const process = configProcessById(await readConfigProcesses(SITE_ID, PROCESS_MACHINE), PROCESS_ID);
    expect(process.launch_mode).toBe('always');
  });

  test('the restart countdown carries a visible cancel × at a touch-sized target', async ({ page }) => {
    await page.goto('/dashboard');
    const pill = cardFor(page, RESTARTING_MACHINE).getByTestId('machine-status-cancel-pill');
    await expect(pill).toBeVisible();

    // `pointer-coarse:` resolves here because the project emulates touch
    await expect(pill.locator('svg.lucide-x')).toBeVisible();
    const box = await pill.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(MIN_TARGET_PX);
    expect(box!.width).toBeGreaterThanOrEqual(MIN_TARGET_PX);
  });
});
