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

jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
    assertUserHasSiteAccess: (...a: unknown[]) => mockAssertSite(...a),
  };
});

import { GET as listGET, POST as createPOST } from '@/app/api/roosts/route';
import {
  GET as detailGET,
  PATCH as detailPATCH,
  DELETE as detailDELETE,
} from '@/app/api/roosts/[roostId]/route';

const SITE = 'site-alpha';
const ROOST = 'rst_roostidexa';

function authed() {
  mockResolveAuth.mockResolvedValue({
    userId: 'user-1',
    keyContext: null,
  });
  mockAssertSite.mockResolvedValue({ siteId: SITE, siteData: {}, machineIds: null });
}

beforeEach(() => {
  jest.clearAllMocks();
  authed();
  mocks.siteDocs.clear();
  mocks.memberDocs.clear();
  mocks.userDocs.clear();
  mocks.siteDocs.set(SITE, { owner: 'user-1' });
  seedMember(SITE, 'user-1', 'owner');
  mocks.set.mockResolvedValue(undefined);
  mocks.update.mockResolvedValue(undefined);
  mocks.get.mockImplementation(() => Promise.resolve(docSnapshot('any', {})));
  mocks.collectionGet.mockResolvedValue(querySnapshot([]));
});

// GET /api/roosts
describe('GET /api/roosts', () => {
  it('400 when siteId missing', async () => {
    const req = createMockRequest('http://localhost/api/roosts');
    const res = await listGET(req);
    expect(res.status).toBe(400);
  });

  it('returns cursor-paginated list, filters tombstoned by default', async () => {
    mocks.collectionGet.mockResolvedValueOnce(
      querySnapshot([
        {
          id: 'rst_active00001',
          data: { name: 'active', targets: ['m1'], currentVersionId: 'v-1' },
        },
        {
          id: 'rst_deleted0001',
          data: { name: 'tomb', targets: [], deletedAt: 1_700_000_000_000 },
        },
      ]),
    );
    const req = createMockRequest(`http://localhost/api/roosts?siteId=${SITE}`);
    const res = await listGET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.roosts).toHaveLength(1);
    expect(body.roosts[0].roostId).toBe('rst_active00001');
    expect(body.next_page_token).toBe('');
    expect(body.nextPageToken).toBe('');
  });

  it('accepts page_size/page_token and emits next_page_token', async () => {
    mocks.collectionGet.mockResolvedValueOnce(
      querySnapshot([
        {
          id: 'rst_active00001',
          data: { name: 'active', targets: ['m1'], currentVersionId: 'v-1' },
        },
        {
          id: 'rst_active00002',
          data: { name: 'next', targets: ['m2'], currentVersionId: 'v-2' },
        },
      ]),
    );

    const req = createMockRequest(
      `http://localhost/api/roosts?siteId=${SITE}&page_size=1&page_token=rst_before`,
    );
    const res = await listGET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.limit).toHaveBeenCalledWith(2);
    expect(mocks.startAfter).toHaveBeenCalled();
    expect(body.roosts).toHaveLength(1);
    expect(body.next_page_token).toBe('rst_active00001');
    expect(body.nextPageToken).toBe(body.next_page_token);
  });

  it('uses the last emitted roost as page token when deleted docs are skipped', async () => {
    mocks.collectionGet
      .mockResolvedValueOnce(
        querySnapshot([
          {
            id: 'rst_active00001',
            data: { name: 'active', targets: ['m1'], currentVersionId: 'v-1' },
          },
          {
            id: 'rst_deleted0001',
            data: { name: 'tomb', targets: [], deletedAt: 1_700_000_000_000 },
          },
        ]),
      )
      .mockResolvedValueOnce(
        querySnapshot([
          {
            id: 'rst_active00002',
            data: { name: 'next', targets: ['m2'], currentVersionId: 'v-2' },
          },
        ]),
      );

    const req = createMockRequest(
      `http://localhost/api/roosts?siteId=${SITE}&page_size=1`,
    );
    const res = await listGET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.roosts).toHaveLength(1);
    expect(body.roosts[0].roostId).toBe('rst_active00001');
    expect(body.next_page_token).toBe('rst_active00001');
  });

  it('includeDeleted=true surfaces tombstoned entries', async () => {
    mocks.collectionGet.mockResolvedValueOnce(
      querySnapshot([
        {
          id: 'rst_deleted0001',
          data: { name: 'tomb', deletedAt: 1_700_000_000_000 },
        },
      ]),
    );
    const req = createMockRequest(
      `http://localhost/api/roosts?siteId=${SITE}&includeDeleted=true`,
    );
    const res = await listGET(req);
    const body = await res.json();
    expect(body.roosts).toHaveLength(1);
  });
});

// POST /api/roosts
describe('POST /api/roosts', () => {
  it('400 when siteId invalid', async () => {
    const req = createMockRequest('http://localhost/api/roosts', {
      method: 'POST',
      body: { siteId: 'bad site id', name: 'x' },
    });
    const res = await createPOST(req);
    expect(res.status).toBe(400);
  });

  it('400 when name missing', async () => {
    const req = createMockRequest('http://localhost/api/roosts', {
      method: 'POST',
      body: { siteId: SITE },
    });
    const res = await createPOST(req);
    expect(res.status).toBe(400);
  });

  it('201 generates a server-side roostId when omitted', async () => {
    mocks.get.mockResolvedValueOnce(docSnapshot('new', null)); // doesn't exist yet
    const req = createMockRequest('http://localhost/api/roosts', {
      method: 'POST',
      body: { siteId: SITE, name: 'my roost', targets: ['m-1'] },
    });
    const res = await createPOST(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.roostId).toMatch(/^rst_[0-9a-f]{18}$/);
    expect(body.name).toBe('my roost');
    expect(body.targets).toEqual(['m-1']);
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'roost_mutated',
        siteId: SITE,
        actor: 'user:user-1',
        targetId: body.roostId,
        attributes: expect.objectContaining({
          verb: 'create',
          endpoint: '/api/roosts',
          method: 'POST',
          targetCount: 1,
        }),
      }),
    );
  });

  it('409 when roost exists (not tombstoned)', async () => {
    mocks.get.mockResolvedValueOnce(docSnapshot(ROOST, { name: 'existing' }));
    const req = createMockRequest('http://localhost/api/roosts', {
      method: 'POST',
      body: { siteId: SITE, name: 'dup', roostId: ROOST },
    });
    const res = await createPOST(req);
    expect(res.status).toBe(409);
  });

  it('undeletes a tombstoned roost by POSTing same roostId', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot(ROOST, { name: 'old', deletedAt: 1_700_000_000_000 }),
    );
    const req = createMockRequest('http://localhost/api/roosts', {
      method: 'POST',
      body: { siteId: SITE, name: 'revived', roostId: ROOST },
    });
    const res = await createPOST(req);
    expect(res.status).toBe(201);
  });
});

// GET /api/roosts/{id}
describe('GET /api/roosts/{id}', () => {
  it('400 when roostId has bad format', async () => {
    const req = createMockRequest(
      `http://localhost/api/roosts/bad?siteId=${SITE}`,
    );
    const res = await detailGET(req, { params: Promise.resolve({ roostId: 'bad' }) });
    expect(res.status).toBe(400);
  });

  it('404 when roost does not exist', async () => {
    mocks.get.mockResolvedValueOnce(docSnapshot(ROOST, null));
    const req = createMockRequest(
      `http://localhost/api/roosts/${ROOST}?siteId=${SITE}`,
    );
    const res = await detailGET(req, { params: Promise.resolve({ roostId: ROOST }) });
    expect(res.status).toBe(404);
  });

  it('returns detail + version summaries', async () => {
    mocks.get.mockImplementationOnce(() =>
      Promise.resolve(
        docSnapshot(ROOST, {
          name: 'alpha',
          targets: ['m1'],
          currentVersionId: 'vrs_version01',
          previousVersionId: null,
          versionCounter: 1,
          schemaVersion: 2,
        }),
      ),
    );
    // current version lookup
    mocks.get.mockImplementationOnce(() =>
      Promise.resolve(
        docSnapshot('vrs_version01', {
          versionUrl: 'https://r2/.../vrs_version01.json',
          versionNumber: 1,
          description: 'initial release',
          totalSize: 1234,
          totalFiles: 3,
        }),
      ),
    );
    const req = createMockRequest(
      `http://localhost/api/roosts/${ROOST}?siteId=${SITE}`,
    );
    const res = await detailGET(req, { params: Promise.resolve({ roostId: ROOST }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.roostId).toBe(ROOST);
    expect(body.name).toBe('alpha');
    expect(body.currentVersion.versionId).toBe('vrs_version01');
    expect(body.currentVersion.versionNumber).toBe(1);
    expect(body.currentVersion.description).toBe('initial release');
    expect(body.versionCounter).toBe(1);
    expect(body.previousVersion).toBeNull();
  });
});

// PATCH /api/roosts/{id}
describe('PATCH /api/roosts/{id}', () => {
  it('400 when neither name/targets/extractPath provided', async () => {
    const req = createMockRequest(
      `http://localhost/api/roosts/${ROOST}`,
      { method: 'PATCH', body: { siteId: SITE } },
    );
    const res = await detailPATCH(req, { params: Promise.resolve({ roostId: ROOST }) });
    expect(res.status).toBe(400);
  });

  it('404 when roost missing', async () => {
    mocks.get.mockResolvedValueOnce(docSnapshot(ROOST, null));
    const req = createMockRequest(
      `http://localhost/api/roosts/${ROOST}`,
      { method: 'PATCH', body: { siteId: SITE, name: 'new' } },
    );
    const res = await detailPATCH(req, { params: Promise.resolve({ roostId: ROOST }) });
    expect(res.status).toBe(404);
  });

  it('409 when roost is tombstoned', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot(ROOST, { deletedAt: 1_700_000_000_000 }),
    );
    const req = createMockRequest(
      `http://localhost/api/roosts/${ROOST}`,
      { method: 'PATCH', body: { siteId: SITE, name: 'new' } },
    );
    const res = await detailPATCH(req, { params: Promise.resolve({ roostId: ROOST }) });
    expect(res.status).toBe(409);
  });

  it('200 on successful rename', async () => {
    mocks.get.mockResolvedValueOnce(docSnapshot(ROOST, { name: 'old' }));
    const req = createMockRequest(
      `http://localhost/api/roosts/${ROOST}`,
      { method: 'PATCH', body: { siteId: SITE, name: 'new' } },
    );
    const res = await detailPATCH(req, { params: Promise.resolve({ roostId: ROOST }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toContain('name');
    expect(mocks.update).toHaveBeenCalled();
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'roost_mutated',
        siteId: SITE,
        actor: 'user:user-1',
        targetId: ROOST,
        attributes: expect.objectContaining({
          verb: 'update',
          endpoint: `/api/roosts/${ROOST}`,
          method: 'PATCH',
          changedFields: ['name'],
        }),
      }),
    );
  });
});

// DELETE /api/roosts/{id}
describe('DELETE /api/roosts/{id}', () => {
  it('400 when siteId missing', async () => {
    const req = createMockRequest(`http://localhost/api/roosts/${ROOST}`, {
      method: 'DELETE',
    });
    const res = await detailDELETE(req, { params: Promise.resolve({ roostId: ROOST }) });
    expect(res.status).toBe(400);
  });

  it('404 when roost missing', async () => {
    mocks.get.mockResolvedValueOnce(docSnapshot(ROOST, null));
    const req = createMockRequest(
      `http://localhost/api/roosts/${ROOST}?siteId=${SITE}`,
      { method: 'DELETE' },
    );
    const res = await detailDELETE(req, { params: Promise.resolve({ roostId: ROOST }) });
    expect(res.status).toBe(404);
  });

  it('soft-deletes with 30-day tombstone', async () => {
    mocks.get.mockResolvedValueOnce(docSnapshot(ROOST, { name: 'x' }));
    const req = createMockRequest(
      `http://localhost/api/roosts/${ROOST}?siteId=${SITE}`,
      { method: 'DELETE' },
    );
    const res = await detailDELETE(req, { params: Promise.resolve({ roostId: ROOST }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.softDeleted).toBe(true);
    expect(body.tombstoneExpiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const updateCall = (mocks.update as jest.Mock).mock.calls[0][0];
    expect(updateCall.deletedBy).toBe('user-1');
    expect(typeof updateCall.tombstoneExpiresAt).toBe('number');
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'roost_mutated',
        siteId: SITE,
        actor: 'user:user-1',
        targetId: ROOST,
        attributes: expect.objectContaining({
          verb: 'delete',
          endpoint: `/api/roosts/${ROOST}`,
          method: 'DELETE',
        }),
      }),
    );
  });
});

// billing gate — roost mutations are pro-only (wave 0.6)
