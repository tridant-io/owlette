/**
 * swoop — the session api and the viewer page's gates, against the emulators.
 *
 * what this can and cannot prove: the emulator has no streamer, so a minted
 * session never gets a host and the page stays at "connecting". everything up
 * to that line is here — who may start a session, what a second factor buys,
 * what the record says, how it ends, and how two viewers share a machine —
 * and the media path itself is proven on real machines, not here.
 *
 * `storageState` is emptied and each test signs in itself: the fixture users
 * carry no second factor, and control needs one.
 */

import crypto from 'crypto';
import { test, expect, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { getAdminDb } from '../../helpers/emulator';
import { dedicatedUser, seedDedicatedUser } from '../../helpers/coverageSeed';
import { grantMembership, seedMachine, seedSite, type TestUser } from '../../helpers/seed';

authenticator.options = { step: 30, window: 1 };
test.use({ storageState: { cookies: [], origins: [] } });
// a step-up right after a sign-in waits for the next totp period: up to 31 s.
test.setTimeout(120_000);

const SUFFIX = crypto.randomBytes(4).toString('hex');
const SITE_ID = `site-swoop-${SUFFIX}`;
const MACHINE_ID = `mach-swoop-${SUFFIX}`;
const EXCLUDED_ID = `mach-excluded-${SUFFIX}`;
const OFFLINE_ID = `mach-offline-${SUFFIX}`;
const SESSIONS = `/api/sites/${SITE_ID}/machines/${MACHINE_ID}/swoop/sessions`;
const KILL = `/api/sites/${SITE_ID}/machines/${MACHINE_ID}/swoop/kill`;

/** a browser dtls fingerprint, in the canonical shape the api checks. */
const fingerprint = (seed: number): string =>
  `sha-256 ${Array.from({ length: 32 }, (_, i) => ((seed * 31 + i * 7) % 256).toString(16).padStart(2, '0').toUpperCase()).join(':')}`;

const CLIENT_CAPS = { codecs: ['h264'], hardware: [], playoutDelay: true, webCodecsHevc: false };

let operator: TestUser;
let operatorSecret = '';
let watcher: TestUser;

async function seedTotpUser(suffix: string): Promise<{ user: TestUser; secret: string }> {
  const user = await seedDedicatedUser(dedicatedUser('member', suffix));
  const secret = authenticator.generateSecret();
  await getAdminDb().collection('users').doc(user.uid).set(
    {
      mfaEnrolled: true,
      requiresMfaSetup: false,
      mfaSecret: secret,
      mfaFactors: { totp: true, passkeys: 0 },
      backupCodes: [crypto.createHash('sha256').update('ABCDEF12').digest('hex')],
    },
    { merge: true },
  );
  return { user, secret };
}

/**
 * a code that is not the one just spent: the api refuses a replayed totp, and
 * the sign-in spent this period's, so a step-up straight after it waits for
 * the next period. `spent` is the code to move past; with none, only a period
 * about to roll over is waited out.
 */
async function freshTotp(page: Page, secret: string, spent?: string): Promise<string> {
  let code = authenticator.generate(secret);
  if (spent !== undefined && code === spent) {
    await page.waitForTimeout((authenticator.timeRemaining() + 1) * 1000);
    code = authenticator.generate(secret);
  } else if (authenticator.timeRemaining() <= 5) {
    await page.waitForTimeout((authenticator.timeRemaining() + 1) * 1000);
    code = authenticator.generate(secret);
  }
  return code;
}

/** the page's own refusal line, not next's route announcer. */
const alertLine = (page: Page) => page.locator('p[role="alert"]');

/** signs in; returns the totp code the sign-in spent, so the next ceremony can move past it. */
async function signIn(page: Page, user: TestUser, secret?: string): Promise<string | undefined> {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(user.email);
  await page.getByLabel(/password/i).first().fill(user.password);
  await page.getByRole('button', { name: /sign in with email/i }).click();
  let spent: string | undefined;
  if (secret) {
    await expect(page).toHaveURL(/\/verify-2fa/, { timeout: 20_000 });
    spent = await freshTotp(page, secret);
    await page.getByPlaceholder('000000').fill(spent);
    await page.getByRole('button', { name: /^verify$/i }).click();
  }
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
  return spent;
}

async function swoopSettings(patch: Record<string, unknown>): Promise<void> {
  await getAdminDb().doc(`sites/${SITE_ID}/settings/swoop`).set(patch, { merge: true });
}

interface ApiReply {
  status: number;
  body: Record<string, unknown>;
}

/**
 * an api call made from inside the page: same origin, same cookies, the same
 * fetch the app itself makes. a playwright request context on a second
 * browser context answered "no valid session" where the page's own fetch
 * did not, so the page's is the one used.
 */
async function apiCall(page: Page, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<ApiReply> {
  return page.evaluate(
    async ([m, p, b]) => {
      const res = await fetch(p as string, {
        method: m as string,
        headers: { 'Content-Type': 'application/json' },
        body: b === undefined ? undefined : JSON.stringify(b),
      });
      const text = await res.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = { raw: text };
      }
      return { status: res.status, body: parsed };
    },
    [method, path, body] as const,
  );
}

async function readSession(page: Page, sid: string): Promise<Record<string, unknown>> {
  const res = await apiCall(page, 'GET', `${SESSIONS}/${sid}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as Record<string, unknown>;
}

/** every swoop api answer the page received, for the failure message. */
function recordSwoopResponses(page: Page): string[] {
  const seen: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/swoop/')) seen.push(`${r.request().method()} ${r.url().split('/api')[1]} ${r.status()}`);
  });
  return seen;
}

test.beforeAll(async () => {
  await seedSite({ id: SITE_ID, name: `Swoop ${SUFFIX}`, owner: 'someone-else', timezone: 'UTC' });
  await seedMachine(SITE_ID, MACHINE_ID, { displayName: `swoop box ${SUFFIX}` });
  await seedMachine(SITE_ID, EXCLUDED_ID, { displayName: `excluded box ${SUFFIX}` });
  await seedMachine(SITE_ID, OFFLINE_ID, { displayName: `offline box ${SUFFIX}` });
  await getAdminDb().doc(`sites/${SITE_ID}/machines/${OFFLINE_ID}`).set({ online: false }, { merge: true });
  await swoopSettings({ enabled: true, excludedMachineIds: [EXCLUDED_ID], membersMayWatch: true, indicator: 'banner' });

  const seeded = await seedTotpUser(`swoop-operator-${SUFFIX}`);
  operator = seeded.user;
  operatorSecret = seeded.secret;
  await grantMembership(SITE_ID, operator.uid, 'admin');

  watcher = await seedDedicatedUser(dedicatedUser('member', `swoop-watcher-${SUFFIX}`));
  await getAdminDb()
    .collection('users')
    .doc(watcher.uid)
    .set({ mfaEnrolled: false, requiresMfaSetup: false, mfaFactors: { totp: false, passkeys: 0 } }, { merge: true });
  await grantMembership(SITE_ID, watcher.uid, 'member');
});

test.describe('the viewer page', () => {
  test('control needs a live second factor: a code opens the session, and the record follows it to its end', async ({
    page,
  }) => {
    const spent = await signIn(page, operator, operatorSecret);
    const seen = recordSwoopResponses(page);
    await page.goto(`/swoop/${SITE_ID}/${MACHINE_ID}`);

    // the first mint is refused with step_up_required and the page asks.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(/confirm it.s you/i, { timeout: 20_000 });

    const minted = page.waitForResponse(
      (r) => r.url().endsWith('/swoop/sessions') && r.request().method() === 'POST' && r.status() === 201,
      { timeout: 45_000 },
    ).catch(() => null);
    await dialog.getByPlaceholder('6-digit code').fill(await freshTotp(page, operatorSecret, spent));
    await dialog.getByRole('button', { name: /^confirm$/i }).click();
    const mintResponse = await minted;
    expect(mintResponse, `swoop responses seen: ${seen.join(' | ')}`).not.toBeNull();
    const grant = ((await mintResponse!.json()) as { data: { sid: string; ctl: boolean } }).data;
    expect(grant.ctl).toBe(true);
    await expect(dialog).toBeHidden();

    // no streamer in the emulator: the page waits for the host, and says so.
    await expect(page.getByText(/connecting/i).first()).toBeVisible();

    const record = await readSession(page, grant.sid);
    expect(record.sid).toBe(grant.sid);
    expect(record.state).not.toBe('ended');
    expect((record.viewers as Array<{ uid: string; ctl: boolean }>).map((v) => [v.uid, v.ctl])).toEqual([
      [operator.uid, true],
    ]);

    // the machine was asked through the queued command, the fallback the
    // emulator always takes because no signal worker is configured here.
    const pending = await getAdminDb().doc(`sites/${SITE_ID}/machines/${MACHINE_ID}/commands/pending`).get();
    const queued = Object.values(pending.data() ?? {}) as Array<{ type?: string; sid?: string }>;
    expect(queued.some((cmd) => cmd.type === 'swoop_session_requested' && cmd.sid === grant.sid)).toBe(true);

    // ending it is one click, one DELETE, and the record says so.
    const ended = page.waitForResponse(
      (r) => r.url().includes(`/swoop/sessions/${grant.sid}`) && r.request().method() === 'DELETE',
    );
    await page.getByRole('button', { name: /end session/i }).click();
    expect((await ended).status()).toBe(200);
    const after = await readSession(page, grant.sid);
    expect(after.state).toBe('ended');
    expect(after.endReason).toBe('closed');
    await expect(page.getByRole('button', { name: /reconnect/i })).toBeVisible();
  });

  test('a member is refused control and watches instead, with no ceremony', async ({ page }) => {
    await signIn(page, watcher);
    const minted = page.waitForResponse(
      (r) => r.url().endsWith('/swoop/sessions') && r.request().method() === 'POST' && r.status() === 201,
      { timeout: 45_000 },
    );
    const seen = recordSwoopResponses(page);
    await page.goto(`/swoop/${SITE_ID}/${MACHINE_ID}`);
    const mintResponse = await minted;
    const body = (await mintResponse.json()) as { data?: { sid: string; ctl: boolean } };
    expect(body.data, `mint body: ${JSON.stringify(body).slice(0, 300)}; seen: ${seen.join(' | ')}`).toBeDefined();
    const grant = body.data!;
    expect(grant.ctl, `mint body: ${JSON.stringify(body).slice(0, 400)}; seen: ${seen.join(' | ')}`).toBe(false);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText(/view only/i)).toBeVisible();
    await expect(page.getByText(/connecting/i).first()).toBeVisible();
    await page.getByRole('button', { name: /end session/i }).click();
  });

  test('the site switch and the exclusion list refuse before any ceremony', async ({ page }) => {
    await signIn(page, operator, operatorSecret);

    await swoopSettings({ enabled: false });
    await page.goto(`/swoop/${SITE_ID}/${MACHINE_ID}`);
    await expect(alertLine(page)).toContainText('swoop is not enabled for this site.');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await swoopSettings({ enabled: true });

    await page.goto(`/swoop/${SITE_ID}/${EXCLUDED_ID}`);
    await expect(alertLine(page)).toContainText('swoop is excluded on this machine.');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

test.describe('two viewers on one machine, over the api', () => {
  test('each holds a lease of its own, and one kill ends every session', async ({ page, browser }) => {
    const operatorPage = page;
    const watcherContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const watcherPage = await watcherContext.newPage();
    let spent = await signIn(operatorPage, operator, operatorSecret);
    await signIn(watcherPage, watcher);

    // the operator's mint carries the code as its proof; the watcher's needs none.
    spent = await freshTotp(operatorPage, operatorSecret, spent);
    const controlRes = await apiCall(operatorPage, 'POST', SESSIONS, {
      control: true,
      fp: fingerprint(1),
      clientCaps: CLIENT_CAPS,
      mfaProof: { code: spent },
    });
    expect(controlRes.status, JSON.stringify(controlRes.body)).toBe(201);
    const control = controlRes.body.data as { sid: string; viewerId: string; ctl: boolean; expiresAt: number };
    expect(control.ctl).toBe(true);

    // an offline machine is refused once the gate and the ceremony have passed.
    const offline = await apiCall(operatorPage, 'POST', `/api/sites/${SITE_ID}/machines/${OFFLINE_ID}/swoop/sessions`, {
      control: true,
      fp: fingerprint(3),
      clientCaps: CLIENT_CAPS,
      // inside the step-up window a control mint needs no new code, but a
      // proof that is present is verified, so it is a fresh one.
      mfaProof: { code: await freshTotp(operatorPage, operatorSecret, spent) },
    });
    expect(offline.status, JSON.stringify(offline.body)).toBe(409);

    const watchRes = await apiCall(watcherPage, 'POST', SESSIONS, {
      control: false,
      fp: fingerprint(2),
      clientCaps: CLIENT_CAPS,
    });
    expect(watchRes.status, JSON.stringify(watchRes.body)).toBe(201);
    const watch = watchRes.body.data as { sid: string; viewerId: string; ctl: boolean };
    expect(watch.ctl).toBe(false);
    expect(watch.sid).not.toBe(control.sid);

    // a lease renews for its own viewer, bound to the fingerprint it was
    // minted with, and for nobody else's session.
    const renew = await apiCall(operatorPage, 'POST', `${SESSIONS}/${control.sid}/lease`, {
      viewerId: control.viewerId,
      fp: fingerprint(1),
    });
    expect(renew.status, JSON.stringify(renew.body)).toBe(200);
    const renewed = renew.body.data as { expiresAt: number; viewerJwt: string };
    expect(renewed.expiresAt).toBeGreaterThanOrEqual(control.expiresAt);
    expect(renewed.viewerJwt.split('.')).toHaveLength(3);

    // the token carries the fingerprint that was presented: the host is the
    // one that checks it against the peer's dtls certificate, so a renewal
    // with another browser's fingerprint mints a token that browser cannot use.
    const claims = (token: string) =>
      JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { fp: string; sid: string };
    expect(claims(renewed.viewerJwt).fp).toBe(fingerprint(1));
    const otherFp = await apiCall(operatorPage, 'POST', `${SESSIONS}/${control.sid}/lease`, {
      viewerId: control.viewerId,
      fp: fingerprint(9),
    });
    expect(otherFp.status, JSON.stringify(otherFp.body)).toBe(200);
    expect(claims((otherFp.body.data as { viewerJwt: string }).viewerJwt).fp).toBe(fingerprint(9));

    const notMine = await apiCall(watcherPage, 'POST', `${SESSIONS}/${control.sid}/lease`, {
      viewerId: control.viewerId,
      fp: fingerprint(1),
    });
    expect(notMine.status).toBeGreaterThanOrEqual(400);

    // a watcher cannot kill; the operator's kill ends both sessions.
    const watcherKill = await apiCall(watcherPage, 'POST', KILL, {});
    expect(watcherKill.status).toBe(403);
    const kill = await apiCall(operatorPage, 'POST', KILL, {});
    expect(kill.status, JSON.stringify(kill.body)).toBe(200);

    for (const sid of [control.sid, watch.sid]) {
      const record = await readSession(operatorPage, sid);
      expect(record.state).toBe('ended');
    }
    const afterKill = await apiCall(operatorPage, 'POST', `${SESSIONS}/${control.sid}/lease`, {
      viewerId: control.viewerId,
      fp: fingerprint(1),
    });
    expect(afterKill.status).toBeGreaterThanOrEqual(400);

    await watcherContext.close();
  });
});
