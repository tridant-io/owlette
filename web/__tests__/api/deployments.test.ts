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

import { POST as deployPOST } from '@/app/api/roosts/[roostId]/deploy/route';
import { GET as deploymentsGET } from '@/app/api/roosts/[roostId]/deployments/route';
import { POST as resyncPOST } from '@/app/api/roosts/[roostId]/resync/route';

const SITE = 'site-dep';
const ROOST = 'rst_deployroot1';
const VERSION = 'vrs_deploy00001';

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
  mocks.batchCommit.mockResolvedValue(undefined);
  mocks.get.mockImplementation(() => Promise.resolve(docSnapshot('user-1', {
    role: 'admin',
    sites: [SITE],
  })));
  mocks.collectionGet.mockResolvedValue(querySnapshot([]));
});

describe('POST /api/roosts/{id}/deploy', () => {
  it('404 when roost does not exist', async () => {
    mocks.get.mockResolvedValueOnce(docSnapshot(ROOST, null));
    const req = createMockRequest(
      `http://localhost/api/roosts/${ROOST}/deploy`,
      { method: 'POST', body: { siteId: SITE } },
    );
    const res = await deployPOST(req, { params: Promise.resolve({ roostId: ROOST }) });
    expect(res.status).toBe(404);
  });

  it('409 when roost is tombstoned', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot(ROOST, {
        deletedAt: 1_700_000_000_000,
        currentVersionId: VERSION,
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/roosts/${ROOST}/deploy`,
      { method: 'POST', body: { siteId: SITE } },
    );
    const res = await deployPOST(req, { params: Promise.resolve({ roostId: ROOST }) });
    expect(res.status).toBe(409);
  });

  it('400 when no current version and none provided', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot(ROOST, { targets: ['m-1'] }), // no currentVersionId
    );
    const req = createMockRequest(
      `http://localhost/api/roosts/${ROOST}/deploy`,
      { method: 'POST', body: { siteId: SITE } },
    );
    const res = await deployPOST(req, { params: Promise.resolve({ roostId: ROOST }) });
    expect(res.status).toBe(400);
  });

  it('400 when no machines (roost targets empty and no override)', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot(ROOST, {
        currentVersionId: VERSION,
        versionUrl: 'https://r2/.../version.json',
        targets: [],
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/roosts/${ROOST}/deploy`,
      { method: 'POST', body: { siteId: SITE } },
    );
    const res = await deployPOST(req, { params: Promise.resolve({ roostId: ROOST }) });
    expect(res.status).toBe(400);
  });

  it('dryRun returns plan without side effects', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot(ROOST, {
        currentVersionId: VERSION,
        versionUrl: 'https://r2/.../version.json',
        targets: ['m-1', 'm-2', 'm-3'],
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/roosts/${ROOST}/deploy`,
      { method: 'POST', body: { siteId: SITE, dryRun: true } },
    );
    const res = await deployPOST(req, { params: Promise.resolve({ roostId: ROOST }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dryRun).toBe(true);
    expect(body.versionId).toBe(VERSION);
    expect(body.canary.length).toBeGreaterThan(0);
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('returns 202 when a rollout is queued', async () => {
    mocks.get
      .mockResolvedValueOnce(
        docSnapshot(ROOST, {
          currentVersionId: VERSION,
          versionUrl: 'https://r2/.../version.json',
          targets: ['m-1', 'm-2'],
        }),
      )
      .mockResolvedValueOnce(docSnapshot(VERSION, null));
    const req = createMockRequest(
      `http://localhost/api/roosts/${ROOST}/deploy`,
      { method: 'POST', body: { siteId: SITE } },
    );
    const res = await deployPOST(req, { params: Promise.resolve({ roostId: ROOST }) });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.rolloutId).toBe(VERSION);
    expect(mocks.batchCommit).toHaveBeenCalledTimes(1);
    expect(mockEmitMutation).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'roost_mutated',
      siteId: SITE,
      targetId: VERSION,
      attributes: expect.objectContaining({ verb: 'deploy' }),
    }));
  });

  it('returns alreadyRunning=true on idempotent re-trigger for active rollout', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot(ROOST, {
        currentVersionId: VERSION,
        versionUrl: 'https://r2/.../version.json',
        targets: ['m-1'],
      }),
    );
    mocks.get.mockResolvedValueOnce(
      docSnapshot(VERSION, {
        stage: 'canary',
        canary: ['m-1'],
        fleet: [],
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/roosts/${ROOST}/deploy`,
      { method: 'POST', body: { siteId: SITE } },
    );
    const res = await deployPOST(req, { params: Promise.resolve({ roostId: ROOST }) });
    const body = await res.json();
    expect(body.alreadyRunning).toBe(true);
  });
});

describe('GET /api/roosts/{id}/deployments', () => {
  it('400 when siteId missing', async () => {
    const req = createMockRequest(
      `http://localhost/api/roosts/${ROOST}/deployments`,
    );
    const res = await deploymentsGET(req, { params: Promise.resolve({ roostId: ROOST }) });
    expect(res.status).toBe(400);
  });

  it('returns paginated rollout list', async () => {
    mocks.collectionGet.mockResolvedValueOnce(
      querySnapshot([
        {
          id: VERSION,
          data: {
            versionId: VERSION,
            stage: 'canary',
            canary: ['m-1'],
            fleet: [],
            versionUrl: 'https://r2/.../x.json',
            extractRoot: '~',
            triggeredBy: 'user-1',
          },
        },
      ]),
    );
    const req = createMockRequest(
      `http://localhost/api/roosts/${ROOST}/deployments?siteId=${SITE}`,
    );
    const res = await deploymentsGET(req, { params: Promise.resolve({ roostId: ROOST }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rollouts).toHaveLength(1);
    expect(body.items).toHaveLength(1);
    expect(body.rollouts[0].rolloutId).toBe(VERSION);
    expect(body.rollouts[0].versionId).toBe(VERSION);
    expect(body.rollouts[0].stage).toBe('canary');
    expect(body.next_page_token).toBe('');
  });

  it('filters on stage=fleet, the stage a rollout is in after its canary', async () => {
    mocks.collectionGet.mockResolvedValueOnce(
      querySnapshot([
        { id: 'v-fleet', data: { versionId: 'v-fleet', stage: 'fleet' } },
        { id: 'v-done', data: { versionId: 'v-done', stage: 'complete' } },
      ]),
    );
    const req = createMockRequest(
      `http://localhost/api/roosts/${ROOST}/deployments?siteId=${SITE}&stage=fleet`,
    );
    const res = await deploymentsGET(req, { params: Promise.resolve({ roostId: ROOST }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rollouts.map((r: { rolloutId: string }) => r.rolloutId)).toEqual(['v-fleet']);
  });
});

describe('POST /api/roosts/{id}/resync', () => {
  it('audits API-key resync with the key actor after committing commands', async () => {
    mockResolveAuth.mockResolvedValueOnce({
      userId: 'user-1',
      keyContext: {
        keyId: 'key-operator',
        scopes: [{ resource: 'roost', id: ROOST, permissions: ['deploy'] }],
        environment: 'live',
        expiresAt: null,
        isLegacy: false,
      },
    });
    mocks.get.mockResolvedValueOnce(
      docSnapshot(ROOST, {
        currentVersionId: VERSION,
        versionUrl: 'https://r2.example/version.json',
        targets: ['m-1', 'm-2'],
      }),
    );

    const req = createMockRequest(
      `http://localhost/api/roosts/${ROOST}/resync`,
      { method: 'POST', body: { siteId: SITE } },
    );
    const res = await resyncPOST(req, { params: Promise.resolve({ roostId: ROOST }) });

    expect(res.status).toBe(200);
    expect(mocks.batchCommit).toHaveBeenCalledTimes(1);
    expect(mockEmitMutation).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'roost_mutated',
      siteId: SITE,
      actor: 'apiKey:key-operator',
      targetId: ROOST,
      attributes: expect.objectContaining({
        verb: 'resync',
        versionId: VERSION,
        targetCount: 2,
      }),
    }));
  });
});

/* ========================================================================== */
/*  billing gate — roost deploy surfaces are pro-only (wave 0.6)              */
/* ========================================================================== */
