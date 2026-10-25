/**
 * Dispatch — reboot flow (D2.1): click reboot -> confirm -> command doc written
 * -> 60s countdown pill, the agent's own. Tick / lockout / revert are E1.x;
 * the active-hours choice is active-hours.spec.ts.
 *
 * Contract (useFirestore.ts::restartMachine): POST the command via the API, which
 * lands a `reboot_machine` entry in `.../commands/pending`; the countdown itself
 * is optimistic client state until the agent writes back.
 *
 * Admin role because the context-menu item is `isSiteAdmin`-gated (B3.2).
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-reboot-target';

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

test('admin can dispatch restart — command written + rebootScheduledAt populated + countdown pill renders', async ({ page }) => {
  await page.goto('/dashboard');

  const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
  await expect(card).toBeVisible();
  await card.getByTestId('machine-context-menu-trigger').click();

  // DropdownMenuContent portals out; reach it by role
  const menu = page.getByRole('menu');
  await menu.getByTestId('machine-context-menu-reboot').click();

  // machineName falls back to the raw machineId when no displayName is set
  const confirmDialog = page.getByRole('dialog', { name: new RegExp(`restart ${MACHINE_ID}\\?`, 'i') });
  await expect(confirmDialog).toBeVisible();

  await confirmDialog.getByRole('button', { name: /^restart$/i }).click();

  // The dialog only closes once both Firestore writes resolve; without this wait
  // the Admin SDK reads below race the client writes.
  await expect(page.getByText('restart command sent to', { exact: false })).toBeVisible({ timeout: 10_000 });

  // rebootScheduledAt > now flips the status pill to the countdown. Only admin
  // gets the cancel variant with a testid; member's text-only badge is B3.2.
  await expect(card.getByTestId('machine-status-cancel-pill')).toBeVisible({ timeout: 5_000 });

  const db = getAdminDb();
  const pendingSnap = await db
    .collection('sites').doc(SITE_ID)
    .collection('machines').doc(MACHINE_ID)
    .collection('commands').doc('pending').get();
  expect(pendingSnap.exists).toBe(true);
  const pending = pendingSnap.data()!;
  const rebootKeys = Object.keys(pending).filter((k) => pending[k]?.type === 'reboot_machine');
  expect(rebootKeys).toHaveLength(1);
  expect(rebootKeys[0]).toMatch(/^cmd_/);
  const cmd = pending[rebootKeys[0]];
  expect(cmd.type).toBe('reboot_machine');
  expect(cmd.status).toBe('pending');
  expect(cmd.delay_seconds).toBe(60);
});
