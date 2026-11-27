/**
 * Alert digest — how alert emails arrive (`users/{uid}.preferences.alertDelivery`,
 * daily when unset) and the queue behind it.
 *
 * The control: it reads "daily digest" with nothing stored, saves as it moves on
 * `/settings/alerts` and in the account-settings dialog, and survives a reload.
 *
 * The queue: with the digest job running (`global/alert_digest.lastRunAt`
 * recent), a settled outage on a seeded site, run through the real
 * `/api/cron/health-check`, queues one row for a person on a digest and none for
 * a member scoped to another machine; with the job never run it queues nothing; `/api/cron/alert-digest` then "sends" it
 * once into `e2e_email_outbox` (the transport under OWLETTE_E2E, which keeps
 * every send it is given, so a second send would show). Two overlapping runs
 * still send once, a run with nothing queued sends nothing, and a person on
 * "as it happens" gets no row.
 *
 * Both crons sweep the whole emulator, so every assertion is filtered to this
 * spec's site, recipient and start time, and the queues it touched are cleared.
 */

import crypto from 'node:crypto';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { E2E_CRON_SECRET } from '../../helpers/cron';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { TEST_USERS, grantMembership, releaseFixtureSite, revokeMembership, seedSite } from '../../helpers/seed';

test.use(roleState('admin'));

const ADMIN = TEST_USERS.admin;
const MEMBER = TEST_USERS.member;
const SUFFIX = crypto.randomBytes(4).toString('hex');
const SITE = `digest-${SUFFIX}`;
const MACHINE = `kiosk-${SUFFIX}`;
const SECOND_MACHINE = `wall-${SUFFIX}`;
const THIRD_MACHINE = `lobby-${SUFFIX}`;
const STARTED = Date.now();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const db = () => getAdminDb();
const userRef = (uid: string) => db().collection('users').doc(uid);
const digestRef = (uid: string) => db().collection('alert_digests').doc(uid);
// the digest job's last run: senders queue only while it is recent
const jobStatus = () => db().collection('global').doc('alert_digest');

async function resetDelivery() {
  for (const uid of [ADMIN.uid, MEMBER.uid]) {
    await userRef(uid).set({ preferences: { alertDelivery: FieldValue.delete() } }, { merge: true });
    await db().recursiveDelete(digestRef(uid));
  }
}

async function storedDelivery(uid = ADMIN.uid): Promise<unknown> {
  return (await userRef(uid).get()).get('preferences.alertDelivery');
}

async function siteRows(uid: string) {
  const snap = await digestRef(uid).collection('digest_events').where('siteId', '==', SITE).get();
  return snap.docs;
}

async function adminOutbox() {
  const snap = await db().collection('e2e_email_outbox').where('to', '==', ADMIN.email).get();
  return snap.docs.filter((d) => (d.get('sentAt') as number) >= STARTED);
}

const cron = (request: APIRequestContext, path: string) =>
  request.get(path, { headers: { 'x-cron-secret': E2E_CRON_SECRET } });

/** a machine whose outage has been confirmed and whose site's pending set has settled */
async function seedSettledOutage(machineId: string) {
  const now = Date.now();
  await db()
    .collection('sites')
    .doc(SITE)
    .collection('machines')
    .doc(machineId)
    .set({
      online: true,
      lastHeartbeat: Timestamp.fromMillis(now - 20 * MIN),
      health: { staleSince: Timestamp.fromMillis(now - 15 * MIN) },
    });
  await db()
    .collection('sites')
    .doc(SITE)
    .set(
      { health: { offlineAlert: { pendingIds: [machineId], pendingUpdatedAt: Timestamp.fromMillis(now - 10 * MIN) } } },
      { merge: true },
    );
}

const deliveryControl = (scope: Page | ReturnType<Page['getByRole']>) =>
  scope.getByRole('combobox', { name: 'alert emails arrive' });

test.beforeAll(async () => {
  await seedSite({ id: SITE, name: 'Z Digest Site', owner: 'someone-else', timezone: 'UTC' });
  await grantMembership(SITE, ADMIN.uid, 'admin');
  // scoped to a machine that never goes down, so the outage is not theirs to hear about
  await grantMembership(SITE, MEMBER.uid, 'member', { machineIds: [`elsewhere-${SUFFIX}`] });
});

test.beforeEach(resetDelivery);

test.afterAll(async () => {
  await resetDelivery();
  for (const machineId of [MACHINE, SECOND_MACHINE, THIRD_MACHINE]) {
    await db().collection('sites').doc(SITE).collection('machines').doc(machineId).delete();
  }
  await revokeMembership(SITE, MEMBER.uid);
  await releaseFixtureSite(SITE, ADMIN.uid);
  const sent = await db().collection('e2e_email_outbox').get();
  await Promise.all(sent.docs.filter((d) => (d.get('sentAt') as number) >= STARTED).map((d) => d.ref.delete()));
});

test('/settings/alerts reads daily digest with nothing stored, and "as it happens" survives a reload', async ({ page }) => {
  await page.goto('/settings/alerts');

  const control = deliveryControl(page);
  await expect(control).toHaveText('daily digest');
  await expect(page.getByText(/one email at 8:00 am your time/)).toBeVisible();

  await control.click();
  await page.getByRole('option', { name: 'as it happens' }).click();

  await expect.poll(() => storedDelivery()).toBe('immediate');
  await page.reload();
  await expect(deliveryControl(page)).toHaveText('as it happens');
});

test('the account-settings dialog has the same control, saved without "save changes"', async ({ page }) => {
  await page.goto('/dashboard');
  await page.getByTestId('user-menu-trigger').click();
  await page.getByRole('menuitem', { name: /account settings/i }).click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: /^alerts$/i }) });
  await dialog.getByRole('button', { name: /^alerts$/i }).first().click();

  const control = deliveryControl(dialog);
  await expect(control).toHaveText('daily digest');
  await control.click();
  await page.getByRole('option', { name: 'weekly digest' }).click();
  await expect.poll(() => storedDelivery()).toBe('weekly');

  // the named timezone links to where it is set, and the picker there is live
  await dialog.getByRole('button', { name: 'change', exact: true }).click();
  await expect(dialog.locator('#timezone')).toBeEnabled();
});

test('an outage queues for a person on a digest, and the digest sends it once', async ({ request }) => {
  await jobStatus().set({ lastRunAt: Date.now() }, { merge: true });
  await seedSettledOutage(MACHINE);

  const check = await cron(request, '/api/cron/health-check');
  expect(check.status(), await check.text()).toBe(200);
  expect((await check.json()).alertsQueued).toBeGreaterThanOrEqual(1);

  const rows = await siteRows(ADMIN.uid);
  expect(rows.map((r) => [r.get('machineId'), r.get('kind'), r.get('category')])).toEqual([[MACHINE, 'offline', 'healthAlerts']]);
  expect(await siteRows(MEMBER.uid)).toHaveLength(0);
  expect(await adminOutbox()).toHaveLength(0);

  // as if queued two days ago, so the admin's 8:00 utc has passed
  await rows[0].ref.update({ queuedAt: Timestamp.fromMillis(Date.now() - 2 * DAY) });
  const run = await cron(request, '/api/cron/alert-digest');
  expect(run.status(), await run.text()).toBe(200);

  const sent = await adminOutbox();
  expect(sent).toHaveLength(1);
  const email = sent[0].data();
  expect(email.subject).toContain('daily digest');
  expect(email.html).toContain(MACHINE);
  expect(email.html).toContain('offline');
  expect(email.headers).toMatchObject({
    'List-Unsubscribe': expect.stringMatching(/^<http.+\/api\/unsubscribe\?token=.+>$/),
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  });
  expect(email.idempotencyKey).toMatch(new RegExp(`^alert-digest/${ADMIN.uid}/daily:`));
  expect(await siteRows(ADMIN.uid)).toHaveLength(0);
  expect((await digestRef(ADMIN.uid).get()).get('pending')).toBe(false);
});

test('two overlapping runs send once, and a run with nothing queued sends nothing', async ({ request }) => {
  const queuedAt = Timestamp.fromMillis(Date.now() - 2 * DAY);
  await digestRef(ADMIN.uid).set({ pending: true, lastQueuedAt: queuedAt });
  await digestRef(ADMIN.uid).collection('digest_events').doc(`e2e-${SUFFIX}`).set({
    siteId: SITE,
    machineId: MACHINE,
    category: 'healthAlerts',
    kind: 'offline',
    severity: 'critical',
    title: 'offline',
    detail: '',
    data: {},
    at: Date.now() - 2 * DAY,
    queuedAt,
    deleteAt: Timestamp.fromMillis(Date.now() + 12 * DAY),
  });
  const before = (await adminOutbox()).length;

  const runs = await Promise.all([cron(request, '/api/cron/alert-digest'), cron(request, '/api/cron/alert-digest')]);
  for (const run of runs) expect(run.status(), await run.text()).toBe(200);
  expect(await adminOutbox()).toHaveLength(before + 1);

  const again = await cron(request, '/api/cron/alert-digest');
  expect(again.status()).toBe(200);
  expect(await adminOutbox()).toHaveLength(before + 1);
});

test('a person on "as it happens" gets no queued row', async ({ request }) => {
  await userRef(ADMIN.uid).set({ preferences: { alertDelivery: 'immediate' } }, { merge: true });
  await seedSettledOutage(SECOND_MACHINE);

  const check = await cron(request, '/api/cron/health-check');
  expect(check.status(), await check.text()).toBe(200);

  // the outage did fire (its cooldown is stamped), and still nothing was queued
  const machine = await db().collection('sites').doc(SITE).collection('machines').doc(SECOND_MACHINE).get();
  expect(machine.get('health.lastCronAlertAt')).toBeDefined();
  expect(await siteRows(ADMIN.uid)).toHaveLength(0);
});

test('with the digest job never run, an outage is emailed as it happens and nothing is queued', async ({ request }) => {
  await jobStatus().delete();
  await seedSettledOutage(THIRD_MACHINE);

  const check = await cron(request, '/api/cron/health-check');
  expect(check.status(), await check.text()).toBe(200);

  const machine = await db().collection('sites').doc(SITE).collection('machines').doc(THIRD_MACHINE).get();
  expect(machine.get('health.lastCronAlertAt')).toBeDefined();
  expect(await siteRows(ADMIN.uid)).toHaveLength(0);
});
