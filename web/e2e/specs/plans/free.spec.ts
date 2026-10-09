/**
 * plans — owlette free and core, end to end, through the entitlement seam.
 *
 * the e2e server runs with PLAN_ENFORCEMENT=on and OWLETTE_E2E=1, so a payer's
 * plan is whatever `e2e_entitlements/{uid}` holds, and a payer without that doc
 * fails open (playwright.config.ts). only this spec's own payer ever gets one:
 * a dedicated member who owns one site with one machine, signed in fresh per
 * test, never a shared fixture user. each test sets the plan it needs.
 */

import crypto from 'crypto';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine, seedSite, seedUser, type TestUser } from '../../helpers/seed';

test.use({ storageState: { cookies: [], origins: [] } });

const SITE_ID = 'plan-site';
// cardFor filters on hasText, so no machine id may contain another.
const LIVE_MACHINE = 'plan-live-machine';
const EXTRA_MACHINE = 'plan-extra-machine';
const PAIRING_MACHINE = 'plan-pairing-machine';
const REFUSED_SITE = 'plan-second-site';
const COMMANDS = `/api/sites/${SITE_ID}/machines/${LIVE_MACHINE}/commands`;

const MACHINE_LIMIT_ERROR = 'owlette free covers one machine. upgrade to add more, or remove a machine first.';

const PAYER: TestUser = {
  uid: 'plan-owner-uid',
  email: 'plan-owner@e2e.test',
  password: 'e2e-plan-owner-password',
  role: 'member',
  sites: [SITE_ID],
  siteRoles: { [SITE_ID]: 'owner' },
  displayName: 'E2E Plan Owner',
};

const PLAN_FLAGS = [
  'owlette.control',
  'owlette.deployments',
  'owlette.swoop',
  'owlette.hoot',
  'owlette.roost',
  'owlette.talons',
  'owlette.webhooks',
  'owlette.api_keys',
];
const flags = (value: '0' | '1') => Object.fromEntries(PLAN_FLAGS.map((flag) => [flag, value]));

/** owlette free: tridant's defaults for an unmapped payer. */
const FREE = {
  resolved: false,
  standing: 'expired',
  ent: { ...flags('0'), 'owlette.machines': '1', 'owlette.sites': '1' },
};

/** core: control on one site; deployments, swoop, hoot and the rest of pro withheld. */
const CORE = {
  resolved: true,
  standing: 'active',
  ent: { ...flags('0'), 'owlette.control': '1', 'owlette.machines': 'unlimited', 'owlette.sites': '1' },
};

const entitlementDoc = () => getAdminDb().collection('e2e_entitlements').doc(PAYER.uid);
const machineDoc = (machineId: string) => getAdminDb().doc(`sites/${SITE_ID}/machines/${machineId}`);
const pendingDoc = () => getAdminDb().doc(`sites/${SITE_ID}/machines/${LIVE_MACHINE}/commands/pending`);

let pairPhrase: string | null = null;

async function setPlan(plan: typeof FREE | typeof CORE): Promise<void> {
  await entitlementDoc().set(plan);
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(PAYER.email);
  await page.getByLabel(/password/i).first().fill(PAYER.password);
  await page.getByRole('button', { name: /sign in with email/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
}

function cardFor(page: Page, machineId: string): Locator {
  return page.getByTestId('machine-card').filter({ hasText: machineId });
}

/** the menu portals out of the card, so it is reached by role. */
async function openMenu(page: Page, card: Locator): Promise<Locator> {
  await card.getByTestId('machine-context-menu-trigger').click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  return menu;
}

/** a command sent as the dashboard sends one: the page's own fetch, on its session. */
async function sendCommand(
  page: Page,
  type: string,
  params: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return page.evaluate(
    async ([url, body, key]) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    },
    [COMMANDS, { type, params }, crypto.randomUUID()] as const,
  );
}

async function pendingTypes(): Promise<string[]> {
  const snap = await pendingDoc().get();
  return Object.values(snap.data() ?? {}).map((command) => (command as { type: string }).type);
}

test.beforeAll(async () => {
  // named to sort after the baseline sites, so even a leftover never displaces site-A as a superadmin's default.
  await seedSite({ id: SITE_ID, name: 'Site Z (Plan)', owner: PAYER.uid, timezone: 'UTC' });
  await seedUser(PAYER);
  await seedMachine(SITE_ID, LIVE_MACHINE, { monitorCount: 0 });
  // after seedMachine, which writes without merge. pairedAt makes this the machine free keeps live.
  await machineDoc(LIVE_MACHINE).set(
    { capabilities: { displayRemoteApply: 1, swoop: 1 }, pairedAt: new Date(Date.now() - 86_400_000) },
    { merge: true },
  );
});

test.beforeEach(async () => {
  await pendingDoc().delete();
});

test.afterAll(async () => {
  const db = getAdminDb();
  await Promise.all(
    [
      entitlementDoc(),
      pendingDoc(),
      machineDoc(LIVE_MACHINE),
      machineDoc(EXTRA_MACHINE),
      db.doc(`sites/${SITE_ID}/members/${PAYER.uid}`),
      // only there if the site refusal regressed.
      db.doc(`sites/${REFUSED_SITE}/members/${PAYER.uid}`),
      db.doc(`sites/${REFUSED_SITE}`),
      ...(pairPhrase ? [db.collection('device_codes').doc(pairPhrase)] : []),
    ].map((ref) => ref.delete()),
  );
  await db.doc(`sites/${SITE_ID}`).delete();
});

test.describe('owlette free', () => {
  test.beforeEach(async () => {
    await setPlan(FREE);
  });

  test('a second machine is refused at authorize, and the agent polling it hears why', async ({ page, request }) => {
    // anonymous, as an installer asks: a signed-in caller would get a pre-authorized
    // code, which names no machine until the agent polls.
    const created = await request.post('/api/agent/auth/device-code', {
      data: { machineId: PAIRING_MACHINE, version: '4.1.6' },
    });
    expect(created.status()).toBe(200);
    const { pairPhrase: phrase, deviceCode } = (await created.json()) as { pairPhrase: string; deviceCode: string };
    pairPhrase = phrase;

    await signIn(page);
    await page.goto(`/add?code=${phrase}`);
    await expect(page.getByLabel(/pairing phrase/i)).toHaveValue(phrase);
    await page.getByRole('button', { name: /authorize machine/i }).click();

    await expect(page.getByText(MACHINE_LIMIT_ERROR)).toBeVisible();
    await expect(page.getByRole('heading', { name: /machine authorized/i })).toHaveCount(0);

    const code = await getAdminDb().collection('device_codes').doc(phrase).get();
    expect(code.data()).toMatchObject({ status: 'refused', refusedReason: MACHINE_LIMIT_ERROR });

    // every fielded agent prints the poll's `error`, so this is what the machine shows.
    const poll = await request.post('/api/agent/auth/device-code/poll', { data: { deviceCode } });
    expect(poll.status()).toBe(402);
    expect(await poll.json()).toEqual({ error: MACHINE_LIMIT_ERROR });
  });

  test('a second site is refused', async ({ page }) => {
    await signIn(page);
    await page.getByTestId('site-switcher-trigger').click();
    await page.getByRole('menuitem', { name: /manage sites/i }).click();
    await page
      .getByRole('dialog', { name: /manage sites/i })
      .getByRole('button', { name: 'new site', exact: true })
      .click();

    const dialog = page.getByRole('dialog', { name: /create new site/i });
    await dialog.getByLabel('site name').fill('Second Plan Site');
    await dialog.getByRole('button', { name: /customize site id/i }).click();
    await dialog.locator('#site-id').fill(REFUSED_SITE);
    const submit = dialog.getByRole('button', { name: /^create site$/i });
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(page.getByText("your plan doesn't cover another site")).toBeVisible();
    await expect(dialog).toBeVisible();
    expect((await getAdminDb().doc(`sites/${REFUSED_SITE}`).get()).exists).toBe(false);
  });

  test('remote commands are refused while an update is accepted', async ({ page }) => {
    await signIn(page);
    const menu = await openMenu(page, cardFor(page, LIVE_MACHINE));
    await expect(menu.getByTestId('machine-context-menu-control-upgrade')).toContainText('part of core');
    await expect(menu.getByTestId('machine-context-menu-reboot')).toHaveCount(0);
    await page.keyboard.press('Escape');

    const reboot = await sendCommand(page, 'reboot_machine', { delay_seconds: 30 });
    expect(reboot.status).toBe(402);
    expect(reboot.body).toMatchObject({
      code: 'plan_required',
      entitlement: 'owlette.control',
      upgradeUrl: '/settings/plan',
    });

    const update = await sendCommand(page, 'update_owlette', {
      installer_url: 'https://e2e.invalid/Owlette-Installer-v4.1.7.exe',
      target_version: '4.1.7',
      checksum_sha256: 'a'.repeat(64),
    });
    expect(update.status).toBe(202);
    expect(await pendingTypes()).toEqual(['update_owlette']);
  });

  test('the dashboard banner says owlette free and leads to the plan page', async ({ page }) => {
    await signIn(page);
    const banner = page.getByTestId('trial-banner');
    await expect(banner).toHaveAttribute('data-banner-state', 'free');
    await expect(banner).toContainText("you're on owlette free");

    await banner.getByRole('link', { name: 'upgrade' }).click();
    await expect(page).toHaveURL(/\/settings\/plan$/);
    await expect(page.getByTestId('current-plan')).toContainText('owlette free');
  });
});

test.describe('core', () => {
  test.beforeEach(async () => {
    await setPlan(CORE);
  });

  test('swoop reads part of pro, and remote commands go through', async ({ page }) => {
    await signIn(page);
    const menu = await openMenu(page, cardFor(page, LIVE_MACHINE));
    await expect(menu.getByTestId('machine-context-menu-swoop-upgrade')).toContainText('part of pro');
    await expect(menu.getByTestId('machine-context-menu-reboot')).toBeVisible();
    await page.keyboard.press('Escape');

    const reboot = await sendCommand(page, 'reboot_machine', { delay_seconds: 30 });
    expect(reboot.status).toBe(202);
    expect(await pendingTypes()).toEqual(['reboot_machine']);
  });
});

test.describe('no entitlement doc', () => {
  test('fails open: no banner and no lock, as with plans off', async ({ page }) => {
    await setPlan(FREE);
    await seedMachine(SITE_ID, EXTRA_MACHINE, { monitorCount: 0 });

    // on free, the machine without a pairedAt falls outside the one-machine limit.
    await signIn(page);
    await expect(cardFor(page, EXTRA_MACHINE).getByTestId('machine-plan-notice')).toBeVisible();
    await expect(page.getByTestId('trial-banner')).toBeVisible();

    await entitlementDoc().delete();
    const planAnswer = page.waitForResponse((res) => res.url().endsWith('/api/account/plan'));
    await page.reload();
    expect(await (await planAnswer).json()).toMatchObject({ enforced: false, reason: 'not_configured' });

    const extra = cardFor(page, EXTRA_MACHINE);
    await expect(extra).toBeVisible();
    const menu = await openMenu(page, extra);
    await expect(menu.getByTestId('machine-context-menu-reboot')).toBeVisible();
    await expect(menu.getByTestId('machine-context-menu-control-upgrade')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('machine-plan-notice')).toHaveCount(0);
    await expect(page.getByTestId('trial-banner')).toHaveCount(0);
  });
});
