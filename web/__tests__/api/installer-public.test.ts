/** @jest-environment node */

/**
 * /api/installer/* — auth path (resolveAuth + requireScope + superadmin check),
 * idempotency, audit emission, and the min-versions-2 transactional guard.
 */

import { createMockRequest } from './helpers/utils';
import { createHash } from 'crypto';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockEmitMutation = jest.fn();
jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: (...a: unknown[]) => mockEmitMutation(...a),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

const STORAGE_BYTES = Buffer.from('fake-installer-content');
const STORAGE_SHA256 = createHash('sha256').update(STORAGE_BYTES).digest('hex');

// Auth mock

const mockResolveAuth = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
  };
});

// Firestore mock — keyed by collection path so tests can pre-populate
// user role docs, version docs, upload docs, and the idempotency cache.

interface DocStore {
  data: Record<string, unknown> | null;
}

const docStore: Record<string, DocStore> = {};
const collectionDocs: Record<string, Array<{ id: string; data: Record<string, unknown> }>> = {};

function pathFor(parts: string[]): string {
  return parts.join('/');
}

function makeDocRef(parts: string[]): unknown {
  const path = pathFor(parts);
  return {
    id: parts[parts.length - 1],
    get: jest.fn(async () => {
      const entry = docStore[path];
      return {
        exists: !!entry && entry.data !== null,
        id: parts[parts.length - 1],
        data: () => entry?.data ?? undefined,
      };
    }),
    set: jest.fn(async (data: Record<string, unknown>) => {
      docStore[path] = { data };
    }),
    update: jest.fn(async (patch: Record<string, unknown>) => {
      const existing = docStore[path]?.data ?? {};
      docStore[path] = { data: { ...existing, ...patch } };
    }),
    delete: jest.fn(async () => {
      docStore[path] = { data: null };
    }),
    collection: (sub: string) => makeCollectionRef([...parts, sub]),
  };
}

function makeCollectionRef(parts: string[]): unknown {
  const path = pathFor(parts);
  let _orderBy: { field: string; dir: string } | null = null;
  let _limit = 1000;
  let _startAfterId: string | null = null;

  const ref: Record<string, unknown> = {
    doc: (id: string) => makeDocRef([...parts, id]),
    orderBy: (field: string, dir: string) => {
      _orderBy = { field, dir };
      return ref;
    },
    limit: (n: number) => {
      _limit = n;
      return ref;
    },
    startAfter: (snap: { id: string }) => {
      _startAfterId = snap.id;
      return ref;
    },
    get: jest.fn(async () => {
      const docs = (collectionDocs[path] || []).slice();
      if (_orderBy) {
        docs.sort((a, b) => {
          const av = a.data[_orderBy!.field] as number | string;
          const bv = b.data[_orderBy!.field] as number | string;
          if (av === bv) return 0;
          return _orderBy!.dir === 'desc' ? (av > bv ? -1 : 1) : av > bv ? 1 : -1;
        });
      }
      let startIdx = 0;
      if (_startAfterId) {
        const idx = docs.findIndex((d) => d.id === _startAfterId);
        startIdx = idx >= 0 ? idx + 1 : 0;
      }
      const sliced = docs.slice(startIdx, startIdx + _limit);
      return {
        docs: sliced.map((d) => ({
          id: d.id,
          exists: true,
          data: () => d.data,
          ref: makeDocRef([...parts, d.id]),
        })),
      };
    }),
  };
  return ref;
}

const mockRunTransaction = jest.fn(
  async (cb: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
    const tx = {
      get: async (refOrQuery: { get: () => Promise<unknown> }) => refOrQuery.get(),
      set: (ref: { set: (data: Record<string, unknown>) => Promise<void> }, data: Record<string, unknown>) =>
        ref.set(data),
      update: (ref: { update: (patch: Record<string, unknown>) => Promise<void> }, patch: Record<string, unknown>) =>
        ref.update(patch),
    };
    return cb(tx);
  },
);

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => makeCollectionRef([name]),
    runTransaction: mockRunTransaction,
  }),
  getAdminAuth: () => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')),
  }),
  getAdminStorage: () => ({
    bucket: () => ({
      file: () => ({
        getSignedUrl: jest
          .fn()
          .mockResolvedValue(['https://storage.example.com/signed']),
        exists: jest.fn().mockResolvedValue([true]),
        getMetadata: jest.fn().mockResolvedValue([{ size: '1048576' }]),
        download: jest.fn().mockResolvedValue([STORAGE_BYTES]),
      }),
    }),
  }),
}));

// Imports come AFTER mocks

import { GET as listGET } from '@/app/api/installer/route';
import { GET as latestGET } from '@/app/api/installer/latest/route';
import { POST as uploadPOST, PUT as uploadPUT } from '@/app/api/installer/upload/route';
import { DELETE as versionDELETE } from '@/app/api/installer/[version]/route';
import { POST as setLatestPOST } from '@/app/api/installer/[version]/set-latest/route';

// Fixtures

function authedAsSuperadminWithKey(perm: 'read' | 'write' | 'admin', userId = 'user-superadmin'): void {
  mockResolveAuth.mockResolvedValue({
    userId,
    keyContext: {
      keyId: 'key_test',
      environment: 'live',
      isLegacy: false,
      scopes: [{ resource: 'installer', id: '*', permissions: [perm] }],
      expiresAt: null,
    },
  });
  docStore[`users/${userId}`] = { data: { role: 'superadmin' } };
}

function authedAsNonSuperadminWithKey(perm: 'read' | 'write' | 'admin'): void {
  mockResolveAuth.mockResolvedValue({
    userId: 'user-regular',
    keyContext: {
      keyId: 'key_test',
      environment: 'live',
      isLegacy: false,
      scopes: [{ resource: 'installer', id: '*', permissions: [perm] }],
      expiresAt: null,
    },
  });
  docStore['users/user-regular'] = { data: { role: 'admin' } };
}

function authedAsSuperadminSession(userId = 'user-superadmin'): void {
  mockResolveAuth.mockResolvedValue({
    userId,
    keyContext: null,
  });
  docStore[`users/${userId}`] = { data: { role: 'superadmin' } };
}

function authedAsKeyMissingScope(perm: 'read' | 'write' | 'admin'): void {
  // Key holder is superadmin but the key only carries `installer=*:read`,
  // so a write/admin call should still 403 scope_insufficient.
  mockResolveAuth.mockResolvedValue({
    userId: 'user-superadmin',
    keyContext: {
      keyId: 'key_readonly',
      environment: 'live',
      isLegacy: false,
      scopes: [{ resource: 'installer', id: '*', permissions: [perm] }],
      expiresAt: null,
    },
  });
  docStore['users/user-superadmin'] = { data: { role: 'superadmin' } };
}

function seedVersion(version: string, data: Partial<Record<string, unknown>> = {}): void {
  const path = `installer_metadata/data/versions/${version}`;
  const merged = {
    version,
    download_url: `https://storage.example.com/${version}.exe`,
    checksum_sha256: 'a'.repeat(64),
    release_notes: null,
    file_size: 1024,
    uploaded_at: 1700000000000 + parseInt(version.replace(/\./g, ''), 10),
    uploaded_by: 'admin',
    ...data,
  };
  docStore[path] = { data: merged };
  collectionDocs['installer_metadata/data/versions'] =
    collectionDocs['installer_metadata/data/versions'] || [];
  const existing = collectionDocs['installer_metadata/data/versions'].findIndex(
    (d) => d.id === version,
  );
  if (existing >= 0) {
    collectionDocs['installer_metadata/data/versions'][existing] = { id: version, data: merged };
  } else {
    collectionDocs['installer_metadata/data/versions'].push({ id: version, data: merged });
  }
}

function seedLatest(version: string, data: Partial<Record<string, unknown>> = {}): void {
  docStore['installer_metadata/latest'] = {
    data: {
      version,
      download_url: `https://storage.example.com/${version}.exe`,
      checksum_sha256: 'a'.repeat(64),
      release_notes: null,
      file_size: 1024,
      uploaded_at: 1700000000000,
      uploaded_by: 'admin',
      release_date: '2026-04-28T00:00:00.000Z',
      ...data,
    },
  };
}

function seedUpload(uploadId: string, overrides: Partial<Record<string, unknown>> = {}): void {
  docStore[`installer_uploads/${uploadId}`] = {
    data: {
      version: '3.0.0',
      fileName: 'Owlette-Installer-v3.0.0.exe',
      storagePath: 'agent-installers/versions/3.0.0/Owlette-Installer-v3.0.0.exe',
      userId: 'user-superadmin',
      releaseNotes: 'a release',
      setAsLatest: true,
      status: 'pending',
      expiresAt: { toMillis: () => Date.now() + 600000 },
      ...overrides,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(docStore)) delete docStore[k];
  for (const k of Object.keys(collectionDocs)) delete collectionDocs[k];
});

// GET /api/installer

describe('GET /api/installer', () => {
  it('lists versions newest-first, paginated, filtering soft-deleted', async () => {
    authedAsSuperadminWithKey('read');
    seedVersion('2.0.0', { uploaded_at: 1 });
    seedVersion('2.1.0', { uploaded_at: 2 });
    seedVersion('2.2.0', { uploaded_at: 3, deletedAt: Date.now() });

    const req = createMockRequest('http://localhost/api/installer');
    const res = await listGET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.versions).toHaveLength(2);
    expect(body.versions[0].version).toBe('2.1.0');
    expect(body.versions[1].version).toBe('2.0.0');
    expect(body.next_page_token).toBe('');
    expect(body.nextPageToken).toBe('');
  });

  it('includeDeleted=true surfaces soft-deleted entries', async () => {
    authedAsSuperadminWithKey('read');
    seedVersion('2.0.0', { uploaded_at: 1 });
    seedVersion('2.2.0', { uploaded_at: 3, deletedAt: 1234 });

    const req = createMockRequest('http://localhost/api/installer?includeDeleted=true');
    const res = await listGET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.versions).toHaveLength(2);
    const deleted = body.versions.find((v: { version: string }) => v.version === '2.2.0');
    expect(deleted.deletedAt).toBe(1234);
  });

  it('rejects non-superadmin api key with 403 forbidden', async () => {
    authedAsNonSuperadminWithKey('read');

    const req = createMockRequest('http://localhost/api/installer');
    const res = await listGET(req);

    expect(res.status).toBe(403);
  });

  it('rejects superadmin key without installer read scope', async () => {
    authedAsKeyMissingScope('write');

    const req = createMockRequest('http://localhost/api/installer');
    const res = await listGET(req);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe('scope_insufficient');
  });

  it('accepts session/id-token superadmin (scope check bypassed)', async () => {
    authedAsSuperadminSession();
    seedVersion('2.0.0');

    const req = createMockRequest('http://localhost/api/installer');
    const res = await listGET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.versions).toHaveLength(1);
  });

  it('emits page_token when more results exist', async () => {
    authedAsSuperadminWithKey('read');
    for (let i = 0; i < 5; i++) {
      seedVersion(`2.${i}.0`, { uploaded_at: i });
    }

    const req = createMockRequest('http://localhost/api/installer?page_size=2');
    const res = await listGET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.versions).toHaveLength(2);
    expect(body.next_page_token).toBe(body.nextPageToken);
    expect(body.nextPageToken).not.toBe('');
  });

  it('uses the last emitted version as page token when deleted docs are skipped', async () => {
    authedAsSuperadminWithKey('read');
    seedVersion('3.0.0', { uploaded_at: 3 });
    seedVersion('2.9.0', { uploaded_at: 2, deletedAt: 1234 });
    seedVersion('2.8.0', { uploaded_at: 1 });

    const req = createMockRequest('http://localhost/api/installer?page_size=1');
    const res = await listGET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0].version).toBe('3.0.0');
    expect(body.next_page_token).toBe('3.0.0');
  });
});

// GET /api/installer/latest

describe('GET /api/installer/latest', () => {
  it('returns current latest installer metadata from the active version record', async () => {
    authedAsSuperadminWithKey('read');
    seedVersion('3.0.0', { uploaded_at: 3, release_date: { toDate: () => new Date('2026-04-28T00:00:00.000Z') } });
    seedLatest('3.0.0', { promoted_at: 456, promoted_by: 'admin-2' });

    const req = createMockRequest('http://localhost/api/installer/latest');
    const res = await latestGET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.version).toBe('3.0.0');
    expect(body.download_url).toBe('https://storage.example.com/3.0.0.exe');
    expect(body.release_date).toBe('2026-04-28T00:00:00.000Z');
    expect(body.promoted_at).toBe(456);
  });

  it('returns 404 when latest pointer is missing', async () => {
    authedAsSuperadminWithKey('read');

    const req = createMockRequest('http://localhost/api/installer/latest');
    const res = await latestGET(req);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.code).toBe('latest_installer_not_found');
  });

  it('returns 404 when latest points at a missing version doc', async () => {
    authedAsSuperadminWithKey('read');
    seedLatest('3.0.0');

    const req = createMockRequest('http://localhost/api/installer/latest');
    const res = await latestGET(req);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.code).toBe('latest_installer_not_found');
  });

  it('returns 404 when latest points at a deleted version', async () => {
    authedAsSuperadminWithKey('read');
    seedVersion('3.0.0', { deletedAt: 1234 });
    seedLatest('3.0.0');

    const req = createMockRequest('http://localhost/api/installer/latest');
    const res = await latestGET(req);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.code).toBe('latest_installer_not_found');
  });

  it('rejects non-superadmin api key with 403 forbidden', async () => {
    authedAsNonSuperadminWithKey('read');
    seedVersion('3.0.0');
    seedLatest('3.0.0');

    const req = createMockRequest('http://localhost/api/installer/latest');
    const res = await latestGET(req);

    expect(res.status).toBe(403);
  });

  it('rejects superadmin key without installer read scope', async () => {
    authedAsKeyMissingScope('write');
    seedVersion('3.0.0');
    seedLatest('3.0.0');

    const req = createMockRequest('http://localhost/api/installer/latest');
    const res = await latestGET(req);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe('scope_insufficient');
  });
});

// POST /api/installer/upload (signed-url request)

describe('POST /api/installer/upload', () => {
  it('returns signed url and emits installer_mutated audit', async () => {
    authedAsSuperadminWithKey('write');

    const req = createMockRequest('http://localhost/api/installer/upload', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'installer-upload-happy' },
      body: { version: '3.0.0', fileName: 'Owlette-Installer-v3.0.0.exe' },
    });
    const res = await uploadPOST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.uploadUrl).toContain('https://');
    expect(body.uploadId).toBeDefined();
    expect(body.storagePath).toContain('3.0.0');
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'installer_mutated',
        siteId: '',
        targetId: '3.0.0',
        attributes: expect.objectContaining({ verb: 'upload_initiated' }),
      }),
    );
  });

  it('requires Idempotency-Key', async () => {
    authedAsSuperadminWithKey('write');

    const req = createMockRequest('http://localhost/api/installer/upload', {
      method: 'POST',
      body: { version: '3.0.0', fileName: 'Owlette-Installer-v3.0.0.exe' },
    });
    const res = await uploadPOST(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe('idempotency_key_required');
  });

  it('rejects invalid version with 400', async () => {
    authedAsSuperadminWithKey('write');

    const req = createMockRequest('http://localhost/api/installer/upload', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'installer-upload-invalid-version' },
      body: { version: 'not-semver', fileName: 'x.exe' },
    });
    const res = await uploadPOST(req);

    expect(res.status).toBe(400);
  });

  it('rejects api key with only :read scope (403 scope_insufficient)', async () => {
    authedAsKeyMissingScope('read');

    const req = createMockRequest('http://localhost/api/installer/upload', {
      method: 'POST',
      body: { version: '3.0.0', fileName: 'Owlette-Installer-v3.0.0.exe' },
    });
    const res = await uploadPOST(req);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe('scope_insufficient');
  });

  it('replays cached response on duplicate Idempotency-Key with same body', async () => {
    authedAsSuperadminWithKey('write');

    const idemKey = 'dup-key-abc';
    const req1 = createMockRequest('http://localhost/api/installer/upload', {
      method: 'POST',
      body: { version: '3.0.0', fileName: 'Owlette-Installer-v3.0.0.exe' },
      headers: { 'Idempotency-Key': idemKey },
    });
    const res1 = await uploadPOST(req1);
    expect(res1.status).toBe(200);

    // Same key + body replays from cache: no new audit event, marker header set.
    mockEmitMutation.mockClear();
    const req2 = createMockRequest('http://localhost/api/installer/upload', {
      method: 'POST',
      body: { version: '3.0.0', fileName: 'Owlette-Installer-v3.0.0.exe' },
      headers: { 'Idempotency-Key': idemKey },
    });
    const res2 = await uploadPOST(req2);
    expect(res2.status).toBe(200);
    expect(res2.headers.get('Idempotent-Replayed')).toBe('true');
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('derives the platform from a .pkg and records it on the upload', async () => {
    authedAsSuperadminWithKey('write');

    const req = createMockRequest('http://localhost/api/installer/upload', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'installer-upload-pkg' },
      body: { version: '3.0.0', fileName: 'Owlette-Installer-v3.0.0.pkg' },
    });
    const res = await uploadPOST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.platform).toBe('macos_arm64');
    expect(body.storagePath).toBe(
      'agent-installers/versions/3.0.0/Owlette-Installer-v3.0.0.pkg',
    );
    expect(docStore[`installer_uploads/${body.uploadId}`]?.data?.platform).toBe('macos_arm64');
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({ verb: 'upload_initiated', platform: 'macos_arm64' }),
      }),
    );
  });

  it('refuses a .deb declared as macos_arm64', async () => {
    authedAsSuperadminWithKey('write');

    const req = createMockRequest('http://localhost/api/installer/upload', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'installer-upload-mismatch' },
      body: { version: '3.0.0', fileName: 'Owlette-Installer-v3.0.0.deb', platform: 'macos_arm64' },
    });
    const res = await uploadPOST(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.detail).toContain('does not match platform macos_arm64');
  });

  it('refuses an unknown platform value', async () => {
    authedAsSuperadminWithKey('write');

    const req = createMockRequest('http://localhost/api/installer/upload', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'installer-upload-bad-platform' },
      body: { version: '3.0.0', fileName: 'Owlette-Installer-v3.0.0.exe', platform: 'amd64' },
    });
    const res = await uploadPOST(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.detail).toContain('windows_x64, macos_arm64, linux_x64');
  });

  it('refuses an unknown extension and names the three accepted ones', async () => {
    authedAsSuperadminWithKey('write');

    const req = createMockRequest('http://localhost/api/installer/upload', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'installer-upload-bad-ext' },
      body: { version: '3.0.0', fileName: 'Owlette-Installer-v3.0.0.zip' },
    });
    const res = await uploadPOST(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.detail).toContain('.exe, .pkg or .deb');
  });
});

// PUT /api/installer/upload (finalize)

describe('PUT /api/installer/upload', () => {
  it('finalizes upload and writes installer_metadata version doc', async () => {
    authedAsSuperadminWithKey('write');
    seedUpload('upload-1');

    const req = createMockRequest('http://localhost/api/installer/upload', {
      method: 'PUT',
      headers: { 'Idempotency-Key': 'installer-finalize-happy' },
      body: { uploadId: 'upload-1', checksum_sha256: STORAGE_SHA256 },
    });
    const res = await uploadPUT(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.version).toBe('3.0.0');
    expect(body.checksum_sha256).toBe(STORAGE_SHA256);
    expect(docStore['installer_metadata/data/versions/3.0.0']).toBeDefined();
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({ verb: 'upload_finalized' }),
      }),
    );
  });

  it('requires Idempotency-Key', async () => {
    authedAsSuperadminWithKey('write');
    seedUpload('upload-1');

    const req = createMockRequest('http://localhost/api/installer/upload', {
      method: 'PUT',
      body: { uploadId: 'upload-1', checksum_sha256: STORAGE_SHA256 },
    });
    const res = await uploadPUT(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe('idempotency_key_required');
  });

  it('returns 404 when upload record does not exist', async () => {
    authedAsSuperadminWithKey('write');

    const req = createMockRequest('http://localhost/api/installer/upload', {
      method: 'PUT',
      headers: { 'Idempotency-Key': 'installer-finalize-missing-upload' },
      body: { uploadId: 'nonexistent' },
    });
    const res = await uploadPUT(req);

    expect(res.status).toBe(404);
  });

  it('computes checksum when finalize omits checksum_sha256', async () => {
    authedAsSuperadminWithKey('write');
    seedUpload('upload-1', { setAsLatest: false });

    const req = createMockRequest('http://localhost/api/installer/upload', {
      method: 'PUT',
      headers: { 'Idempotency-Key': 'installer-finalize-computed-checksum' },
      body: { uploadId: 'upload-1' },
    });
    const res = await uploadPUT(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.checksum_sha256).toBe(STORAGE_SHA256);
    expect(docStore['installer_metadata/data/versions/3.0.0']?.data?.checksum_sha256).toBe(STORAGE_SHA256);
  });

  it('rejects finalize when checksum does not match the uploaded object', async () => {
    authedAsSuperadminWithKey('write');
    seedUpload('upload-1');

    const req = createMockRequest('http://localhost/api/installer/upload', {
      method: 'PUT',
      headers: { 'Idempotency-Key': 'installer-finalize-checksum-mismatch' },
      body: { uploadId: 'upload-1', checksum_sha256: 'a'.repeat(64) },
    });
    const res = await uploadPUT(req);
    const body = await res.json();

    expect(res.status).toBe(412);
    expect(body.code).toBe('checksum_mismatch');
    expect(docStore['installer_metadata/data/versions/3.0.0']).toBeUndefined();
  });

  const WINDOWS_FILE = {
    download_url: 'https://storage.example.com/3.0.0.exe',
    checksum_sha256: 'a'.repeat(64),
    file_size: 1024,
    file_name: 'Owlette-Installer-v3.0.0.exe',
    uploaded_at: 1700000000000,
  };
  const MAC_FILE = {
    download_url: 'https://storage.example.com/3.0.0.pkg',
    checksum_sha256: 'b'.repeat(64),
    file_size: 2048,
    file_name: 'Owlette-Installer-v3.0.0.pkg',
    uploaded_at: 1700000000001,
  };
  const PKG_UPLOAD = {
    fileName: 'Owlette-Installer-v3.0.0.pkg',
    storagePath: 'agent-installers/versions/3.0.0/Owlette-Installer-v3.0.0.pkg',
    platform: 'macos_arm64',
  };

  it('merges a .pkg into an existing version without touching the windows alias', async () => {
    authedAsSuperadminWithKey('write');
    seedVersion('3.0.0', { files: { windows_x64: WINDOWS_FILE } });
    seedUpload('upload-1', { ...PKG_UPLOAD, setAsLatest: false });

    const req = createMockRequest('http://localhost/api/installer/upload', {
      method: 'PUT',
      headers: { 'Idempotency-Key': 'installer-finalize-pkg' },
      body: { uploadId: 'upload-1' },
    });
    const res = await uploadPUT(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.platform).toBe('macos_arm64');
    expect(Object.keys(body.files).sort()).toEqual(['macos_arm64', 'windows_x64']);
    const doc = docStore['installer_metadata/data/versions/3.0.0']?.data as Record<string, unknown>;
    expect(doc.download_url).toBe(WINDOWS_FILE.download_url);
    expect(doc.checksum_sha256).toBe(WINDOWS_FILE.checksum_sha256);
    expect(doc.file_size).toBe(WINDOWS_FILE.file_size);
    expect(doc.uploaded_by).toBe('admin');
    const files = doc.files as Record<string, Record<string, unknown>>;
    expect(files.windows_x64).toEqual(WINDOWS_FILE);
    expect(files.macos_arm64).toMatchObject({
      download_url: 'https://storage.example.com/signed',
      checksum_sha256: STORAGE_SHA256,
      file_size: 1048576,
      file_name: 'Owlette-Installer-v3.0.0.pkg',
    });
    expect(docStore['installer_metadata/latest']).toBeUndefined();
  });

  it('refreshes the windows alias on a windows_x64 re-upload and keeps the other platforms', async () => {
    authedAsSuperadminWithKey('write');
    seedVersion('3.0.0', { files: { windows_x64: WINDOWS_FILE, macos_arm64: MAC_FILE } });
    seedUpload('upload-1', { platform: 'windows_x64', setAsLatest: false });

    const req = createMockRequest('http://localhost/api/installer/upload', {
      method: 'PUT',
      headers: { 'Idempotency-Key': 'installer-finalize-exe-again' },
      body: { uploadId: 'upload-1' },
    });
    const res = await uploadPUT(req);

    expect(res.status).toBe(200);
    const doc = docStore['installer_metadata/data/versions/3.0.0']?.data as Record<string, unknown>;
    expect(doc.download_url).toBe('https://storage.example.com/signed');
    expect(doc.checksum_sha256).toBe(STORAGE_SHA256);
    expect(doc.file_size).toBe(1048576);
    const files = doc.files as Record<string, Record<string, unknown>>;
    expect(files.windows_x64.download_url).toBe('https://storage.example.com/signed');
    expect(files.macos_arm64).toEqual(MAC_FILE);
  });

  it('writes latest with every platform after a mac upload with setAsLatest', async () => {
    authedAsSuperadminWithKey('write');
    seedVersion('3.0.0', {
      files: { windows_x64: WINDOWS_FILE },
      release_date: { toDate: () => new Date('2026-04-28T00:00:00.000Z') },
    });
    seedUpload('upload-1', { ...PKG_UPLOAD, setAsLatest: true });

    const req = createMockRequest('http://localhost/api/installer/upload', {
      method: 'PUT',
      headers: { 'Idempotency-Key': 'installer-finalize-pkg-latest' },
      body: { uploadId: 'upload-1' },
    });
    const res = await uploadPUT(req);

    expect(res.status).toBe(200);
    const latest = docStore['installer_metadata/latest']?.data as Record<string, unknown>;
    expect(latest.version).toBe('3.0.0');
    expect(latest.download_url).toBe(WINDOWS_FILE.download_url);
    expect(latest.release_date).toBe('2026-04-28T00:00:00.000Z');
    expect(latest.promoted_by).toBe('user-superadmin');
    expect(typeof latest.promoted_at).toBe('number');
    const files = latest.files as Record<string, Record<string, unknown>>;
    expect(files.windows_x64).toEqual(WINDOWS_FILE);
    expect(files.macos_arm64.checksum_sha256).toBe(STORAGE_SHA256);
  });

  it('revives a soft-deleted version with fresh fields and only the new file', async () => {
    authedAsSuperadminWithKey('write');
    seedVersion('3.0.0', {
      deletedAt: 1234,
      deletedBy: 'admin',
      files: { windows_x64: WINDOWS_FILE, macos_arm64: MAC_FILE },
    });
    seedUpload('upload-1', { ...PKG_UPLOAD, setAsLatest: false });

    const req = createMockRequest('http://localhost/api/installer/upload', {
      method: 'PUT',
      headers: { 'Idempotency-Key': 'installer-finalize-revive' },
      body: { uploadId: 'upload-1' },
    });
    const res = await uploadPUT(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    const doc = docStore['installer_metadata/data/versions/3.0.0']?.data as Record<string, unknown>;
    expect(doc.deletedAt).toBeNull();
    expect(doc.deletedBy).toBeUndefined();
    expect(doc.download_url).toBeUndefined();
    expect(doc.uploaded_by).toBe('user-superadmin');
    expect(Object.keys(doc.files as object)).toEqual(['macos_arm64']);
    expect(Object.keys(body.files)).toEqual(['macos_arm64']);
  });
});

// DELETE /api/installer/{version}

describe('DELETE /api/installer/{version}', () => {
  it('soft-deletes when more than 2 active versions exist', async () => {
    authedAsSuperadminWithKey('admin');
    seedVersion('2.0.0');
    seedVersion('2.1.0');
    seedVersion('2.2.0');

    const req = createMockRequest('http://localhost/api/installer/2.0.0', {
      method: 'DELETE',
    });
    const res = await versionDELETE(req, {
      params: Promise.resolve({ version: '2.0.0' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.deletedAt).toBeGreaterThan(0);
    expect(docStore['installer_metadata/data/versions/2.0.0']?.data?.deletedAt).toBeDefined();
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({ verb: 'soft_deleted' }),
      }),
    );
  });

  it('refuses to delete the current latest version', async () => {
    authedAsSuperadminWithKey('admin');
    seedVersion('2.0.0');
    seedVersion('2.1.0');
    seedVersion('2.2.0');
    seedLatest('2.1.0');

    const req = createMockRequest('http://localhost/api/installer/2.1.0', {
      method: 'DELETE',
    });
    const res = await versionDELETE(req, {
      params: Promise.resolve({ version: '2.1.0' }),
    });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('latest_version_protected');
    expect(docStore['installer_metadata/data/versions/2.1.0']?.data?.deletedAt).toBeUndefined();
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('refuses delete that would drop active count below 2 (409 min_versions_violated)', async () => {
    authedAsSuperadminWithKey('admin');
    seedVersion('2.0.0');
    seedVersion('2.1.0'); // exactly 2 — deleting either should fail

    const req = createMockRequest('http://localhost/api/installer/2.0.0', {
      method: 'DELETE',
    });
    const res = await versionDELETE(req, {
      params: Promise.resolve({ version: '2.0.0' }),
    });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('min_versions_violated');
    // Doc was not mutated.
    expect(docStore['installer_metadata/data/versions/2.0.0']?.data?.deletedAt).toBeUndefined();
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('idempotent: deleting an already-deleted version returns 200 without re-emitting audit', async () => {
    authedAsSuperadminWithKey('admin');
    seedVersion('2.0.0', { deletedAt: 1234 });
    seedVersion('2.1.0');
    seedVersion('2.2.0');

    const req = createMockRequest('http://localhost/api/installer/2.0.0', {
      method: 'DELETE',
    });
    const res = await versionDELETE(req, {
      params: Promise.resolve({ version: '2.0.0' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.alreadyDeleted).toBe(true);
    expect(body.deletedAt).toBe(1234);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown version', async () => {
    authedAsSuperadminWithKey('admin');
    seedVersion('2.0.0');
    seedVersion('2.1.0');
    seedVersion('2.2.0');

    const req = createMockRequest('http://localhost/api/installer/9.9.9', {
      method: 'DELETE',
    });
    const res = await versionDELETE(req, {
      params: Promise.resolve({ version: '9.9.9' }),
    });

    expect(res.status).toBe(404);
  });

  it('rejects non-superadmin even with installer=*:admin scope', async () => {
    authedAsNonSuperadminWithKey('admin');
    seedVersion('2.0.0');
    seedVersion('2.1.0');
    seedVersion('2.2.0');

    const req = createMockRequest('http://localhost/api/installer/2.0.0', {
      method: 'DELETE',
    });
    const res = await versionDELETE(req, {
      params: Promise.resolve({ version: '2.0.0' }),
    });

    expect(res.status).toBe(403);
  });

  it('rejects superadmin key with write but not admin scope', async () => {
    authedAsKeyMissingScope('write');
    seedVersion('2.0.0');
    seedVersion('2.1.0');
    seedVersion('2.2.0');

    const req = createMockRequest('http://localhost/api/installer/2.0.0', {
      method: 'DELETE',
    });
    const res = await versionDELETE(req, {
      params: Promise.resolve({ version: '2.0.0' }),
    });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe('scope_insufficient');
  });

  it('rejects malformed version path with 400 validation', async () => {
    authedAsSuperadminWithKey('admin');

    const req = createMockRequest('http://localhost/api/installer/not-semver', {
      method: 'DELETE',
    });
    const res = await versionDELETE(req, {
      params: Promise.resolve({ version: 'not-semver' }),
    });

    expect(res.status).toBe(400);
  });
});

// POST /api/installer/{version}/set-latest

describe('POST /api/installer/{version}/set-latest', () => {
  it('promotes existing version to latest atomically', async () => {
    authedAsSuperadminWithKey('admin');
    seedVersion('3.0.0');

    const req = createMockRequest('http://localhost/api/installer/3.0.0/set-latest', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'installer-set-latest-happy' },
      body: {},
    });
    const res = await setLatestPOST(req, {
      params: Promise.resolve({ version: '3.0.0' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.version).toBe('3.0.0');
    expect(docStore['installer_metadata/latest']?.data?.version).toBe('3.0.0');
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({ verb: 'set_latest' }),
      }),
    );
  });

  it('requires Idempotency-Key', async () => {
    authedAsSuperadminWithKey('admin');
    seedVersion('3.0.0');

    const req = createMockRequest('http://localhost/api/installer/3.0.0/set-latest', {
      method: 'POST',
      body: {},
    });
    const res = await setLatestPOST(req, {
      params: Promise.resolve({ version: '3.0.0' }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe('idempotency_key_required');
  });

  it('refuses to promote a soft-deleted version (409 version_deleted)', async () => {
    authedAsSuperadminWithKey('admin');
    seedVersion('3.0.0', { deletedAt: 1234 });

    const req = createMockRequest('http://localhost/api/installer/3.0.0/set-latest', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'installer-set-latest-deleted' },
      body: {},
    });
    const res = await setLatestPOST(req, {
      params: Promise.resolve({ version: '3.0.0' }),
    });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('version_deleted');
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown version', async () => {
    authedAsSuperadminWithKey('admin');

    const req = createMockRequest('http://localhost/api/installer/9.9.9/set-latest', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'installer-set-latest-missing' },
      body: {},
    });
    const res = await setLatestPOST(req, {
      params: Promise.resolve({ version: '9.9.9' }),
    });

    expect(res.status).toBe(404);
  });

  it('rejects non-superadmin api key', async () => {
    authedAsNonSuperadminWithKey('admin');
    seedVersion('3.0.0');

    const req = createMockRequest('http://localhost/api/installer/3.0.0/set-latest', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'installer-set-latest-forbidden' },
      body: {},
    });
    const res = await setLatestPOST(req, {
      params: Promise.resolve({ version: '3.0.0' }),
    });

    expect(res.status).toBe(403);
  });

  it('rejects superadmin key with write but not admin scope', async () => {
    authedAsKeyMissingScope('write');
    seedVersion('3.0.0');

    const req = createMockRequest('http://localhost/api/installer/3.0.0/set-latest', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'installer-set-latest-write-scope' },
      body: {},
    });
    const res = await setLatestPOST(req, {
      params: Promise.resolve({ version: '3.0.0' }),
    });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe('scope_insufficient');
  });

  it('replays cached response on duplicate Idempotency-Key', async () => {
    authedAsSuperadminWithKey('admin');
    seedVersion('3.0.0');

    const idemKey = 'set-latest-key-1';
    const req1 = createMockRequest('http://localhost/api/installer/3.0.0/set-latest', {
      method: 'POST',
      body: {},
      headers: { 'Idempotency-Key': idemKey },
    });
    const res1 = await setLatestPOST(req1, {
      params: Promise.resolve({ version: '3.0.0' }),
    });
    expect(res1.status).toBe(200);

    mockEmitMutation.mockClear();
    const req2 = createMockRequest('http://localhost/api/installer/3.0.0/set-latest', {
      method: 'POST',
      body: {},
      headers: { 'Idempotency-Key': idemKey },
    });
    const res2 = await setLatestPOST(req2, {
      params: Promise.resolve({ version: '3.0.0' }),
    });
    expect(res2.status).toBe(200);
    expect(res2.headers.get('Idempotent-Replayed')).toBe('true');
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('normalizes Firestore timestamp release_date in latest response', async () => {
    authedAsSuperadminWithKey('admin');
    seedVersion('3.0.0', {
      release_date: { toDate: () => new Date('2026-04-28T00:00:00.000Z') },
    });

    const req = createMockRequest('http://localhost/api/installer/3.0.0/set-latest', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'installer-set-latest-timestamp' },
      body: {},
    });
    const res = await setLatestPOST(req, {
      params: Promise.resolve({ version: '3.0.0' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.latest.release_date).toBe('2026-04-28T00:00:00.000Z');
    expect(docStore['installer_metadata/latest']?.data?.release_date).toBe(
      '2026-04-28T00:00:00.000Z',
    );
  });
});
