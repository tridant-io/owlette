/**
 * /deployments by keyboard alone. The row used to be a CollapsibleTrigger on a
 * <div>: not focusable, so a keyboard user could never expand a deployment, and
 * the failure reason lived only in a hover tooltip on a non-focusable badge.
 *
 * Tab reaches the row's disclosure button, Enter expands it, the reason is on
 * the page as text, and the per-machine retry is a few tab stops further on.
 *
 * Isolation: the deployment is dedicated to this file and removed in afterAll,
 * so the dispatch specs' "exactly one deployment" assertions hold.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { TEST_SITES } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = TEST_SITES[0].id;
const MACHINE_ID = 'e2e-a11y-deploy-failed';
const DEPLOYMENT_ID = 'e2e-a11y-keyboard-deployment';
const DEPLOYMENT_NAME = 'e2e keyboard rollout';
const FAILURE = 'install exited with code 1603';

async function tabUntilFocused(page: Page, target: Locator, max: number) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error(`not reached within ${max} tab presses`);
}

test.beforeAll(async () => {
  await getAdminDb()
    .collection('sites')
    .doc(SITE_ID)
    .collection('deployments')
    .doc(DEPLOYMENT_ID)
    .set({
      name: DEPLOYMENT_NAME,
      installer_name: 'keyboard-test.exe',
      installer_url: 'https://example.com/keyboard-test.exe',
      silent_flags: '/SILENT',
      sha256_checksum: 'ef'.repeat(32),
      status: 'failed',
      createdAt: Timestamp.now(),
      targets: [{ machineId: MACHINE_ID, status: 'failed', error: FAILURE }],
    });
});

test.afterAll(async () => {
  await getAdminDb()
    .collection('sites')
    .doc(SITE_ID)
    .collection('deployments')
    .doc(DEPLOYMENT_ID)
    .delete();
});

test('a failed deployment expands, shows its reason and reaches retry by keyboard', async ({ page }) => {
  await page.goto('/deployments');
  await expect(page.getByRole('heading', { level: 1, name: 'deployments', exact: true })).toBeVisible({
    timeout: 10_000,
  });

  const disclosure = page.getByRole('button', { name: `details for ${DEPLOYMENT_NAME}` });
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  // collapsed, the reason is nowhere in the page text
  await expect(page.getByText(FAILURE, { exact: true })).toHaveCount(0);

  await tabUntilFocused(page, disclosure, 80);
  await page.keyboard.press('Enter');

  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText(FAILURE, { exact: true })).toBeVisible();

  const retry = page.getByRole('button', { name: `retry deployment to ${MACHINE_ID}` });
  await expect(retry).toBeVisible();
  // the actions menu sits between the disclosure and the expanded content
  await tabUntilFocused(page, retry, 5);
  await expect(retry).toBeFocused();

  // and it closes the same way it opened
  await disclosure.focus();
  await page.keyboard.press('Enter');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(retry).toHaveCount(0);
});
