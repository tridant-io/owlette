/**
 * A machine's menu opens hoot aimed at that machine: a fresh chat whose target
 * is that one machine, the caret in the message box, and the query gone from
 * the url so a reload doesn't aim there again. The link outranks the stored
 * target and leaves it as it was: following a link is not a change of preference.
 */

import { test, expect } from '@playwright/test';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { TEST_USERS } from '../../helpers/seed';
import {
  seedHootFixture,
  HOOT_FIXTURE_MACHINE_ID,
  HOOT_FIXTURE_OFFLINE_MACHINE_ID,
} from '../../helpers/coverageSeed';
import { machineCard, pinDashboardContext } from '../../helpers/processConfig';

const SITE_ID = 'site-A';
const UID = TEST_USERS.admin.uid;

test.use(roleState('admin'));

const storedTarget = async () =>
  (await getAdminDb().collection('users').doc(UID).get()).data()?.lastMachineIds?.[SITE_ID];

test.beforeEach(async () => {
  await seedHootFixture({ userId: UID });
  await pinDashboardContext(UID, SITE_ID);
  // aimed elsewhere, so the link has a stored target to beat
  await getAdminDb()
    .collection('users')
    .doc(UID)
    .set({ lastMachineIds: { [SITE_ID]: [HOOT_FIXTURE_OFFLINE_MACHINE_ID] } }, { merge: true });
});

test("a machine's menu opens hoot aimed at that machine", async ({ page }) => {
  await page.goto('/dashboard');
  await machineCard(page, HOOT_FIXTURE_MACHINE_ID).getByTestId('machine-context-menu-trigger').click();
  await page.getByTestId('machine-context-menu-hoot').click();

  await expect(page).toHaveURL(/\/hoot$/);
  await expect(page.getByLabel('hoot target')).toContainText(HOOT_FIXTURE_MACHINE_ID);
  await expect(page.getByLabel('hoot target')).not.toContainText(HOOT_FIXTURE_OFFLINE_MACHINE_ID);
  await expect(page.getByLabel('chat message')).toBeFocused();
  expect(await storedTarget()).toEqual([HOOT_FIXTURE_OFFLINE_MACHINE_ID]);
});
