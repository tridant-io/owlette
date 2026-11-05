/**
 * Mobile — /deployments. Viewport / isMobile / hasTouch come from the
 * `mobile-chromium` project, which owns every spec under specs/mobile/**.
 *
 * The row is narrow-viewport shaped: name block takes priority (`min-w-0
 * flex-1`), the 90px status badge and timestamp drop out below `sm`, and the ⋮
 * trigger grows to a 40px touch target via `pointer-coarse:`.
 * responsive-acceptance only measures the collapsed list; this expands a row
 * (long installer url, per-target rows) and opens the actions menu. The failed
 * target's machine is inside its active hours, so its retry asks for a reason
 * in a confirm that has to fit too (dispatch/deployment-active-hours.spec.ts
 * owns the behaviour).
 *
 * Isolation: the deployment + machine are dedicated to this file and removed in
 * afterAll, so the dispatch specs' "exactly one deployment" assertions hold.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '../../helpers/emulator';
import { assertNoHorizontalOverflow, expectFullyWithinViewport } from '../../helpers/mobile';
import { roleState } from '../../helpers/roles';
import { TEST_SITES, activeHoursAroundNow, seedMachine } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = TEST_SITES[0].id;
const OK_MACHINE_ID = 'e2e-mobile-deploy-ok';
const FAILED_MACHINE_ID = 'e2e-mobile-deploy-failed';
const DEPLOYMENT_ID = 'e2e-mobile-deployment';
const DEPLOYMENT_NAME = 'e2e mobile touchdesigner rollout';
const INSTALLER_NAME = 'TouchDesigner.2023.11600.exe';
// Long on purpose — the expanded row renders it in a `break-all` span, which
// is the widest single string on the page.
const INSTALLER_URL =
  'https://example.com/downloads/touchdesigner/2023.11600/TouchDesigner.2023.11600.installer.exe';

const MIN_TOUCH_TARGET_PX = 40;

async function seedDeployment(): Promise<void> {
  await Promise.all([
    seedMachine(SITE_ID, OK_MACHINE_ID),
    seedMachine(SITE_ID, FAILED_MACHINE_ID, { activeHours: activeHoursAroundNow(true), activeHoursGuard: true }),
  ]);
  await getAdminDb()
    .collection('sites')
    .doc(SITE_ID)
    .collection('deployments')
    .doc(DEPLOYMENT_ID)
    .set({
      name: DEPLOYMENT_NAME,
      installer_name: INSTALLER_NAME,
      installer_url: INSTALLER_URL,
      silent_flags: '/SILENT /NORESTART',
      sha256_checksum: 'cd'.repeat(32),
      status: 'failed',
      createdAt: Timestamp.now(),
      targets: [
        { machineId: OK_MACHINE_ID, status: 'completed' },
        {
          machineId: FAILED_MACHINE_ID,
          status: 'failed',
          error: 'install exited with code 1603',
        },
      ],
    });
}

async function openDeploymentsPage(page: Page): Promise<Locator> {
  await page.goto('/deployments');
  await expect(page.getByRole('heading', { name: 'deployments', exact: true })).toBeVisible({
    timeout: 10_000,
  });
  const row = page.getByText(DEPLOYMENT_NAME, { exact: true });
  await expect(row).toBeVisible();
  return row;
}

test.beforeAll(async () => {
  await seedDeployment();
});

test.afterAll(async () => {
  const db = getAdminDb();
  await Promise.all([
    db.collection('sites').doc(SITE_ID).collection('deployments').doc(DEPLOYMENT_ID).delete(),
    db.collection('sites').doc(SITE_ID).collection('machines').doc(OK_MACHINE_ID).delete(),
    db.collection('sites').doc(SITE_ID).collection('machines').doc(FAILED_MACHINE_ID).delete(),
  ]);
});

test('expanding a deployment row reveals its targets without widening the page', async ({ page }) => {
  const rowLabel = await openDeploymentsPage(page);
  // Status badge + timestamp are `hidden sm:*` — at 390px only the leading
  // status icon carries state, which is what keeps the row inside the viewport.
  await assertNoHorizontalOverflow(page);

  await rowLabel.click();

  await expect(page.getByText(INSTALLER_URL, { exact: true })).toBeVisible();
  await expect(page.getByText('/SILENT /NORESTART', { exact: true })).toBeVisible();
  await expect(page.getByText('targets (2)', { exact: true })).toBeVisible();
  await expect(page.getByText(OK_MACHINE_ID, { exact: true })).toBeVisible();
  await expect(page.getByText(FAILED_MACHINE_ID, { exact: true })).toBeVisible();
  // a failure that is not an active-hours refusal reads as the agent wrote it
  await expect(page.getByText('install exited with code 1603', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: `retry deployment to ${FAILED_MACHINE_ID}` }),
  ).toBeVisible();

  await assertNoHorizontalOverflow(page);
});

test('the row actions menu has a touch-sized trigger and opens its items', async ({ page }) => {
  await openDeploymentsPage(page);

  const trigger = page.getByRole('button', {
    name: `deployment actions for ${DEPLOYMENT_NAME}`,
  });
  const box = await trigger.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
  expect(box!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);

  await trigger.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  // A failed target is seeded, so all three items render.
  await expect(menu.getByRole('menuitem', { name: /retry failed/i })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /uninstall software/i })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /delete record/i })).toBeVisible();

  await assertNoHorizontalOverflow(page);

  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
});

test('the retry confirm inside active hours fits a phone', async ({ page }) => {
  const rowLabel = await openDeploymentsPage(page);
  await rowLabel.click();
  await page.getByRole('button', { name: `retry deployment to ${FAILED_MACHINE_ID}` }).click();

  const confirm = page.getByRole('dialog', { name: 'retry inside active hours?' });
  await expect(confirm.getByRole('listitem')).toContainText(FAILED_MACHINE_ID);
  await confirm.getByLabel('reason').fill('venue closed for the day');

  for (const name of ['retry anyway', 'cancel']) {
    await expectFullyWithinViewport(page, confirm.getByRole('button', { name, exact: true }), name);
  }
  await assertNoHorizontalOverflow(page);

  // nothing is sent: the dispatch spec owns the retry itself
  await confirm.getByRole('button', { name: 'cancel', exact: true }).click();
  await expect(confirm).toBeHidden();
});
