/**
 * Machine list — every metric cell is one height. The sparkline cells are
 * 52px buttons centred in the row; the network cell has no sparkline and sized
 * to its three text lines instead, so its hover ran the full row, taller than
 * the rest.
 */

import { test, expect } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { TEST_SITES, seedMachine } from '../../helpers/seed';

const SITE_ID = TEST_SITES[0].id;
const MACHINE_ID = 'e2e-list-metric-cells';

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
          cpus: { CPU0: { percent: 40 } },
          memory: { percent: 50, usedGb: 16 },
          nics: { eth0: { txBps: 903, rxBps: 25_000, txUtil: 0, rxUtil: 0 } },
          primary: { cpu: 'CPU0', nic: 'eth0' },
        },
      },
      { merge: true },
    );
});

test.describe('machine list metric cells — admin on site-A', () => {
  test.use(roleState('admin'));

  test('the network cell is the same box as the sparkline cells', async ({ page }) => {
    // the network column only shows from xl
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/dashboard');
    await page.getByTestId('view-toggle-list').click();

    const network = page.getByRole('button', { name: `open network history for ${MACHINE_ID}` });
    await expect(network).toBeVisible();
    await expect(network).toContainText('eth0');

    // both boxes from one frame: other specs seed machines into this site in
    // parallel, so the row can move between two separate reads
    const offsets = () =>
      page.evaluate((machineId) => {
        const box = (metric: string) =>
          document
            .querySelector(`button[aria-label="open ${metric} history for ${machineId}"]`)!
            .getBoundingClientRect();
        const cpu = box('cpu');
        const net = box('network');
        return { height: Math.round(net.height - cpu.height), top: Math.round(net.top - cpu.top) };
      }, MACHINE_ID);
    await expect.poll(offsets).toEqual({ height: 0, top: 0 });
  });
});
