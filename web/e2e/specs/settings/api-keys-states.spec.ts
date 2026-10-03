/**
 * Settings — api keys states: /settings/api-keys with four pre-seeded keys, one
 * per lifecycle state (active / rotated-in-grace / expired / revoked). Asserts
 * each row's status-badge text and tone class against KeyCard.tsx keyStatusAt().
 *
 * Seeded through the Admin SDK (user-subcollection record + top-level
 * api_keys/{keyHash} lookup), not POST /api/keys.
 *
 * The revoked row lives behind the panel's "show revoked" disclosure: revoke is a
 * soft delete, so that list only grows and is folded away by default.
 */

import crypto from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { test, expect, type Page } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { TEST_USERS } from '../../helpers/seed';
import type {
  ApiKeyEnvironment,
  ApiKeyLookup,
  ApiKeyRecord,
  ApiKeyScope,
} from '../../../lib/apiKeyTypes';

test.use(roleState('admin'));

const ADMIN_UID = TEST_USERS.admin.uid;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const PUBLISHER_SCOPES: ApiKeyScope[] = [
  { resource: 'roost', id: '*', permissions: ['read', 'write'] },
  { resource: 'site', id: '*', permissions: ['read', 'write'] },
  { resource: 'machine', id: '*', permissions: ['read', 'write'] },
];

type KeyState = 'active' | 'rotated-in-grace' | 'expired' | 'revoked';

interface SeedKeyOptions {
  state: KeyState;
  keyId: string;
  name: string;
}

const SEED_KEYS: SeedKeyOptions[] = [
  { state: 'active', keyId: 'e2e-state-active', name: 'e2e state active' },
  { state: 'rotated-in-grace', keyId: 'e2e-state-rotated', name: 'e2e state rotated' },
  { state: 'expired', keyId: 'e2e-state-expired', name: 'e2e state expired' },
  { state: 'revoked', keyId: 'e2e-state-revoked', name: 'e2e state revoked' },
];

async function seedKey(opts: SeedKeyOptions): Promise<void> {
  const db = getAdminDb();
  const environment: ApiKeyEnvironment = 'live';
  // Deterministic raw value per keyId so the hash is stable on warm-emulator re-runs.
  const rawKey = `owk_live_e2e-states-${opts.keyId}-pad${'x'.repeat(20)}`;
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const keyPrefix = rawKey.slice(0, 15);
  const now = Date.now();

  const base: Omit<ApiKeyRecord, 'createdAt' | 'expiresAt'> & {
    createdAt: FirebaseFirestore.FieldValue;
    expiresAt: number;
  } = {
    name: opts.name,
    keyHash,
    keyPrefix,
    environment,
    scopes: PUBLISHER_SCOPES,
    expiresAt: now + 60 * DAY_MS,
    createdAt: FieldValue.serverTimestamp(),
    lastUsedAt: null,
  };

  const lookup: ApiKeyLookup = {
    userId: ADMIN_UID,
    keyId: opts.keyId,
    environment,
    scopes: PUBLISHER_SCOPES,
    expiresAt: base.expiresAt,
  };

  let record: typeof base & {
    rotatedAt?: number;
    retiresAt?: number;
    revokedAt?: number;
  } = base;
  let lookupDoc: ApiKeyLookup = lookup;

  switch (opts.state) {
    case 'active':
      break;
    case 'rotated-in-grace': {
      const rotatedAt = now - HOUR_MS;
      const retiresAt = now + 23 * HOUR_MS;
      record = { ...base, rotatedAt, retiresAt };
      lookupDoc = { ...lookup, retiresAt };
      break;
    }
    case 'expired': {
      const expiresAt = now - HOUR_MS;
      record = { ...base, expiresAt };
      lookupDoc = { ...lookup, expiresAt };
      break;
    }
    case 'revoked': {
      record = { ...base, revokedAt: now - HOUR_MS };
      break;
    }
  }

  const batch = db.batch();
  batch.set(
    db.collection('users').doc(ADMIN_UID).collection('api_keys').doc(opts.keyId),
    record,
  );
  batch.set(db.collection('api_keys').doc(keyHash), lookupDoc);
  await batch.commit();
}

async function clearApiKeys() {
  const db = getAdminDb();
  const userKeysSnap = await db
    .collection('users')
    .doc(ADMIN_UID)
    .collection('api_keys')
    .get();
  await Promise.all(userKeysSnap.docs.map((d) => d.ref.delete()));
  const lookupSnap = await db
    .collection('api_keys')
    .where('userId', '==', ADMIN_UID)
    .get();
  await Promise.all(lookupSnap.docs.map((d) => d.ref.delete()));
}

function rowFor(page: Page, name: string) {
  return page
    .locator('div.rounded-md.border')
    .filter({ has: page.locator('p.font-medium', { hasText: name }) })
    .first();
}

test.beforeEach(async () => {
  await clearApiKeys();
  for (const opts of SEED_KEYS) {
    await seedKey(opts);
  }
});

test.afterEach(async () => {
  await clearApiKeys();
});

test('active key row renders the green "active" badge', async ({ page }) => {
  await page.goto('/settings/api-keys');
  await expect(
    page.getByRole('heading', { name: 'api keys', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  const row = rowFor(page, 'e2e state active');
  await expect(row).toBeVisible();

  const badge = row.locator('[data-slot="badge"]', { hasText: /^active$/ });
  await expect(badge).toBeVisible();
  await expect(badge).toHaveClass(/text-success/);
});

test('rotated-in-grace row renders amber "rotated (grace)" badge with retire-by hint', async ({
  page,
}) => {
  await page.goto('/settings/api-keys');
  await expect(
    page.getByRole('heading', { name: 'api keys', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  const row = rowFor(page, 'e2e state rotated');
  await expect(row).toBeVisible();

  const badge = row.locator('[data-slot="badge"]', { hasText: /^rotated \(grace\)$/ });
  await expect(badge).toBeVisible();
  await expect(badge).toHaveClass(/text-warning/);

  await expect(row.getByText(/old key stops working /i)).toBeVisible();
});

test(
  'expired key row renders the red "expired" badge',
  async ({ page }) => {
    // Promoted from fixme: GET /api/keys now derives `expired` server-side
    // (buildApiKeyListItem), so a past-due key no longer renders "expiring soon".
    await page.goto('/settings/api-keys');
    await expect(
    page.getByRole('heading', { name: 'api keys', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

    const row = rowFor(page, 'e2e state expired');
    const badge = row.locator('[data-slot="badge"]', { hasText: /^expired$/ });
    await expect(badge).toBeVisible();
    await expect(badge).toHaveClass(/text-danger/);
  },
);

test(
  'revoked key row renders a terminal "revoked" badge with muted treatment',
  async ({ page }) => {
    // Promoted from fixme: revoke is a soft delete now, GET /api/keys derives
    // `revoked` from the surviving revokedAt stamp, and keyStatusAt() branches on
    // it first — ahead of expired, mirroring the auth path's own precedence.
    await page.goto('/settings/api-keys');
    await expect(
    page.getByRole('heading', { name: 'api keys', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

    // Revoked keys are grouped behind a disclosure so the list stays readable as
    // it accumulates; nothing is filtered server-side.
    await page.getByRole('button', { name: /^show revoked \(\d+\)$/ }).click();

    const row = rowFor(page, 'e2e state revoked');
    const badge = row.locator('[data-slot="badge"]', { hasText: /^revoked$/ });
    await expect(badge).toBeVisible();
    await expect(badge).toHaveClass(/text-muted-foreground/);

    // Terminal in every direction: rotate and edit 409, and revoking again is a
    // no-op, so the row carries no action control at all.
    await expect(row.getByRole('button', { name: /^actions for / })).toHaveCount(0);
    await expect(row.getByRole('button', { name: /^revoke / })).toHaveCount(0);
  },
);
