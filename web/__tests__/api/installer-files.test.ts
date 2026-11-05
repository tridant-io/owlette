/** @jest-environment node */

/**
 * /api/installer/* — the per-platform `files` map reads back from every
 * endpoint, a legacy doc synthesises `windows_x64`, and set-latest carries
 * `files` into `installer_metadata/latest`.
 */

import { createMockRequest } from './helpers/utils';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: jest.fn(),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

const mockResolveAuth = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
  };
});

// Firestore mock — keyed by document path; a collection query returns the
// docs seeded under it, sorted by the requested field.

const docStore: Record<string, Record<string, unknown> | null> = {};
const collectionDocs: Record<string, Array<{ id: string; data: Record<string, unknown> }>> = {};

function makeDocRef(parts: string[]): unknown {
  const path = parts.join('/');
  return {
    id: parts[parts.length - 1],
    get: jest.fn(async () => {
      const data = docStore[path];
      return {
        exists: data !== null && data !== undefined,
        id: parts[parts.length - 1],
        data: () => data ?? undefined,
      };
    }),
    set: jest.fn(async (data: Record<string, unknown>) => {
      docStore[path] = data;
    }),
    collection: (sub: string) => makeCollectionRef([...parts, sub]),
  };
}

function makeCollectionRef(parts: string[]): unknown {
  const path = parts.join('/');
  let orderField: string | null = null;
  let limit = 1000;

  const ref: Record<string, unknown> = {
    doc: (id: string) => makeDocRef([...parts, id]),
    orderBy: (field: string) => {
      orderField = field;
      return ref;
    },
    limit: (n: number) => {
      limit = n;
      return ref;
    },
    startAfter: () => ref,
    get: jest.fn(async () => {
      const docs = (collectionDocs[path] ?? []).slice();
      if (orderField) {
        const field = orderField;
        docs.sort((a, b) => (b.data[field] as number) - (a.data[field] as number));
      }
      return {
        docs: docs.slice(0, limit).map((d) => ({
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

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => makeCollectionRef([name]),
    runTransaction: async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
        set: (ref: { set: (data: Record<string, unknown>) => Promise<void> }, data: Record<string, unknown>) =>
          ref.set(data),
      }),
  }),
  getAdminAuth: () => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')),
  }),
}));

// Imports come AFTER mocks

import { GET as listGET } from '@/app/api/installer/route';
import { GET as latestGET } from '@/app/api/installer/latest/route';
import { POST as setLatestPOST } from '@/app/api/installer/[version]/set-latest/route';

// Fixtures

const WINDOWS_FILE = {
  download_url: 'https://storage.example.com/3.4.0/Owlette-Installer-v3.4.0.exe',
  checksum_sha256: 'a'.repeat(64),
  file_size: 1024,
  file_name: 'Owlette-Installer-v3.4.0.exe',
  uploaded_at: 1700000000000,
};

const MAC_FILE = {
  download_url: 'https://storage.example.com/3.4.0/Owlette-Installer-v3.4.0.pkg',
  checksum_sha256: 'b'.repeat(64),
  file_size: 2048,
  file_name: 'Owlette-Installer-v3.4.0.pkg',
  uploaded_at: 1700000001000,
};

function authedAsSuperadmin(perm: 'read' | 'admin'): void {
  mockResolveAuth.mockResolvedValue({
    userId: 'user-superadmin',
    keyContext: {
      keyId: 'key_test',
      environment: 'live',
      isLegacy: false,
      scopes: [{ resource: 'installer', id: '*', permissions: [perm] }],
      expiresAt: null,
    },
  });
  docStore['users/user-superadmin'] = { role: 'superadmin' };
}

// a doc written before `files` existed: the windows installer in the flat fields only
function seedLegacyVersion(version: string): void {
  seedVersionDoc(version, {
    version,
    download_url: `https://storage.example.com/${version}.exe`,
    checksum_sha256: 'c'.repeat(64),
    file_size: 4096,
    uploaded_at: 1600000000000,
    uploaded_by: 'admin',
    release_notes: null,
  });
}

function seedTwoFileVersion(version: string): void {
  seedVersionDoc(version, {
    version,
    download_url: WINDOWS_FILE.download_url,
    checksum_sha256: WINDOWS_FILE.checksum_sha256,
    file_size: WINDOWS_FILE.file_size,
    uploaded_at: WINDOWS_FILE.uploaded_at,
    uploaded_by: 'admin',
    release_notes: 'two platforms',
    files: { windows_x64: WINDOWS_FILE, macos_arm64: MAC_FILE },
  });
}

function seedVersionDoc(version: string, data: Record<string, unknown>): void {
  docStore[`installer_metadata/data/versions/${version}`] = data;
  collectionDocs['installer_metadata/data/versions'] = [
    ...(collectionDocs['installer_metadata/data/versions'] ?? []),
    { id: version, data },
  ];
}

function seedLatest(version: string): void {
  docStore['installer_metadata/latest'] = {
    version,
    release_date: '2026-04-28T00:00:00.000Z',
    promoted_at: 1700000002000,
    promoted_by: 'admin',
  };
}

function setLatestRequest(version: string) {
  return setLatestPOST(
    createMockRequest(`http://localhost/api/installer/${version}/set-latest`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `installer-files-set-latest-${version}` },
      body: {},
    }),
    { params: Promise.resolve({ version }) },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(docStore)) delete docStore[k];
  for (const k of Object.keys(collectionDocs)) delete collectionDocs[k];
});

describe('GET /api/installer', () => {
  it('returns files for every version, synthesising windows_x64 on a legacy doc', async () => {
    authedAsSuperadmin('read');
    seedLegacyVersion('3.3.0');
    seedTwoFileVersion('3.4.0');

    const res = await listGET(createMockRequest('http://localhost/api/installer'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.versions).toHaveLength(2);
    const [twoFile, legacy] = body.versions;
    expect(twoFile.version).toBe('3.4.0');
    expect(twoFile.files).toEqual({ windows_x64: WINDOWS_FILE, macos_arm64: MAC_FILE });
    expect(legacy.version).toBe('3.3.0');
    expect(legacy.files).toEqual({
      windows_x64: {
        download_url: 'https://storage.example.com/3.3.0.exe',
        checksum_sha256: 'c'.repeat(64),
        file_size: 4096,
        file_name: 'Owlette-Installer-v3.3.0.exe',
        uploaded_at: 1600000000000,
      },
    });
    // the flat alias is untouched
    expect(legacy.download_url).toBe('https://storage.example.com/3.3.0.exe');
  });
});

describe('GET /api/installer/latest', () => {
  it('returns both files of a two-platform version', async () => {
    authedAsSuperadmin('read');
    seedTwoFileVersion('3.4.0');
    seedLatest('3.4.0');

    const res = await latestGET(createMockRequest('http://localhost/api/installer/latest'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.version).toBe('3.4.0');
    expect(body.download_url).toBe(WINDOWS_FILE.download_url);
    expect(body.files).toEqual({ windows_x64: WINDOWS_FILE, macos_arm64: MAC_FILE });
  });

  it('synthesises files.windows_x64 for a legacy latest version', async () => {
    authedAsSuperadmin('read');
    seedLegacyVersion('3.3.0');
    seedLatest('3.3.0');

    const res = await latestGET(createMockRequest('http://localhost/api/installer/latest'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.files.windows_x64.file_name).toBe('Owlette-Installer-v3.3.0.exe');
    expect(body.files.windows_x64.download_url).toBe(body.download_url);
    expect(Object.keys(body.files)).toEqual(['windows_x64']);
  });
});

describe('POST /api/installer/{version}/set-latest', () => {
  it('writes files into installer_metadata/latest and returns them', async () => {
    authedAsSuperadmin('admin');
    seedTwoFileVersion('3.4.0');

    const res = await setLatestRequest('3.4.0');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.latest.files).toEqual({ windows_x64: WINDOWS_FILE, macos_arm64: MAC_FILE });

    const written = docStore['installer_metadata/latest'];
    expect(written).toMatchObject({
      version: '3.4.0',
      download_url: WINDOWS_FILE.download_url,
      checksum_sha256: WINDOWS_FILE.checksum_sha256,
      file_size: WINDOWS_FILE.file_size,
      files: { windows_x64: WINDOWS_FILE, macos_arm64: MAC_FILE },
      promoted_by: 'user-superadmin',
    });
    expect(typeof written?.promoted_at).toBe('number');
  });

  it('promotes a legacy version with a synthesised windows_x64 entry', async () => {
    authedAsSuperadmin('admin');
    seedLegacyVersion('3.3.0');

    const res = await setLatestRequest('3.3.0');

    expect(res.status).toBe(200);
    expect(docStore['installer_metadata/latest']?.files).toEqual({
      windows_x64: {
        download_url: 'https://storage.example.com/3.3.0.exe',
        checksum_sha256: 'c'.repeat(64),
        file_size: 4096,
        file_name: 'Owlette-Installer-v3.3.0.exe',
        uploaded_at: 1600000000000,
      },
    });
  });
});
