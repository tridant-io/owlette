/**
 * Admin — installer versions page.
 *
 * Seeded via Admin SDK, bypassing Storage:
 *   `installer_metadata/data/versions/{version}` + `installer_metadata/latest`
 *   (a pointer doc cloned from the current latest version's metadata).
 *
 * Not covered: end-to-end upload (needs a real .exe fixture, and the metadata
 * shape is already pinned here), and the delete happy path (the hook calls
 * deleteObject() first, which fails for seeded-only versions — needs a
 * stubStorage helper).
 */

import { test, expect } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';

test.use(roleState('superadmin'));

interface SeededInstaller {
  version: string;
  file_size: number;
  uploadedDaysAgo: number;
  release_notes?: string;
}

const OLDER_VERSION: SeededInstaller = {
  version: '2.0.0',
  file_size: 90_000_000,
  uploadedDaysAgo: 14,
  release_notes: 'initial release',
};

const LATEST_VERSION: SeededInstaller = {
  version: '2.1.0',
  file_size: 100_000_000,
  uploadedDaysAgo: 1,
  release_notes: 'minor feature release',
};

function makeVersionData(spec: SeededInstaller) {
  const d = new Date();
  d.setDate(d.getDate() - spec.uploadedDaysAgo);
  return {
    version: spec.version,
    download_url: `https://storage.emulator/installers/${spec.version}/Owlette.exe`,
    file_size: spec.file_size,
    release_date: Timestamp.fromDate(d),
    uploaded_at: d.getTime(),
    checksum_sha256: 'deadbeef'.repeat(8),
    uploaded_by: 'super@e2e.test',
    deletedAt: null,
    ...(spec.release_notes ? { release_notes: spec.release_notes } : {}),
  };
}

async function seedInstallerMetadata() {
  const db = getAdminDb();
  const versionsCol = db.collection('installer_metadata').doc('data').collection('versions');
  const latestDoc = db.collection('installer_metadata').doc('latest');

  // Clear prior state so reruns don't leak.
  const existing = await versionsCol.get();
  await Promise.all(existing.docs.map((d) => d.ref.delete()));

  await versionsCol.doc(OLDER_VERSION.version).set(makeVersionData(OLDER_VERSION));
  await versionsCol.doc(LATEST_VERSION.version).set(makeVersionData(LATEST_VERSION));
  await latestDoc.set(makeVersionData(LATEST_VERSION));
}

test.beforeEach(async () => {
  await seedInstallerMetadata();
});

test('lists seeded versions with sizes, uploader and the latest badge on the right row', async ({ page }) => {
  await page.goto('/admin/installers');

  // 10s, not the 5s default: RequireAdminAccess holds a "verifying
  // permissions..." gate while AuthContext hydrates against the auth emulator,
  // which races the default on cold-emulator runs. Every heading check here
  // keeps the bump.
  await expect(
    page.getByRole('heading', { name: 'installers', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  await expect(page.getByText('current latest version')).toBeVisible();
  // Scope to the card, or this matches the same text in the table.
  const statsCard = page
    .locator('div.bg-card.border')
    .filter({ hasText: 'current latest version' });
  await expect(statsCard.getByText(LATEST_VERSION.version, { exact: true })).toBeVisible();

  const table = page.locator('table');
  const olderRow = table.locator('tr').filter({ hasText: OLDER_VERSION.version });
  const latestRow = table.locator('tr').filter({ hasText: LATEST_VERSION.version });

  await expect(olderRow).toBeVisible();
  await expect(latestRow).toBeVisible();

  await expect(latestRow).toContainText('super@e2e.test');

  await expect(latestRow.getByText('Latest', { exact: true })).toBeVisible();
  await expect(olderRow.getByText('Latest', { exact: true })).toHaveCount(0);

  // Match only /MB/ — don't pin formatFileSize()'s exact rounding.
  await expect(latestRow).toContainText(/MB/);
});

test('the latest row hides the set-as-latest and delete buttons', async ({ page }) => {
  await page.goto('/admin/installers');
  // RequireAdminAccess spinner — see the first test.
  await expect(
    page.getByRole('heading', { name: 'installers', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  const latestRow = page.locator('table tr').filter({ hasText: LATEST_VERSION.version });
  await expect(latestRow).toBeVisible();

  await expect(latestRow.getByRole('button', { name: /set as latest/i })).toHaveCount(0);

  // Trash is omitted too (a spacer div renders instead). red-400 is the
  // trash-only color, so its absence is the simplest negative.
  await expect(latestRow.locator('button.text-red-400')).toHaveCount(0);

  // The older row keeps both affordances.
  const olderRow = page.locator('table tr').filter({ hasText: OLDER_VERSION.version });
  await expect(olderRow.getByRole('button', { name: /set as latest/i })).toBeVisible();
  await expect(olderRow.locator('button.text-red-400')).toHaveCount(1);
});

test('set-as-latest confirms via dialog and updates Firestore latest doc', async ({ page }) => {
  await page.goto('/admin/installers');
  // RequireAdminAccess spinner — see the first test.
  await expect(
    page.getByRole('heading', { name: 'installers', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  const olderRow = page.locator('table tr').filter({ hasText: OLDER_VERSION.version });
  await olderRow.getByRole('button', { name: /set as latest/i }).click();

  const confirmDialog = page.getByRole('dialog', { name: /^set as latest version$/i });
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog).toContainText(OLDER_VERSION.version);

  await confirmDialog.getByRole('button', { name: /^OK$/ }).click();

  await expect(page.getByText(/latest version updated/i)).toBeVisible();

  const newLatestRow = page.locator('table tr').filter({ hasText: OLDER_VERSION.version });
  const oldLatestRow = page.locator('table tr').filter({ hasText: LATEST_VERSION.version });
  await expect(newLatestRow.getByText('Latest', { exact: true })).toBeVisible();
  await expect(oldLatestRow.getByText('Latest', { exact: true })).toHaveCount(0);

  // Admin SDK read-through — the real contract assertion.
  const db = getAdminDb();
  const latest = await db.collection('installer_metadata').doc('latest').get();
  expect(latest.exists).toBe(true);
  expect(latest.data()!.version).toBe(OLDER_VERSION.version);
});

test('clicking "upload new version" opens the upload dialog', async ({ page }) => {
  await page.goto('/admin/installers');
  // RequireAdminAccess spinner — see the first test.
  await expect(
    page.getByRole('heading', { name: 'installers', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: /upload new version/i }).click();

  await expect(
    page.getByRole('dialog', { name: /^upload new installer version$/i }),
  ).toBeVisible();
});
