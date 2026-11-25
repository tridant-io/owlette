/**
 * Dispatch — cancel deployment.
 *
 * Seeds a deployment with one downloading target, clicks the per-target cancel
 * X, and asserts: a `cancel_installation` command in commands/pending, the
 * target status flipped to 'cancelled' (cancelDeployment does this inside the
 * same transaction, so no agent stub is needed for that step), and the cancel-X
 * gone. Then stubs the agent completing the command to prove pending → completed.
 * A second case adds a queued machine and proves the X cancels only its own.
 * A third proves an installing target has no X, and that a cancel the server
 * refuses, because the machine started installing mid-click, shows the reason.
 */

import { test, expect } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';
import { completeCommand, getPendingCommandIds } from '../../helpers/stubAgent';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-cancel-deploy-target';
const OTHER_MACHINE_ID = 'e2e-cancel-deploy-other';
const DEPLOYMENT_ID = `deploy-${Date.now()}`;
const DEPLOYMENT_NAME = 'E2E Cancel Deployment';
const INSTALLER_NAME = 'cancel-test.exe';

async function clearDeploymentsAndCommands() {
  const db = getAdminDb();
  await Promise.all([
    db.collection('sites').doc(SITE_ID).collection('deployments').get().then((s) =>
      Promise.all(s.docs.map((d) => d.ref.delete())),
    ),
    db.collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID).collection('commands').get().then((s) =>
      Promise.all(s.docs.map((d) => d.ref.delete())),
    ),
  ]);
}

async function seedActiveDeployment() {
  const db = getAdminDb();
  await db.collection('sites').doc(SITE_ID).collection('deployments').doc(DEPLOYMENT_ID).set({
    name: DEPLOYMENT_NAME,
    installer_name: INSTALLER_NAME,
    installer_url: `https://example.com/${INSTALLER_NAME}`,
    silent_flags: '/SILENT',
    status: 'in_progress',
    createdAt: Timestamp.now(),
    targets: [
      // Active state, so the cancel X renders.
      { machineId: MACHINE_ID, status: 'downloading', progress: 30 },
    ],
  });
}

test.beforeEach(async () => {
  await seedMachine(SITE_ID, MACHINE_ID);
  await clearDeploymentsAndCommands();
  await seedActiveDeployment();
});

test('admin cancels an in-flight deployment target — command dispatched + target flips to cancelled + cancel button gone', async ({ page }) => {
  await page.goto('/deployments');
  await expect(page.getByRole('heading', { name: 'deployments', exact: true })).toBeVisible({ timeout: 10_000 });

  await page.getByText(DEPLOYMENT_NAME, { exact: true }).click();

  const targetRow = page
    .locator('div.flex.items-center.justify-between')
    .filter({ hasText: MACHINE_ID })
    .first();
  await expect(targetRow).toBeVisible();
  await expect(targetRow.getByText('downloading', { exact: true })).toBeVisible();

  // The aria-label exists because an icon-only button needs an accessible name.
  await targetRow.getByRole('button', { name: `cancel deployment to ${MACHINE_ID}` }).click();

  // cancelDeployment flips the status inside its transaction, independent of
  // any agent response — the UI catches up on the next snapshot tick.
  await expect(targetRow.getByText('cancelled', { exact: true })).toBeVisible({ timeout: 5_000 });
  // Cancel X is gated to active states only.
  await expect(targetRow.getByRole('button', { name: /cancel deployment to/ })).toHaveCount(0);

  const pendingIds = await getPendingCommandIds(SITE_ID, MACHINE_ID);
  const cancelKeys = pendingIds.filter((id) => id.startsWith('cancel_'));
  expect(cancelKeys).toHaveLength(1);

  const db = getAdminDb();
  const pendingSnap = await db
    .collection('sites').doc(SITE_ID)
    .collection('machines').doc(MACHINE_ID)
    .collection('commands').doc('pending').get();
  const cmd = pendingSnap.data()![cancelKeys[0]];
  expect(cmd.type).toBe('cancel_installation');
  expect(cmd.deployment_id).toBe(DEPLOYMENT_ID);
  expect(cmd.installer_name).toBe(INSTALLER_NAME);

  // Admin SDK read: proves the transaction landed, not just an optimistic flip.
  const deploySnap = await db.collection('sites').doc(SITE_ID).collection('deployments').doc(DEPLOYMENT_ID).get();
  const targets = deploySnap.data()!.targets as Array<{ machineId: string; status: string; cancelledAt?: unknown }>;
  const cancelledTarget = targets.find((t) => t.machineId === MACHINE_ID)!;
  expect(cancelledTarget.status).toBe('cancelled');
  expect(cancelledTarget.cancelledAt).toBeDefined();

  // Stub the agent finishing the cancel, completing the lifecycle.
  await completeCommand(SITE_ID, MACHINE_ID, cancelKeys[0], { cancelled: true }, { cmdType: 'cancel_installation' });

  const pendingAfter = await getPendingCommandIds(SITE_ID, MACHINE_ID);
  expect(pendingAfter).not.toContain(cancelKeys[0]);
  const completedSnap = await db
    .collection('sites').doc(SITE_ID)
    .collection('machines').doc(MACHINE_ID)
    .collection('commands').doc('completed').get();
  expect(completedSnap.data()![cancelKeys[0]].status).toBe('completed');
});

test('admin cancels one machine of a deployment — the other machine stays queued', async ({ page }) => {
  const db = getAdminDb();
  await seedMachine(SITE_ID, OTHER_MACHINE_ID);
  await db
    .collection('sites').doc(SITE_ID)
    .collection('machines').doc(OTHER_MACHINE_ID)
    .collection('commands').doc('pending')
    .delete();
  const deploymentRef = db.collection('sites').doc(SITE_ID).collection('deployments').doc(DEPLOYMENT_ID);
  await deploymentRef.update({
    targets: [
      { machineId: MACHINE_ID, status: 'downloading', progress: 30 },
      { machineId: OTHER_MACHINE_ID, status: 'pending' },
    ],
  });

  await page.goto('/deployments');
  await expect(page.getByRole('heading', { name: 'deployments', exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByText(DEPLOYMENT_NAME, { exact: true }).click();

  // hasNotText keeps an ancestor holding both lines from matching either one.
  const lines = page.locator('div.flex.items-center.justify-between');
  const targetRow = lines.filter({ hasText: MACHINE_ID, hasNotText: OTHER_MACHINE_ID }).first();
  const otherRow = lines.filter({ hasText: OTHER_MACHINE_ID, hasNotText: MACHINE_ID }).first();
  await expect(otherRow.getByText('pending', { exact: true })).toBeVisible();

  await targetRow.getByRole('button', { name: `cancel deployment to ${MACHINE_ID}` }).click();
  await expect(targetRow.getByText('cancelled', { exact: true })).toBeVisible({ timeout: 5_000 });

  await expect(otherRow.getByText('pending', { exact: true })).toBeVisible();
  await expect(otherRow.getByRole('button', { name: `cancel deployment to ${OTHER_MACHINE_ID}` })).toBeVisible();

  const targets = (await deploymentRef.get()).data()!.targets as Array<{ machineId: string; status: string }>;
  expect(targets.find((t) => t.machineId === MACHINE_ID)!.status).toBe('cancelled');
  expect(targets.find((t) => t.machineId === OTHER_MACHINE_ID)!.status).toBe('pending');
  const otherCancels = (await getPendingCommandIds(SITE_ID, OTHER_MACHINE_ID)).filter((id) => id.startsWith('cancel_'));
  expect(otherCancels).toHaveLength(0);
});

test('an installing target has no cancel, and a cancel the server refuses says why', async ({ page }) => {
  const db = getAdminDb();
  const deploymentRef = db.collection('sites').doc(SITE_ID).collection('deployments').doc(DEPLOYMENT_ID);
  await deploymentRef.update({
    targets: [
      { machineId: MACHINE_ID, status: 'downloading', progress: 30 },
      { machineId: OTHER_MACHINE_ID, status: 'installing', progress: 60 },
    ],
  });

  await page.goto('/deployments');
  await expect(page.getByRole('heading', { name: 'deployments', exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByText(DEPLOYMENT_NAME, { exact: true }).click();

  const lines = page.locator('div.flex.items-center.justify-between');
  const targetRow = lines.filter({ hasText: MACHINE_ID, hasNotText: OTHER_MACHINE_ID }).first();
  const installingRow = lines.filter({ hasText: OTHER_MACHINE_ID, hasNotText: MACHINE_ID }).first();
  await expect(installingRow.getByText('installing', { exact: true })).toBeVisible();
  await expect(installingRow.getByRole('button', { name: /cancel deployment to/ })).toHaveCount(0);

  // the machine starts installing while the click is on its way
  await page.route('**/deployments/*/cancel', async (route) => {
    await deploymentRef.update({
      targets: [
        { machineId: MACHINE_ID, status: 'installing', progress: 10 },
        { machineId: OTHER_MACHINE_ID, status: 'installing', progress: 60 },
      ],
    });
    await route.continue();
  });
  await targetRow.getByRole('button', { name: `cancel deployment to ${MACHINE_ID}` }).click();

  await expect(
    page
      .locator('[data-sonner-toast]')
      .filter({ hasText: `${MACHINE_ID} has already started installing or finished, so it can't be cancelled` }),
  ).toBeVisible({ timeout: 5_000 });
  const targets = (await deploymentRef.get()).data()!.targets as Array<{ machineId: string; status: string }>;
  expect(targets.find((t) => t.machineId === MACHINE_ID)!.status).toBe('installing');
  const cancels = (await getPendingCommandIds(SITE_ID, MACHINE_ID)).filter((id) => id.startsWith('cancel_'));
  expect(cancels).toHaveLength(0);
});
