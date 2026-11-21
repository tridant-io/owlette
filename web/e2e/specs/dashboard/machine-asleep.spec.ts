/**
 * A Mac's agent marks the machine asleep on its way to sleep. The card shows
 * the asleep pill, not offline, through a dark wake's fresh heartbeat as well,
 * and goes back to the online dot when a heartbeat says it fully woke.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-machine-asleep';

function writeMachine(fields: Record<string, unknown>) {
  return getAdminDb()
    .collection('sites')
    .doc(SITE_ID)
    .collection('machines')
    .doc(MACHINE_ID)
    .set(fields, { merge: true });
}

test('an asleep machine shows asleep, not offline, until it fully wakes', async ({ page }) => {
  await seedMachine(SITE_ID, MACHINE_ID, { heartbeatOffsetSec: 1800 });
  await writeMachine({ osFamily: 'macos', asleep: true });

  await page.goto('/dashboard');

  const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
  await expect(card.getByTestId('machine-status-asleep')).toHaveText('asleep');
  await expect(card.getByText('offline', { exact: true })).toHaveCount(0);

  // a dark wake: a fresh heartbeat that still says asleep
  await writeMachine({ lastHeartbeat: Math.floor(Date.now() / 1000) });
  await expect(card.getByTestId('machine-status-asleep')).toBeVisible();
  await expect(card.getByRole('img', { name: 'online' })).toHaveCount(0);

  // the first heartbeat after a full wake
  await writeMachine({ asleep: false, lastHeartbeat: Math.floor(Date.now() / 1000) });
  await expect(card.getByRole('img', { name: 'online' })).toBeVisible();
  await expect(card.getByTestId('machine-status-asleep')).toHaveCount(0);
});
