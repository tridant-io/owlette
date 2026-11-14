/**
 * the login cookie's second-factor time, dated back. swoop counts a ceremony the
 * sign-in passed under five minutes ago as its step-up, so a spec about the
 * step-up itself needs a sign-in older than that, and waiting five minutes is
 * not a test. the e2e server's session secret is this file's, so the cookie can
 * be unsealed, dated back and sealed again exactly as the server would.
 */

import { expect, type Page } from '@playwright/test';
import { sealData, unsealData } from 'iron-session';

/** the e2e web server's `SESSION_SECRET` (playwright.config.ts). iron-session needs 32+ chars. */
export const E2E_SESSION_SECRET = 'demo-session-secret-for-emulator-playwright-tests-32chars';

/**
 * dates the signed-in page's second factor `ageMs` back, then returns it to the
 * dashboard. every page load re-posts the session and the answer reseals the
 * cookie that request carried, so the page leaves the origin first: nothing in
 * flight can undo the change, and the re-post afterwards keeps it.
 */
export async function ageSignInCeremony(page: Page, ageMs = 10 * 60 * 1000): Promise<void> {
  await page.goto('about:blank');
  const context = page.context();
  const cookie = (await context.cookies()).find((c) => c.name === '__session');
  expect(cookie, 'no __session cookie to date back').toBeDefined();
  const session = await unsealData<Record<string, unknown>>(cookie!.value, { password: E2E_SESSION_SECRET });
  expect(typeof session.userId, 'the __session cookie did not unseal').toBe('string');
  const value = await sealData(
    { ...session, mfaCompletedAt: Date.now() - ageMs },
    { password: E2E_SESSION_SECRET },
  );
  await context.addCookies([{ ...cookie!, value }]);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
}
