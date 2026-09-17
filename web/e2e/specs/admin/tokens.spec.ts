/**
 * Admin — agent tokens page.
 *
 * Tokens live in the ROOT `agent_refresh_tokens` collection filtered by the
 * `siteId` field (not a subcollection). The page reads
 * `/api/sites/{siteId}/agent-tokens` and revokes via .../revoke.
 *
 * Covers list rendering, empty state, revoke-single and revoke-all (each
 * verified against the Admin SDK). No create-token UI exists — tokens are
 * minted by the agent device-code pairing flow.
 */

import { test, expect, type Page } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedSite } from '../../helpers/seed';

test.use(roleState('superadmin'));

const SITE_ID = 'site-token-tests';
const SITE_NAME = 'Z Token Test Site';

interface SeededToken {
  id: string;
  machineId: string;
  version: string;
}

async function clearTokensForSite() {
  const db = getAdminDb();
  const snap = await db
    .collection('agent_refresh_tokens')
    .where('siteId', '==', SITE_ID)
    .get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

async function seedToken(token: SeededToken) {
  const db = getAdminDb();
  await db
    .collection('agent_refresh_tokens')
    .doc(token.id)
    .set({
      siteId: SITE_ID,
      machineId: token.machineId,
      version: token.version,
      createdBy: 'super-uid',
      createdAt: Timestamp.now(),
      lastUsed: null,
      expiresAt: null, // never expires
      agentUid: `agent-${token.machineId}`,
    });
}

async function tokensForSite() {
  const db = getAdminDb();
  const snap = await db
    .collection('agent_refresh_tokens')
    .where('siteId', '==', SITE_ID)
    .get();
  return snap.docs;
}

test.beforeEach(async () => {
  await seedSite({ id: SITE_ID, name: SITE_NAME, owner: 'someone-else', timezone: 'UTC' });
  await clearTokensForSite();
});

async function gotoTokensForSeededSite(page: Page) {
  await page.goto('/admin/tokens');
  // 10s: RequireAdminAccess shows a "verifying permissions..." gate while
  // AuthContext hydrates against the auth emulator, and the default 5s races
  // that on cold-emulator runs.
  await expect(
    page.getByRole('heading', { name: 'agent tokens', exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  const siteSelect = page.getByRole('combobox').first();
  await siteSelect.click();
  await page.getByRole('option', { name: SITE_NAME, exact: true }).click();
  await expect(siteSelect).toContainText(SITE_NAME);
}

test('lists seeded tokens with machine IDs and the "Never expires" badge', async ({ page }) => {
  await seedToken({ id: 'token-a-hash', machineId: 'machine-a', version: '2.9.0' });
  await seedToken({ id: 'token-b-hash', machineId: 'machine-b', version: '2.9.0' });

  await gotoTokensForSeededSite(page);

  // Both rows visible with machine IDs (rendered in mono).
  const rowA = page.getByRole('row', { name: /machine-a/ });
  const rowB = page.getByRole('row', { name: /machine-b/ });
  await expect(rowA).toBeVisible();
  await expect(rowB).toBeVisible();
  // Version column.
  await expect(rowA).toContainText('2.9.0');
  // Seeded with expiresAt: null → "Never expires" badge.
  await expect(rowA.getByText('Never expires', { exact: true })).toBeVisible();

  // "revoke all" affordance appears when tokens.length > 0.
  await expect(page.getByRole('button', { name: /revoke all/i })).toBeVisible();
});

test('empty-state message and no revoke-all when no tokens exist', async ({ page }) => {
  // beforeEach already cleared tokens for this site.
  await gotoTokensForSeededSite(page);

  await expect(page.getByText('no active tokens for this site')).toBeVisible();
  // The revoke-all button is gated on `tokens.length > 0` — hidden here.
  await expect(page.getByRole('button', { name: /revoke all/i })).toHaveCount(0);
});

test('revoking a single token removes the Firestore doc', async ({ page }) => {
  await seedToken({ id: 'token-keep', machineId: 'machine-keep', version: '2.9.0' });
  await seedToken({ id: 'token-zap', machineId: 'machine-zap', version: '2.9.0' });

  await gotoTokensForSeededSite(page);

  // Per-row revoke button is labelled just "revoke" (text, not icon).
  const zapRow = page.getByRole('row', { name: /machine-zap/ });
  await zapRow.getByRole('button', { name: /^revoke$/i }).click();

  // Confirmation dialog title includes the machine ID.
  const confirmDialog = page.getByRole('dialog', { name: /revoke token for machine-zap/i });
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByRole('button', { name: /^revoke token$/i }).click();

  // Success toast + zapped row disappears.
  await expect(page.getByText('Token revoked', { exact: true })).toBeVisible();
  await expect(page.getByRole('row', { name: /machine-zap/ })).toHaveCount(0);
  // The kept row is still there.
  await expect(page.getByRole('row', { name: /machine-keep/ })).toBeVisible();

  // Admin SDK — only the kept token remains.
  const remaining = await tokensForSite();
  expect(remaining.map((d) => d.id)).toEqual(['token-keep']);
});

test('revoking all tokens clears every doc for the site', async ({ page }) => {
  await seedToken({ id: 'token-1', machineId: 'machine-1', version: '2.9.0' });
  await seedToken({ id: 'token-2', machineId: 'machine-2', version: '2.9.0' });
  await seedToken({ id: 'token-3', machineId: 'machine-3', version: '2.9.0' });

  await gotoTokensForSeededSite(page);

  await expect(page.getByRole('row', { name: /machine-1/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /machine-2/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /machine-3/ })).toBeVisible();

  const revokeAllButton = page.getByRole('button', { name: /^revoke all$/i });
  await expect(revokeAllButton).toBeVisible();
  await revokeAllButton.click();

  const confirmDialog = page.getByRole('dialog', { name: /revoke all tokens/i });
  await expect(confirmDialog).toBeVisible();
  // The confirm button's text varies with count: "revoke all 3 tokens".
  await confirmDialog.getByRole('button', { name: /^revoke all 3 tokens$/i }).click();

  await expect(page.getByText('All tokens revoked', { exact: true })).toBeVisible();
  // Empty state returns.
  await expect(page.getByText('no active tokens for this site')).toBeVisible();

  // Admin SDK — nothing left for this site.
  const remaining = await tokensForSite();
  expect(remaining.length).toBe(0);
});
