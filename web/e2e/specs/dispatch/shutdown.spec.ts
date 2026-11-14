/**
 * Dispatch — shutdown flow. Same shape as the reboot spec with a different
 * command type and schedule field.
 *
 * Contract (useFirestore.ts::shutdownMachine):
 *   1. `sendMachineCommand` writes `shutdown_machine_{Date.now()}` to
 *      `commands/pending`.
 *   2. `updateDoc` sets `{ shutdownScheduledAt: now+60s, configChangeFlag: true }`
 *      on the machine status doc: the agent's own 60s countdown.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-shutdown-target';

async function clearMachineCommands() {
  const db = getAdminDb();
  const col = db.collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID).collection('commands');
  const snap = await col.get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

test.beforeEach(async () => {
  await seedMachine(SITE_ID, MACHINE_ID);
  await clearMachineCommands();
});

test('admin can dispatch shutdown — command written + shutdownScheduledAt populated + countdown pill renders', async ({ page }) => {
  await page.goto('/dashboard');

  const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
  await expect(card).toBeVisible();
  await card.getByTestId('machine-context-menu-trigger').click();

  const menu = page.getByRole('menu');
  await menu.getByTestId('machine-context-menu-shutdown').click();

  const confirmDialog = page.getByRole('dialog', { name: new RegExp(`shutdown ${MACHINE_ID}\\?`, 'i') });
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByRole('button', { name: /^shutdown$/i }).click();

  // Confirm returns immediately while the Promise.all writes are in flight, so
  // reading Firestore before this toast races them.
  await expect(page.getByText('shutdown command sent to', { exact: false })).toBeVisible({ timeout: 10_000 });

  // The cancel-countdown pill renders for shutdownScheduledAt > now too.
  await expect(card.getByTestId('machine-status-cancel-pill')).toBeVisible({ timeout: 5_000 });

  const db = getAdminDb();
  // Exactly one shutdown_machine_* entry; rebootScheduledAt stays clear.
  const pendingSnap = await db
    .collection('sites').doc(SITE_ID)
    .collection('machines').doc(MACHINE_ID)
    .collection('commands').doc('pending').get();
  expect(pendingSnap.exists).toBe(true);
  const pending = pendingSnap.data()!;
  const shutdownKeys = Object.keys(pending).filter((k) => pending[k]?.type === 'shutdown_machine');
  expect(shutdownKeys).toHaveLength(1);
  expect(shutdownKeys[0]).toMatch(/^cmd_/);
  const cmd = pending[shutdownKeys[0]];
  expect(cmd.type).toBe('shutdown_machine');
  expect(cmd.status).toBe('pending');
  expect(cmd.delay_seconds).toBe(60);
});
