/**
 * the grant that lets a machine act on other machines of its site (ADR 0017),
 * in the swoop & screens section of the site's settings. an owner turns it on,
 * adds a sender at tier 2 with one machine, and finds it kept after a reload.
 * a member is turned away from the settings, so never sees the section.
 */

import { test, expect } from '@playwright/test';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { seedMachine } from '../../helpers/seed';

const SITE_ID = 'site-C';
const SENDER = 'e2e-fleet-sender';
const TARGET = 'e2e-fleet-target';

const fleetDoc = () => getAdminDb().doc(`sites/${SITE_ID}/settings/fleet`);
const machineDoc = (id: string) => getAdminDb().doc(`sites/${SITE_ID}/machines/${id}`);

test.beforeAll(async () => {
  await seedMachine(SITE_ID, SENDER, { monitorCount: 0 });
  await seedMachine(SITE_ID, TARGET, { monitorCount: 0 });
  await fleetDoc().delete();
});

test.afterAll(async () => {
  await fleetDoc().delete();
  await machineDoc(SENDER).delete();
  await machineDoc(TARGET).delete();
});

test.describe('owner of site-C', () => {
  test.use(roleState('owner'));

  test('turns it on, adds a sender at tier 2 with one machine, and keeps it across a reload', async ({ page }) => {
    await page.goto(`/admin/sites/${SITE_ID}?section=swoop`);

    const enable = page.getByRole('switch', { name: 'let machines act on other machines' });
    await expect(enable).toHaveAttribute('aria-checked', 'false');
    await enable.click();
    await expect(enable).toHaveAttribute('aria-checked', 'true');

    const row = page.getByTestId(`fleet-sender-${SENDER}`);
    await row.getByRole('switch').click();
    // a new sender starts with no machines, at the lowest tier
    await expect(row.getByRole('combobox', { name: `${SENDER} on which machines` })).toHaveText('no machines');

    await row.getByRole('combobox', { name: `${SENDER} how far` }).click();
    await page.getByRole('option', { name: 'bounded changes' }).click();
    await expect(row.getByText('shell commands')).toHaveCount(0);

    await row.getByRole('combobox', { name: `${SENDER} on which machines` }).click();
    await page.getByRole('option', { name: 'chosen machines' }).click();
    await row.getByTestId(`fleet-sender-${SENDER}-machines`).click();
    await page.getByRole('checkbox', { name: TARGET }).click();

    await expect
      .poll(async () => (await fleetDoc().get()).data())
      .toMatchObject({ enabled: true, senders: { [SENDER]: { maxTier: 2, machineIds: [TARGET] } } });

    await page.reload();
    await expect(page.getByRole('switch', { name: 'let machines act on other machines' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    const kept = page.getByTestId(`fleet-sender-${SENDER}`);
    await expect(kept.getByRole('combobox', { name: `${SENDER} how far` })).toHaveText('bounded changes');
    await expect(kept.getByRole('combobox', { name: `${SENDER} on which machines` })).toHaveText('chosen machines');
    await expect(kept.getByTestId(`fleet-sender-${SENDER}-machines`)).toHaveText(TARGET);
  });

  test('privileged shows the one warning line', async ({ page }) => {
    // its own sender, so the test stands without the one before it
    await fleetDoc().set({ enabled: true, senders: { [SENDER]: { maxTier: 1 } } });
    await page.goto(`/admin/sites/${SITE_ID}?section=swoop`);

    const row = page.getByTestId(`fleet-sender-${SENDER}`);
    await expect(row.getByText('shell commands')).toHaveCount(0);
    await row.getByRole('combobox', { name: `${SENDER} how far` }).click();
    await page.getByRole('option', { name: 'privileged' }).click();

    await expect(row.getByText('privileged runs shell commands on the machines it may act on, with nobody approving.')).toBeVisible();
  });
});

test.describe('member of site-A', () => {
  test.use(roleState('member'));

  test('does not see the section', async ({ page }) => {
    await page.goto('/admin/sites/site-A?section=swoop');

    // the admin panel turns a plain member away to the dashboard
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('switch', { name: 'let machines act on other machines' })).toHaveCount(0);
    await expect(page.getByTestId('fleet-senders')).toHaveCount(0);
  });
});
