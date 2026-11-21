/**
 * Dispatch — deployments inside active hours.
 *
 * A windows agent with `capabilities.activeHoursGuard` refuses an install
 * inside its active hours, before it closes any process, unless a person
 * overrode it. So the deployment dialog names the chosen machines inside
 * their window and takes a reason first; the route turns the body's
 * `active_hours_override` into `activeHoursOverride: { reason, approvedBy }`
 * on every install command it queues. A retry needs its own override, so the
 * retry actions ask the same question. When the agent refuses anyway (its
 * clock is the one that counts), `functions/src/deploymentStatus.ts` copies
 * its error onto the target, and the page shows it under the target in plain
 * words.
 *
 * Seeded machines run on UTC; `activeHoursAroundNow` places the window around,
 * or clear of, the hour the spec runs in. The functions emulator is not part
 * of this suite, so the refused target is stubbed the way deploymentStatus.ts
 * writes it.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { activeHoursAroundNow, seedMachine } from '../../helpers/seed';
import { activeHoursRefusal, getPendingCommandIds, stubDeploymentTarget } from '../../helpers/stubAgent';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-deploy-active-hours';
const SHA256 = 'cd'.repeat(32);
const REASON = 'venue closed for the day';
const APPROVED_BY = 'user:admin-uid';

const clock = (hour: number) => `${String(hour).padStart(2, '0')}:00`;
const span = (w: { start: number; end: number }) => `${clock(w.start)}–${clock(w.end)}`;
/** how the page words the agent's refusal under its target */
const refusedText = (w: { start: number; end: number }) =>
  `refused: inside active hours ${span(w)} (machine time), they end at ${clock(w.end)}`;

function siteDoc() {
  return getAdminDb().collection('sites').doc(SITE_ID);
}

async function clearCommands() {
  const snap = await siteDoc().collection('machines').doc(MACHINE_ID).collection('commands').get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

async function clearDeployments() {
  const snap = await siteDoc().collection('deployments').get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

async function installCommands(): Promise<Array<Record<string, unknown>>> {
  const ids = (await getPendingCommandIds(SITE_ID, MACHINE_ID)).filter((id) => id.startsWith('install_'));
  if (ids.length === 0) return [];
  const pending = (await siteDoc().collection('machines').doc(MACHINE_ID).collection('commands').doc('pending').get())
    .data() as Record<string, Record<string, unknown>>;
  return ids.map((id) => pending[id]);
}

async function onlyInstallCommand(): Promise<Record<string, unknown>> {
  await expect.poll(async () => (await installCommands()).length, { timeout: 10_000 }).toBe(1);
  return (await installCommands())[0];
}

/** /deployments → new deployment, filled in and pointed at the one machine. */
async function fillDeployment(page: Page): Promise<{ dialog: Locator; installerName: string }> {
  await page.goto('/deployments');
  await expect(page.getByRole('heading', { name: 'deployments', exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: /^new deployment$/i }).first().click();

  const dialog = page.getByRole('dialog', { name: /^deploy software$/i });
  await expect(dialog).toBeVisible();
  const installerName = `ah-installer-${Date.now()}.exe`;
  await dialog.locator('#installer-url').fill(`https://example.com/${installerName}`);
  // the url is unreachable here, so the checksum is entered by hand
  await dialog.getByRole('button', { name: /^enter manually$/i }).click();
  await dialog.locator('#manual-checksum').fill(SHA256);
  await dialog.getByRole('checkbox', { name: MACHINE_ID }).click();
  return { dialog, installerName };
}

async function seedRefusedDeployment(window: { start: number; end: number }): Promise<{ id: string; name: string }> {
  const id = `deploy-${Date.now()}`;
  const name = 'e2e refused deployment';
  await siteDoc().collection('deployments').doc(id).set({
    name,
    installer_name: 'refused-test.exe',
    installer_url: 'https://example.com/refused-test.exe',
    silent_flags: '/SILENT',
    // a checksum keeps the retry route's legacy self-heal (an installer fetch) out of it
    sha256_checksum: SHA256,
    status: 'failed',
    createdAt: Timestamp.now(),
    targets: [{ machineId: MACHINE_ID, status: 'failed', error: activeHoursRefusal(window) }],
  });
  return { id, name };
}

test.beforeEach(async () => {
  await clearCommands();
  await clearDeployments();
});

test.afterAll(async () => {
  await clearCommands();
  await clearDeployments();
  await siteDoc().collection('machines').doc(MACHINE_ID).delete();
});

test.describe('inside active hours on a guarded windows agent', () => {
  const window = activeHoursAroundNow(true);

  test.beforeEach(async () => {
    await seedMachine(SITE_ID, MACHINE_ID, { activeHours: window, activeHoursGuard: true });
  });

  test('deploy anyway needs a reason, and the install command carries the person\'s override', async ({ page }) => {
    const { dialog } = await fillDeployment(page);
    const deploy = dialog.getByRole('button', { name: /^deploy to 1 machine$/ });
    await deploy.click();

    const confirm = page.getByRole('dialog', { name: 'deploy inside active hours?' });
    const listed = confirm.getByRole('listitem');
    await expect(listed).toHaveCount(1);
    await expect(listed).toContainText(MACHINE_ID);
    await expect(listed).toContainText(span(window));
    const anyway = confirm.getByRole('button', { name: 'deploy anyway' });
    await expect(anyway).toBeDisabled();

    // cancel goes back to the deployment and sends nothing
    await confirm.getByRole('button', { name: 'cancel' }).click();
    await expect(confirm).toBeHidden();
    await expect(dialog).toBeVisible();
    expect((await siteDoc().collection('deployments').get()).size).toBe(0);

    await deploy.click();
    await confirm.getByLabel('reason').fill(REASON);
    await anyway.click();
    await expect(page.getByText(/deployment started/i)).toBeVisible({ timeout: 10_000 });
    await expect(confirm).toBeHidden();
    await expect(dialog).toBeHidden();

    const cmd = await onlyInstallCommand();
    expect(cmd.type).toBe('install_software');
    expect(cmd.activeHoursOverride).toEqual({ reason: REASON, approvedBy: APPROVED_BY });
    // the body field never reaches the agent as a param: only the envelope carries it
    expect(cmd.active_hours_override).toBeUndefined();
  });

  test('retrying a refused target asks for its own reason, and the retry carries it', async ({ page }) => {
    const deployment = await seedRefusedDeployment(window);
    await page.goto('/deployments');
    await page.getByRole('button', { name: `details for ${deployment.name}` }).click();
    await expect(page.getByText(refusedText(window), { exact: true })).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: `retry deployment to ${MACHINE_ID}` }).click();
    const confirm = page.getByRole('dialog', { name: 'retry inside active hours?' });
    await expect(confirm.getByRole('listitem')).toContainText(MACHINE_ID);
    const anyway = confirm.getByRole('button', { name: 'retry anyway' });
    await expect(anyway).toBeDisabled();
    await confirm.getByLabel('reason').fill(REASON);
    await anyway.click();

    await expect(page.getByText('retrying deployment for 1 machine(s)', { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(confirm).toBeHidden();

    const cmd = await onlyInstallCommand();
    expect(cmd.deployment_id).toBe(deployment.id);
    expect(cmd.retry_attempt).toBe(true);
    expect(cmd.activeHoursOverride).toEqual({ reason: REASON, approvedBy: APPROVED_BY });
  });

  test('retry failed from the row menu asks the same, and cancel sends nothing', async ({ page }) => {
    const deployment = await seedRefusedDeployment(window);
    await page.goto('/deployments');
    await page.getByRole('button', { name: `deployment actions for ${deployment.name}` }).click();
    await page.getByRole('menuitem', { name: /retry failed/i }).click();

    const confirm = page.getByRole('dialog', { name: 'retry inside active hours?' });
    await expect(confirm.getByRole('listitem')).toContainText(MACHINE_ID);
    await confirm.getByRole('button', { name: 'cancel' }).click();
    await expect(confirm).toBeHidden();

    expect(await installCommands()).toHaveLength(0);
    const targets = (await siteDoc().collection('deployments').doc(deployment.id).get()).data()!.targets;
    expect(targets[0].status).toBe('failed');
  });
});

test('outside active hours the deployment goes straight out, and the agent\'s refusal shows on its target', async ({ page }) => {
  // outside the window on this clock, so no confirm and no override; the
  // agent's own clock is the one that counts, and it refuses
  await seedMachine(SITE_ID, MACHINE_ID, { activeHours: activeHoursAroundNow(false), activeHoursGuard: true });
  const { dialog, installerName } = await fillDeployment(page);
  await dialog.getByRole('button', { name: /^deploy to 1 machine$/ }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  await expect(page.getByRole('dialog', { name: 'deploy inside active hours?' })).toHaveCount(0);

  const cmd = await onlyInstallCommand();
  expect(cmd.activeHoursOverride).toBeUndefined();

  const refused = { start: 8, end: 17 };
  await stubDeploymentTarget(SITE_ID, cmd.deployment_id as string, MACHINE_ID, {
    status: 'failed',
    error: activeHoursRefusal(refused),
  });

  // the name falls back to the installer's, which the row shows twice
  await page.getByRole('button', { name: `details for ${installerName}` }).click();
  await expect(page.getByText(refusedText(refused), { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Error: active_hours')).toHaveCount(0);
});
