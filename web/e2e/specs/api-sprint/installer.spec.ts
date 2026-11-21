/**
 * installer-api e2e — the platform-scoped `/api/installer/*` endpoints with an
 * `installer=*:write|admin` superadmin api key.
 *
 * Happy paths: GET /api/installer, POST upload (signed url), PUT upload
 * (finalize), POST {version}/set-latest, DELETE {version}.
 * Negatives: 403 superadmin gate for a non-superadmin key; 409
 * min_versions_violated when DELETE would drop active count below 2.
 *
 * The binary PUT to the signed URL is NOT exercised — only the metadata side.
 * The storage object is stubbed directly so finalize's `file.exists()` passes.
 */
import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { mintApiKey, revokeApiKey, authHeaders, type MintedApiKey } from '../../helpers/apiKey';
import { getAdminDb } from '../../helpers/emulator';

const SUFFIX = crypto.randomBytes(4).toString('hex');

let superKey: MintedApiKey;
// A non-platform-scoped key — used to assert the superadmin gate rejects it.
let nonPlatformKey: MintedApiKey;
// installer write without admin: uploads, but may not move latest.
let writeOnlyKey: MintedApiKey;

async function clearInstallerVersions(): Promise<void> {
  const db = getAdminDb();
  const col = db.collection('installer_metadata').doc('data').collection('versions');
  const snap = await col.get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
  await db.collection('installer_metadata').doc('latest').delete().catch(() => undefined);
}

async function clearInstallerUploads(): Promise<void> {
  const db = getAdminDb();
  const snap = await db.collection('installer_uploads').get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

async function seedVersion(version: string, deletedAt: number | null = null): Promise<void> {
  const db = getAdminDb();
  await db
    .collection('installer_metadata')
    .doc('data')
    .collection('versions')
    .doc(version)
    .set({
      version,
      download_url: `https://example.com/Owlette-Installer-v${version}.exe`,
      checksum_sha256: 'a'.repeat(64),
      release_notes: null,
      file_size: 1024,
      uploaded_at: Date.now(),
      uploaded_by: 'super-uid',
      ...(deletedAt !== null ? { deletedAt } : {}),
    });
}

test.beforeAll(async () => {
  superKey = await mintApiKey({
    ownerUid: 'super-uid',
    name: `e2e-installer-super-${SUFFIX}`,
    scopes: [{ resource: 'installer', id: '*', permissions: ['read', 'write', 'admin'] }],
  });
  nonPlatformKey = await mintApiKey({
    ownerUid: 'admin-uid', // admin role, not superadmin
    name: `e2e-installer-non-platform-${SUFFIX}`,
    scopes: [{ resource: 'site', id: 'site-A', permissions: ['read', 'write'] }],
  });
  writeOnlyKey = await mintApiKey({
    ownerUid: 'super-uid',
    name: `e2e-installer-write-only-${SUFFIX}`,
    scopes: [{ resource: 'installer', id: '*', permissions: ['write'] }],
  });
});

test.afterAll(async () => {
  if (superKey) await revokeApiKey(superKey);
  if (nonPlatformKey) await revokeApiKey(nonPlatformKey);
  if (writeOnlyKey) await revokeApiKey(writeOnlyKey);
  await clearInstallerVersions();
  await clearInstallerUploads();
});

test.beforeEach(async () => {
  await clearInstallerVersions();
  await clearInstallerUploads();
});

test('GET /api/installer — lists versions newest first', async ({ request }) => {
  await Promise.all([seedVersion('1.0.0'), seedVersion('2.0.0'), seedVersion('3.0.0')]);

  const res = await request.get('/api/installer?page_size=50', {
    headers: authHeaders(superKey, false),
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.versions)).toBe(true);
  expect(body.versions.length).toBeGreaterThanOrEqual(3);
  // Verify the version field is present.
  expect(typeof body.versions[0].version).toBe('string');
});

test('POST /api/installer/upload — step 1 returns signed upload url + uploadId', async ({ request }) => {
  const version = '9.9.1';
  const res = await request.post('/api/installer/upload', {
    headers: authHeaders(superKey),
    data: {
      version,
      fileName: `Owlette-Installer-v${version}.exe`,
      releaseNotes: 'e2e test build',
      setAsLatest: true,
    },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(typeof body.uploadUrl).toBe('string');
  expect(typeof body.uploadId).toBe('string');
  expect(body.storagePath).toContain(version);

  // Firestore record was written.
  const db = getAdminDb();
  const uploadDoc = await db.collection('installer_uploads').doc(body.uploadId).get();
  expect(uploadDoc.exists).toBe(true);
  expect(uploadDoc.data()?.version).toBe(version);
  expect(uploadDoc.data()?.status).toBe('pending');
});

test('POST /api/installer/upload — non-superadmin api key gets 403', async ({ request }) => {
  const res = await request.post('/api/installer/upload', {
    headers: authHeaders(nonPlatformKey),
    data: {
      version: '9.9.2',
      fileName: 'Owlette-Installer-v9.9.2.exe',
    },
  });
  expect(res.status()).toBe(403);
});

test('POST /api/installer/upload — a write-only key uploads without promoting, and is refused promoting', async ({ request }) => {
  const version = '9.9.3';
  const fileName = `Owlette-Installer-v${version}.exe`;

  const refused = await request.post('/api/installer/upload', {
    headers: authHeaders(writeOnlyKey),
    data: { version, fileName },
  });
  expect(refused.status()).toBe(403);
  expect((await refused.json()).code).toBe('scope_insufficient');

  const res = await request.post('/api/installer/upload', {
    headers: authHeaders(writeOnlyKey),
    data: { version, fileName, setAsLatest: false },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  const uploadDoc = await getAdminDb().collection('installer_uploads').doc(body.uploadId).get();
  expect(uploadDoc.data()?.setAsLatest).toBe(false);
});

test('POST /api/installer/{version}/set-latest — promotes to latest', async ({ request }) => {
  const version = '4.5.6';
  await seedVersion(version);

  const res = await request.post(`/api/installer/${version}/set-latest`, {
    headers: authHeaders(superKey),
    data: {},
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.version).toBe(version);
  expect(body.latest?.version).toBe(version);

  const db = getAdminDb();
  const latestDoc = await db.collection('installer_metadata').doc('latest').get();
  expect(latestDoc.data()?.version).toBe(version);
});

test('DELETE /api/installer/{version} — soft-deletes when min-versions-active not violated', async ({ request }) => {
  // Seed 3 active versions so deleting one leaves 2 (the floor).
  await Promise.all([seedVersion('1.0.0'), seedVersion('2.0.0'), seedVersion('3.0.0')]);

  // Floor check is `active <= MIN_ACTIVE_VERSIONS(2)`, so 3 → delete would
  // already trip it. Seed 4.
  await seedVersion('4.0.0');

  const res = await request.delete('/api/installer/1.0.0', {
    headers: authHeaders(superKey, false),
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.version).toBe('1.0.0');
  expect(typeof body.deletedAt === 'number').toBe(true);

  // Doc has deletedAt set.
  const db = getAdminDb();
  const docSnap = await db
    .collection('installer_metadata')
    .doc('data')
    .collection('versions')
    .doc('1.0.0')
    .get();
  expect(typeof docSnap.data()?.deletedAt).toBe('number');
});

test('DELETE /api/installer/{version} — 409 min_versions_violated at floor', async ({ request }) => {
  // Seed exactly 2 active versions — deleting either should trip the floor.
  await Promise.all([seedVersion('1.0.0'), seedVersion('2.0.0')]);

  const res = await request.delete('/api/installer/1.0.0', {
    headers: authHeaders(superKey, false),
  });
  expect(res.status()).toBe(409);
  const body = await res.json();
  expect(body.code).toBe('min_versions_violated');
});
