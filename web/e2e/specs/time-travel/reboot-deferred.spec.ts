/**
 * Time-travel — a restart held until active hours end.
 *
 * A guarded windows agent asked to restart inside its active hours with
 * `when: after_active_hours` writes `rebootDeferredUntil` (unix seconds) and no
 * countdown. The pill names that instant on the machine clock, "restart at
 * HH:MM", and stays still while time passes: as MM:SS six hours would read
 * 360:00 and overflow the list's 72px status cell. Only the agent ends the
 * hold: cancel sends `cancel_reboot`, and at the window's end the agent clears
 * the field and writes the ordinary 60 s countdown. The machine menu cancels
 * it too, and keeps restart for a person who wants it now.
 *
 * Clock pattern from reboot-countdown.spec.ts: install before goto, anchored
 * at real now so Firebase Auth keeps working, then fastForward. Seeded
 * machines run on UTC, so the machine clock reads as an ISO time.
 */

import { test, expect, type Page } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { activeHoursAroundNow, seedMachine } from '../../helpers/seed';
import { completeCommand } from '../../helpers/stubAgent';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-reboot-deferred';

function machineRef() {
  return getAdminDb().collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID);
}

/** The instant's HH:MM on a UTC machine clock. */
const utcClock = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(11, 16);

async function seedHeldRestart(inSec: number): Promise<number> {
  const until = Math.floor(Date.now() / 1000) + inSec;
  await seedMachine(SITE_ID, MACHINE_ID, {
    activeHours: activeHoursAroundNow(true),
    activeHoursGuard: true,
    rebootDeferredUntil: until,
  });
  return until;
}

async function machineCard(page: Page) {
  await page.goto('/dashboard');
  const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
  await expect(card).toBeVisible();
  return card;
}

test.beforeEach(async () => {
  const snap = await machineRef().collection('commands').get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
});

test('a held restart names its machine-clock time, holds still as time passes, and cancels with cancel_reboot', async ({ page }) => {
  await page.clock.install({ time: Date.now() });
  const until = await seedHeldRestart(6 * 3600);
  const card = await machineCard(page);

  const pill = card.getByTestId('machine-status-deferred-pill');
  await expect(pill).toHaveAccessibleName(`restart at ${utcClock(until)} (machine time) — click to cancel`);
  await expect(pill).toContainText(`restart at ${utcClock(until)}`);
  await expect(pill).not.toHaveClass(/animate-pulse/);
  await expect(card.getByTestId('machine-status-cancel-pill')).toHaveCount(0);

  // a countdown would have moved two minutes; a clock time doesn't. under the
  // 300 s heartbeat age, so the machine stays online
  await page.clock.fastForward(120_000);
  await expect(pill).toContainText(`restart at ${utcClock(until)}`);
  await expect(card.getByText(/\d{3}:\d\d/)).toHaveCount(0);

  await pill.click();
  let cancelId: string | undefined;
  await expect.poll(async () => {
    const pending = (await machineRef().collection('commands').doc('pending').get()).data() ?? {};
    cancelId = Object.keys(pending).find((id) => pending[id]?.type === 'cancel_reboot');
    return cancelId;
  }, { timeout: 5_000 }).toBeDefined();

  // the agent drops the hold and clears the field (`_handle_cancel_reboot`)
  await completeCommand(SITE_ID, MACHINE_ID, cancelId!, 'Reboot cancelled', { cmdType: 'cancel_reboot' });
  await machineRef().set({ rebootDeferredUntil: null }, { merge: true });

  await expect(pill).toHaveCount(0, { timeout: 5_000 });
  await expect(card.getByTestId('machine-status-online')).toBeVisible();
});

test('the machine menu cancels a held restart too, and still offers restart now', async ({ page }) => {
  await seedHeldRestart(6 * 3600);
  const card = await machineCard(page);

  await card.getByTestId('machine-context-menu-trigger').click();
  await expect(page.getByTestId('machine-context-menu-reboot')).toBeVisible();
  await page.getByTestId('machine-context-menu-cancel-reboot').click();

  await expect.poll(async () => {
    const pending = (await machineRef().collection('commands').doc('pending').get()).data() ?? {};
    return Object.values(pending).some((cmd) => (cmd as { type?: string })?.type === 'cancel_reboot');
  }, { timeout: 5_000 }).toBe(true);
});

test('the hold\'s time passing changes nothing until the agent fires it into the countdown', async ({ page }) => {
  const realNow = Date.now();
  await page.clock.install({ time: realNow });
  const until = await seedHeldRestart(90);
  const card = await machineCard(page);
  const pill = card.getByTestId('machine-status-deferred-pill');
  await expect(pill).toContainText(`restart at ${utcClock(until)}`);

  // past the hold's instant: the dashboard doesn't guess, the agent decides
  await page.clock.fastForward(120_000);
  await expect(pill).toContainText(`restart at ${utcClock(until)}`);

  // the agent fires it: the hold goes and the ordinary countdown takes over in
  // one write. anchored on the page's fake clock, which is ~120 s ahead
  const pageNowSec = Math.floor(realNow / 1000) + 120;
  await machineRef().set(
    { rebootDeferredUntil: null, rebooting: true, rebootScheduledAt: pageNowSec + 300, rebootSource: 'deferred' },
    { merge: true },
  );

  const countdown = card.getByTestId('machine-status-cancel-pill');
  await expect(countdown).toBeVisible({ timeout: 5_000 });
  await expect(countdown.locator('span').filter({ hasText: /^\d\d:\d\d$/ })).toBeVisible();
  await expect(pill).toHaveCount(0);
});

test('in the list the time fits the status cell, and the row is not dimmed', async ({ page }) => {
  const until = await seedHeldRestart(6 * 3600);
  await page.goto('/dashboard');
  await page.getByTestId('view-toggle-list').click();

  const row = page.getByRole('row').filter({ hasText: MACHINE_ID }).first();
  const pill = row.getByTestId('machine-status-deferred-pill');
  await expect(pill).toHaveAccessibleName(`restart at ${utcClock(until)} (machine time) — click to cancel`);
  await expect(pill).toContainText(utcClock(until));
  await expect(pill).not.toContainText('restart at');

  const cell = pill.locator('xpath=ancestor::td[1]');
  const [pillBox, cellBox] = [await pill.boundingBox(), await cell.boundingBox()];
  expect(pillBox && cellBox).toBeTruthy();
  expect(pillBox!.x + pillBox!.width).toBeLessThanOrEqual(cellBox!.x + cellBox!.width);
  expect(await cell.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

  // only `rebooting` and offline dim a row; a hold is neither
  await expect(row.getByRole('button', { name: `open cpu history for ${MACHINE_ID}` })).not.toHaveClass(/opacity-80/);
});

test.describe('at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the card keeps the time and drops the words, as the list cell does', async ({ page }) => {
    const until = await seedHeldRestart(6 * 3600);
    const card = await machineCard(page);
    const pill = card.getByTestId('machine-status-deferred-pill');
    await expect(pill).toHaveAccessibleName(`restart at ${utcClock(until)} (machine time) — click to cancel`);
    await expect(pill).toContainText(utcClock(until));
    await expect(pill.getByText('restart at')).toBeHidden();
  });
});

test.describe('a member', () => {
  test.use(roleState('member'));

  test('sees the held restart\'s time, with no cancel', async ({ page }) => {
    const until = await seedHeldRestart(6 * 3600);
    const card = await machineCard(page);
    const pill = card.getByRole('img', { name: `restart at ${utcClock(until)} (machine time)` });
    await expect(pill).toBeVisible();
    await expect(card.getByRole('button', { name: /click to cancel/ })).toHaveCount(0);
  });
});
