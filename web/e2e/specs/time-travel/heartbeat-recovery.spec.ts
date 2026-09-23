/**
 * Time-travel — heartbeat recovery flips the pill back online.
 *
 * Seed a stale machine, fast-forward past the 30s staleness interval so the
 * client locally flips it offline, then write a fresh heartbeat via the admin
 * SDK and assert the onSnapshot listener OVERWRITES that local flip.
 *
 * That overwrite is the point: a regression where the local `online: false`
 * sticks despite Firestore updating passes E3.1 + E3.2 and fails only here.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-heartbeat-recovery';

test('stale machine recovers to online when the agent writes a fresh heartbeat', async ({ page }) => {
  const realNow = Date.now();
  await page.clock.install({ time: realNow });

  // online=true but heartbeat 320s old: the green dot renders from
  // `data.online`, then the interval's first tick flips it to the offline pill.
  await seedMachine(SITE_ID, MACHINE_ID, { heartbeatOffsetSec: 320 });

  await page.goto('/dashboard');

  const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
  await expect(card).toBeVisible();

  // The setInterval is only registered once machines.length goes 0 → N, so
  // advance AFTER the card is visible or the timer isn't in the clock queue.
  await page.clock.fastForward(30_000);
  await expect(card.getByText('offline', { exact: true })).toBeVisible();

  // The admin SDK runs in Node on real wall-clock time, so from the browser's
  // fake clock this lands ~30s in the past — still far under the 300s bar.
  const db = getAdminDb();
  await db
    .collection('sites')
    .doc(SITE_ID)
    .collection('machines')
    .doc(MACHINE_ID)
    .set(
      {
        online: true,
        lastHeartbeat: Math.floor(Date.now() / 1000),
      },
      { merge: true },
    );

  // Proves the snapshot overwrites the local offline-flip; without
  // setMachines' wholesale replace the pill would stay stuck offline.
  await expect(card.getByRole('img', { name: 'online' })).toBeVisible();
  await expect(card.getByText('offline', { exact: true })).toHaveCount(0);
});
