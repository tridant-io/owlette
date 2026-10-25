/**
 * Dispatch — restart and shutdown inside active hours.
 *
 * A windows agent with `capabilities.activeHoursGuard` refuses a restart or a
 * shutdown inside its active hours unless a person overrode it, and counts a
 * refused restart against its 5 s rate limit. So the dashboard asks first and
 * sends the person's choice with the first request:
 *   - restart now, with a reason: the route turns `active_hours_override` into
 *     the envelope's `activeHoursOverride: { reason, approvedBy }`;
 *   - restart when active hours end: `when: 'after_active_hours'`, no override,
 *     and no countdown, since the agent restarts only when the window is over.
 * When the agent refuses anyway (its clock is the one that counts), the
 * countdown the dashboard drew goes and a toast names the window. A machine
 * whose agent guards nothing keeps today's confirm.
 *
 * Seeded machines run on UTC; `activeHoursAroundNow` places the window around,
 * or clear of, the hour the spec runs in.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { activeHoursAroundNow, seedMachine } from '../../helpers/seed';
import { activeHoursRefusal, failCommand, getPendingCommandIds } from '../../helpers/stubAgent';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const SITE_NAME = 'Site A (Assigned)';
const MACHINE_ID = 'e2e-active-hours-target';
const REASON = 'venue closed for the day';

const clock = (hour: number) => `${String(hour).padStart(2, '0')}:00`;
const span = (w: { start: number; end: number }) => `${clock(w.start)}–${clock(w.end)}`;

function commandsCol() {
  return getAdminDb()
    .collection('sites').doc(SITE_ID)
    .collection('machines').doc(MACHINE_ID)
    .collection('commands');
}

async function pendingOfType(type: string): Promise<Array<Record<string, unknown>>> {
  const snap = await commandsCol().doc('pending').get();
  const pending = (snap.data() ?? {}) as Record<string, Record<string, unknown>>;
  return Object.values(pending).filter((cmd) => cmd?.type === type);
}

test.beforeEach(async () => {
  const snap = await commandsCol().get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
});

async function machineCard(page: Page): Promise<Locator> {
  await page.goto('/dashboard');
  const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
  await expect(card).toBeVisible();
  return card;
}

async function openFromMenu(page: Page, card: Locator, itemTestId: string): Promise<void> {
  await card.getByTestId('machine-context-menu-trigger').click();
  await page.getByRole('menu').getByTestId(itemTestId).click();
}

test.describe('inside active hours on a guarded windows agent', () => {
  const window = activeHoursAroundNow(true);

  test.beforeEach(async () => {
    await seedMachine(SITE_ID, MACHINE_ID, { activeHours: window, activeHoursGuard: true });
  });

  test('restart now needs a reason, and the command carries the person\'s override', async ({ page }) => {
    const card = await machineCard(page);
    await openFromMenu(page, card, 'machine-context-menu-reboot');

    const dialog = page.getByRole('dialog', { name: `restart ${MACHINE_ID}?` });
    await expect(dialog.getByTestId('active-hours-notice')).toHaveText(
      `inside active hours (${span(window)}, machine time)`,
    );
    const restartNow = dialog.getByRole('button', { name: 'restart now' });
    await expect(restartNow).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'restart when active hours end' })).toBeEnabled();

    await dialog.getByLabel('reason').fill(REASON);
    await restartNow.click();

    await expect(page.getByText(`restart command sent to ${MACHINE_ID}`)).toBeVisible({ timeout: 10_000 });
    await expect(dialog).toBeHidden();
    await expect(card.getByTestId('machine-status-cancel-pill')).toBeVisible({ timeout: 5_000 });

    const [cmd] = await pendingOfType('reboot_machine');
    expect(cmd).toBeDefined();
    expect(cmd.activeHoursOverride).toEqual({ reason: REASON, approvedBy: 'user:admin-uid' });
    // the body field never reaches the agent as a param: only the envelope carries it
    expect(cmd.active_hours_override).toBeUndefined();
    expect(cmd.when).toBeUndefined();
    expect(cmd.delay_seconds).toBe(60);
  });

  test('restart when active hours end defers with no override and draws no countdown', async ({ page }) => {
    const card = await machineCard(page);
    await openFromMenu(page, card, 'machine-context-menu-reboot');

    const dialog = page.getByRole('dialog', { name: `restart ${MACHINE_ID}?` });
    await dialog.getByRole('button', { name: 'restart when active hours end' }).click();

    await expect(page.getByText(`${MACHINE_ID} will restart when active hours end`)).toBeVisible({ timeout: 10_000 });
    await expect(dialog).toBeHidden();

    const [cmd] = await pendingOfType('reboot_machine');
    expect(cmd).toBeDefined();
    expect(cmd.when).toBe('after_active_hours');
    expect(cmd.activeHoursOverride).toBeUndefined();
    await expect(card.getByTestId('machine-status-cancel-pill')).toHaveCount(0);
  });

  test('shutdown offers no deferral and needs a reason', async ({ page }) => {
    const card = await machineCard(page);
    await openFromMenu(page, card, 'machine-context-menu-shutdown');

    const dialog = page.getByRole('dialog', { name: `shutdown ${MACHINE_ID}?` });
    await expect(dialog.getByTestId('active-hours-notice')).toBeVisible();
    await expect(dialog.getByRole('button', { name: /when active hours end/ })).toHaveCount(0);
    const shutDownNow = dialog.getByRole('button', { name: 'shut down now' });
    await expect(shutDownNow).toBeDisabled();

    await dialog.getByLabel('reason').fill(REASON);
    await shutDownNow.click();
    await expect(page.getByText(`shutdown command sent to ${MACHINE_ID}`)).toBeVisible({ timeout: 10_000 });

    const [cmd] = await pendingOfType('shutdown_machine');
    expect(cmd).toBeDefined();
    expect(cmd.activeHoursOverride).toEqual({ reason: REASON, approvedBy: 'user:admin-uid' });
    expect(cmd.when).toBeUndefined();
  });

  test('the restart-pending approve button asks the same question', async ({ page }) => {
    await seedMachine(SITE_ID, MACHINE_ID, {
      activeHours: window,
      activeHoursGuard: true,
      rebootPending: { reason: 'show.exe crashed 9 times' },
    });
    const card = await machineCard(page);
    await card.getByTestId('reboot-pending-approve').click();

    const dialog = page.getByRole('dialog', { name: `restart ${MACHINE_ID}?` });
    await expect(dialog.getByTestId('active-hours-notice')).toBeVisible();
    await dialog.getByRole('button', { name: 'cancel' }).click();
    await expect(dialog).toBeHidden();

    expect(await pendingOfType('reboot_machine')).toHaveLength(0);
  });

  test('the manage-sites machine list asks the same question', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByTestId('site-switcher-trigger').click();
    await page.getByRole('menuitem', { name: /manage sites/i }).click();
    const manage = page.getByRole('dialog', { name: /manage sites/i });
    await manage.getByRole('button', { name: `machines on ${SITE_NAME}` }).click();
    await manage.getByRole('button', { name: `restart ${MACHINE_ID}` }).click();

    const dialog = page.getByRole('dialog', { name: `restart ${MACHINE_ID}?` });
    await expect(dialog.getByTestId('active-hours-notice')).toHaveText(
      `inside active hours (${span(window)}, machine time)`,
    );
    await dialog.getByRole('button', { name: 'restart when active hours end' }).click();
    await expect(page.getByText(`${MACHINE_ID} will restart when active hours end`)).toBeVisible({ timeout: 10_000 });

    const [cmd] = await pendingOfType('reboot_machine');
    expect(cmd).toBeDefined();
    expect(cmd.when).toBe('after_active_hours');
  });
});

test('a refusal from the agent takes the countdown back and names the window', async ({ page }) => {
  // outside the window on this clock, so the plain confirm sends a plain restart;
  // the agent's own clock is the one that counts, and it refuses
  await seedMachine(SITE_ID, MACHINE_ID, { activeHours: activeHoursAroundNow(false), activeHoursGuard: true });
  const card = await machineCard(page);
  await openFromMenu(page, card, 'machine-context-menu-reboot');

  const dialog = page.getByRole('dialog', { name: `restart ${MACHINE_ID}?` });
  await expect(dialog.getByTestId('active-hours-notice')).toHaveCount(0);
  await dialog.getByRole('button', { name: /^restart$/ }).click();
  await expect(page.getByText(`restart command sent to ${MACHINE_ID}`)).toBeVisible({ timeout: 10_000 });
  await expect(card.getByTestId('machine-status-cancel-pill')).toBeVisible({ timeout: 5_000 });

  const [commandId] = await getPendingCommandIds(SITE_ID, MACHINE_ID);
  expect(commandId).toBeDefined();
  await failCommand(SITE_ID, MACHINE_ID, commandId, activeHoursRefusal({ start: 8, end: 17 }));

  await expect(page.getByText('restart refused: inside active hours 08:00–17:00')).toBeVisible({ timeout: 10_000 });
  await expect(card.getByTestId('machine-status-cancel-pill')).toHaveCount(0);
});

test('a machine whose agent guards nothing keeps today\'s confirm', async ({ page }) => {
  // the window holds now, but an agent without the capability ignores it all
  await seedMachine(SITE_ID, MACHINE_ID, { activeHours: activeHoursAroundNow(true) });
  const card = await machineCard(page);
  await openFromMenu(page, card, 'machine-context-menu-reboot');

  const dialog = page.getByRole('dialog', { name: `restart ${MACHINE_ID}?` });
  await expect(dialog).toContainText('restart the machine in 60 seconds');
  await expect(dialog.getByTestId('active-hours-notice')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /^restart$/ })).toBeVisible();
});
