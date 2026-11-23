/**
 * Account — change password (C4.2)
 *
 * The flow lives in AccountSettingsDialog's "security" section behind an "update
 * password" toggle; AuthContext's `updatePassword` re-authenticates via
 * `EmailAuthProvider.credential(...)` then calls Firebase's `updatePassword`.
 *
 * Covers the happy path (save → "Password Updated" toast + emulator REST sign-in with
 * the NEW password succeeds — load-bearing, because firebase-admin.UserRecord carries
 * no password-update timestamp) and the wrong-current-password edge, where re-auth
 * fails with 'auth/wrong-password' / 'auth/invalid-credential' and AuthContext
 * surfaces "Current password is incorrect."
 *
 * FIXTURE ISOLATION — use the dedicated `password-test-user`, never TEST_USERS.member.
 * Firebase revokes ALL refresh tokens on a password change, which would leave
 * `fixtures/member.json` storageState (captured once in global-setup) holding dead
 * tokens for every downstream member-scoped spec; afterEach can restore the password
 * but not the tokens. That caused six cascading failures across account/preferences,
 * account/profile, auth/logout and sites/access-defaults, all timing out because the
 * dashboard never rendered a signed-in shell.
 */

import { test, expect } from '@playwright/test';
import { getAdminAuth, AUTH_EMULATOR_URL, EMULATOR_PROJECT_ID } from '../../helpers/emulator';
import { seedUser, type TestUser } from '../../helpers/seed';
import { clippedFocusRings } from '../../helpers/focusRing';
import { recordSlides, slideSettled } from '../../helpers/slide';

// Do NOT use roleState here. See header comment for the fixture-isolation
// rationale. Each test signs in fresh through the /login form.
test.use({ storageState: { cookies: [], origins: [] } });

const PW_USER: TestUser = {
  uid: 'password-test-user',
  email: 'password-test@e2e.test',
  password: 'e2e-password-test-initial',
  role: 'member',
  sites: ['site-A'],
  displayName: 'E2E Password Test',
};

test.beforeAll(async () => {
  // Idempotent — re-seeding on warm emulators resets the password so
  // previous-run mutations don't poison the first test here.
  await seedUser(PW_USER);
});

test.afterEach(async () => {
  // Restore the seeded password so the next test (and warm-emulator reruns) start from
  // a known baseline. Scoped to PW_USER — the shared member account is untouched.
  await getAdminAuth().updateUser(PW_USER.uid, { password: PW_USER.password });
});

async function signIn(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).first().fill(password);
  await page.getByRole('button', { name: /sign in with email/i }).click();
  await page.waitForURL(/\/dashboard|\/setup-2fa|\/verify-2fa/, { timeout: 15_000 });
}

/** Auth-emulator REST sign-in: 200 = success, 400 = INVALID_PASSWORD / EMAIL_NOT_FOUND. */
async function signInStatus(email: string, password: string): Promise<number> {
  const url =
    `${AUTH_EMULATOR_URL}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword` +
    `?key=demo-api-key`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // The Auth emulator requires a project-id hint on REST calls.
      'X-Goog-Project-Id': EMULATOR_PROJECT_ID,
    },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  return res.status;
}

async function openSecuritySection(
  page: import('@playwright/test').Page,
  currentPasswordForSignIn: string,
) {
  await signIn(page, PW_USER.email, currentPasswordForSignIn);
  await page.getByTestId('user-menu-trigger').click();
  await page.getByRole('menuitem', { name: /account settings/i }).click();
  // Sidebar button labelled "security" on the left; mobile has a scrollable
  // tab bar with the same text — first() picks the visible one.
  await page.getByRole('button', { name: /^security$/i }).first().click();
}

test('user can change password; new password authenticates against the emulator', async ({ page }) => {
  const newPassword = `e2e-new-pw-${Date.now()}`;

  await openSecuritySection(page, PW_USER.password);
  await page.getByRole('button', { name: /^update password$/i }).click();
  await page.locator('#currentPassword').fill(PW_USER.password);
  await page.locator('#newPassword').fill(newPassword);
  await page.locator('#confirmPassword').fill(newPassword);

  await page.getByRole('button', { name: /^save changes$/i }).click();

  // Success toast from updatePassword's happy path.
  await expect(page.getByText('Password Updated', { exact: true })).toBeVisible();

  // Auth emulator REST — new password works, old password doesn't.
  const newStatus = await signInStatus(PW_USER.email, newPassword);
  expect(newStatus).toBe(200);

  const oldStatus = await signInStatus(PW_USER.email, PW_USER.password);
  expect(oldStatus).toBe(400);
});

test('submitting a wrong current password surfaces "Current password is incorrect"', async ({ page }) => {
  const newPassword = `e2e-never-applied-pw-${Date.now()}`;

  await openSecuritySection(page, PW_USER.password);
  await page.getByRole('button', { name: /^update password$/i }).click();
  await page.locator('#currentPassword').fill('definitely-the-wrong-password');
  await page.locator('#newPassword').fill(newPassword);
  await page.locator('#confirmPassword').fill(newPassword);

  await page.getByRole('button', { name: /^save changes$/i }).click();

  // AuthContext's specific 'auth/wrong-password' / 'auth/invalid-credential'
  // branch fires a toast with description "Current password is incorrect."
  await expect(
    page.getByText('Current password is incorrect.', { exact: true }),
  ).toBeVisible();

  // Seeded password still works — the save never went through.
  const oldStatus = await signInStatus(PW_USER.email, PW_USER.password);
  expect(oldStatus).toBe(200);
});

test('the password fields slide open and shut, and keep their whole focus rings', async ({ page }) => {
  await openSecuritySection(page, PW_USER.password);

  const block = page.locator('[data-slot="collapsible"]').filter({ hasText: 'change password' });
  // the one button reads "update password" while shut and "cancel" while open
  const toggle = block.getByRole('button', { name: /^(update password|cancel)$/ });
  const field = page.locator('#currentPassword');
  const slides = await recordSlides(block);

  await toggle.click();
  await expect.poll(slides).toBe('collapsible-down');
  await expect(field).toBeVisible();

  await toggle.click();
  await expect.poll(slides).toBe('collapsible-down collapsible-up');
  await expect(field).toHaveCount(0);

  await toggle.click();
  await expect(field).toBeVisible();
  await slideSettled(block);
  expect(await clippedFocusRings(page, block)).toEqual([]);
});
