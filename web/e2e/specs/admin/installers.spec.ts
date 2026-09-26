/**
 * Admin — installer versions page.
 *
 * Seeded via Admin SDK, bypassing Storage:
 *   `installer_metadata/data/versions/{version}` + `installer_metadata/latest`
 *   (a pointer doc cloned from the current latest version's metadata).
 * The older version keeps the pre-`files` flat shape (windows only); the
 * latest carries `files` for windows and macos.
 *
 * The upload spec drives the real dialog → POST → binary PUT → PUT finalize
 * flow. The browser's raw PUT to the storage emulator carries no firebase
 * auth, and `storage.rules` needs a superadmin to write `agent-installers/`,
 * so the spec adds the emulator's `Bearer owner` bypass header to that one
 * request.
 *
 * Not covered: the delete happy path (the hook calls deleteObject() first,
 * which fails for seeded-only versions — needs a stubStorage helper).
 */

import { createHash } from 'crypto';
import { test, expect } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { installerFileName, type InstallerPlatform } from '@/lib/installerPlatform';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';

test.use(roleState('superadmin'));

interface SeededInstaller {
  version: string;
  file_size: number;
  uploadedDaysAgo: number;
  release_notes?: string;
  /** platforms written under `files`; absent = the legacy flat windows-only shape */
  platforms?: InstallerPlatform[];
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
  platforms: ['windows_x64', 'macos_arm64'],
};

const PKG_BYTES = Buffer.from('not a real pkg, but the bytes the emulator stores and finalize hashes');
const PKG_SHA256 = createHash('sha256').update(PKG_BYTES).digest('hex');

function makeVersionData(spec: SeededInstaller) {
  const d = new Date();
  d.setDate(d.getDate() - spec.uploadedDaysAgo);
  const fileEntry = (platform: InstallerPlatform) => ({
    download_url: `https://storage.emulator/installers/${spec.version}/${installerFileName(spec.version, platform)}`,
    checksum_sha256: 'deadbeef'.repeat(8),
    file_size: spec.file_size,
    file_name: installerFileName(spec.version, platform),
    uploaded_at: d.getTime(),
  });
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
    ...(spec.platforms
      ? { files: Object.fromEntries(spec.platforms.map((p) => [p, fileEntry(p)])) }
      : {}),
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

test('renders one file row per platform under each version, — where the version has no file', async ({ page }) => {
  await page.goto('/admin/installers');
  // RequireAdminAccess spinner — see the first test.
  await expect(
    page.getByRole('heading', { name: 'installers', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  // Each version is its own <tbody>: the version row, then a row per platform.
  const olderGroup = page.locator('tbody').filter({ hasText: OLDER_VERSION.version });
  const latestGroup = page.locator('tbody').filter({ hasText: LATEST_VERSION.version });

  // The legacy flat doc synthesises the windows entry; the other two are empty.
  const olderWindows = olderGroup.locator('tr[data-platform="windows_x64"]');
  await expect(olderWindows).toContainText('windows');
  await expect(olderWindows).toContainText(/MB/);
  await expect(olderWindows).toContainText('sha256 deadbeefdead');
  await expect(olderWindows.getByRole('link', { name: /download/i })).toHaveAttribute(
    'href',
    /Owlette\.exe$/,
  );
  for (const platform of ['macos_arm64', 'linux_x64']) {
    const row = olderGroup.locator(`tr[data-platform="${platform}"]`);
    await expect(row).toContainText('—');
    await expect(row.getByRole('link')).toHaveCount(0);
  }

  // A doc with `files` lists what it has and — for what it lacks.
  const latestMac = latestGroup.locator('tr[data-platform="macos_arm64"]');
  await expect(latestMac).toContainText('macos (apple silicon)');
  await expect(latestMac).toContainText(/MB/);
  await expect(latestMac.getByRole('link', { name: /download/i })).toHaveAttribute(
    'href',
    /\.pkg$/,
  );
  await expect(latestGroup.locator('tr[data-platform="linux_x64"]')).toContainText('—');
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

test('the upload dialog refuses a non-installer file and labels a .pkg by platform', async ({ page }) => {
  await page.goto('/admin/installers');
  // RequireAdminAccess spinner — see the first test.
  await expect(
    page.getByRole('heading', { name: 'installers', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: /upload new version/i }).click();
  const dialog = page.getByRole('dialog', { name: /^upload new installer version$/i });
  await expect(dialog).toBeVisible();

  // The hidden <input type="file"> behind "choose file".
  const fileInput = dialog.locator('#file-upload');
  await fileInput.setInputFiles({
    name: 'Owlette-Installer-v2.0.0.zip',
    mimeType: 'application/zip',
    buffer: PKG_BYTES,
  });
  await expect(page.getByText(/invalid file/i)).toBeVisible();
  await expect(dialog.getByText('Owlette-Installer-v2.0.0.zip')).toHaveCount(0);

  await fileInput.setInputFiles({
    name: 'Owlette-Installer-v2.0.0.pkg',
    mimeType: 'application/octet-stream',
    buffer: PKG_BYTES,
  });
  await expect(dialog.getByText('Owlette-Installer-v2.0.0.pkg')).toBeVisible();
  await expect(dialog.getByText('macos (apple silicon)')).toBeVisible();
  await expect(dialog.locator('#version')).toHaveValue('2.0.0');
});

test('uploading a .pkg under an existing version lists the macos file beside the windows one', async ({ page }) => {
  // storage.rules wants a superadmin on agent-installers/ writes and the raw
  // XHR carries no firebase auth; the emulator honours this bypass header.
  await page.route('**/v0/b/**', (route) =>
    route.continue({
      headers: { ...route.request().headers(), authorization: 'Bearer owner' },
    }),
  );

  await page.goto('/admin/installers');
  // RequireAdminAccess spinner — see the first test.
  await expect(
    page.getByRole('heading', { name: 'installers', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: /upload new version/i }).click();
  const dialog = page.getByRole('dialog', { name: /^upload new installer version$/i });
  await expect(dialog).toBeVisible();

  await dialog.locator('#file-upload').setInputFiles({
    name: `Owlette-Installer-v${OLDER_VERSION.version}.pkg`,
    mimeType: 'application/octet-stream',
    buffer: PKG_BYTES,
  });
  await expect(dialog.locator('#version')).toHaveValue(OLDER_VERSION.version);
  // Keep the seeded latest pointer where it is: this adds a file to an old version.
  await dialog.locator('#set-latest').click();
  await dialog.getByRole('button', { name: /^upload installer$/i }).click();

  await expect(page.getByText(/upload successful/i)).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toBeHidden();

  const group = page.locator('tbody').filter({ hasText: OLDER_VERSION.version });
  await expect(group.locator('tr[data-platform="windows_x64"]')).toContainText(/MB/);
  const macRow = group.locator('tr[data-platform="macos_arm64"]');
  await expect(macRow).toContainText('macos (apple silicon)');
  await expect(macRow).toContainText(`${PKG_BYTES.length} Bytes`);
  await expect(macRow).toContainText(`sha256 ${PKG_SHA256.slice(0, 12)}`);
  await expect(macRow.getByRole('link', { name: /download/i })).toHaveCount(1);
  await expect(group.locator('tr[data-platform="linux_x64"]')).toContainText('—');

  // Admin SDK read-through: the file merged into `files`, the pointer untouched.
  const db = getAdminDb();
  const versionDoc = await db
    .collection('installer_metadata')
    .doc('data')
    .collection('versions')
    .doc(OLDER_VERSION.version)
    .get();
  const files = versionDoc.data()!.files;
  expect(files.macos_arm64.file_name).toBe(`Owlette-Installer-v${OLDER_VERSION.version}.pkg`);
  expect(files.macos_arm64.file_size).toBe(PKG_BYTES.length);
  expect(files.macos_arm64.checksum_sha256).toBe(PKG_SHA256);
  expect(files.windows_x64).toBeUndefined();
  const latest = await db.collection('installer_metadata').doc('latest').get();
  expect(latest.data()!.version).toBe(LATEST_VERSION.version);
});
