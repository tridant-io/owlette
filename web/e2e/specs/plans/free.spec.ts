/**
 * plans — owlette free and core, end to end, through the entitlement seam.
 *
 * a site's plan is whatever `e2e_entitlements/site:{siteId}` holds, and a site
 * without that doc fails open (e2e/helpers/plans.ts). only this spec's own site
 * ever gets one: a dedicated member owns one site with one machine, and a
 * dedicated site admin shares it, each signed in fresh per test, never a shared
 * fixture user. each test sets the plan it needs.
 */

import crypto from 'crypto';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { getAdminAuth, getAdminDb } from '../../helpers/emulator';
import { CORE, FREE, clearPlanState, endTrial, signIn, siteEntitlements } from '../../helpers/plans';
import { revokeMembership, seedMachine, seedSite, seedUser, type TestUser } from '../../helpers/seed';

test.use({ storageState: { cookies: [], origins: [] } });

const SITE_ID = 'plan-site';
// cardFor filters on hasText, so no machine id may contain another.
const LIVE_MACHINE = 'plan-live-machine';
const EXTRA_MACHINE = 'plan-extra-machine';
const PAIRING_MACHINE = 'plan-pairing-machine';
const COMMANDS = `/api/sites/${SITE_ID}/machines/${LIVE_MACHINE}/commands`;
const BILLING_SECTION = `/admin/sites/${SITE_ID}?section=billing`;

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

/** a site admin of the same site: a member who is not the owner, and who manages its machines. */
const SITE_ADMIN: TestUser = {
  uid: 'plan-admin-uid',
  email: 'plan-admin@e2e.test',
  password: 'e2e-plan-admin-password',
  role: 'member',
  sites: [SITE_ID],
  siteRoles: { [SITE_ID]: 'admin' },
  displayName: 'E2E Plan Admin',
};

const machineDoc = (machineId: string) => getAdminDb().doc(`sites/${SITE_ID}/machines/${machineId}`);
const pendingDoc = () => getAdminDb().doc(`sites/${SITE_ID}/machines/${LIVE_MACHINE}/commands/pending`);

let pairPhrase: string | null = null;

async function setPlan(plan: typeof FREE | typeof CORE): Promise<void> {
  await siteEntitlements(SITE_ID).set(plan);
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
  await seedUser(SITE_ADMIN);
  await endTrial(PAYER.uid);
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
  await clearPlanState([PAYER.uid, SITE_ADMIN.uid], [SITE_ID]);
  await revokeMembership(SITE_ID, SITE_ADMIN.uid);
  await db.doc(`users/${SITE_ADMIN.uid}`).delete();
  await getAdminAuth().deleteUser(SITE_ADMIN.uid).catch(() => undefined);
  await Promise.all(
    [
      pendingDoc(),
      machineDoc(LIVE_MACHINE),
      machineDoc(EXTRA_MACHINE),
      db.doc(`sites/${SITE_ID}/members/${PAYER.uid}`),
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

    await signIn(page, PAYER);
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

  test('a second site asks for a plan in the create dialog', async ({ page }) => {
    await signIn(page, PAYER);
    await page.getByTestId('site-switcher-trigger').click();
    await page.getByRole('menuitem', { name: /manage sites/i }).click();
    await expect(page).toHaveURL(/\/admin\/sites$/);
    await page.getByRole('button', { name: 'new site', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: /create new site/i });
    await expect(dialog.getByTestId('create-site-plan')).toContainText(
      'owlette free covers one site, and Site Z (Plan) is on it. pick a plan for this one.',
    );
    const plans = dialog.getByRole('radiogroup', { name: 'plan' });
    await expect(plans.getByRole('radio', { name: /^pro/ })).toHaveAttribute('aria-checked', 'true');
    await dialog.getByLabel('site name').fill('Second Plan Site');
    await expect(dialog.getByRole('button', { name: 'create on pro' })).toBeEnabled();

    await plans.getByRole('radio', { name: /^core/ }).click();
    await expect(plans.getByRole('radio', { name: /^core/ })).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.getByRole('button', { name: 'create on core' })).toBeEnabled();
    await expect(dialog.getByRole('button', { name: 'create site' })).toHaveCount(0);

    // creating goes on to checkout, which plans/billing.spec.ts follows.
    await dialog.getByRole('button', { name: 'cancel' }).click();
    await expect(dialog).toBeHidden();
  });

  test("remote commands are refused while an update is accepted, and the owner's lock leads to billing", async ({ page }) => {
    await signIn(page, PAYER);
    const menu = await openMenu(page, cardFor(page, LIVE_MACHINE));
    const upgrade = menu.getByTestId('machine-context-menu-control-upgrade');
    await expect(upgrade).toContainText('part of core');
    await expect(upgrade).toHaveAttribute('href', BILLING_SECTION);
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

  test("the dashboard banner says the site is on owlette free and leads to its billing; the plan page lists it with no banner", async ({
    page,
  }) => {
    await signIn(page, PAYER);
    const banner = page.getByTestId('trial-banner');
    await expect(banner).toHaveAttribute('data-banner-state', 'free');
    await expect(banner).toContainText('this site is on owlette free');
    await expect(banner).not.toContainText('ask the site owner');

    await banner.getByRole('link', { name: 'upgrade' }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/sites/${SITE_ID}\\?section=billing$`));

    // a plan belongs to a site, and the plan page is about none
    await page.goto('/settings/plan');
    const row = page.getByTestId(`plan-site-${SITE_ID}`);
    await expect(row).toContainText('Site Z (Plan)');
    await expect(row).toContainText('owlette free');
    await expect(row.getByRole('link', { name: 'billing for Site Z (Plan)' })).toHaveAttribute('href', BILLING_SECTION);
    await expect(page.getByTestId('trial-banner')).toHaveCount(0);

    // the one free site, and its one machine, are all owlette free allows.
    const usage = page.getByTestId('free-usage');
    await expect(usage.locator('dt')).toHaveText(['sites', 'machines']);
    await expect(usage.locator('dd')).toHaveText(['1 of 1', '1 of 1']);
  });
});

test.describe('core', () => {
  test.beforeEach(async () => {
    await setPlan(CORE);
  });

  test('swoop and hoot read part of pro, and remote commands go through', async ({ page }) => {
    await signIn(page, PAYER);
    const menu = await openMenu(page, cardFor(page, LIVE_MACHINE));
    await expect(menu.getByTestId('machine-context-menu-swoop-upgrade')).toContainText('part of pro');
    await expect(menu.getByTestId('machine-context-menu-hoot-upgrade')).toContainText('part of pro');
    await expect(menu.getByTestId('machine-context-menu-hoot')).toHaveCount(0);
    await expect(menu.getByTestId('machine-context-menu-reboot')).toBeVisible();
    await page.keyboard.press('Escape');

    const reboot = await sendCommand(page, 'reboot_machine', { delay_seconds: 30 });
    expect(reboot.status).toBe(202);
    expect(await pendingTypes()).toEqual(['reboot_machine']);
  });

  test("the swoop viewer says swoop is part of pro, sends the owner to the site's billing, and stops", async ({ page }) => {
    await signIn(page, PAYER);
    await page.goto(`/swoop/${SITE_ID}/${LIVE_MACHINE}`);
    const notice = page.getByRole('alert').filter({ hasText: 'swoop is part of pro.' });
    await expect(notice).toBeVisible();
    await expect(notice.getByRole('link', { name: 'upgrade' })).toHaveAttribute('href', BILLING_SECTION);
    await expect(notice).not.toContainText(/reconnecting in|turn it on/);
  });
});

test.describe('no entitlement doc', () => {
  test('fails open: no banner and no lock, as with plans off', async ({ page }) => {
    await setPlan(FREE);
    await seedMachine(SITE_ID, EXTRA_MACHINE, { monitorCount: 0 });

    // on free, the machine without a pairedAt falls outside the one-machine limit.
    await signIn(page, PAYER);
    await expect(cardFor(page, EXTRA_MACHINE).getByTestId('machine-plan-notice')).toBeVisible();
    await expect(page.getByTestId('trial-banner')).toBeVisible();

    await siteEntitlements(SITE_ID).delete();
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

// the server counts the owner's free sites and names the machines owlette free keeps live, so a site
// admin sees the lock the owner sees, and is told to ask the owner where the owner gets a link.
test.describe('a site admin, who is not the owner', () => {
  test.beforeEach(async () => {
    await setPlan(FREE);
    await seedMachine(SITE_ID, EXTRA_MACHINE, { monitorCount: 0 });
  });

  test('sees the machine past the limit locked, and reads ask the site owner on a locked feature', async ({ page }) => {
    await signIn(page, SITE_ADMIN);

    const extra = cardFor(page, EXTRA_MACHINE);
    await expect(extra.getByTestId('machine-plan-notice')).toHaveText(
      'owlette free covers 1 machine. ask the site owner to upgrade this site to see this one.',
    );
    await expect(extra.getByRole('link', { name: 'upgrade' })).toHaveCount(0);
    // a locked machine offers no configuration, to an admin either.
    await expect(extra.getByRole('button', { name: /^add process$/i })).toHaveCount(0);
    await expect(cardFor(page, LIVE_MACHINE).getByTestId('machine-plan-notice')).toHaveCount(0);

    const menu = await openMenu(page, cardFor(page, LIVE_MACHINE));
    const locked = menu.getByTestId('machine-context-menu-control-upgrade');
    await expect(locked).toContainText('part of core');
    await expect(locked).toContainText('ask the site owner to upgrade this site');
    await expect(locked.locator('a')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // the site's plan is the same for everyone on it, and only its owner can change it
    const banner = page.getByTestId('trial-banner');
    await expect(banner).toHaveAttribute('data-banner-state', 'free');
    await expect(banner).toContainText('this site is on owlette free');
    await expect(banner).toContainText('ask the site owner to upgrade this site.');
    await expect(banner.getByRole('link')).toHaveCount(0);
  });
});
