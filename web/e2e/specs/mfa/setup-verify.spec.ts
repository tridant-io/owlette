import crypto from 'crypto';
import fs from 'fs';
import { test, expect } from '@playwright/test';
import { authenticator } from 'otplib';
import { E2E_BASE_URL, getAdminDb } from '../../helpers/emulator';
import { dedicatedUser, seedDedicatedUser } from '../../helpers/coverageSeed';
import type { TestUser } from '../../helpers/seed';

authenticator.options = { step: 30, window: 1 };

test.use({ storageState: { cookies: [], origins: [] } });

// Local mirror of the server-side device-trust contract. Do NOT import
// web/lib/deviceTrust.server.ts — it pulls in @/lib/firebase-admin (production
// Admin init), which collides with the emulator Admin SDK the e2e helpers stand
// up. Keep these literals in sync with deviceTrust.server.ts.
const DEVICE_TRUST_COOKIE = 'owlette_device_trust';
const DEVICE_TRUST_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

async function signIn(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).first().fill(password);
  await page.getByRole('button', { name: /sign in with email/i }).click();
}

async function fillFreshTotp(page: import('@playwright/test').Page, secret: string) {
  const secondsUntilNextCode = authenticator.timeRemaining();
  if (secondsUntilNextCode <= 5) {
    await page.waitForTimeout((secondsUntilNextCode + 1) * 1000);
  }
  await page.getByPlaceholder('000000').fill(authenticator.generate(secret));
}

// Seed a dedicated MFA-enrolled user (unique per run) with a TOTP secret and
// one hashed backup code. Hoisted so the trust-scoping test can seed two.
async function seedMfaUser(suffix: string): Promise<{ user: TestUser; secret: string }> {
  const user = await seedDedicatedUser(dedicatedUser('member', suffix));
  const secret = authenticator.generateSecret();
  const backupCode = 'ABCDEF12';
  await getAdminDb().collection('users').doc(user.uid).set(
    {
      mfaEnrolled: true,
      requiresMfaSetup: false,
      mfaSecret: secret,
      backupCodes: [crypto.createHash('sha256').update(backupCode).digest('hex')],
    },
    { merge: true },
  );
  return { user, secret };
}

// Mint a trusted-device record + raw cookie token for `uid`, mirroring
// deviceTrust.server.ts createTrustedDevice, so a fresh context can carry a
// pre-trusted cookie without re-running the interactive verify flow.
async function seedTrustedDevice(uid: string): Promise<string> {
  const raw = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const now = Date.now();
  await getAdminDb()
    .collection('users')
    .doc(uid)
    .collection('trustedDevices')
    .doc(hash)
    .set({
      tokenHash: hash,
      createdAt: now,
      expiresAt: now + DEVICE_TRUST_DURATION_MS,
      userAgent: 'e2e-seed',
      lastUsedAt: now,
    });
  return raw;
}

test('setup-2fa generates a manual secret, verifies TOTP, and shows backup codes', async ({ page }) => {
  const user = await seedDedicatedUser(dedicatedUser('member', `mfa-setup-${Date.now()}`));

  await signIn(page, user.email, user.password);
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });

  await page.goto('/setup-2fa');
  await expect(page.getByText(/set up two-factor authentication/i).first()).toBeVisible();
  // Method chooser (passkey or authenticator app). The TOTP secret is minted
  // only once this branch is picked, so the QR code doesn't exist before it.
  await page.getByRole('button', { name: /authenticator app/i }).click();
  await expect(page.getByAltText(/2FA QR Code/i)).toBeVisible();
  const secret = await page.locator('input[readonly]').inputValue();
  expect(secret.length).toBeGreaterThan(10);

  await page.getByRole('button', { name: /continue to verification/i }).click();
  await fillFreshTotp(page, secret);
  await page.getByRole('button', { name: /verify & enable 2FA/i }).click();

  await expect(page.getByText(/save backup codes/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /continue to dashboard/i })).toBeVisible();

  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: /download codes/i }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('owlette-backup-codes.txt');
  const sheet = fs.readFileSync(await download.path(), 'utf8');
  expect(sheet).toContain(`account: ${user.email}`);
  expect(sheet.match(/^\d+\.\s+\S+$/gm)).toHaveLength(10);
});

test('verify-2fa with trust-device mints a 30-day cookie and skips the challenge on reload + re-login', async ({
  page,
  context,
  browser,
}) => {
  const { user, secret } = await seedMfaUser(`mfa-login-${Date.now()}`);

  // ── Phase A: complete the 2FA challenge with "trust this device" checked ──
  await signIn(page, user.email, user.password);
  await expect(page).toHaveURL(/\/verify-2fa/, { timeout: 20_000 });

  await expect(page.getByText(/two-factor authentication/i).first()).toBeVisible();
  await page.getByLabel(/trust this device/i).click();
  await fillFreshTotp(page, secret);
  await page.getByRole('button', { name: /^verify$/i }).click();

  // No toast to assert on: leaving the challenge is a document load, which tears
  // the toaster down before it can paint (see `leaveChallenge` in
  // app/verify-2fa/page.tsx). Phase B asserts the trust record and cookie
  // directly, which is what the toast was standing in for anyway.
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });

  // Phase B: device-trust cookie minted (httpOnly, secure, ~30d).
  // Read the FULL jar, unfiltered: the e2e webServer runs the PRODUCTION build,
  // so the cookie is Secure, and Playwright's URL-filtered cookies() can drop
  // Secure cookies for an http:// loopback base URL even though Chromium stored
  // and will send them.
  const cookies = await context.cookies();
  const trustCookie = cookies.find((c) => c.name === DEVICE_TRUST_COOKIE);
  expect(trustCookie, 'device-trust cookie should be set').toBeTruthy();
  expect(trustCookie!.httpOnly).toBe(true);
  // Production build → Secure cookie; Chromium still sends it to loopback.
  expect(trustCookie!.secure).toBe(true);
  const nowSec = Date.now() / 1000;
  expect(trustCookie!.expires).toBeGreaterThan(nowSec + 29 * 24 * 60 * 60);
  expect(trustCookie!.expires).toBeLessThan(nowSec + 31 * 24 * 60 * 60);

  // Phase C: reload / re-navigate must not bounce to /verify-2fa. bug-1
  // regression: every load re-POSTs /api/auth/session, and createSession must
  // preserve the verified state rather than clobber it.
  let sawVerifyDuringReload = false;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame() && frame.url().includes('/verify-2fa')) {
      sawVerifyDuringReload = true;
    }
  });
  await page.reload();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
  expect(sawVerifyDuringReload, 'reload must not re-challenge at /verify-2fa').toBe(false);

  // Phase D: a fresh context carrying ONLY the trust cookie skips the
  // challenge. Deliberately no __session — that would pass via the preserve
  // path instead of trust.
  const trustedContext = await browser.newContext({ baseURL: E2E_BASE_URL });
  try {
    await trustedContext.addCookies([trustCookie!]);
    const trustedPage = await trustedContext.newPage();
    let sawVerifyDuringRelogin = false;
    trustedPage.on('framenavigated', (frame) => {
      if (frame === trustedPage.mainFrame() && frame.url().includes('/verify-2fa')) {
        sawVerifyDuringRelogin = true;
      }
    });

    await signIn(trustedPage, user.email, user.password);
    await expect(trustedPage).toHaveURL(/\/dashboard/, { timeout: 20_000 });
    expect(
      sawVerifyDuringRelogin,
      'trusted re-login must not visit /verify-2fa',
    ).toBe(false);
  } finally {
    await trustedContext.close();
  }
});

test('verify-2fa WITHOUT trust: session survives reload (preserve path, no device-trust backstop)', async ({
  page,
  context,
}) => {
  const { user, secret } = await seedMfaUser(`mfa-preserve-${Date.now()}`);

  // "trust this device" UNCHECKED, so no device-trust cookie: this isolates
  // createSession's preserve wiring from the trust backstop, which would carry
  // a reload even if preserve regressed. The trust test's reload assertion runs
  // with a valid trust cookie, so it cannot catch a preserve-only regression.
  await signIn(page, user.email, user.password);
  await expect(page).toHaveURL(/\/verify-2fa/, { timeout: 20_000 });

  await expect(page.getByText(/two-factor authentication/i).first()).toBeVisible();
  await fillFreshTotp(page, secret);
  await page.getByRole('button', { name: /^verify$/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });

  // Read the FULL jar (unfiltered) so a Secure cookie on the http:// loopback
  // origin can't be silently dropped — the cookie's true absence is what proves
  // the reload below isn't carried by device trust.
  const cookies = await context.cookies();
  expect(
    cookies.find((c) => c.name === DEVICE_TRUST_COOKIE),
    'no device-trust cookie should exist without the trust checkbox',
  ).toBeUndefined();

  // With no trust backstop only the preserve branch can keep mfaVerified=true
  // across the every-load /api/auth/session POST.
  let sawVerifyDuringReload = false;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame() && frame.url().includes('/verify-2fa')) {
      sawVerifyDuringReload = true;
    }
  });
  await page.reload();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
  expect(
    sawVerifyDuringReload,
    'reload without device trust must not re-challenge at /verify-2fa (preserve path)',
  ).toBe(false);
});

test('device trust is user-scoped — a different user on the same browser is still challenged', async ({
  browser,
}) => {
  const suffix = `mfa-scope-${Date.now()}`;
  const userA = await seedMfaUser(`${suffix}-a`);
  const userB = await seedMfaUser(`${suffix}-b`);

  // User A trusts this device (record under A's uid + A's raw cookie token).
  const rawTokenA = await seedTrustedDevice(userA.user.uid);

  // A's cookie in the exact shape the production server sets (Secure, HTTPOnly,
  // domain/path scoped) — not via `url:`, which can strip Secure. Reused
  // verbatim by the positive control (A) and the negative assertion (B) so both
  // exercise the identical token + record.
  const trustCookieA = {
    name: DEVICE_TRUST_COOKIE,
    value: rawTokenA,
    domain: new URL(E2E_BASE_URL).hostname,
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax' as const,
    expires: Math.floor((Date.now() + DEVICE_TRUST_DURATION_MS) / 1000),
  };

  // Positive control: A with its own trust cookie skips the challenge. Without
  // it, B being challenged proves nothing — B would be challenged even if the
  // hand-built cookie never reached the server.
  const contextA = await browser.newContext({ baseURL: E2E_BASE_URL });
  try {
    await contextA.addCookies([trustCookieA]);
    const pageA = await contextA.newPage();
    let sawVerifyForA = false;
    pageA.on('framenavigated', (frame) => {
      if (frame === pageA.mainFrame() && frame.url().includes('/verify-2fa')) {
        sawVerifyForA = true;
      }
    });

    await signIn(pageA, userA.user.email, userA.user.password);
    await expect(pageA).toHaveURL(/\/dashboard/, { timeout: 20_000 });
    expect(
      sawVerifyForA,
      'positive control: A with its own trust cookie must not be challenged',
    ).toBe(false);
  } finally {
    await contextA.close();
  }

  // Negative assertion: B carrying A's cookie is still challenged. Fresh
  // context so the jars can't cross-contaminate; the record is scoped to A's
  // uid, so createSession(B) finds nothing → challenge.
  const contextB = await browser.newContext({ baseURL: E2E_BASE_URL });
  try {
    await contextB.addCookies([trustCookieA]);
    const pageB = await contextB.newPage();

    await signIn(pageB, userB.user.email, userB.user.password);
    await expect(pageB).toHaveURL(/\/verify-2fa/, { timeout: 20_000 });
  } finally {
    await contextB.close();
  }
});

test('clearing the challenge reached from the landing header lands on the dashboard', async ({
  page,
}) => {
  // The path Davor hit on production 2026-09-04: signed in but unverified, on the
  // marketing page, clicking "go to dashboard" in the header. next/link PREFETCHES
  // that href, the proxy answers the prefetch with the /verify-2fa redirect, and the
  // App Router holds it against the /dashboard segment — so a client-side
  // router.push after the gate is satisfied resolves to the cached redirect and the
  // challenge never leaves the screen. Only a manual reload got through.
  //
  // Every other spec here enters the challenge from /login, where nothing has
  // prefetched /dashboard, which is why they stayed green through the bug. The exit
  // is a document load now (`leaveChallenge` in app/verify-2fa/page.tsx); this test
  // fails against `router.push`.
  const { user, secret } = await seedMfaUser(`challenge-exit-${Date.now()}`);

  await signIn(page, user.email, user.password);
  await expect(page).toHaveURL(/\/verify-2fa/, { timeout: 20_000 });

  // Leave the challenge for the public landing page. The header renders
  // "go to dashboard" once auth resolves, and prefetching starts from there.
  await page.goto('/');
  const dashboardLink = page.getByRole('link', { name: /go to dashboard/i });
  await expect(dashboardLink).toBeVisible({ timeout: 20_000 });
  // Hover to force the prefetch even if the link never entered the viewport
  // observer, then give the redirect a moment to be cached against /dashboard.
  await dashboardLink.hover();
  await page.waitForTimeout(1_000);

  await dashboardLink.click();
  await expect(page).toHaveURL(/\/verify-2fa/, { timeout: 20_000 });

  await fillFreshTotp(page, secret);
  await page.getByRole('button', { name: /^verify$/i }).click();

  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
});
