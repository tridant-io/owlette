/**
 * Auth — signup. Asserts the new user's Firestore doc under the three-role
 * model: role 'member' (NOT the retired 'user'), requiresMfaSetup true, and NO
 * legacy `sites[]` field — and that signup redirects to /setup-2fa, not
 * /dashboard.
 *
 * Also the email verification a password signup triggers: bootstrap mints the
 * verification link (RESEND_API_KEY is unset in e2e, so the send is skipped but
 * the code still lands in the auth emulator), and /verify-email consumes it.
 * The banner itself sits in the app header, which a new account cannot reach
 * before 2fa setup — it is unit-tested (VerifyEmailBanner.test.tsx).
 */

import { test, expect } from '@playwright/test';
import { AUTH_EMULATOR_URL, EMULATOR_PROJECT_ID, getAdminDb } from '../../helpers/emulator';

// Fresh context — no storageState, so the browser starts unauthenticated.
test.use({ storageState: { cookies: [], origins: [] } });

interface EmulatorOobCode {
  email: string;
  oobCode: string;
  requestType: string;
}

/** The verification code the auth emulator holds for `email`, if one was minted. */
async function verifyEmailOobCode(email: string): Promise<string | null> {
  const res = await fetch(`${AUTH_EMULATOR_URL}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/oobCodes`);
  const { oobCodes = [] } = (await res.json()) as { oobCodes?: EmulatorOobCode[] };
  const match = oobCodes.find((c) => c.email === email && c.requestType === 'VERIFY_EMAIL');
  return match?.oobCode ?? null;
}

test('new signup writes role: member, redirects to /setup-2fa, and can verify its email', async ({ page }) => {
  // Unique per run so re-runs cannot collide with seeded users, even though
  // global-setup resets the emulator.
  const stamp = Date.now();
  const email = `new-signup-${stamp}@e2e.test`;
  const password = 'e2e-new-signup-password';

  await page.goto('/register');

  // Email FIRST: the form is progressive — name and password only mount once
  // email is focused, so filling any other field first would time out.
  await page.getByLabel(/^email$/i).fill(email);

  await page.getByLabel(/first name/i).fill('E2E');
  await page.getByLabel(/last name/i).fill('Signup');
  await page.getByLabel(/^password$/i).fill(password);
  await page.getByLabel(/confirm password/i).fill(password);

  // "i agree to the terms ..." checkbox (if present on the form).
  const termsCheckbox = page.getByLabel(/terms/i).first();
  if (await termsCheckbox.isVisible().catch(() => false)) {
    await termsCheckbox.check();
  }

  await page.getByRole('button', { name: /create account|sign up|register/i }).first().click();

  // Either URL proves the MFA gate fired: session-cookie timing can bounce the
  // user through /login?redirect=/setup-2fa first. Accepting both avoids
  // flaking on the createSessionCookie/navigation race.
  await expect(page).toHaveURL(/\/setup-2fa|\/login\?redirect=%2Fsetup-2fa/, {
    timeout: 20_000,
  });

  // The real assertion: new code MUST write 'member' directly, not rely on the
  // permission-model-split migration to re-flip a legacy 'user'.
  const db = getAdminDb();
  // Modular entrypoint: v14 dropped the default `admin` namespace export.
  const { getAuth } = await import('firebase-admin/auth');
  const authAdmin = getAuth();
  const userRecord = await authAdmin.getUserByEmail(email);
  const userDoc = await db.collection('users').doc(userRecord.uid).get();
  expect(userDoc.exists).toBe(true);
  const data = userDoc.data()!;
  expect(data.role).toBe('member');
  expect(data.requiresMfaSetup).toBe(true);
  // The legacy `sites[]` field must NOT be seeded. Site access comes from
  // `sites/{siteId}/members/{uid}`, and wave 6.1 deletes this field — seeding it
  // here meant the very next signup re-created what the migration had removed,
  // so its "field is gone" gate could never converge.
  expect(data).not.toHaveProperty('sites');

  // Verification blocks nothing: the account is still unverified and got through
  // to 2fa setup above.
  expect(userRecord.emailVerified).toBe(false);
  await expect.poll(() => verifyEmailOobCode(email)).not.toBeNull();
  const oobCode = (await verifyEmailOobCode(email))!;

  await page.goto(`/verify-email?oobCode=${encodeURIComponent(oobCode)}`);
  await expect(page.getByRole('heading', { name: 'email verified' })).toBeVisible();
  expect((await authAdmin.getUserByEmail(email)).emailVerified).toBe(true);
});
