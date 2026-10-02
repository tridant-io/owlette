/**
 * Dispatch — create deployment. Drives /deployments → new deployment dialog →
 * installer URL → target machine → deploy, then asserts the Firestore writes:
 * `sites/{siteId}/deployments/{deployId}` (status 'pending' → 'in_progress'
 * once every per-machine command lands) plus one
 * `install_{deployId}_{machineId}_{ts}` command per target under
 * `machines/{id}/commands/pending`.
 *
 * Admin role — deployment creation is a site-admin action.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';
import { getPendingCommandIds } from '../../helpers/stubAgent';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-deploy-target';

async function clearMachineCommands() {
  const db = getAdminDb();
  const col = db.collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID).collection('commands');
  const snap = await col.get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

async function clearDeploymentsForSite() {
  const db = getAdminDb();
  const col = db.collection('sites').doc(SITE_ID).collection('deployments');
  const snap = await col.get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

test.beforeEach(async () => {
  await seedMachine(SITE_ID, MACHINE_ID);
  await clearMachineCommands();
  await clearDeploymentsForSite();
});

test('admin creates a deployment — deployment doc + per-target install command both written', async ({ page }) => {
  await page.goto('/deployments');

  // Page title is an h2, not an h1.
  await expect(page.getByRole('heading', { name: 'deployments', exact: true })).toBeVisible({ timeout: 10_000 });

  // "new deployment" renders in the empty state or the header — first() takes both.
  await page.getByRole('button', { name: /^new deployment$/i }).first().click();

  const dialog = page.getByRole('dialog', { name: /^deploy software$/i });
  await expect(dialog).toBeVisible();

  // onChange auto-derives installer_name from the URL's last path segment.
  const installerUrl = `https://example.com/test-installer-${Date.now()}.exe`;
  await dialog.locator('#installer-url').fill(installerUrl);

  // The dialog auto-computes the required sha256 by fetching the URL, which is
  // unreachable here — switch to manual entry.
  const sha256 = 'cd'.repeat(32);
  await dialog.getByRole('button', { name: /^enter manually$/i }).click();
  await dialog.locator('#manual-checksum').fill(sha256);

  await dialog.getByRole('checkbox', { name: MACHINE_ID }).click();

  // Button text pluralises with selectedMachines.size.
  await dialog.getByRole('button', { name: /^deploy to 1 machine$/i }).click();

  // useDeployments resolves before the dialog close + list refresh land, so
  // wait on the collection rather than the UI.
  const db = getAdminDb();
  let deploymentDocs: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  await expect.poll(async () => {
    const snap = await db.collection('sites').doc(SITE_ID).collection('deployments').get();
    deploymentDocs = snap.docs;
    return deploymentDocs.length;
  }, { timeout: 10_000 }).toBe(1);

  const deployment = deploymentDocs[0].data();
  const deploymentId = deploymentDocs[0].id;
  expect(deploymentId).toMatch(/^deploy-\d+$/);
  expect(deployment.installer_url).toBe(installerUrl);
  expect(deployment.installer_name).toMatch(/^test-installer-\d+\.exe$/);
  expect(deployment.sha256_checksum).toBe(sha256);
  // Status: 'in_progress' once the per-machine commands have all landed.
  expect(['pending', 'in_progress']).toContain(deployment.status);
  expect(Array.isArray(deployment.targets)).toBe(true);
  expect(deployment.targets).toHaveLength(1);
  expect(deployment.targets[0].machineId).toBe(MACHINE_ID);
  expect(deployment.targets[0].status).toBe('pending');

  // The install command landed with the right type + deployment_id linkage.
  let installKeys: string[] = [];
  await expect.poll(async () => {
    const pendingIds = await getPendingCommandIds(SITE_ID, MACHINE_ID);
    installKeys = pendingIds.filter((id) => id.startsWith('install_'));
    return installKeys.length;
  }, { timeout: 10_000 }).toBe(1);

  const pendingSnap = await db
    .collection('sites').doc(SITE_ID)
    .collection('machines').doc(MACHINE_ID)
    .collection('commands').doc('pending').get();
  const cmd = pendingSnap.data()![installKeys[0]];
  expect(cmd.type).toBe('install_software');
  expect(cmd.deployment_id).toBe(deploymentId);
  expect(cmd.installer_url).toBe(installerUrl);
  expect(cmd.sha256_checksum).toBe(sha256);
  expect(cmd.status).toBe('pending');
});
