/**
 * mfa: changing the factors an account holds needs a session that has cleared a
 * challenge, and the two ways back for someone who can't clear one still work: a
 * live code at /api/mfa/disable, and a superadmin's reset.
 *
 * passkeys are seeded as documents: nothing here runs a webauthn ceremony, so the
 * credential has no private key behind it. `specs/mfa/passkey-factor.spec.ts`
 * covers the ceremonies, including a verified session removing the last passkey.
 */

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { sealData, unsealData } from 'iron-session';
import { authenticator } from 'otplib';
import { getAdminDb } from '../../helpers/emulator';
import { dedicatedUser, seedDedicatedUser } from '../../helpers/coverageSeed';
import { roleState } from '../../helpers/roles';
import type { TestUser } from '../../helpers/seed';
import { E2E_SESSION_SECRET } from '../../helpers/signInCeremony';
import { unspentTotp } from '../../helpers/totp';

authenticator.options = { step: 30, window: 1 };

test.use({ storageState: { cookies: [], origins: [] } });

const CREDENTIAL_ID = 'seeded-credential';

async function seedPasskeyDoc(uid: string) {
  await getAdminDb().collection('users').doc(uid).collection('passkeys').doc(CREDENTIAL_ID).set({
    credentialPublicKey: 'seeded',
    counter: 0,
    transports: [],
    deviceType: 'singleDevice',
    backedUp: false,
    friendlyName: 'seeded passkey',
    createdAt: new Date(),
    lastUsedAt: new Date(),
  });
}

/** an account holding a passkey and, when `secret` is given, an authenticator app. */
async function giveFactors(uid: string, secret?: string) {
  await seedPasskeyDoc(uid);
  await getAdminDb()
    .collection('users')
    .doc(uid)
    .set(
      {
        mfaEnrolled: true,
        requiresMfaSetup: false,
        mfaFactors: { totp: !!secret, passkeys: 1 },
        ...(secret ? { mfaSecret: secret, backupCodes: [] } : {}),
      },
      { merge: true },
    );
}

async function seedUserWithFactors(suffix: string, secret?: string): Promise<TestUser> {
  const user = await seedDedicatedUser(dedicatedUser('member', `${suffix}-${Date.now()}`));
  await giveFactors(user.uid, secret);
  return user;
}

async function signInWithPassword(page: Page, user: TestUser) {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(user.email);
  await page.getByLabel(/password/i).first().fill(user.password);
  await page.getByRole('button', { name: /sign in with email/i }).click();
}

async function passCodeChallenge(page: Page, user: TestUser, secret: string) {
  await signInWithPassword(page, user);
  await expect(page).toHaveURL(/\/verify-2fa/, { timeout: 20_000 });
  await page.getByPlaceholder('000000').fill(await unspentTotp(page, secret));
  await page.getByRole('button', { name: /^verify$/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
}

function passkeyPath(user: TestUser): string {
  return `/api/passkeys/${CREDENTIAL_ID}?userId=${user.uid}`;
}

const renameBody = (user: TestUser) => ({
  data: { userId: user.uid, friendlyName: 'renamed passkey' },
});

async function readInventory(uid: string) {
  const ref = getAdminDb().collection('users').doc(uid);
  const [user, passkeys] = await Promise.all([ref.get(), ref.collection('passkeys').get()]);
  return { factors: user.data()?.mfaFactors, passkeyDocs: passkeys.size };
}

/** each step is soft so one run reports every step's answer, not only the first. */
async function expectChallengeRequired(label: string, res: { status(): number; json(): Promise<unknown> }) {
  expect.soft(res.status(), label).toBe(403);
  const body = (await res.json().catch(() => ({}))) as { code?: string };
  expect.soft(body.code, label).toBe('mfa_challenge_required');
}

/** the factor routes, each answering a challenge-required 403 on this session. */
async function expectFactorChangesRefused(api: APIRequestContext, user: TestUser) {
  await expectChallengeRequired(
    'rename',
    await api.patch(`/api/passkeys/${CREDENTIAL_ID}`, renameBody(user)),
  );
  await expectChallengeRequired('remove', await api.delete(passkeyPath(user)));

  const setup = await api.post('/api/mfa/setup', {
    data: { userId: user.uid, email: user.email },
  });
  await expectChallengeRequired('start enrolling', setup);
  // a refused setup returns no secret, so verify-setup is asked with one it never issued
  const { secret = authenticator.generateSecret() } = setup.ok()
    ? ((await setup.json()) as { secret?: string })
    : {};
  await expectChallengeRequired(
    'finish enrolling',
    await api.post('/api/mfa/verify-setup', {
      data: { userId: user.uid, code: authenticator.generate(secret) },
    }),
  );
}

test('a session that has not cleared a challenge cannot change the factors on an account', async ({
  page,
}) => {
  const user = await seedUserWithFactors('factor-unverified');

  await signInWithPassword(page, user);
  await expect(page).toHaveURL(/\/verify-2fa/, { timeout: 20_000 });

  const list = await page.request.get(`/api/passkeys/list?userId=${user.uid}`);
  expect(list.status()).toBe(200);
  expect(((await list.json()) as { passkeys: unknown[] }).passkeys).toHaveLength(1);

  await expectFactorChangesRefused(page.request, user);

  expect.soft(await readInventory(user.uid)).toEqual({
    factors: { totp: false, passkeys: 1 },
    passkeyDocs: 1,
  });
  await page.goto('/dashboard');
  await expect.soft(page).toHaveURL(/\/verify-2fa/, { timeout: 20_000 });
});

test('a sign-in from before the account held a factor cannot change them either', async ({ page }) => {
  const user = await seedDedicatedUser(dedicatedUser('member', `factor-stale-${Date.now()}`));
  await getAdminDb().collection('users').doc(user.uid).set(
    { mfaEnrolled: false, requiresMfaSetup: true, mfaFactors: { totp: false, passkeys: 0 } },
    { merge: true },
  );

  await signInWithPassword(page, user);
  await expect(page).toHaveURL(/\/setup-2fa/, { timeout: 20_000 });

  // closed first: a live page would re-post the session and refresh the cookie
  const api = page.context().request;
  await page.close();

  // the owner enrolls from another browser, which this cookie knows nothing about
  await giveFactors(user.uid);

  await expectFactorChangesRefused(api, user);
  expect.soft(await readInventory(user.uid)).toEqual({
    factors: { totp: false, passkeys: 1 },
    passkeyDocs: 1,
  });
});

test('the security panel asks to verify when a change is refused', async ({ page }) => {
  const secret = authenticator.generateSecret();
  const user = await seedUserWithFactors('factor-panel', secret);
  await passCodeChallenge(page, user, secret);

  await page.getByTestId('user-menu-trigger').click();
  await page.getByRole('menuitem', { name: /account settings/i }).click();
  await page.getByRole('button', { name: /^security$/i }).first().click();
  await expect(page.getByRole('button', { name: 'remove seeded passkey' })).toBeVisible();

  // the panel stays open while this session stops being verified underneath it
  const context = page.context();
  const cookie = (await context.cookies()).find((c) => c.name === '__session');
  const session = await unsealData<Record<string, unknown>>(cookie!.value, {
    password: E2E_SESSION_SECRET,
  });
  const value = await sealData({ ...session, mfaVerified: false }, { password: E2E_SESSION_SECRET });
  await context.addCookies([{ ...cookie!, value }]);

  await page.getByRole('button', { name: 'remove seeded passkey' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^remove$/ }).click();

  // the api refuses a session that hasn't passed its second factor before the factor-change gate runs
  await expect(page.getByText('complete two-factor verification first')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'remove passkey' })).toHaveCount(0);
  await expect(page.getByText(/verify a factor you already have before adding or changing one/)).toBeVisible();
  expect(await readInventory(user.uid)).toEqual({
    factors: { totp: true, passkeys: 1 },
    passkeyDocs: 1,
  });
});

test('a verified session renames and removes factors, down to the last one', async ({ page }) => {
  const secret = authenticator.generateSecret();
  const user = await seedUserWithFactors('factor-verified', secret);

  await passCodeChallenge(page, user, secret);

  const rename = await page.request.patch(`/api/passkeys/${CREDENTIAL_ID}`, renameBody(user));
  expect(rename.status(), await rename.text()).toBe(200);

  const removeApp = await page.request.post('/api/mfa/disable', {
    data: { code: await unspentTotp(page, secret) },
  });
  expect(removeApp.status(), await removeApp.text()).toBe(200);
  expect(await readInventory(user.uid)).toEqual({
    factors: { totp: false, passkeys: 1 },
    passkeyDocs: 1,
  });

  // same session, no reload: proving a factor a moment ago still counts
  const removeLast = await page.request.delete(passkeyPath(user));
  expect(removeLast.status(), await removeLast.text()).toBe(200);
  expect(await readInventory(user.uid)).toEqual({
    factors: { totp: false, passkeys: 0 },
    passkeyDocs: 0,
  });

  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/setup-2fa/, { timeout: 20_000 });
});

test('a live code removes the authenticator app before any challenge is cleared', async ({ page }) => {
  const secret = authenticator.generateSecret();
  const user = await seedUserWithFactors('factor-proof', secret);

  await signInWithPassword(page, user);
  await expect(page).toHaveURL(/\/verify-2fa/, { timeout: 20_000 });

  const wrong = await page.request.post('/api/mfa/disable', { data: { code: '000000' } });
  expect(wrong.status()).toBe(400);

  const right = await page.request.post('/api/mfa/disable', {
    data: { code: await unspentTotp(page, secret) },
  });
  expect(right.status(), await right.text()).toBe(200);
  expect(await readInventory(user.uid)).toEqual({
    factors: { totp: false, passkeys: 1 },
    passkeyDocs: 1,
  });
});

test('a superadmin reset brings back someone who has lost every factor', async ({ browser, page, baseURL }) => {
  const secret = authenticator.generateSecret();
  const user = await seedUserWithFactors('factor-reset', secret);

  const admin = await browser.newContext({ ...roleState('superadmin'), baseURL });
  const reset = await admin.request.post(`/api/users/${user.uid}/mfa-reset`);
  expect(reset.status(), await reset.text()).toBe(200);
  expect(await reset.json()).toMatchObject({
    clearedTotp: true,
    deletedPasskeys: 1,
    enrolled: false,
    setupRequired: true,
  });
  await admin.close();

  await signInWithPassword(page, user);
  await expect(page).toHaveURL(/\/setup-2fa/, { timeout: 20_000 });

  const setup = await page.request.post('/api/mfa/setup', {
    data: { userId: user.uid, email: user.email },
  });
  expect(setup.status(), await setup.text()).toBe(200);
  const { secret: newSecret } = (await setup.json()) as { secret: string };
  const verify = await page.request.post('/api/mfa/verify-setup', {
    data: { userId: user.uid, code: await unspentTotp(page, newSecret) },
  });
  expect(verify.status(), await verify.text()).toBe(200);
  expect(await readInventory(user.uid)).toEqual({
    factors: { totp: true, passkeys: 0 },
    passkeyDocs: 0,
  });
});
