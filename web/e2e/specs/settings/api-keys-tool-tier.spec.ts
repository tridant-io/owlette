/**
 * Settings — api keys: choosing a key's tool tier. Create and edit both offer it,
 * in lowercase, and it defaults to tier 1. Raising takes a session that passed a
 * second factor, so the choosing specs sign in with totp and the refusal spec with
 * a fixture account that holds no factor. The commands route then answers by the
 * tier that was chosen.
 */

import crypto from 'crypto';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { getAdminDb } from '../../helpers/emulator';
import { dedicatedUser, seedDedicatedUser } from '../../helpers/coverageSeed';
import { grantMembership, seedMachine, seedSite, type TestUser } from '../../helpers/seed';

authenticator.options = { step: 30, window: 1 };

test.use({ storageState: { cookies: [], origins: [] } });

const SITE_ID = 'tool-tier-site';
const MACHINE_ID = 'tool-tier-machine';
const COMMANDS = `/api/sites/${SITE_ID}/machines/${MACHINE_ID}/commands`;
const MACHINE_SCOPE = [{ resource: 'machine', id: '*', permissions: ['read', 'write'] }];

// one account per spec: the api refuses a totp code it has already seen.
const creator = { user: null as unknown as TestUser, secret: '' };
const editor = { user: null as unknown as TestUser, secret: '' };
let noFactor: TestUser;

async function seedTotpUser(suffix: string): Promise<{ user: TestUser; secret: string }> {
  const user = await seedDedicatedUser(dedicatedUser('admin', suffix));
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

async function clearKeys(uid: string): Promise<void> {
  const db = getAdminDb();
  const records = await db.collection('users').doc(uid).collection('api_keys').get();
  await Promise.all(records.docs.map((doc) => doc.ref.delete()));
  const lookups = await db.collection('api_keys').where('userId', '==', uid).get();
  await Promise.all(lookups.docs.map((doc) => doc.ref.delete()));
}

async function onlyKey(uid: string): Promise<Record<string, unknown>> {
  const lookups = await getAdminDb().collection('api_keys').where('userId', '==', uid).get();
  expect(lookups.size).toBe(1);
  return lookups.docs[0].data();
}

async function signIn(page: Page, user: TestUser, secret?: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(user.email);
  await page.getByLabel(/password/i).first().fill(user.password);
  await page.getByRole('button', { name: /sign in with email/i }).click();
  if (secret) {
    await expect(page).toHaveURL(/\/verify-2fa/, { timeout: 20_000 });
    if (authenticator.timeRemaining() <= 5) {
      await page.waitForTimeout((authenticator.timeRemaining() + 1) * 1000);
    }
    await page.getByPlaceholder('000000').fill(authenticator.generate(secret));
    await page.getByRole('button', { name: /^verify$/i }).click();
  }
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
}

async function openKeysPage(page: Page): Promise<void> {
  await page.goto('/settings/api-keys');
  await expect(page.getByRole('heading', { name: 'api keys', exact: true })).toBeVisible({
    timeout: 10_000,
  });
}

async function chooseTier(scope: Locator | Page, page: Page, label: string): Promise<void> {
  await scope.getByLabel('tool tier').click();
  await page.getByRole('option', { name: label }).click();
}

async function createKey(page: Page, name: string, tierLabel?: string): Promise<number> {
  await page.getByRole('button', { name: /^create key$/i }).click();
  const dialog = page.getByRole('dialog', { name: 'create api key' });
  await dialog.getByLabel('name').fill(name);
  if (tierLabel) await chooseTier(dialog, page, tierLabel);
  const response = page.waitForResponse(
    (res) => res.url().endsWith('/api/keys') && res.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: /^create key$/i }).click();
  return (await response).status();
}

test.beforeAll(async () => {
  Object.assign(creator, await seedTotpUser('tool-tier-creator'));
  Object.assign(editor, await seedTotpUser('tool-tier-editor'));
  noFactor = await seedDedicatedUser(dedicatedUser('admin', 'tool-tier-no-factor'));
  await seedSite({ id: SITE_ID, name: 'tool tier site', owner: editor.user.uid });
  await grantMembership(SITE_ID, editor.user.uid, 'owner');
  await seedMachine(SITE_ID, MACHINE_ID);
});

async function clearAllKeys(): Promise<void> {
  await Promise.all([creator, editor, { user: noFactor }].map(({ user }) => clearKeys(user.uid)));
}

test.beforeEach(clearAllKeys);
test.afterAll(clearAllKeys);

test('create offers the tiers in lowercase, defaults to tier 1, and a chosen tier sticks', async ({
  page,
}) => {
  await signIn(page, creator.user, creator.secret);
  await openKeysPage(page);

  await page.getByRole('button', { name: /^create key$/i }).click();
  const dialog = page.getByRole('dialog', { name: 'create api key' });
  await expect(dialog.getByLabel('tool tier')).toContainText('tier 1: read only');
  await expect(dialog.getByText('changes nothing.')).toBeVisible();
  await dialog.getByLabel('tool tier').click();
  for (const label of ['tier 1: read only', 'tier 2: machine changes', 'tier 3: full control']) {
    await expect(page.getByRole('option', { name: label })).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await dialog.getByRole('button', { name: 'cancel' }).click();

  const name = `tier-${Date.now()}`;
  expect(await createKey(page, name, 'tier 2: machine changes')).toBe(200);
  expect((await onlyKey(creator.user.uid)).maxToolTier).toBe(2);

  await page.getByRole('button', { name: `show details for ${name}` }).click();
  await expect(page.getByText('tier 2: machine changes')).toBeVisible();
});

test('the editor raises a key made at tier 1, and the commands route follows', async ({
  page,
  request,
}) => {
  const { uid } = editor.user;
  await signIn(page, editor.user, editor.secret);
  await openKeysPage(page);

  // minted with no value, as every key before this setting was
  const rawKey = `owk_live_${crypto.randomBytes(32).toString('base64url')}`;
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const keyId = crypto.randomUUID();
  const name = `old-key-${Date.now()}`;
  const expiresAt = Date.now() + 86_400_000;
  const db = getAdminDb();
  await db.collection('users').doc(uid).collection('api_keys').doc(keyId).set({
    name,
    keyHash,
    keyPrefix: rawKey.slice(0, 15),
    environment: 'live',
    scopes: MACHINE_SCOPE,
    expiresAt,
    createdAt: new Date(),
    lastUsedAt: null,
    expiredMarkedAt: null,
  });
  await db.collection('api_keys').doc(keyHash).set({
    userId: uid,
    keyId,
    environment: 'live',
    scopes: MACHINE_SCOPE,
    expiresAt,
  });

  // parameters each tool accepts, so a call reaches the tier gate rather than the parameter check
  const params: Record<string, Record<string, unknown>> = { run_powershell: { script: 'Get-Date' } };
  const runTool = (toolName: string) =>
    request.post(COMMANDS, {
      headers: { 'x-api-key': rawKey, 'Idempotency-Key': crypto.randomUUID() },
      data: { type: 'mcp_tool_call', params: { tool_name: toolName, tool_params: params[toolName] ?? {} } },
    });

  expect((await runTool('get_system_info')).status()).toBe(202);
  const refused = await runTool('run_powershell');
  expect(refused.status()).toBe(403);
  expect((await refused.json()).code).toBe('max_tool_tier_exceeded');

  await page.reload();
  await page.getByRole('button', { name: `actions for ${name}` }).click();
  await page.getByRole('menuitem', { name: 'edit scopes' }).click();
  const panel = page.getByRole('heading', { name: `editing ${name}` }).locator('xpath=parent::div');
  await expect(panel.getByLabel('tool tier')).toContainText('tier 1: read only');
  await chooseTier(panel, page, 'tier 3: full control');
  const saved = page.waitForResponse(
    (res) => res.url().endsWith(`/api/keys/${keyId}`) && res.request().method() === 'PATCH',
  );
  await panel.getByRole('button', { name: 'save changes' }).click();
  expect((await saved).status()).toBe(200);

  expect((await db.collection('api_keys').doc(keyHash).get()).data()?.maxToolTier).toBe(3);
  expect((await runTool('run_powershell')).status()).toBe(202);
});

test('without a second factor a tier 1 key is fine and a raise says why not', async ({ page }) => {
  await signIn(page, noFactor);
  await openKeysPage(page);

  expect(await createKey(page, `plain-${Date.now()}`)).toBe(200);
  expect((await onlyKey(noFactor.uid)).maxToolTier).toBe(1);
  await page.getByRole('button', { name: 'dismiss' }).first().click();

  expect(await createKey(page, `raised-${Date.now()}`, 'tier 2: machine changes')).toBe(403);
  await expect(page.getByText(/needs a dashboard session that passed your second factor/)).toBeVisible();
  expect((await onlyKey(noFactor.uid)).maxToolTier).toBe(1);
});
