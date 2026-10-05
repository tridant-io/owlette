/**
 * Mobile responsive acceptance gate. One test per route at 390x844 (viewport /
 * isMobile / hasTouch come from the `mobile-chromium` project): navigate, wait
 * for a real content anchor, assert the document does not scroll horizontally.
 *
 * `assertNoHorizontalOverflow` calls `stabilize` itself — do NOT call it again.
 *
 * Every content-driven route is seeded with real rows first: an empty view
 * cannot overflow, so asserting one proves nothing.
 *
 * Zero `test.fixme`s remain. If a route overflows, fix the route — never soften
 * the assertion, and never re-add a fixme for a passing route (Playwright does
 * not flag a fixme that would have passed).
 */

import crypto from 'crypto';
import { test, expect, type Page } from '@playwright/test';
import { FieldValue } from 'firebase-admin/firestore';
import { authenticator } from 'otplib';
import { getAdminAuth, getAdminDb } from '../../helpers/emulator';
import { assertNoHorizontalOverflow } from '../../helpers/mobile';
import { roleState } from '../../helpers/roles';
import {
  TEST_SITES,
  TEST_USERS,
  seedMachine,
  seedRoostWithVersionHistory,
  seedUser,
  type TestUser,
} from '../../helpers/seed';
import {
  dedicatedUser,
  seedHootFixture,
  seedDedicatedUser,
  seedLogEvents,
} from '../../helpers/coverageSeed';
import { mintApiKey, revokeApiKey, type MintedApiKey } from '../../helpers/apiKey';

const SITE_ID = TEST_SITES[0].id;
const MACHINE_ID = 'e2e-mobile-overflow-machine';
const ROOST_ID = 'rst_mobile_overflow_001';
const ROOST_NAME = 'mobile-overflow-roost';
const WEBHOOK_ID = 'e2e-mobile-overflow-webhook';
const WEBHOOK_URL = 'https://example.com/mobile-overflow/hook';
const API_KEY_NAME = 'e2e-mobile-overflow-key';

/**
 * Deliberately long local part: the recovery pages echo the account email back,
 * and an unbreakable address is exactly what sets a grid column's floor and
 * pushes the card past its max-width. A short seeded address would let a
 * missing break-words pass.
 */
const LONG_EMAIL_USER: TestUser = {
  uid: 'mobile-overflow-reset-user',
  email: 'mobile-overflow-a-very-long-local-part-for-wrapping@e2e-overflow-example.test',
  password: 'e2e-mobile-overflow-initial',
  role: 'member',
  sites: [TEST_SITES[0].id],
  displayName: 'E2E Mobile Overflow Reset',
};

/**
 * Webhook subscription in the exact shape `POST /api/webhooks` stores, so the
 * settings page renders a real card (long url, per-event badges), not empty state.
 */
async function seedWebhook(): Promise<void> {
  await getAdminDb()
    .collection('sites')
    .doc(SITE_ID)
    .collection('webhooks')
    .doc(WEBHOOK_ID)
    .set({
      schemaVersion: 1,
      url: WEBHOOK_URL,
      hostname: 'example.com',
      events: ['version.published', 'deployment.completed', 'machine.offline'],
      description: 'seeded by responsive-acceptance.spec.ts',
      signingSecret: `whsec_${'0'.repeat(64)}`,
      secretRotatedAt: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      createdBy: TEST_USERS.admin.uid,
      paused: false,
      deletedAt: null,
      lastDeliveryAt: null,
      lastDeliveryStatus: null,
      failureCount: 0,
    });
}

/**
 * Fleet stressing 390px: an online machine with a two-monitor profile and a
 * reboot-pending banner (card view only), plus a stale/offline one.
 */
async function seedDashboardMachines(): Promise<void> {
  await seedMachine(SITE_ID, MACHINE_ID, { rebootPending: true });
  await seedMachine(SITE_ID, `${MACHINE_ID}-offline`, { heartbeatOffsetSec: 600 });
}

test.describe('mobile responsive acceptance — public routes', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('/login does not scroll horizontally', async ({ page }) => {
    await page.goto('/login');
    // Progressive form: password + submit only mount once email is focused, so
    // a bare `goto` would measure a two-button shell.
    await page.getByLabel(/^email$/i).fill('mobile-overflow@e2e.test');
    await expect(page.getByRole('button', { name: /sign in with email/i })).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  test('/login puts the sign-up prompt on its own line', async ({ page }) => {
    await page.goto('/login');
    const forgot = await page.getByRole('link', { name: 'forgot password?' }).boundingBox();
    const prompt = await page.getByText(/have an account\?/).boundingBox();
    const signUp = await page.getByRole('link', { name: 'sign up', exact: true }).boundingBox();
    expect(prompt!.y).toBeGreaterThanOrEqual(forgot!.y + forgot!.height);
    // the prompt and its link wrap together, never mid-phrase
    expect(Math.abs(signUp!.y - prompt!.y)).toBeLessThan(prompt!.height);
  });

  // Task 4.4 calls /register broken, but the expanded form fits at 390px today,
  // so this asserts live — whatever 4.4 saw, it is not document overflow.
  test('/register does not scroll horizontally', async ({ page }) => {
    await page.goto('/register');
    // Progressive form (see auth/signup.spec.ts) — measure the expanded state.
    await page.getByLabel(/^email$/i).fill('mobile-overflow@e2e.test');
    await expect(page.getByLabel(/first name/i)).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  test('/demo does not scroll horizontally', async ({ page }) => {
    await page.goto('/demo');
    await expect(page.getByRole('heading', { name: /welcome to owlette!/i })).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  // Both states: the confirmation echoes the submitted address, and Turnstile's
  // `flexible` size has a 300px floor against a ~294px column at this viewport.
  test('/forgot-password does not scroll horizontally', async ({ page }) => {
    await seedUser(LONG_EMAIL_USER);

    await page.goto('/forgot-password');
    await expect(page.getByRole('button', { name: /send reset link/i })).toBeVisible();
    await assertNoHorizontalOverflow(page);

    await page.getByLabel(/email/i).fill(LONG_EMAIL_USER.email);
    await page.getByRole('button', { name: /send reset link/i }).click();
    await expect(page.getByText(/a password reset link is on its way/i)).toBeVisible({
      timeout: 15_000,
    });
    await assertNoHorizontalOverflow(page);
  });

  // The `ready` state is the one that renders the account email, so mint a real
  // oobCode rather than settling for the `invalid` branch.
  test('/reset-password does not scroll horizontally', async ({ page }) => {
    await seedUser(LONG_EMAIL_USER);

    const link = await getAdminAuth().generatePasswordResetLink(LONG_EMAIL_USER.email);
    const oobCode = new URL(link).searchParams.get('oobCode');
    expect(oobCode).toBeTruthy();

    await page.goto(`/reset-password?oobCode=${encodeURIComponent(oobCode!)}`);
    await expect(page.getByText(LONG_EMAIL_USER.email)).toBeVisible({ timeout: 15_000 });
    await assertNoHorizontalOverflow(page);
  });
});

test.describe('mobile responsive acceptance — fresh-user routes', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  /**
   * /setup-2fa needs a signed-in, un-enrolled user — same setup as
   * mfa/setup-verify.spec.ts: seed a member, sign in for real, then navigate.
   */
  async function signInFreshUser(page: Page): Promise<void> {
    const user = await seedDedicatedUser(
      dedicatedUser('member', `mobile-2fa-${Date.now()}`),
    );
    await page.goto('/login');
    await page.getByLabel(/email/i).fill(user.email);
    await page.getByLabel(/password/i).first().fill(user.password);
    await page.getByRole('button', { name: /sign in with email/i }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
  }

  // As with /register: 4.4 calls it broken, but it fits at 390px today.
  test('/setup-2fa does not scroll horizontally', async ({ page }) => {
    await signInFreshUser(page);
    await page.goto('/setup-2fa');
    await expect(page.getByText(/set up two-factor authentication/i).first()).toBeVisible();
    // Both TOTP screens: the method chooser, then the QR step behind it.
    await assertNoHorizontalOverflow(page);
    await page.getByRole('button', { name: /authenticator app/i }).click();
    await expect(page.getByAltText(/2FA QR code/i)).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  /**
   * /verify-2fa is only reachable mid-login by an enrolled user, so seed the
   * TOTP factor the way mfa/setup-verify.spec.ts does and sign in for real.
   * Both code modes are measured: the backup-code field is the wider of the two
   * (16 characters at mono + tracking).
   */
  test('/verify-2fa does not scroll horizontally', async ({ page }) => {
    const user = await seedDedicatedUser(
      dedicatedUser('member', `mobile-verify-2fa-${Date.now()}`),
    );
    await getAdminDb()
      .collection('users')
      .doc(user.uid)
      .set(
        {
          mfaEnrolled: true,
          requiresMfaSetup: false,
          mfaSecret: authenticator.generateSecret(),
          backupCodes: [
            crypto.createHash('sha256').update('ABCDEF12').digest('hex'),
          ],
        },
        { merge: true },
      );

    await page.goto('/login');
    await page.getByLabel(/email/i).fill(user.email);
    await page.getByLabel(/password/i).first().fill(user.password);
    await page.getByRole('button', { name: /sign in with email/i }).click();

    await expect(page).toHaveURL(/\/verify-2fa/, { timeout: 20_000 });
    await expect(page.getByPlaceholder('000000')).toBeVisible();
    await assertNoHorizontalOverflow(page);

    await page.getByRole('button', { name: /use backup code instead/i }).click();
    await expect(page.getByPlaceholder('backup code')).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });
});

test.describe('mobile responsive acceptance — authenticated routes', () => {
  test.use(roleState('admin'));

  let mintedKey: MintedApiKey | null = null;

  test.afterAll(async () => {
    if (mintedKey) {
      await revokeApiKey(mintedKey);
      mintedKey = null;
    }
    await getAdminDb()
      .collection('sites')
      .doc(SITE_ID)
      .collection('webhooks')
      .doc(WEBHOOK_ID)
      .delete();
  });

  test('/dashboard (card view) does not scroll horizontally', async ({ page }) => {
    await seedDashboardMachines();
    await page.goto('/dashboard');
    // Card is the default — dashboard/page.tsx only overrides viewType from
    // localStorage, which the role fixture never sets.
    await expect(page.getByTestId('machine-card').first()).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  // Only the CARD view can overflow: the list table is `table-layout: fixed` +
  // `contain: layout`, so it clips instead of widening the page.
  test('/dashboard (list view) does not scroll horizontally', async ({ page }) => {
    await seedDashboardMachines();
    await page.goto('/dashboard');
    await expect(page.getByTestId('machine-card').first()).toBeVisible();

    await page.getByTestId('view-toggle-list').click();
    // Park the pointer off the toggle — its Radix tooltip would be measured.
    await page.mouse.move(0, 0);
    await expect(page.getByTestId('machine-row').first()).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  test('/logs does not scroll horizontally', async ({ page }) => {
    await seedLogEvents(SITE_ID);
    await page.goto('/logs');
    await expect(page.getByRole('heading', { name: /^logs$/i })).toBeVisible();
    await expect(page.getByText('TouchDesigner', { exact: true }).first()).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  // /hoot does not overflow the DOCUMENT at 390px (what this gate measures — see
  // helpers/mobile.ts); an inner-pane scroller would need its own assertion.
  test('/hoot does not scroll horizontally', async ({ page }) => {
    await seedHootFixture({ userId: TEST_USERS.admin.uid });
    await page.goto('/hoot');
    // Conversations sit behind a collapsed sidebar here — anchor on the
    // always-mounted composer + target selector.
    await expect(page.getByLabel(/hoot target/i)).toBeVisible();
    await expect(page.getByLabel('chat message')).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  test('/deployments does not scroll horizontally', async ({ page }) => {
    await seedMachine(SITE_ID, MACHINE_ID);
    await page.goto('/deployments');
    await expect(
      page.getByRole('heading', { name: 'deployments', exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await assertNoHorizontalOverflow(page);
  });

  test('/roosts does not scroll horizontally', async ({ page }) => {
    await seedMachine(SITE_ID, MACHINE_ID);
    await seedRoostWithVersionHistory(SITE_ID, ROOST_ID, {
      name: ROOST_NAME,
      targets: [MACHINE_ID],
      versionCount: 2,
      descriptions: ['initial import', 'mobile responsive acceptance fixture'],
    });
    await page.goto('/roosts');
    await expect(
      page.getByRole('heading', { name: 'roosts', exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`[data-roost-row="${ROOST_ID}"]`)).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  test('/settings/api-keys does not scroll horizontally', async ({ page }) => {
    mintedKey = await mintApiKey({
      ownerUid: TEST_USERS.admin.uid,
      name: API_KEY_NAME,
      scopes: [{ resource: 'site', id: SITE_ID, permissions: ['read', 'write'] }],
    });
    await page.goto('/settings/api-keys');
    await expect(
      page.getByRole('heading', { name: 'api keys', exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(API_KEY_NAME)).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  test('/settings/webhooks does not scroll horizontally', async ({ page }) => {
    await seedWebhook();
    await page.goto('/settings/webhooks');
    await expect(
      page.getByRole('heading', { name: 'webhooks', exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('code', { hasText: WEBHOOK_URL })).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  test('/settings/alerts does not scroll horizontally', async ({ page }) => {
    await page.goto('/settings/alerts');
    await expect(
      page.getByRole('heading', { name: 'manage alerts', exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await assertNoHorizontalOverflow(page);
  });

  test('/add does not scroll horizontally', async ({ page }) => {
    await page.goto('/add?code=silver-compass-drift');
    await expect(page.getByText('add machine').first()).toBeVisible();
    await expect(page.getByLabel(/pairing phrase/i)).toHaveValue('silver-compass-drift');
    await assertNoHorizontalOverflow(page);
  });
});
