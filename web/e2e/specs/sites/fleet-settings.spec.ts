/**
 * the grant that lets a machine act on other machines of its site (ADR 0017),
 * on the admin panel's hoot page. raising a machine's tier takes a session that
 * passed a second factor, so a site admin who signs in with totp turns it on,
 * adds a sender at tier 2 with one machine, and finds it kept after a reload.
 * the owner fixture holds no factor: its raise is refused and the grant keeps
 * its tier. a member is turned away from the admin panel, so never sees the page.
 */

import crypto from 'crypto';
import { test, expect, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { getAdminDb } from '../../helpers/emulator';
import { dedicatedUser, seedDedicatedUser } from '../../helpers/coverageSeed';
import { roleState } from '../../helpers/roles';
import { seedMachine, type TestUser } from '../../helpers/seed';
import { unspentTotp } from '../../helpers/totp';

authenticator.options = { step: 30, window: 1 };

const SITE_ID = 'site-C';
const SENDER = 'e2e-fleet-sender';
const TARGET = 'e2e-fleet-target';

const fleetDoc = () => getAdminDb().doc(`sites/${SITE_ID}/settings/fleet`);
const machineDoc = (id: string) => getAdminDb().doc(`sites/${SITE_ID}/machines/${id}`);

// an admin of site-C alone, so the admin panel opens on it
let admin: TestUser;
let adminSecret = '';

test.beforeAll(async () => {
  await seedMachine(SITE_ID, SENDER, { monitorCount: 0 });
  await seedMachine(SITE_ID, TARGET, { monitorCount: 0 });
  await fleetDoc().delete();

  admin = await seedDedicatedUser({
    ...dedicatedUser('admin', `fleet-settings-${crypto.randomBytes(4).toString('hex')}`),
    sites: [SITE_ID],
  });
  adminSecret = authenticator.generateSecret();
  await getAdminDb().collection('users').doc(admin.uid).set(
    {
      mfaEnrolled: true,
      requiresMfaSetup: false,
      mfaSecret: adminSecret,
      mfaFactors: { totp: true, passkeys: 0 },
      backupCodes: [crypto.createHash('sha256').update('ABCDEF12').digest('hex')],
    },
    { merge: true },
  );
});

test.afterAll(async () => {
  await fleetDoc().delete();
  await machineDoc(SENDER).delete();
  await machineDoc(TARGET).delete();
});

async function signInWithCode(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(admin.email);
  await page.getByLabel(/password/i).first().fill(admin.password);
  await page.getByRole('button', { name: /sign in with email/i }).click();
  await expect(page).toHaveURL(/\/verify-2fa/, { timeout: 20_000 });
  await page.getByPlaceholder('000000').fill(await unspentTotp(page, adminSecret));
  await page.getByRole('button', { name: /^verify$/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
}

test.describe('an admin of site-C who passed a second factor', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  // the second sign-in waits for the next totp period: up to 31 s
  test.setTimeout(90_000);

  test('turns it on, adds a sender at tier 2 with one machine, and keeps it across a reload', async ({ page }) => {
    await signInWithCode(page);
    await page.goto('/admin/hoot');

    const enable = page.getByRole('switch', { name: 'let machines act on other machines' });
    await expect(enable).toHaveAttribute('aria-checked', 'false');
    // off, the machines are not listed: one line says how to get them
    await expect(page.getByText('turn this on to choose which machines may act.')).toBeVisible();
    await expect(page.getByTestId('fleet-senders')).toHaveCount(0);
    await enable.click();
    await expect(enable).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('turn this on to choose which machines may act.')).toHaveCount(0);

    const row = page.getByTestId(`fleet-sender-${SENDER}`);
    await row.getByRole('switch').click();
    // a new sender starts at the lowest tier, picking its machines, and says it reaches none yet
    await expect(row.getByRole('combobox', { name: `${SENDER} on which machines` })).toHaveText('chosen machines');
    await expect(row.getByTestId(`fleet-sender-${SENDER}-machines`)).toBeVisible();
    const nothing = row.getByText('reaches no machines yet: pick them under on which machines.');
    await expect(nothing).toBeVisible();

    await row.getByRole('combobox', { name: `${SENDER} how far` }).click();
    await page.getByRole('option', { name: 'bounded changes' }).click();
    await expect(row.getByText('shell commands')).toHaveCount(0);

    await row.getByTestId(`fleet-sender-${SENDER}-machines`).click();
    await page.getByRole('checkbox', { name: TARGET }).click();
    await expect(nothing).toHaveCount(0);

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
    await signInWithCode(page);
    await page.goto('/admin/hoot');

    const row = page.getByTestId(`fleet-sender-${SENDER}`);
    await expect(row.getByText('shell commands')).toHaveCount(0);
    await row.getByRole('combobox', { name: `${SENDER} how far` }).click();
    await page.getByRole('option', { name: 'privileged' }).click();

    await expect(row.getByText('privileged runs shell commands on the machines it may act on, with nobody approving.')).toBeVisible();
    await expect.poll(async () => (await fleetDoc().get()).data()?.senders?.[SENDER]).toEqual({ maxTier: 3 });
  });
});

test.describe('owner of site-C, with no second factor', () => {
  test.use(roleState('owner'));

  test('raising a tier is refused, and the grant keeps its tier', async ({ page }) => {
    await fleetDoc().set({ enabled: true, senders: { [SENDER]: { maxTier: 1 } } });
    await page.goto('/admin/hoot');

    const row = page.getByTestId(`fleet-sender-${SENDER}`);
    await row.getByRole('combobox', { name: `${SENDER} how far` }).click();
    await page.getByRole('option', { name: 'bounded changes' }).click();

    await expect(page.getByText('could not change which machines may act on others')).toBeVisible();
    await expect(row.getByRole('combobox', { name: `${SENDER} how far` })).toHaveText('read');
    expect((await fleetDoc().get()).data()?.senders?.[SENDER]).toEqual({ maxTier: 1 });
  });
});

test.describe('member of site-A', () => {
  test.use(roleState('member'));

  test('does not see the page', async ({ page }) => {
    await page.goto('/admin/hoot');

    // the admin panel turns a plain member away to the dashboard
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('switch', { name: 'let machines act on other machines' })).toHaveCount(0);
    await expect(page.getByTestId('fleet-senders')).toHaveCount(0);
  });
});
