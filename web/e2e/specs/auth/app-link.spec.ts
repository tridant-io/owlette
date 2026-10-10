/**
 * app-link (lib/appLink.server.ts): a signed-in browser hands its session to owlette swoop. The
 * app is played by a fresh browser context, which is all its webview is here — a page with a
 * cookie jar of its own.
 *
 * Flow A, website → app: a TOTP user who cleared the challenge mints a code, and the fresh context
 * opening /app-link with it lands on `next` signed in with no /verify-2fa hop. Expiry is a unit
 * test (__tests__/api/app-link.test.ts): the server clock cannot be moved from here.
 *
 * Flow B, cold app start: the app (the fresh context, with the app's ua token) clicks sign in with
 * your browser on /login, the signed-in TOTP user's browser approves the window it opened, and the
 * app's poll lands it on the redirect signed in, again with no /verify-2fa hop.
 */

import crypto from 'crypto';
import { test, expect, devices, type Browser, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { E2E_BASE_URL, getAdminDb } from '../../helpers/emulator';
import { dedicatedUser, seedDedicatedUser } from '../../helpers/coverageSeed';
import type { TestUser } from '../../helpers/seed';

authenticator.options = { step: 30, window: 1 };
test.use({ storageState: { cookies: [], origins: [] } });

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

async function signInWithTotp(page: Page, user: TestUser, secret: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(user.email);
  await page.getByLabel(/password/i).first().fill(user.password);
  await page.getByRole('button', { name: /sign in with email/i }).click();
  await expect(page).toHaveURL(/\/verify-2fa/, { timeout: 20_000 });
  if (authenticator.timeRemaining() <= 5) {
    await page.waitForTimeout((authenticator.timeRemaining() + 1) * 1000);
  }
  await page.getByPlaceholder('000000').fill(authenticator.generate(secret));
  await page.getByRole('button', { name: /^verify$/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
}

/**
 * The page's own fetch, with the page's cookies: the e2e server is a production build, so the
 * session cookie is Secure, and a playwright request context on the http loopback can drop it.
 */
async function apiCall(
  page: Page,
  method: 'GET' | 'POST',
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return page.evaluate(
    async ([m, p]) => {
      const res = await fetch(p, {
        method: m,
        headers: { 'Content-Type': 'application/json' },
        body: m === 'POST' ? '{}' : undefined,
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    },
    [method, path] as const,
  );
}

const APP_UA = `${devices['Desktop Chrome'].userAgent} owlette-swoop-viewer/0.0.0`;

/** A context with nothing in it: owlette swoop's webview on first launch. */
async function freshApp(browser: Browser, userAgent?: string) {
  return browser.newContext({
    baseURL: E2E_BASE_URL,
    storageState: { cookies: [], origins: [] },
    userAgent,
  });
}

test('a code minted by a signed-in totp user signs owlette swoop in, mfa included, once', async ({
  page,
  browser,
}) => {
  const { user, secret } = await seedTotpUser(`app-link-${Date.now()}`);
  await signInWithTotp(page, user, secret);
  await page.goto('/swoop');
  await expect(page).toHaveURL(/\/swoop(\?|$)/);

  const minted = await apiCall(page, 'POST', '/api/auth/app-link');
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  const code = minted.body.code as string;
  const link = `/app-link?code=${code}&next=${encodeURIComponent('/swoop')}`;

  const app = await freshApp(browser);
  try {
    const appPage = await app.newPage();
    let sawChallenge = false;
    appPage.on('framenavigated', (frame) => {
      if (frame === appPage.mainFrame() && frame.url().includes('/verify-2fa')) sawChallenge = true;
    });

    await appPage.goto(link);
    await expect(appPage).toHaveURL(/\/swoop(\?|$)/, { timeout: 20_000 });
    expect(sawChallenge, 'the handoff must not stop at /verify-2fa').toBe(false);

    const session = await apiCall(appPage, 'GET', '/api/auth/session');
    expect(session.body).toMatchObject({
      authenticated: true,
      userId: user.uid,
      mfaRequired: true,
      mfaVerified: true,
    });
  } finally {
    await app.close();
  }

  const replay = await freshApp(browser);
  try {
    const replayPage = await replay.newPage();
    await replayPage.goto(link);
    await expect(replayPage.getByRole('alert').filter({ hasText: 'that sign-in link is no longer valid' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(replayPage.getByRole('link', { name: 'sign in' })).toHaveAttribute(
      'href',
      '/login?redirect=%2Fswoop',
    );
  } finally {
    await replay.close();
  }
});

test('a cold start signs owlette swoop in through the signed-in browser, mfa included', async ({
  page,
  browser,
}) => {
  // a totp sign-in may wait out the end of a period, and the app polls every 3 s.
  test.setTimeout(90_000);
  const { user, secret } = await seedTotpUser(`app-link-cold-${Date.now()}`);
  await signInWithTotp(page, user, secret);

  const app = await freshApp(browser, APP_UA);
  try {
    const appPage = await app.newPage();
    let sawChallenge = false;
    appPage.on('framenavigated', (frame) => {
      if (frame === appPage.mainFrame() && frame.url().includes('/verify-2fa')) sawChallenge = true;
    });

    await appPage.goto('/login?redirect=%2Fswoop');
    await expect(appPage.getByRole('button', { name: /continue with google/i })).toHaveCount(0);

    // the real app hands this window to the system browser; here it is a popup in the app's own
    // context, which only gives up the url it was opened with.
    const approveRequest = app.waitForEvent('request', (r) => r.url().includes('/app-link/approve?code='));
    const popupOpened = app.waitForEvent('page');
    await appPage.getByRole('button', { name: 'sign in with your browser' }).click();
    const approveUrl = (await approveRequest).url();
    await (await popupOpened).close();
    await expect(appPage.getByText('waiting for your browser…')).toBeVisible();

    await page.goto(approveUrl);
    await expect(page.getByRole('heading', { name: 'sign in owlette swoop on this computer?' })).toBeVisible();
    await page.getByRole('button', { name: 'approve' }).click();
    await expect(page.getByText('done, go back to owlette swoop')).toBeVisible();

    await expect(appPage).toHaveURL(/\/swoop(\?|$)/, { timeout: 20_000 });
    expect(sawChallenge, 'the handoff must not stop at /verify-2fa').toBe(false);

    const session = await apiCall(appPage, 'GET', '/api/auth/session');
    expect(session.body).toMatchObject({
      authenticated: true,
      userId: user.uid,
      mfaRequired: true,
      mfaVerified: true,
    });
  } finally {
    await app.close();
  }
});
