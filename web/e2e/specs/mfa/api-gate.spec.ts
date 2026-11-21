/**
 * The API answers a session or an id token only once the account's second factor is
 * passed. Driven over HTTP with a real password sign-in on the auth emulator, because
 * the pages' redirect gate says nothing about these routes. The pre-MFA list has to keep
 * working, or the challenge could never be completed.
 */

import crypto from 'crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { sealData } from 'iron-session';
import { authenticator } from 'otplib';
import { AUTH_EMULATOR_URL, getAdminDb } from '../../helpers/emulator';
import { dedicatedUser, deleteDocIfExists, seedDedicatedUser } from '../../helpers/coverageSeed';
import { mintApiKey, revokeApiKey } from '../../helpers/apiKey';
import { seedMachineWithProcesses } from '../../helpers/processConfig';
import { E2E_SESSION_SECRET } from '../../helpers/signInCeremony';
import type { TestUser } from '../../helpers/seed';

authenticator.options = { step: 30, window: 1 };

test.use({ storageState: { cookies: [], origins: [] } });

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-api-gate-machine';
const PROCESS_ID = 'e2e-api-gate-process';
const CODE = 'mfa_challenge_required';

async function seedEnrolledAdmin(suffix: string): Promise<{ user: TestUser; secret: string }> {
  const user = await seedNoFactorAdmin(suffix);
  const secret = authenticator.generateSecret();
  await getAdminDb().collection('users').doc(user.uid).set(
    {
      mfaEnrolled: true,
      requiresMfaSetup: false,
      mfaFactors: { totp: true, passkeys: 0 },
      mfaSecret: secret,
    },
    { merge: true },
  );
  return { user, secret };
}

async function seedNoFactorAdmin(suffix: string): Promise<TestUser> {
  return seedDedicatedUser(dedicatedUser('admin', `api-gate-${suffix}-${Date.now()}`));
}

/** Email and password only, the way a stolen password would be used. */
async function passwordIdToken(request: APIRequestContext, user: TestUser): Promise<string> {
  const res = await request.post(
    `${AUTH_EMULATOR_URL}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key`,
    { data: { email: user.email, password: user.password, returnSecureToken: true } },
  );
  expect(res.status(), 'password sign-in on the auth emulator').toBe(200);
  return ((await res.json()) as { idToken: string }).idToken;
}

function sessionCookieFrom(setCookie: string | undefined): string {
  const match = (setCookie ?? '').match(/__session=([^;]+)/);
  expect(match, 'no __session cookie in the response').not.toBeNull();
  return `__session=${match![1]}`;
}

async function passwordCookie(request: APIRequestContext, idToken: string): Promise<string> {
  const res = await request.post('/api/auth/session', { data: { idToken } });
  expect(res.status(), 'session create').toBe(200);
  return sessionCookieFrom(res.headers()['set-cookie']);
}

/**
 * A cookie minted just now in the shape from before the mfa fields existed: uid and expiry,
 * nothing else. Such a cookie is dated by its seven-day expiry, so a nearer one would read as
 * minted before the account was.
 */
async function legacyCookie(uid: string): Promise<string> {
  const sealed = await sealData(
    { userId: uid, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 },
    { password: E2E_SESSION_SECRET },
  );
  return `__session=${sealed}`;
}

type Probe = {
  name: string;
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  data?: Record<string, unknown>;
};

const GATED: Probe[] = [
  { name: 'mint a key', method: 'post', path: '/api/keys', data: {
    name: 'e2e gate', scopes: [{ resource: 'site', id: SITE_ID, permissions: ['read'] }],
  } },
  { name: 'list keys', method: 'get', path: '/api/keys' },
  { name: 'read a site', method: 'get', path: `/api/sites/${SITE_ID}` },
  { name: 'read a machine', method: 'get', path: `/api/sites/${SITE_ID}/machines/${MACHINE_ID}` },
  { name: 'run a command', method: 'post', path: `/api/sites/${SITE_ID}/machines/${MACHINE_ID}/commands`, data: {
    type: 'kill_process', params: { process_name: 'gate-process' },
  } },
  { name: 'patch a process', method: 'patch', path: `/api/sites/${SITE_ID}/machines/${MACHINE_ID}/processes/${PROCESS_ID}`, data: {
    exe_path: 'C:\\seed\\patched.exe',
  } },
  { name: 'kill a process', method: 'post', path: `/api/sites/${SITE_ID}/machines/${MACHINE_ID}/processes/${PROCESS_ID}/kill` },
  { name: 'read hoot conversations', method: 'get', path: `/api/hoot/conversations?siteId=${SITE_ID}` },
  // dry run: on unfixed code this probe must report, not erase the fixture.
  { name: 'delete the account', method: 'delete', path: '/api/users/me?dryRun=true' },
];

function send(
  request: APIRequestContext,
  probe: Probe,
  headers: Record<string, string>,
) {
  const all = { ...headers, 'idempotency-key': crypto.randomUUID() };
  const options = { headers: all, ...(probe.data ? { data: probe.data } : {}) };
  if (probe.method === 'get') return request.get(probe.path, { headers: all });
  if (probe.method === 'patch') return request.patch(probe.path, options);
  if (probe.method === 'delete') return request.delete(probe.path, options);
  return request.post(probe.path, options);
}

async function expectRefused(
  request: APIRequestContext,
  headers: Record<string, string>,
  label: string,
): Promise<void> {
  for (const probe of GATED) {
    const res = await send(request, probe, headers);
    const body = (await res.json().catch(() => ({}))) as { code?: string };
    expect
      .soft({ probe: `${label}: ${probe.name}`, status: res.status(), code: body.code })
      .toEqual({ probe: `${label}: ${probe.name}`, status: 403, code: CODE });
  }
}

test.beforeAll(async () => {
  await seedMachineWithProcesses(SITE_ID, MACHINE_ID, [{ id: PROCESS_ID, name: 'gate-process' }]);
});

test.afterAll(async () => {
  await deleteDocIfExists(`sites/${SITE_ID}/machines/${MACHINE_ID}`);
  await deleteDocIfExists(`config/${SITE_ID}/machines/${MACHINE_ID}`);
});

test('a password-only cookie is refused until the challenge is passed, and nothing it sent took effect', async ({ request }) => {
  const { user, secret } = await seedEnrolledAdmin('cookie');
  const idToken = await passwordIdToken(request, user);
  const cookie = await passwordCookie(request, idToken);

  await expectRefused(request, { cookie }, 'password-only cookie');

  const db = getAdminDb();
  const keys = await db.collection('users').doc(user.uid).collection('api_keys').get();
  expect(keys.size, 'no key was minted').toBe(0);
  const config = await db.collection('config').doc(SITE_ID).collection('machines').doc(MACHINE_ID).get();
  const processes = (config.data()?.processes ?? []) as { id: string; exe_path: string }[];
  expect(processes.find((p) => p.id === PROCESS_ID)?.exe_path).not.toContain('patched');

  const verify = await request.post('/api/mfa/verify-login', {
    headers: { cookie },
    data: { userId: user.uid, code: authenticator.generate(secret) },
  });
  expect(verify.status(), 'challenge').toBe(200);
  const verified = sessionCookieFrom(verify.headers()['set-cookie']);

  const list = await request.get('/api/keys', { headers: { cookie: verified } });
  expect(list.status(), 'verified session lists keys').toBe(200);
  const site = await request.get(`/api/sites/${SITE_ID}`, { headers: { cookie: verified } });
  expect(site.status(), 'verified session reads the site').toBe(200);
});

test('a password-only id token is refused for an account holding a factor', async ({ request }) => {
  const { user } = await seedEnrolledAdmin('token');
  const idToken = await passwordIdToken(request, user);

  await expectRefused(request, { authorization: `Bearer ${idToken}` }, 'password-only id token');

  const keys = await getAdminDb().collection('users').doc(user.uid).collection('api_keys').get();
  expect(keys.size, 'no key was minted').toBe(0);
});

test('a password-only cookie and id token together are still refused', async ({ request }) => {
  const { user } = await seedEnrolledAdmin('both');
  const idToken = await passwordIdToken(request, user);
  const cookie = await passwordCookie(request, idToken);

  await expectRefused(request, { cookie, authorization: `Bearer ${idToken}` }, 'cookie and token');
});

test('a cookie from before the mfa fields is refused for an enrolled account, not for one with no factor', async ({ request }) => {
  const { user } = await seedEnrolledAdmin('legacy');
  await expectRefused(request, { cookie: await legacyCookie(user.uid) }, 'legacy cookie');

  const plain = await seedNoFactorAdmin('legacy-plain');
  const res = await request.get('/api/keys', { headers: { cookie: await legacyCookie(plain.uid) } });
  expect(res.status(), 'a no-factor account keeps its legacy cookie').toBe(200);
});

test('a cookie minted at zero factors is refused once the account gains one', async ({ request }) => {
  const user = await seedNoFactorAdmin('stale');
  const idToken = await passwordIdToken(request, user);
  const cookie = await passwordCookie(request, idToken);

  const before = await request.get('/api/keys', { headers: { cookie } });
  expect(before.status(), 'no factor yet').toBe(200);

  await getAdminDb().collection('users').doc(user.uid).set(
    { mfaEnrolled: true, requiresMfaSetup: false, mfaFactors: { totp: true, passkeys: 0 } },
    { merge: true },
  );

  await expectRefused(request, { cookie }, 'zero-factor cookie, factor since');
});

test('mfa/disable answers a password-only session, and only with live proof', async ({ request }) => {
  const { user, secret } = await seedEnrolledAdmin('disable');
  const idToken = await passwordIdToken(request, user);
  const cookie = await passwordCookie(request, idToken);

  const noProof = await request.post('/api/mfa/disable', {
    headers: { cookie },
    data: { code: '000000' },
  });
  const noProofBody = (await noProof.json()) as { code?: string };
  expect(noProof.status(), 'a wrong code is refused by the proof check').toBeLessThan(500);
  expect(noProof.ok(), 'a wrong code does not disable').toBe(false);
  expect(noProofBody.code, 'it reached the proof check').not.toBe(CODE);

  const proved = await request.post('/api/mfa/disable', {
    headers: { cookie },
    data: { code: authenticator.generate(secret) },
  });
  expect(proved.status(), 'live proof').toBe(200);
});

test('the pre-mfa list answers a password-only session', async ({ request }) => {
  const { user, secret } = await seedEnrolledAdmin('pre-mfa');
  const idToken = await passwordIdToken(request, user);
  const cookie = await passwordCookie(request, idToken);
  const headers = { cookie };

  const status = await request.get('/api/auth/session', { headers });
  expect(await status.json()).toMatchObject({ authenticated: true, mfaRequired: true, mfaVerified: false });

  const passkeys = await request.get(`/api/passkeys/list?userId=${user.uid}`, { headers });
  expect(passkeys.status(), 'passkeys/list').toBe(200);

  const factors = await request.get('/api/mfa/factors', { headers });
  expect(factors.status(), 'mfa/factors').toBe(200);
  expect(await factors.json()).toMatchObject({ mfaVerified: false });

  // the route's own answer for an account holding no passkey, so it was reached.
  const stepUp = await request.post('/api/passkeys/step-up/options', { headers, data: {} });
  expect(stepUp.status(), 'step-up/options').toBe(400);
  expect(await stepUp.json()).toMatchObject({ code: 'no_passkeys' });

  // the enrollment gate's own refusal, which names adding a factor.
  const setup = await request.post('/api/mfa/setup', { headers, data: { userId: user.uid, email: user.email } });
  expect(setup.status(), 'mfa/setup').toBe(403);
  expect(await setup.json()).toMatchObject({ code: CODE, error: expect.stringContaining('second factor') });

  const wrong = await request.post('/api/mfa/verify-login', {
    headers,
    data: { userId: user.uid, code: '000000' },
  });
  expect(wrong.status(), 'verify-login reaches the code check').toBe(400);

  const bootstrap = await request.post('/api/users/bootstrap', {
    headers: { authorization: `Bearer ${idToken}`, 'idempotency-key': crypto.randomUUID() },
    data: { displayName: 'gate', timezone: 'UTC' },
  });
  expect(bootstrap.status(), 'users/bootstrap').toBeLessThan(300);

  const created = await request.post('/api/webhooks/user-created', {
    headers: { authorization: `Bearer ${idToken}` },
    data: {
      email: user.email,
      displayName: user.displayName,
      authMethod: 'email',
      createdAt: new Date().toISOString(),
    },
  });
  // past auth it needs resend, which the rig blanks, so 500 here means it got through.
  expect([401, 403], 'webhooks/user-created').not.toContain(created.status());

  const verify = await request.post('/api/mfa/verify-login', {
    headers,
    data: { userId: user.uid, code: authenticator.generate(secret) },
  });
  expect(verify.status(), 'verify-login').toBe(200);
});

test('an account with no factor keeps working on a cookie and on an id token', async ({ request }) => {
  const user = await seedNoFactorAdmin('plain');
  const idToken = await passwordIdToken(request, user);
  const cookie = await passwordCookie(request, idToken);

  for (const headers of [{ cookie }, { authorization: `Bearer ${idToken}` }]) {
    const keys = await request.get('/api/keys', { headers });
    expect(keys.status(), 'list keys').toBe(200);
    const site = await request.get(`/api/sites/${SITE_ID}`, { headers });
    expect(site.status(), 'read the site').toBe(200);
  }
});

// these run one browser per session: a request context sends its own stored cookie beside any
// cookie header, so two sessions of one account need two contexts
test.describe('one browser per session', () => {
  let browsers: APIRequestContext[] = [];
  let newBrowser: () => Promise<APIRequestContext>;

  test.beforeEach(async ({ playwright, baseURL }) => {
    newBrowser = async () => {
      const browser = await playwright.request.newContext({ baseURL });
      browsers.push(browser);
      return browser;
    };
  });

  test.afterEach(async () => {
    await Promise.all(browsers.map((b) => b.dispose()));
    browsers = [];
  });

  const codeOf = async (res: { json(): Promise<unknown> }) => ((await res.json()) as { code?: string }).code;

  test('an account that has to set up a factor is refused until it enrols, and answered where it does', async () => {
    const user = await seedNoFactorAdmin('setup');
    await getAdminDb().collection('users').doc(user.uid).set({ requiresMfaSetup: true }, { merge: true });
    const browser = await newBrowser();
    const idToken = await passwordIdToken(browser, user);
    await passwordCookie(browser, idToken);

    const onCookie = await browser.get('/api/keys');
    expect(onCookie.status(), 'list keys on the cookie').toBe(403);
    expect(await codeOf(onCookie)).toBe('mfa_setup_required');
    const onToken = await (await newBrowser()).get('/api/keys', { headers: { authorization: `Bearer ${idToken}` } });
    expect(onToken.status(), 'list keys on the id token').toBe(403);
    expect(await codeOf(onToken)).toBe('mfa_setup_required');

    const setup = await browser.post('/api/mfa/setup', { data: { userId: user.uid, email: user.email } });
    expect(setup.status(), 'mfa/setup').toBe(200);
    const { secret } = (await setup.json()) as { secret: string };
    const enrol = await browser.post('/api/mfa/verify-setup', {
      data: { userId: user.uid, code: authenticator.generate(secret) },
    });
    expect(enrol.status(), 'verify-setup').toBe(200);
    expect((await browser.get('/api/keys')).status(), 'the enrolled session lists keys').toBe(200);
  });

  test('a totp code passes one challenge, not two', async () => {
    const { user, secret } = await seedEnrolledAdmin('replay');
    const [first, second] = [await newBrowser(), await newBrowser()];
    await passwordCookie(first, await passwordIdToken(first, user));
    await passwordCookie(second, await passwordIdToken(second, user));
    const code = authenticator.generate(secret);

    expect((await first.post('/api/mfa/verify-login', { data: { userId: user.uid, code } })).status()).toBe(200);
    expect((await second.post('/api/mfa/verify-login', { data: { userId: user.uid, code } })).status()).toBe(400);
  });

  test('a factor change ends the sessions minted before it, and keeps the one that made it', async () => {
    const { user, secret } = await seedEnrolledAdmin('cutoff');
    const backupCode = (c: string) => crypto.createHash('sha256').update(c).digest('hex');
    const userRef = getAdminDb().collection('users').doc(user.uid);
    // a passkey as well, so the account stays enrolled once the authenticator app goes
    await userRef.collection('passkeys').doc('seeded-credential').set({ credentialPublicKey: 'seeded', counter: 0 });
    await userRef.set(
      { mfaFactors: { totp: true, passkeys: 1 }, backupCodes: [backupCode('CUTOFF01'), backupCode('CUTOFF02')] },
      { merge: true },
    );

    async function verifiedBrowser(data: Record<string, unknown>): Promise<APIRequestContext> {
      const browser = await newBrowser();
      await passwordCookie(browser, await passwordIdToken(browser, user));
      const verify = await browser.post('/api/mfa/verify-login', { data: { userId: user.uid, ...data } });
      expect(verify.status(), 'challenge').toBe(200);
      return browser;
    }
    const other = await verifiedBrowser({ code: 'CUTOFF01', isBackupCode: true });
    const mine = await verifiedBrowser({ code: authenticator.generate(secret) });
    expect((await other.get('/api/keys')).status()).toBe(200);

    const removed = await mine.post('/api/mfa/disable', { data: { code: 'CUTOFF02', isBackupCode: true } });
    expect(removed.status(), 'mfa/disable').toBe(200);

    expect((await other.get('/api/keys')).status(), 'the other session').toBe(401);
    expect((await mine.get('/api/keys')).status(), 'the session that made the change').toBe(200);
  });
});

test('an api key of an enrolled account needs no challenge', async ({ request }) => {
  const { user } = await seedEnrolledAdmin('key');
  const key = await mintApiKey({
    ownerUid: user.uid,
    scopes: [{ resource: 'site', id: SITE_ID, permissions: ['read'] }],
  });
  try {
    const res = await request.get(`/api/sites/${SITE_ID}`, {
      headers: { authorization: `Bearer ${key.rawKey}` },
    });
    expect(res.status()).toBe(200);
  } finally {
    await revokeApiKey(key);
  }
});

test('the cli authorize page sends a password-only session to the challenge first', async ({ page }) => {
  const { user } = await seedEnrolledAdmin('cli');
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(user.email);
  await page.getByLabel(/password/i).first().fill(user.password);
  await page.getByRole('button', { name: /sign in with email/i }).click();
  await expect(page).toHaveURL(/\/verify-2fa/, { timeout: 20_000 });

  await page.goto('/cli/authorize?code=some-pairing-phrase');
  await expect(page).toHaveURL(/\/verify-2fa\?redirect=.*cli.*authorize/, { timeout: 20_000 });
});
