/**
 * MFA — leaving the challenge. "cancel and sign out" on /verify-2fa signs the
 * user out and lands them on /login, where another account can sign in.
 *
 * While the challenge is pending the proxy answers /login with a redirect back
 * to /verify-2fa, which fails cancel two ways:
 * - sign-out used to clear the firebase user before the session DELETE
 *   returned, so the page's own no-user push to /login bounced off the still
 *   valid cookie, fell back to a full reload, and the reload killed the cancel
 *   (looping until the DELETE won). A cold dev server compiles the DELETE on
 *   first use, which is how the owner hit it; the delay stands in for that.
 * - a /login redirect cached by the App Router earlier in the challenge (a
 *   prefetch here, through Next's debug router handle) is replayed by any later
 *   client push to /login.
 */

import { test, expect, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { getAdminDb } from '../../helpers/emulator';
import { dedicatedUser, seedDedicatedUser } from '../../helpers/coverageSeed';

test.use({ storageState: { cookies: [], origins: [] } });

async function reachChallenge(page: Page, suffix: string) {
  const user = await seedDedicatedUser(dedicatedUser('member', suffix));
  await getAdminDb().collection('users').doc(user.uid).set(
    { mfaEnrolled: true, requiresMfaSetup: false, mfaSecret: authenticator.generateSecret() },
    { merge: true },
  );
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(user.email);
  await page.getByLabel(/password/i).first().fill(user.password);
  await page.getByRole('button', { name: /sign in with email/i }).click();
  await expect(page).toHaveURL(/\/verify-2fa/, { timeout: 20_000 });
}

async function cancelLandsOnLogin(page: Page) {
  await page.getByRole('button', { name: 'cancel and sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('button', { name: /continue with google/i })).toBeVisible();
  await expect(page.getByRole('button', { name: 'cancel and sign out' })).toHaveCount(0);
}

test('cancel reaches the login page while the session delete is slow', async ({ page }) => {
  await reachChallenge(page, 'cancel-slow-delete');
  await page.route('**/api/auth/session', async (route) => {
    if (route.request().method() === 'DELETE') await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
  });

  await cancelLandsOnLogin(page);
});

test('cancel reaches the login page past a cached challenge redirect', async ({ page }) => {
  await reachChallenge(page, 'cancel-cached-redirect');
  const prefetched = page.waitForResponse((res) => new URL(res.url()).pathname === '/login');
  await page.evaluate(() => {
    (window as unknown as { next: { router: { prefetch: (href: string) => void } } }).next.router.prefetch('/login');
  });
  await prefetched;

  await cancelLandsOnLogin(page);
});
