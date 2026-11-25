/** @jest-environment node */

import { createMockRequest } from './helpers/utils';
import {
  mocks,
  mockDbFactory,
  docSnapshot,
  querySnapshot,
  seedMember
} from './helpers/firestore-mock';

const mockEmitMutation = jest.fn();

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDbFactory(),
  getAdminAuth: () => ({ verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')) }),
}));
jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

const mockResolveAuth = jest.fn();
const mockAssertSite = jest.fn();
const mockHasChunk = jest.fn();

jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
    assertUserHasSiteAccess: (...a: unknown[]) => mockAssertSite(...a),
  };
});
jest.mock('@/lib/r2Client.server', () => ({
  hasChunk: (...a: unknown[]) => mockHasChunk(...a),
  missingChunks: jest.fn(async () => []),
  presignPutChunk: jest.fn(async (_site: string, hash: string) => `https://r2.test/put/${hash}`),
  PUT_URL_TTL_SECONDS: 900,
}));

import { POST as mountPOST } from '@/app/api/chunks/[digest]/mount/route';
import { GET as referrersGET } from '@/app/api/chunks/[digest]/referrers/route';

const SITE = 'site-abc';
const DIGEST = 'a'.repeat(64);
const ROOST_FROM = 'rst_from_123456';
const ROOST_TO = 'rst_to_12345678';

function makeAuthed() {
  mockResolveAuth.mockResolvedValue({
    userId: 'user-1',
    keyContext: null, // session-style: no scope check
  });
  mockAssertSite.mockResolvedValue({ siteId: SITE, siteData: {}, machineIds: null });
}

beforeEach(() => {
  jest.clearAllMocks();
  makeAuthed();
  mocks.siteDocs.clear();
  mocks.memberDocs.clear();
  mocks.userDocs.clear();
  mocks.siteDocs.set(SITE, { owner: 'user-1' });
  seedMember(SITE, 'user-1', 'owner');
  mocks.set.mockResolvedValue(undefined);
  mocks.get.mockImplementation(() => Promise.resolve(docSnapshot('x', {})));
  mocks.collectionGet.mockResolvedValue(querySnapshot([]));
});

describe('POST /api/chunks/{digest}/mount', () => {
  it('400 when digest is invalid', async () => {
    const req = createMockRequest(
      `http://localhost/api/chunks/not-a-hash/mount?siteId=${SITE}&from=${ROOST_FROM}&to=${ROOST_TO}`,
      { method: 'POST' },
    );
    const res = await mountPOST(req, { params: Promise.resolve({ digest: 'not-a-hash' }) });
    expect(res.status).toBe(400);
  });

  it('400 when from == to', async () => {
    const req = createMockRequest(
      `http://localhost/api/chunks/${DIGEST}/mount?siteId=${SITE}&from=${ROOST_FROM}&to=${ROOST_FROM}`,
      { method: 'POST' },
    );
    const res = await mountPOST(req, { params: Promise.resolve({ digest: DIGEST }) });
    expect(res.status).toBe(400);
  });

  it('404 when chunk not present in R2', async () => {
    mockHasChunk.mockResolvedValueOnce(false);
    const req = createMockRequest(
      `http://localhost/api/chunks/${DIGEST}/mount?siteId=${SITE}&from=${ROOST_FROM}&to=${ROOST_TO}`,
      { method: 'POST' },
    );
    const res = await mountPOST(req, { params: Promise.resolve({ digest: DIGEST }) });
    expect(res.status).toBe(404);
  });

  it('404 when source roost missing', async () => {
    mockHasChunk.mockResolvedValue(true);
    // first get returns missing "from" roost
    mocks.get.mockImplementationOnce(() => Promise.resolve(docSnapshot(ROOST_FROM, null)));
    mocks.get.mockImplementationOnce(() => Promise.resolve(docSnapshot(ROOST_TO, {})));
    const req = createMockRequest(
      `http://localhost/api/chunks/${DIGEST}/mount?siteId=${SITE}&from=${ROOST_FROM}&to=${ROOST_TO}`,
      { method: 'POST' },
    );
    const res = await mountPOST(req, { params: Promise.resolve({ digest: DIGEST }) });
    expect(res.status).toBe(404);
  });

  it('201 on success, writes idempotent mount entry', async () => {
    mockHasChunk.mockResolvedValue(true);
    mocks.get.mockResolvedValue(docSnapshot('any', {}));
    const req = createMockRequest(
      `http://localhost/api/chunks/${DIGEST}/mount?siteId=${SITE}&from=${ROOST_FROM}&to=${ROOST_TO}`,
      { method: 'POST' },
    );
    const res = await mountPOST(req, { params: Promise.resolve({ digest: DIGEST }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.mounted).toBe(true);
    expect(body.zeroByte).toBe(true);
    expect(body.from).toBe(ROOST_FROM);
    expect(body.to).toBe(ROOST_TO);
    expect(mocks.set).toHaveBeenCalled();
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'chunk_mutated',
        siteId: SITE,
        actor: 'user:user-1',
        targetId: DIGEST,
        attributes: expect.objectContaining({
          verb: 'mount',
          endpoint: `/api/chunks/${DIGEST}/mount`,
          method: 'POST',
          fromRoostId: ROOST_FROM,
          toRoostId: ROOST_TO,
          zeroByte: true,
        }),
      }),
    );
  });
});

describe('GET /api/chunks/{digest}/referrers', () => {
  it('400 when digest invalid', async () => {
    const req = createMockRequest(
      `http://localhost/api/chunks/bad/referrers?siteId=${SITE}`,
    );
    const res = await referrersGET(req, { params: Promise.resolve({ digest: 'bad' }) });
    expect(res.status).toBe(400);
  });

  it('400 when siteId missing', async () => {
    const req = createMockRequest(
      `http://localhost/api/chunks/${DIGEST}/referrers`,
    );
    const res = await referrersGET(req, { params: Promise.resolve({ digest: DIGEST }) });
    expect(res.status).toBe(400);
  });

  it('returns paginated referrer list', async () => {
    mocks.collectionGet.mockResolvedValueOnce(
      querySnapshot([
        {
          id: `mount_${ROOST_FROM}_${ROOST_TO}`,
          data: {
            source: 'mount',
            fromRoostId: ROOST_FROM,
            toRoostId: ROOST_TO,
            mountedAt: 1_700_000_000_000,
            mountedBy: 'user-1',
          },
        },
      ]),
    );
    const req = createMockRequest(
      `http://localhost/api/chunks/${DIGEST}/referrers?siteId=${SITE}&limit=50`,
    );
    const res = await referrersGET(req, { params: Promise.resolve({ digest: DIGEST }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.referrers).toHaveLength(1);
    expect(body.items).toHaveLength(1);
    expect(body.referrers[0].source).toBe('mount');
    expect(body.referrers[0].fromRoostId).toBe(ROOST_FROM);
    expect(body.referrers[0].referencedAt).toBeTruthy();
    expect(body.next_page_token).toBe('');
    expect(body.nextPageToken).toBe('');
  });
});

/* ========================================================================== */
/*  billing gate — the chunk upload surfaces are pro-only (wave 0.6)          */
/* ========================================================================== */
