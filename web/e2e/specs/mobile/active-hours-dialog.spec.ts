/**
 * Mobile — the restart and shutdown confirm inside active hours, at 390px.
 *
 * Three stacked actions, a notice and a reason field are the most this dialog
 * ever holds; every button has to sit fully on screen, with nothing pushing
 * the page sideways. The dispatch behaviour itself is dispatch/active-hours.spec.ts.
 */

import { test, expect, type Page } from '@playwright/test';
import { assertNoHorizontalOverflow, expectFullyWithinViewport } from '../../helpers/mobile';
import { roleState } from '../../helpers/roles';
import { activeHoursAroundNow, seedMachine, TEST_SITES } from '../../helpers/seed';

const SITE_ID = TEST_SITES[0].id;
const MACHINE_ID = 'e2e-mobile-active-hours';

test.use(roleState('admin'));

test.beforeEach(async () => {
  await seedMachine(SITE_ID, MACHINE_ID, { activeHours: activeHoursAroundNow(true), activeHoursGuard: true });
});

async function openConfirm(page: Page, itemTestId: string, title: string) {
  await page.goto('/dashboard');
  const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
  await expect(card).toBeVisible();
  await card.getByTestId('machine-context-menu-trigger').click();
  await page.getByRole('menu').getByTestId(itemTestId).click();
  const dialog = page.getByRole('dialog', { name: title });
  await expect(dialog.getByTestId('active-hours-notice')).toBeVisible();
  return dialog;
}

test('the restart choice fits a phone, all three actions on screen', async ({ page }) => {
  const dialog = await openConfirm(page, 'machine-context-menu-reboot', `restart ${MACHINE_ID}?`);
  await dialog.getByLabel('reason').fill('venue closed for the day');

  for (const name of ['restart when active hours end', 'restart now', 'cancel']) {
    await expectFullyWithinViewport(page, dialog.getByRole('button', { name, exact: true }), name);
  }
  await assertNoHorizontalOverflow(page);
});

test('the shutdown choice fits a phone', async ({ page }) => {
  const dialog = await openConfirm(page, 'machine-context-menu-shutdown', `shutdown ${MACHINE_ID}?`);

  for (const name of ['shut down now', 'cancel']) {
    await expectFullyWithinViewport(page, dialog.getByRole('button', { name, exact: true }), name);
  }
  await assertNoHorizontalOverflow(page);
});
