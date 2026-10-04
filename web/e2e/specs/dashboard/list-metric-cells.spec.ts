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

    const cpu = page.getByRole('button', { name: `open cpu history for ${MACHINE_ID}` });
    const network = page.getByRole('button', { name: `open network history for ${MACHINE_ID}` });
    await expect(network).toBeVisible();
    await expect(network).toContainText('eth0');

    const cpuBox = (await cpu.boundingBox())!;
    const networkBox = (await network.boundingBox())!;
    expect(Math.abs(networkBox.height - cpuBox.height)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(networkBox.y - cpuBox.y)).toBeLessThanOrEqual(0.5);
  });
});
