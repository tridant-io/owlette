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
 * carry no second factor, and control needs one. a second factor passed at
 * sign-in under five minutes ago is itself the step-up, so the specs about the
 * step-up date the sign-in's back (`ageSignInCeremony`), and one spec keeps it
 * fresh.
 */

import crypto from 'crypto';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { getAdminDb } from '../../helpers/emulator';
import { dedicatedUser, seedDedicatedUser } from '../../helpers/coverageSeed';
import { grantMembership, seedMachine, seedSite, type TestUser } from '../../helpers/seed';
import { ageSignInCeremony } from '../../helpers/signInCeremony';

authenticator.options = { step: 30, window: 1 };
test.use({ storageState: { cookies: [], origins: [] } });
// a step-up right after a sign-in waits for the next totp period: up to 31 s.
test.setTimeout(120_000);

const SUFFIX = crypto.randomBytes(4).toString('hex');
const SITE_ID = `site-swoop-${SUFFIX}`;
const MACHINE_ID = `mach-swoop-${SUFFIX}`;
const EXCLUDED_ID = `mach-excluded-${SUFFIX}`;
const OFFLINE_ID = `mach-offline-${SUFFIX}`;
const RETURNING_ID = `mach-returning-${SUFFIX}`;
const RELOAD_ID = `mach-reload-${SUFFIX}`;
const CODEC_ID = `mach-codec-${SUFFIX}`;
const FRESH_ID = `mach-fresh-${SUFFIX}`;
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

/**
 * signs in; returns the totp code the sign-in spent, so the next ceremony can move
 * past it. a totp sign-in is dated ten minutes back unless `fresh`, so the step-up
 * still asks.
 */
async function signIn(
  page: Page,
  user: TestUser,
  secret?: string,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<string | undefined> {
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
  if (secret && !fresh) await ageSignInCeremony(page);
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
  await seedMachine(SITE_ID, RETURNING_ID, { displayName: `returning box ${SUFFIX}` });
  await seedMachine(SITE_ID, RELOAD_ID, { displayName: `reload box ${SUFFIX}` });
  await seedMachine(SITE_ID, CODEC_ID, { displayName: `codec box ${SUFFIX}` });
  await seedMachine(SITE_ID, FRESH_ID, { displayName: `fresh box ${SUFFIX}` });
  await getAdminDb().doc(`sites/${SITE_ID}/machines/${RETURNING_ID}`).set({ online: false }, { merge: true });
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

    // the quality menu is one row per axis with what is chosen; the options
    // sit a level down.
    await page.getByRole('button', { name: 'quality ceiling' }).click();
    const quality = page.getByRole('menu');
    await expect(quality.getByRole('menuitem')).toHaveText([
      /^bandwidth\s*auto$/,
      /^resolution\s*native$/,
      /^frame rate\s*60 fps$/,
      /^codec\s*auto$/,
    ]);
    await quality.getByRole('menuitem', { name: /^bandwidth/ }).click();
    await page.getByRole('menuitemradio', { name: '20 mbps' }).click();
    await page.getByRole('button', { name: 'quality ceiling' }).click();
    await expect(page.getByRole('menuitem', { name: /^bandwidth/ })).toHaveText(/^bandwidth\s*20 mbps$/);
    await page.keyboard.press('Escape');

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

  test('a reload keeps control after the 7-day window, without asking again', async ({ page }) => {
    const spent = await signIn(page, operator, operatorSecret);
    const sessions = `/api/sites/${SITE_ID}/machines/${RELOAD_ID}/swoop/sessions`;
    const minted = (r: { url(): string; request(): { method(): string }; status(): number }) =>
      r.url().endsWith(sessions) && r.request().method() === 'POST' && r.status() === 201;
    await page.goto(`/swoop/${SITE_ID}/${RELOAD_ID}`);

    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(/confirm it.s you/i, { timeout: 20_000 });
    const first = page.waitForResponse(minted, { timeout: 45_000 });
    await dialog.getByPlaceholder('6-digit code').fill(await freshTotp(page, operatorSecret, spent));
    await dialog.getByRole('button', { name: /^confirm$/i }).click();
    expect(((await (await first).json()) as { data: { ctl: boolean } }).data.ctl).toBe(true);
    await expect(dialog).toBeHidden();

    // the 7 days since the ceremony have passed: only the tab's own
    // continuity can bring control back now.
    const windows = await getAdminDb().collection(`users/${operator.uid}/swoop_step_up`).get();
    const lapsed = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await Promise.all(windows.docs.map((d) => d.ref.set({ openedAt: lapsed, expiresAt: lapsed + 1 }, { merge: true })));

    const again = page.waitForResponse(minted, { timeout: 45_000 });
    await page.reload();
    const response = await again;
    expect((JSON.parse(response.request().postData() ?? '{}') as { continuity?: string }).continuity).toBeTruthy();
    expect(((await response.json()) as { data: { ctl: boolean } }).data.ctl).toBe(true);
    await expect(dialog).toBeHidden();
  });

  test('a second factor passed at sign-in moments ago is the step-up for the first machine', async ({ page }) => {
    await signIn(page, operator, operatorSecret, { fresh: true });
    const sessions = `/api/sites/${SITE_ID}/machines/${FRESH_ID}/swoop/sessions`;
    const minted = page.waitForResponse(
      (r) => r.url().endsWith(sessions) && r.request().method() === 'POST',
      { timeout: 45_000 },
    );
    await page.goto(`/swoop/${SITE_ID}/${FRESH_ID}`);

    const response = await minted;
    expect(response.status(), await response.text()).toBe(201);
    expect(response.request().postDataJSON()).not.toHaveProperty('mfaProof');
    expect(((await response.json()) as { data: { ctl: boolean } }).data.ctl).toBe(true);
    await expect(page.getByText(/connecting/i).first()).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // the window rests on the sign-in's own ceremony, and the trail says why it opened
    const rows = await getAdminDb().collection(`sites/${SITE_ID}/audit_log`).where('target.id', '==', FRESH_ID).get();
    const opened = rows.docs.map((d) => d.data()).filter((row) => row.metadata?.event === 'step_up_opened');
    expect(opened.map((row) => [row.actor?.userId, row.metadata?.reason])).toEqual([[operator.uid, 'fresh_sign_in']]);

    await page.getByRole('button', { name: /end session/i }).click();
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

    // the letterbox follows the page: the night page at night, a neutral grey by day
    const stage = page.locator('video[aria-label="remote screen"]').locator('..');
    const background = (target: Locator) => target.evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(await background(stage)).toBe(await background(page.locator('body')));
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
    // zero chroma either way chrome writes it: lab(42 0 0) or oklch(0.5 0 0)
    expect(await background(stage)).toMatch(/^(?:lab|oklch)\([\d.]+ 0 0\)$/);

    await page.getByRole('button', { name: /end session/i }).click();
  });

  test('a codec choice is kept for the machine and starts a new session whose offer carries it', async ({ page }) => {
    // every offer the page makes, as it hands it to its own connection: the
    // emulator has no signalling worker to read one off.
    await page.addInitScript(() => {
      const offers: string[] = [];
      (window as unknown as { swoopOffers: string[] }).swoopOffers = offers;
      const setLocal = RTCPeerConnection.prototype.setLocalDescription;
      RTCPeerConnection.prototype.setLocalDescription = function (
        this: RTCPeerConnection,
        description?: RTCLocalSessionDescriptionInit,
      ) {
        if (description?.type === 'offer' && description.sdp) offers.push(description.sdp);
        return setLocal.call(this, description as RTCLocalSessionDescriptionInit);
      };
    });
    /** the codec names on an offer's video m-line. */
    const videoCodecs = (sdp: string): string[] => {
      const section = sdp.split(/\r?\n(?=m=)/).find((part) => part.startsWith('m=video')) ?? '';
      return [...new Set([...section.matchAll(/^a=rtpmap:\d+ ([^/]+)\//gm)].map((match) => match[1].toLowerCase()))];
    };
    const offers = () => page.evaluate(() => (window as unknown as { swoopOffers: string[] }).swoopOffers);

    // the watcher needs no ceremony, so both sessions are minted without one.
    await signIn(page, watcher);
    const sessions = `/api/sites/${SITE_ID}/machines/${CODEC_ID}/swoop/sessions`;
    const minted = (r: { url(): string; request(): { method(): string }; status(): number }) =>
      r.url().endsWith(sessions) && r.request().method() === 'POST' && r.status() === 201;
    const deletes: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'DELETE' && r.url().includes('/swoop/sessions/')) deletes.push(r.url());
    });

    const first = page.waitForResponse(minted, { timeout: 45_000 });
    await page.goto(`/swoop/${SITE_ID}/${CODEC_ID}`);
    await first;
    await expect.poll(async () => (await offers()).length).toBe(1);
    expect(videoCodecs((await offers())[0])).toContain('vp8');

    await page.getByRole('button', { name: 'quality ceiling' }).click();
    await page.getByRole('menuitem', { name: /^codec/ }).click();
    await expect(page.getByText('reconnects to apply.')).toBeVisible();
    const second = page.waitForResponse(minted, { timeout: 45_000 });
    await page.getByRole('menuitemradio', { name: 'h264' }).click();
    await second;

    // the new session's offer names h.264 and nothing else that carries a picture.
    await expect.poll(async () => (await offers()).length).toBe(2);
    const narrowed = videoCodecs((await offers())[1]);
    expect(narrowed).toContain('h264');
    expect(narrowed.filter((codec) => !['h264', 'rtx', 'red', 'ulpfec', 'flexfec-03'].includes(codec))).toEqual([]);

    const stored = await page.evaluate((key) => sessionStorage.getItem(key), `owlette.swoop.codec/${SITE_ID}/${CODEC_ID}`);
    expect(stored).toBe('h264');
    await page.getByRole('button', { name: 'quality ceiling' }).click();
    await expect(page.getByRole('menuitem', { name: /^codec/ })).toHaveText(/^codec\s*h264$/);
    await page.keyboard.press('Escape');
    // replaced, not ended: a DELETE would void the tab's continuity.
    expect(deletes).toEqual([]);
  });

  test('the site switch and the exclusion list refuse before any ceremony', async ({ page }) => {
    await signIn(page, operator, operatorSecret);

    // a policy refusal is the api's answer, so the page stops rather than retrying it.
    await swoopSettings({ enabled: false });
    await page.goto(`/swoop/${SITE_ID}/${MACHINE_ID}`);
    await expect(alertLine(page)).toContainText('swoop is not enabled for this site.');
    await expect(alertLine(page)).not.toContainText('reconnecting');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // said in the middle of the stage, with the way on (#323): never a spinner beside it.
    await expect(page.getByText(/connecting/i)).toHaveCount(0);
    await expect(alertLine(page).getByRole('link', { name: 'open site settings' })).toHaveAttribute(
      'href',
      `/dashboard?settings=${SITE_ID}`,
    );
    await expect(alertLine(page).getByRole('link', { name: 'back to dashboard' })).toBeVisible();
    await expect(page.getByTestId('session-bar').getByRole('link', { name: 'back to dashboard' })).toBeVisible();
    await swoopSettings({ enabled: true });

    await page.goto(`/swoop/${SITE_ID}/${EXCLUDED_ID}`);
    await expect(alertLine(page)).toContainText('swoop is excluded on this machine.');
    await expect(alertLine(page)).not.toContainText('reconnecting');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('an offline machine is retried on its own, and the session starts once it is back', async ({ page }) => {
    // the watcher needs no ceremony, so the only refusal on the way is the machine's state.
    await signIn(page, watcher);
    const seen = recordSwoopResponses(page);
    await page.goto(`/swoop/${SITE_ID}/${RETURNING_ID}`);

    await expect(alertLine(page)).toContainText('this machine is offline', { timeout: 20_000 });
    await expect(alertLine(page)).toContainText(/reconnecting in \d+ s/);

    const minted = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/machines/${RETURNING_ID}/swoop/sessions`) &&
        r.request().method() === 'POST' &&
        r.status() === 201,
      { timeout: 45_000 },
    ).catch(() => null);
    await getAdminDb().doc(`sites/${SITE_ID}/machines/${RETURNING_ID}`).set({ online: true }, { merge: true });
    expect(await minted, `swoop responses seen: ${seen.join(' | ')}`).not.toBeNull();

    // the next attempt got a session: the refusal line is gone and the page waits for the host.
    await expect(alertLine(page)).toHaveCount(0);
    await expect(page.getByText(/connecting/i).first()).toBeVisible();
    await page.getByRole('button', { name: /end session/i }).click();
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
    const control = controlRes.body.data as {
      sid: string;
      viewerId: string;
      ctl: boolean;
      expiresAt: number;
      continuity?: string;
    };
    expect(control.ctl).toBe(true);
    // a control grant carries the tab's continuity token, `<sid>.<secret>`;
    // it is what lets the same tab reconnect after hours without a new code.
    expect(control.continuity).toMatch(new RegExp(`^${control.sid}\\.[A-Za-z0-9_-]{43}$`));

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
