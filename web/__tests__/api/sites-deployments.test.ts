/** @jest-environment node */

/**
 * HTTP-shape coverage for the site-scoped deployment endpoints (list, create,
 * detail, delete, retry, cancel, uninstall): scope-pass, scope-fail, and each
 * verb's happy / error paths (validation, 413 over_quota, idempotency replay).
 * Retired compatibility admin routes are deliberately absent.
 */

import { createMockRequest } from './helpers/utils';
import {
  mocks,
  mockDbFactory,
  docSnapshot,
  querySnapshot,
} from './helpers/firestore-mock';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDbFactory(),
  getAdminAuth: () => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')),
  }),
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: jest.fn(),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

jest.mock('@/lib/authorizedHandler.server', () => ({
  authorizedSiteHandler: () => (handler: (...args: unknown[]) => unknown) =>
    async (
      request: unknown,
      routeContext: { params: Promise<{ siteId: string }> },
    ) => {
      const params = await routeContext.params;
      return handler(
        request,
        {
          actor: {
            type: 'user',
            userId: 'user-1',
            role: 'admin',
            siteRoles: { [params.siteId]: 'admin' },
          },
          siteId: params.siteId,
          correlationId: 'corr-test',
          // The wrapper has always supplied these; the routes only started
          // reading them from ctx once task 1.4 removed the inner gate that
          // used to hand them over separately.
          auth: { userId: 'user-1', keyContext: null },
          scopeCheck: { isLegacy: false },
        },
        routeContext,
      );
    },
}));

const mockResolveAuth = jest.fn();
const mockAssertSite = jest.fn();
const mockComputeChecksum = jest.fn();
const mockSiteAuditActor = jest.fn();

// the site wrapper only ever hands a route a user or an api key; this lets a
// test put a `system:` actor behind a route to prove the route still checks it.
jest.mock('@/lib/actions/auditActor.server', () => ({
  siteAuditActor: (...a: unknown[]) => mockSiteAuditActor(...a),
}));

// Retry self-heals checksum-less legacy deployments by streaming + hashing the
// installer; mocked so tests never hit the network. requireActual preserves
// InstallerChecksumError's identity for the route's instanceof mapping.
jest.mock('@/lib/actions/computeInstallerChecksum.server', () => {
  const actual = jest.requireActual('@/lib/actions/computeInstallerChecksum.server');
  return {
    ...actual,
    computeInstallerChecksum: (...a: unknown[]) => mockComputeChecksum(...a),
  };
});

jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
    assertUserHasSiteAccess: (...a: unknown[]) => mockAssertSite(...a),
  };
});

import { FieldValue } from 'firebase-admin/firestore';
import { emitMutation } from '@/lib/auditLogClient';
import type { ApiKeyScope } from '@/lib/apiKeyTypes';
import type { ResolvedAuth } from '@/lib/apiAuth.server';

import { GET as listGET, POST as createPOST } from '@/app/api/sites/[siteId]/deployments/route';
import {
  DELETE as detailDELETE,
  GET as detailGET,
} from '@/app/api/sites/[siteId]/deployments/[deploymentId]/route';
import { POST as retryPOST } from '@/app/api/sites/[siteId]/deployments/[deploymentId]/retry/route';
import { POST as cancelPOST } from '@/app/api/sites/[siteId]/deployments/[deploymentId]/cancel/route';
import { POST as uninstallPOST } from '@/app/api/sites/[siteId]/deployments/[deploymentId]/uninstall/route';

const SITE = 'site-alpha';
const DEPLOYMENT = 'deploy-1700000000000';

const mockedEmit = emitMutation as jest.MockedFunction<typeof emitMutation>;

function authedSession(): ResolvedAuth {
  return { userId: 'user-1', keyContext: null };
}

function authedKey(scopes: ApiKeyScope[] | null): ResolvedAuth {
  return {
    userId: 'user-1',
    keyContext: {
      keyId: 'key-test',
      scopes,
      environment: 'live',
      expiresAt: Date.now() + 60_000,
      isLegacy: scopes === null,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mocks.siteDocs.clear();
  mocks.memberDocs.clear();
  mocks.userDocs.clear();
  mockResolveAuth.mockResolvedValue(authedSession());
  mockAssertSite.mockResolvedValue({ siteId: SITE, siteData: {}, machineIds: null });
  mockSiteAuditActor.mockImplementation(
    jest.requireActual('@/lib/actions/auditActor.server').siteAuditActor,
  );
  mocks.set.mockResolvedValue(undefined);
  mocks.update.mockResolvedValue(undefined);
  mocks.del.mockResolvedValue(undefined);
  mocks.get.mockImplementation(() => Promise.resolve(docSnapshot('any', null)));
  mocks.collectionGet.mockResolvedValue(querySnapshot([]));
  mockComputeChecksum.mockResolvedValue({
    sha256_checksum: 'f0'.repeat(32),
    size_bytes: 1024,
  });
});

const validCreateBody = {
  name: 'q2 vlc rollout',
  installer_name: 'vlc-3.0.21-win64.exe',
  installer_url: 'https://get.videolan.org/vlc/3.0.21/win64/vlc-3.0.21-win64.exe',
  silent_flags: '/S',
  machines: ['machine-1', 'machine-2'],
};

function idempotencyHeaders(key: string): Record<string, string> {
  return { 'Idempotency-Key': key };
}

function queueIdempotencyMiss(): void {
  mocks.get.mockResolvedValueOnce(docSnapshot('idempotency-cache', null));
}

// a merge write that queues a command: not the site's lastDeploymentActivityAt stamp.
function isCommandWrite(c: unknown[]): boolean {
  return (
    (c[1] as { merge?: boolean })?.merge === true &&
    !('lastDeploymentActivityAt' in (c[0] as object))
  );
}

// the stamp the deployment sweeper scans sites by.
function siteStamps(): unknown[][] {
  return mocks.set.mock.calls.filter(
    (c: unknown[]) =>
      'lastDeploymentActivityAt' in (c[0] as object) &&
      (c[1] as { merge?: boolean })?.merge === true,
  );
}

describe('GET /api/sites/{siteId}/deployments', () => {
  it('200 with cursor-paginated list', async () => {
    mocks.collectionGet.mockResolvedValueOnce(
      querySnapshot([
        {
          id: DEPLOYMENT,
          data: {
            name: 'rollout',
            installer_name: 'vlc.exe',
            installer_url: 'https://example.com/vlc.exe',
            silent_flags: '/S',
            targets: [{ machineId: 'm1', status: 'completed' }],
            status: 'completed',
            createdAt: 1_700_000_000_000,
          },
        },
      ]),
    );
    const req = createMockRequest(`http://localhost/api/sites/${SITE}/deployments`);
    const res = await listGET(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(DEPLOYMENT);
    expect(body.next_page_token).toBe('');
  });

  it('200 + emits next_page_token when over a page', async () => {
    // pageSize+1 docs → the route emits a next_page_token.
    mocks.collectionGet.mockResolvedValueOnce(
      querySnapshot(
        Array.from({ length: 26 }, (_, i) => ({
          id: `deploy-${i}`,
          data: { name: `d${i}`, status: 'completed', createdAt: 1_700_000_000_000 - i },
        })),
      ),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments?page_size=25`,
    );
    const res = await listGET(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(25);
    expect(body.next_page_token).toBe('deploy-24');
  });

  it('400 when page_size is above MAX', async () => {
    mocks.collectionGet.mockResolvedValueOnce(querySnapshot([]));
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments?page_size=999`,
    );
    const res = await listGET(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(400);
  });

  it('accepts legacy limit/cursor aliases', async () => {
    mocks.get.mockResolvedValueOnce(docSnapshot('deploy-prev', { createdAt: 1 }));
    mocks.collectionGet.mockResolvedValueOnce(querySnapshot([]));
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments?limit=10&cursor=deploy-prev`,
    );
    const res = await listGET(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(200);
    expect(mocks.limit).toHaveBeenCalledWith(11);
    expect(mocks.startAfter).toHaveBeenCalled();
  });

  it('200 — scope-pass: site=<id>:read on api key', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'site', id: SITE, permissions: ['read'] }]),
    );
    mocks.collectionGet.mockResolvedValueOnce(querySnapshot([]));
    const req = createMockRequest(`http://localhost/api/sites/${SITE}/deployments`);
    const res = await listGET(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(200);
  });

  // Scope assertions REMOVED here by task 1.4: this suite mocks
  // authorizedSiteHandler, and the scope check now lives only in that
  // wrapper, so an assertion here would pass whatever the gate did.
  // Covered instead by scopeEnforcement.test.ts (mechanism),
  // authorizedHandler.test.ts:365 (wrapper), and
  // membershipEscalation.test.ts (route-level, real wrapper).
});

describe('POST /api/sites/{siteId}/deployments', () => {
  it('201 happy path: writes deployment doc + fans out commands', async () => {
    mocks.get.mockResolvedValue(docSnapshot(SITE, {})); // site doc, no quota override
    const req = createMockRequest(`http://localhost/api/sites/${SITE}/deployments`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'idem-create-happy' },
      body: validCreateBody,
    });
    const res = await createPOST(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.deploymentId).toMatch(/^deploy-\d+$/);
    expect(body.targets).toHaveLength(2);

    // Deployment doc + fan-out merges (one per machine).
    const mergeCalls = mocks.set.mock.calls.filter(isCommandWrite);
    expect(mergeCalls).toHaveLength(2);
    const firstCmd = mergeCalls[0][0];
    const cmdKey = Object.keys(firstCmd)[0];
    expect(firstCmd[cmdKey].type).toBe('install_software');
    expect(mocks.update).toHaveBeenCalledWith({ status: 'in_progress' });
    // the sweeper only scans sites with recent activity; without this it never fails a stuck target.
    expect(siteStamps()).toHaveLength(1);

    expect(mockedEmit).toHaveBeenCalledTimes(1);
    expect(mockedEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'deployment_mutated',
        siteId: SITE,
        attributes: expect.objectContaining({ verb: 'create', target_count: 2 }),
      }),
    );
  });

  it('201 an active_hours_override flows to every install_software command', async () => {
    mocks.get.mockResolvedValue(docSnapshot(SITE, {}));
    const req = createMockRequest(`http://localhost/api/sites/${SITE}/deployments`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'idem-create-override' },
      body: { ...validCreateBody, active_hours_override: { reason: 'venue closed today' } },
    });
    const res = await createPOST(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(201);
    const mergeCalls = mocks.set.mock.calls.filter(isCommandWrite);
    expect(mergeCalls).toHaveLength(2);
    for (const call of mergeCalls) {
      const cmd = call[0][Object.keys(call[0])[0]];
      expect(cmd.activeHoursOverride).toEqual({
        reason: 'venue closed today',
        approvedBy: 'user:user-1',
      });
      expect(cmd).not.toHaveProperty('active_hours_override');
    }
  });

  it('400 when active_hours_override is malformed, nothing written', async () => {
    mocks.get.mockResolvedValue(docSnapshot(SITE, {}));
    const req = createMockRequest(`http://localhost/api/sites/${SITE}/deployments`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'idem-create-bad-override' },
      body: { ...validCreateBody, active_hours_override: { reason: '   ' } },
    });
    const res = await createPOST(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(400);
    expect((await res.json()).errors).toHaveProperty(['body.active_hours_override']);
    const mergeCalls = mocks.set.mock.calls.filter(isCommandWrite);
    expect(mergeCalls).toHaveLength(0);
  });

  it('400 when Idempotency-Key is missing', async () => {
    const req = createMockRequest(`http://localhost/api/sites/${SITE}/deployments`, {
      method: 'POST',
      body: validCreateBody,
    });
    const res = await createPOST(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('idempotency_key_required');
  });

  it('400 when name missing', async () => {
    mocks.get.mockResolvedValue(docSnapshot(SITE, {}));
    const req = createMockRequest(`http://localhost/api/sites/${SITE}/deployments`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'idem-create-missing-name' },
      body: { ...validCreateBody, name: '' },
    });
    const res = await createPOST(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(400);
  });

  it('400 when installer_url is not https', async () => {
    mocks.get.mockResolvedValue(docSnapshot(SITE, {}));
    const req = createMockRequest(`http://localhost/api/sites/${SITE}/deployments`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'idem-create-http-installer' },
      body: { ...validCreateBody, installer_url: 'http://example.com/setup.exe' },
    });
    const res = await createPOST(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(400);
  });

  it('400 when machines is empty', async () => {
    mocks.get.mockResolvedValue(docSnapshot(SITE, {}));
    const req = createMockRequest(`http://localhost/api/sites/${SITE}/deployments`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'idem-create-empty-machines' },
      body: { ...validCreateBody, machines: [] },
    });
    const res = await createPOST(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(400);
  });

  it('400 when sha256_checksum has wrong length', async () => {
    mocks.get.mockResolvedValue(docSnapshot(SITE, {}));
    const req = createMockRequest(`http://localhost/api/sites/${SITE}/deployments`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'idem-create-bad-checksum' },
      body: { ...validCreateBody, sha256_checksum: 'deadbeef' },
    });
    const res = await createPOST(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(400);
  });

  it('413 over_quota when machines exceed default 100', async () => {
    mocks.get.mockResolvedValue(docSnapshot(SITE, {})); // no override
    const req = createMockRequest(`http://localhost/api/sites/${SITE}/deployments`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'idem-create-default-quota' },
      body: {
        ...validCreateBody,
        machines: Array.from({ length: 101 }, (_, i) => `m-${i}`),
      },
    });
    const res = await createPOST(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.code).toBe('over_quota');
    expect(body.quota).toEqual({ max_targets: 100, requested: 101 });
  });

  it('413 over_quota honors per-site deployQuota override', async () => {
    mocks.siteDocs.set(SITE, { deployQuota: 5 });
    const req = createMockRequest(`http://localhost/api/sites/${SITE}/deployments`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'idem-create-site-quota' },
      body: {
        ...validCreateBody,
        machines: Array.from({ length: 6 }, (_, i) => `m-${i}`),
      },
    });
    const res = await createPOST(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.quota.max_targets).toBe(5);
  });

  it('201 — scope-pass: site=<id>:write on api key', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'site', id: SITE, permissions: ['write'] }]),
    );
    mocks.get.mockResolvedValue(docSnapshot(SITE, {}));
    const req = createMockRequest(`http://localhost/api/sites/${SITE}/deployments`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'idem-create-scope-pass' },
      body: validCreateBody,
    });
    const res = await createPOST(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(201);
  });


  it('replays cached response on Idempotency-Key hit with matching body', async () => {
    const crypto = await import('crypto');
    const raw = JSON.stringify(validCreateBody);
    const bodyHash = crypto.createHash('sha256').update(raw).digest('hex');
    // First doc.get() = idempotency cache lookup
    mocks.get.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        userId: 'user-1',
        environment: 'unknown',
        key: 'idem-create-1',
        bodyHash,
        status: 201,
        headers: { 'content-type': 'application/json' },
        body: '{"deploymentId":"deploy-replayed","siteId":"site-alpha"}',
        expiresAt: Date.now() + 60_000,
      }),
    });

    const req = createMockRequest(`http://localhost/api/sites/${SITE}/deployments`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'idem-create-1' },
      body: validCreateBody,
    });
    const res = await createPOST(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(201);
    expect(res.headers.get('Idempotent-Replayed')).toBe('true');
    const body = await res.json();
    expect(body.deploymentId).toBe('deploy-replayed');
    // The handler should NOT have written anything on a replay.
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('422 idempotency_key_mismatch when same key, different body', async () => {
    // Cache holds a different body hash.
    mocks.get.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        userId: 'user-1',
        environment: 'unknown',
        key: 'idem-create-2',
        bodyHash: 'a'.repeat(64),
        status: 201,
        headers: {},
        body: '{}',
        expiresAt: Date.now() + 60_000,
      }),
    });

    const req = createMockRequest(`http://localhost/api/sites/${SITE}/deployments`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'idem-create-2' },
      body: validCreateBody,
    });
    const res = await createPOST(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('idempotency_key_mismatch');
  });
});

describe('GET /api/sites/{siteId}/deployments/{deploymentId}', () => {
  it('200 with full deployment detail', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot(DEPLOYMENT, {
        name: 'detail-test',
        installer_name: 'vlc.exe',
        installer_url: 'https://example.com/vlc.exe',
        silent_flags: '/S',
        targets: [{ machineId: 'm1', status: 'completed' }],
        status: 'completed',
        createdAt: 1_700_000_000_000,
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}`,
    );
    const res = await detailGET(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(DEPLOYMENT);
    expect(body.name).toBe('detail-test');
    expect(body.targets).toHaveLength(1);
  });

  it('404 when deployment not found', async () => {
    mocks.get.mockResolvedValueOnce(docSnapshot(DEPLOYMENT, null));
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}`,
    );
    const res = await detailGET(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(404);
  });

});

describe('DELETE /api/sites/{siteId}/deployments/{deploymentId}', () => {
  it('200 - deletes terminal deployment', async () => {
    queueIdempotencyMiss();
    mocks.get.mockResolvedValueOnce(
      docSnapshot(DEPLOYMENT, {
        status: 'completed',
        targets: [{ machineId: 'm1', status: 'completed' }],
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}`,
      { method: 'DELETE', headers: idempotencyHeaders('idem-delete-happy'), body: {} },
    );
    const res = await detailDELETE(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      deploymentId: DEPLOYMENT,
      siteId: SITE,
      deleted: true,
    });
    expect(mocks.del).toHaveBeenCalledTimes(1);
  });

  it('200 - deletes partial_failed deployment when targets are terminal', async () => {
    queueIdempotencyMiss();
    mocks.get.mockResolvedValueOnce(
      docSnapshot(DEPLOYMENT, {
        status: 'partial_failed',
        targets: [
          { machineId: 'm1', status: 'completed' },
          { machineId: 'm2', status: 'failed' },
        ],
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}`,
      {
        method: 'DELETE',
        headers: idempotencyHeaders('idem-delete-partial-failed'),
        body: {},
      },
    );
    const res = await detailDELETE(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);
    expect(mocks.del).toHaveBeenCalledTimes(1);
  });

  it('404 when deployment not found', async () => {
    queueIdempotencyMiss();
    mocks.get.mockResolvedValueOnce(docSnapshot(DEPLOYMENT, null));
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}`,
      { method: 'DELETE', headers: idempotencyHeaders('idem-delete-not-found'), body: {} },
    );
    const res = await detailDELETE(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(404);
  });

  it('409 when deployment status is not terminal', async () => {
    queueIdempotencyMiss();
    mocks.get.mockResolvedValueOnce(
      docSnapshot(DEPLOYMENT, {
        status: 'in_progress',
        targets: [{ machineId: 'm1', status: 'installing' }],
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}`,
      { method: 'DELETE', headers: idempotencyHeaders('idem-delete-conflict'), body: {} },
    );
    const res = await detailDELETE(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('deployment_in_flight');
  });

  it('400 when Idempotency-Key is missing', async () => {
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}`,
      { method: 'DELETE', body: {} },
    );
    const res = await detailDELETE(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('idempotency_key_required');
  });

});

describe('POST /api/sites/{siteId}/deployments/{deploymentId}/retry', () => {
  // the first read, then the claim transaction's re-read of the same record.
  function stageDeployment(snapshot: ReturnType<typeof docSnapshot>) {
    mocks.get.mockResolvedValueOnce(snapshot).mockResolvedValueOnce(snapshot);
  }

  it('200 — re-queues install for failed targets only', async () => {
    queueIdempotencyMiss();
    stageDeployment(
      docSnapshot(DEPLOYMENT, {
        installer_name: 'vlc.exe',
        installer_url: 'https://example.com/vlc.exe',
        silent_flags: '/S',
        targets: [
          { machineId: 'm1', status: 'completed' },
          { machineId: 'm2', status: 'failed', error: 'oh no' },
          { machineId: 'm3', status: 'failed' },
        ],
        status: 'partial',
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/retry`,
      { method: 'POST', headers: idempotencyHeaders('idem-retry-happy'), body: {} },
    );
    const res = await retryPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.retried).toBe(2);
    expect(body.machine_ids).toEqual(['m2', 'm3']);

    // Two install_software commands re-queued (one per failed target).
    const mergeCalls = mocks.set.mock.calls.filter(isCommandWrite);
    expect(mergeCalls).toHaveLength(2);
    expect(mergeCalls[0][0][Object.keys(mergeCalls[0][0])[0]].retry_attempt).toBe(true);

    // Targets array updated: failed → pending, error dropped, retriedAt set.
    const updatePayload = mocks.update.mock.calls[0][0];
    expect(updatePayload.status).toBe('in_progress');
    const m2 = updatePayload.targets.find((t: { machineId: string }) => t.machineId === 'm2');
    expect(m2.status).toBe('pending');
    expect(m2.error).toBeUndefined();
    expect(m2.retriedAt).toBeDefined();
    const m1 = updatePayload.targets.find((t: { machineId: string }) => t.machineId === 'm1');
    expect(m1.status).toBe('completed'); // unchanged

    expect(mockedEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'deployment_mutated',
        attributes: expect.objectContaining({ verb: 'retry', retried_count: 2 }),
      }),
    );

    // No stored checksum — self-heal pins one and stamps every re-issued command.
    expect(mockComputeChecksum).toHaveBeenCalledWith(
      'https://example.com/vlc.exe',
      expect.anything(),
    );
    expect(updatePayload.sha256_checksum).toBe('f0'.repeat(32));
    for (const call of mergeCalls) {
      const cmd = call[0][Object.keys(call[0])[0]];
      expect(cmd.sha256_checksum).toBe('f0'.repeat(32));
    }
  });

  it('skips checksum compute when the deployment already has one', async () => {
    queueIdempotencyMiss();
    stageDeployment(
      docSnapshot(DEPLOYMENT, {
        installer_name: 'vlc.exe',
        installer_url: 'https://example.com/vlc.exe',
        silent_flags: '/S',
        sha256_checksum: 'ab'.repeat(32),
        targets: [{ machineId: 'm1', status: 'failed' }],
        status: 'failed',
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/retry`,
      { method: 'POST', headers: idempotencyHeaders('idem-retry-has-sum'), body: {} },
    );
    const res = await retryPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(200);
    expect(mockComputeChecksum).not.toHaveBeenCalled();

    const mergeCalls = mocks.set.mock.calls.filter(isCommandWrite);
    const cmd = mergeCalls[0][0][Object.keys(mergeCalls[0][0])[0]];
    expect(cmd.sha256_checksum).toBe('ab'.repeat(32));
    // No re-pin: doc already had the checksum.
    expect(mocks.update.mock.calls[0][0].sha256_checksum).toBeUndefined();
  });

  it('carries the processes to close and the projects to hold, as the first attempt did', async () => {
    queueIdempotencyMiss();
    stageDeployment(
      docSnapshot(DEPLOYMENT, {
        installer_name: 'td.exe',
        installer_url: 'https://example.com/td.exe',
        silent_flags: '/S',
        sha256_checksum: 'ab'.repeat(32),
        close_processes: ['TouchDesigner.exe'],
        suppress_projects: ['C:\\show\\main.toe'],
        targets: [{ machineId: 'm1', status: 'failed' }],
        status: 'failed',
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/retry`,
      { method: 'POST', headers: idempotencyHeaders('idem-retry-close'), body: {} },
    );
    const res = await retryPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(200);

    const mergeCalls = mocks.set.mock.calls.filter(isCommandWrite);
    const cmd = mergeCalls[0][0][Object.keys(mergeCalls[0][0])[0]];
    expect(cmd.close_processes).toEqual(['TouchDesigner.exe']);
    expect(cmd.suppress_projects).toEqual(['C:\\show\\main.toe']);
  });

  it('retries only the machines in the body filter', async () => {
    queueIdempotencyMiss();
    stageDeployment(
      docSnapshot(DEPLOYMENT, {
        installer_name: 'vlc.exe',
        installer_url: 'https://example.com/vlc.exe',
        silent_flags: '/S',
        sha256_checksum: 'ab'.repeat(32),
        targets: [
          { machineId: 'm1', status: 'failed', error: 'a' },
          { machineId: 'm2', status: 'failed', error: 'b' },
        ],
        status: 'failed',
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/retry`,
      {
        method: 'POST',
        headers: idempotencyHeaders('idem-retry-filter'),
        body: { machines: ['m2'] },
      },
    );
    const res = await retryPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.retried).toBe(1);
    expect(body.machine_ids).toEqual(['m2']);

    // Only one command queued; m1 stays failed with its error intact.
    const mergeCalls = mocks.set.mock.calls.filter(isCommandWrite);
    expect(mergeCalls).toHaveLength(1);
    const updatePayload = mocks.update.mock.calls[0][0];
    const m1 = updatePayload.targets.find((t: { machineId: string }) => t.machineId === 'm1');
    expect(m1.status).toBe('failed');
    expect(m1.error).toBe('a');
    const m2 = updatePayload.targets.find((t: { machineId: string }) => t.machineId === 'm2');
    expect(m2.status).toBe('pending');
  });

  it('200 — an active_hours_override flows to every re-queued install and is audited', async () => {
    queueIdempotencyMiss();
    stageDeployment(
      docSnapshot(DEPLOYMENT, {
        installer_name: 'vlc.exe',
        installer_url: 'https://example.com/vlc.exe',
        silent_flags: '/S',
        sha256_checksum: 'ab'.repeat(32),
        targets: [
          { machineId: 'm1', status: 'failed', error: 'Error: active_hours: inside active hours 08:00–17:00 (machine time); they end at 17:00' },
          { machineId: 'm2', status: 'failed' },
        ],
        status: 'failed',
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/retry`,
      {
        method: 'POST',
        headers: idempotencyHeaders('idem-retry-override'),
        body: { active_hours_override: { reason: '  venue closed today ' } },
      },
    );
    const res = await retryPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(200);
    const mergeCalls = mocks.set.mock.calls.filter(isCommandWrite);
    expect(mergeCalls).toHaveLength(2);
    for (const call of mergeCalls) {
      const cmd = call[0][Object.keys(call[0])[0]];
      expect(cmd.activeHoursOverride).toEqual({
        reason: 'venue closed today',
        approvedBy: 'user:user-1',
      });
    }
    expect(mockedEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({
          verb: 'retry',
          activeHoursOverride: true,
          activeHoursOverrideReason: 'venue closed today',
        }),
      }),
    );
  });

  it('a retry without an override carries none', async () => {
    queueIdempotencyMiss();
    stageDeployment(
      docSnapshot(DEPLOYMENT, {
        installer_name: 'vlc.exe',
        installer_url: 'https://example.com/vlc.exe',
        silent_flags: '/S',
        sha256_checksum: 'ab'.repeat(32),
        targets: [{ machineId: 'm1', status: 'failed' }],
        status: 'failed',
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/retry`,
      { method: 'POST', headers: idempotencyHeaders('idem-retry-no-override'), body: {} },
    );
    const res = await retryPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(200);
    const mergeCalls = mocks.set.mock.calls.filter(isCommandWrite);
    expect(mergeCalls[0][0][Object.keys(mergeCalls[0][0])[0]]).not.toHaveProperty('activeHoursOverride');
    expect(mockedEmit.mock.calls[0][0].attributes).not.toHaveProperty('activeHoursOverride');
  });

  it.each([
    ['an empty reason', { reason: '' }],
    ['an over-long reason', { reason: 'x'.repeat(501) }],
    ['an unknown key', { reason: 'ok', approvedBy: 'user:attacker' }],
    ['a boolean', true],
  ])('400 when active_hours_override has %s, nothing read or written', async (_label, override) => {
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/retry`,
      {
        method: 'POST',
        headers: idempotencyHeaders(`idem-retry-bad-override-${_label}`),
        body: { active_hours_override: override },
      },
    );
    const res = await retryPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).errors).toHaveProperty(['body.active_hours_override']);
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('400 when a system actor carries an override, nothing read or written', async () => {
    mockSiteAuditActor.mockReturnValue('system:talon');
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/retry`,
      {
        method: 'POST',
        headers: idempotencyHeaders('idem-retry-system-override'),
        body: { active_hours_override: { reason: 'venue closed today' } },
      },
    );
    const res = await retryPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors['body.active_hours_override'][0]).toContain('needs a person');
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('400 when machines filter is malformed', async () => {
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/retry`,
      {
        method: 'POST',
        headers: idempotencyHeaders('idem-retry-badfilter'),
        body: { machines: [] },
      },
    );
    const res = await retryPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(400);
  });

  it('surfaces a checksum compute failure without queuing commands', async () => {
    queueIdempotencyMiss();
    const { InstallerChecksumError } = jest.requireActual(
      '@/lib/actions/computeInstallerChecksum.server',
    );
    mockComputeChecksum.mockRejectedValueOnce(
      new InstallerChecksumError('fetch_failed', 'download failed with http 404'),
    );
    mocks.get.mockResolvedValueOnce(
      docSnapshot(DEPLOYMENT, {
        installer_name: 'vlc.exe',
        installer_url: 'https://example.com/vlc.exe',
        silent_flags: '/S',
        targets: [{ machineId: 'm1', status: 'failed' }],
        status: 'failed',
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/retry`,
      { method: 'POST', headers: idempotencyHeaders('idem-retry-heal-fail'), body: {} },
    );
    const res = await retryPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(422);
    const mergeCalls = mocks.set.mock.calls.filter(isCommandWrite);
    expect(mergeCalls).toHaveLength(0);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('404 when deployment not found', async () => {
    queueIdempotencyMiss();
    mocks.get.mockResolvedValueOnce(docSnapshot(DEPLOYMENT, null));
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/retry`,
      { method: 'POST', headers: idempotencyHeaders('idem-retry-not-found'), body: {} },
    );
    const res = await retryPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(404);
  });

  it('409 when no targets are in failed state', async () => {
    queueIdempotencyMiss();
    mocks.get.mockResolvedValueOnce(
      docSnapshot(DEPLOYMENT, {
        installer_name: 'vlc.exe',
        installer_url: 'https://example.com/vlc.exe',
        silent_flags: '/S',
        targets: [{ machineId: 'm1', status: 'completed' }],
        status: 'completed',
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/retry`,
      { method: 'POST', headers: idempotencyHeaders('idem-retry-conflict'), body: {} },
    );
    const res = await retryPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('no_failed_targets');
  });

  it('400 when Idempotency-Key is missing', async () => {
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/retry`,
      { method: 'POST', body: {} },
    );
    const res = await retryPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('idempotency_key_required');
  });

  describe('against a live record', () => {
    type Target = { machineId: string; status: string; failedCommandType?: string; error?: string };
    const installer = {
      installer_name: 'vlc.exe',
      installer_url: 'https://example.com/vlc.exe',
      silent_flags: '/S',
      status: 'partial',
    };
    const pinned = { ...installer, sha256_checksum: 'ab'.repeat(32) };

    // reads see the latest write, as requests in flight together would.
    function liveDeployment(initial: Record<string, unknown>) {
      const path = `sites/${SITE}/deployments/${DEPLOYMENT}`;
      let record = initial;
      mocks.get.mockImplementation((p: string) =>
        Promise.resolve(p === path ? docSnapshot(DEPLOYMENT, record) : docSnapshot('any', null)),
      );
      mocks.update.mockImplementation(async (payload: Record<string, unknown>) => {
        if ('targets' in payload) record = { ...record, ...payload };
      });
      return {
        statuses: () => (record.targets as Target[]).map((t) => t.status),
        setTargets: (targets: Target[]) => {
          record = { ...record, targets };
        },
      };
    }

    function retry(key: string, body: Record<string, unknown> = {}) {
      return retryPOST(
        createMockRequest(`http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/retry`, {
          method: 'POST',
          headers: idempotencyHeaders(key),
          body,
        }),
        { params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }) },
      );
    }

    const queuedInstalls = () => mocks.set.mock.calls.filter(isCommandWrite);

    it('replaces an install still queued from before, so a machine that was offline runs one', async () => {
      liveDeployment({ ...pinned, targets: [{ machineId: 'm1', status: 'failed' }] });
      // the sweeper timed m1 out at `pending`: its first install is still queued.
      const pendingPath = `sites/${SITE}/machines/m1/commands/pending`;
      const deploymentGet = mocks.get.getMockImplementation()!;
      mocks.get.mockImplementation((p: string) =>
        p === pendingPath
          ? Promise.resolve(
              docSnapshot('pending', {
                install_first: { type: 'install_software', deployment_id: DEPLOYMENT },
                reboot_1: { type: 'reboot_machine' },
              }),
            )
          : deploymentGet(p),
      );

      const res = await retry('idem-retry-live-stale-install');

      expect(res.status).toBe(200);
      const [[payload]] = queuedInstalls() as Array<[Record<string, unknown>]>;
      expect(FieldValue.delete().isEqual(payload.install_first as FieldValue)).toBe(true);
      expect(payload).not.toHaveProperty('reboot_1');
      expect(Object.keys(payload).filter((k) => k.startsWith('install_deploy'))).toHaveLength(1);
    });

    it('stamps the site so the sweeper watches the targets it claimed', async () => {
      liveDeployment({ ...pinned, targets: [{ machineId: 'm1', status: 'failed' }] });

      const res = await retry('idem-retry-live-stamp');

      expect(res.status).toBe(200);
      expect(siteStamps()).toHaveLength(1);
    });

    it('audits what was queued, then answers 500, when one of three installs cannot be queued', async () => {
      const live = liveDeployment({
        ...pinned,
        targets: [
          { machineId: 'm1', status: 'failed' },
          { machineId: 'm2', status: 'failed' },
          { machineId: 'm3', status: 'failed' },
        ],
      });
      let installWrites = 0;
      mocks.set.mockImplementation(async (...args: unknown[]) => {
        if (isCommandWrite(args) && ++installWrites === 2) throw new Error('write failed');
      });

      const res = await retry('idem-retry-live-partial-queue');

      expect(res.status).toBe(500);
      expect(mockedEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          attributes: expect.objectContaining({
            verb: 'retry',
            retried_count: 2,
            machine_ids: ['m1', 'm3'],
            unqueued_machine_ids: ['m2'],
          }),
        }),
      );
      // claimed before queuing: m2 waits for the sweeper, with no second install anywhere.
      expect(live.statuses()).toEqual(['pending', 'pending', 'pending']);
    });

    it('keeps a result that lands while the checksum downloads', async () => {
      const live = liveDeployment({
        ...installer,
        targets: [
          { machineId: 'm1', status: 'failed' },
          { machineId: 'm2', status: 'installing' },
        ],
      });
      mockComputeChecksum.mockImplementation(async () => {
        live.setTargets([
          { machineId: 'm1', status: 'failed' },
          { machineId: 'm2', status: 'completed' },
        ]);
        return { sha256_checksum: 'f0'.repeat(32), size_bytes: 1024 };
      });

      const res = await retry('idem-retry-live-checksum');

      expect(res.status).toBe(200);
      expect(live.statuses()).toEqual(['pending', 'completed']);
    });

    it('two per-machine retries in flight together both land', async () => {
      const live = liveDeployment({
        ...pinned,
        targets: [
          { machineId: 'm1', status: 'failed' },
          { machineId: 'm2', status: 'failed' },
        ],
      });

      const [first, second] = await Promise.all([
        retry('idem-retry-live-m1', { machines: ['m1'] }),
        retry('idem-retry-live-m2', { machines: ['m2'] }),
      ]);

      expect([first.status, second.status]).toEqual([200, 200]);
      expect(live.statuses()).toEqual(['pending', 'pending']);
      expect(queuedInstalls()).toHaveLength(2);
    });

    it('queues no install for a target that left `failed` before the retry claimed it', async () => {
      const live = liveDeployment({
        ...installer,
        targets: [{ machineId: 'm1', status: 'failed' }],
      });
      // another retry claims m1 while this one downloads the installer.
      mockComputeChecksum.mockImplementation(async () => {
        live.setTargets([{ machineId: 'm1', status: 'pending' }]);
        return { sha256_checksum: 'f0'.repeat(32), size_bytes: 1024 };
      });

      const res = await retry('idem-retry-live-claimed');

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('no_failed_targets');
      expect(body.detail).toMatch(/nothing was queued/);
      expect(queuedInstalls()).toHaveLength(0);
      expect(live.statuses()).toEqual(['pending']);
    });

    it('does not reinstall a program whose uninstall failed', async () => {
      const live = liveDeployment({
        ...pinned,
        targets: [
          { machineId: 'm1', status: 'failed', failedCommandType: 'uninstall_software' },
          { machineId: 'm2', status: 'failed', failedCommandType: 'install_software' },
          // what agents answered the deployment uninstall before it sent a program name:
          // windows and macOS, then linux.
          { machineId: 'm3', status: 'failed', error: 'Error: Software name and uninstall command required' },
          {
            machineId: 'm4',
            status: 'failed',
            error: "Error: executing command uninstall_software: No module named 'winreg'",
          },
        ],
      });

      const res = await retry('idem-retry-live-uninstall-failed');

      expect(res.status).toBe(200);
      expect((await res.json()).machine_ids).toEqual(['m2']);
      expect(live.statuses()).toEqual(['failed', 'pending', 'failed', 'failed']);
      expect(queuedInstalls()).toHaveLength(1);
    });

    it('409 when the only machine named is one whose uninstall failed', async () => {
      liveDeployment({
        ...pinned,
        targets: [{ machineId: 'm1', status: 'failed', failedCommandType: 'uninstall_software' }],
      });

      const res = await retry('idem-retry-live-named-uninstall', { machines: ['m1'] });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('no_failed_targets');
      expect(body.detail).toMatch(/uninstall/);
      expect(queuedInstalls()).toHaveLength(0);
    });
  });
});

describe('POST /api/sites/{siteId}/deployments/{deploymentId}/cancel', () => {
  it('200 — cancels pending targets, leaves installing/completed alone', async () => {
    // 1st get: deployment doc; then one pending command doc per cancellable
    // target (there is one); then the transaction's re-read of the deployment.
    queueIdempotencyMiss();
    const deployment = docSnapshot(DEPLOYMENT, {
      installer_name: 'vlc.exe',
      targets: [
        { machineId: 'm1', status: 'installing' },
        { machineId: 'm2', status: 'pending' },
        { machineId: 'm3', status: 'completed' },
      ],
      status: 'in_progress',
    });
    mocks.get
      .mockResolvedValueOnce(deployment)
      .mockResolvedValueOnce({
        exists: true,
        data: () => ({
          install_deploy_xxx_m2_1: {
            type: 'install_software',
            deployment_id: DEPLOYMENT,
          },
          some_other_command: { type: 'reboot_machine' },
        }),
      })
      .mockResolvedValueOnce(deployment);
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/cancel`,
      { method: 'POST', headers: idempotencyHeaders('idem-cancel-happy'), body: {} },
    );
    const res = await cancelPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cancelled).toBe(1);
    expect(body.machine_ids).toEqual(['m2']);

    // Pending command for m2 was deleted.
    const pendingUpdate = mocks.update.mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>).install_deploy_xxx_m2_1 !== undefined,
    );
    expect(pendingUpdate).toBeDefined();

    // m1/m3 untouched, m2 cancelled; status stays non-terminal (m1 installing).
    const deploymentUpdate = mocks.update.mock.calls.find(
      (c: unknown[]) => (c[0] as { targets?: unknown }).targets !== undefined,
    );
    expect(deploymentUpdate).toBeDefined();
    const updateArg = deploymentUpdate![0] as {
      targets: Array<{ machineId: string; status: string }>;
      status?: string;
    };
    expect(updateArg.status).toBeUndefined();
    expect(updateArg.targets.find((t) => t.machineId === 'm2')!.status).toBe('cancelled');
    expect(updateArg.targets.find((t) => t.machineId === 'm1')!.status).toBe('installing');
  });

  it('200 — flips deployment status to cancelled when every target terminal-cancelled', async () => {
    queueIdempotencyMiss();
    const deployment = docSnapshot(DEPLOYMENT, {
      installer_name: 'vlc.exe',
      targets: [{ machineId: 'm1', status: 'pending' }],
      status: 'in_progress',
    });
    mocks.get
      .mockResolvedValueOnce(deployment)
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce(deployment);
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/cancel`,
      { method: 'POST', headers: idempotencyHeaders('idem-cancel-terminal'), body: {} },
    );
    const res = await cancelPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('cancelled');
  });

  it('404 when deployment not found', async () => {
    queueIdempotencyMiss();
    mocks.get.mockResolvedValueOnce(docSnapshot(DEPLOYMENT, null));
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/cancel`,
      { method: 'POST', headers: idempotencyHeaders('idem-cancel-not-found'), body: {} },
    );
    const res = await cancelPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(404);
  });

  it('409 when nothing is cancellable', async () => {
    queueIdempotencyMiss();
    mocks.get.mockResolvedValueOnce(
      docSnapshot(DEPLOYMENT, {
        installer_name: 'vlc.exe',
        targets: [{ machineId: 'm1', status: 'completed' }],
        status: 'completed',
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/cancel`,
      { method: 'POST', headers: idempotencyHeaders('idem-cancel-conflict'), body: {} },
    );
    const res = await cancelPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('no_cancellable_targets');
  });

  it('cancels only the machines in the body filter', async () => {
    queueIdempotencyMiss();
    const deployment = docSnapshot(DEPLOYMENT, {
      installer_name: 'vlc.exe',
      targets: [
        { machineId: 'm1', status: 'pending' },
        { machineId: 'm2', status: 'pending' },
      ],
      status: 'in_progress',
    });
    mocks.get
      .mockResolvedValueOnce(deployment)
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce(deployment);
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/cancel`,
      {
        method: 'POST',
        headers: idempotencyHeaders('idem-cancel-filter'),
        body: { machines: ['m2'] },
      },
    );
    const res = await cancelPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cancelled).toBe(1);
    expect(body.machine_ids).toEqual(['m2']);
    expect(body.status).toBe('in_progress');

    const deploymentUpdate = mocks.update.mock.calls.find(
      (c: unknown[]) => (c[0] as { targets?: unknown }).targets !== undefined,
    );
    const updateArg = deploymentUpdate![0] as {
      targets: Array<{ machineId: string; status: string }>;
    };
    expect(updateArg.targets.find((t) => t.machineId === 'm1')!.status).toBe('pending');
    expect(updateArg.targets.find((t) => t.machineId === 'm2')!.status).toBe('cancelled');
  });

  it('409 no_cancellable_targets when the filter names no cancellable target', async () => {
    queueIdempotencyMiss();
    mocks.get.mockResolvedValueOnce(
      docSnapshot(DEPLOYMENT, {
        installer_name: 'vlc.exe',
        targets: [
          { machineId: 'm1', status: 'installing' },
          { machineId: 'm2', status: 'pending' },
        ],
        status: 'in_progress',
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/cancel`,
      {
        method: 'POST',
        headers: idempotencyHeaders('idem-cancel-filter-miss'),
        body: { machines: ['m1', 'm9'] },
      },
    );
    const res = await cancelPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('no_cancellable_targets');
    expect(body.detail).toMatch(/machines filter/);
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('a filter naming one cancellable target and one installing cancels only the first', async () => {
    queueIdempotencyMiss();
    const deployment = docSnapshot(DEPLOYMENT, {
      installer_name: 'vlc.exe',
      targets: [
        { machineId: 'm1', status: 'installing' },
        { machineId: 'm2', status: 'pending' },
      ],
      status: 'in_progress',
    });
    mocks.get
      .mockResolvedValueOnce(deployment)
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce(deployment);
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/cancel`,
      {
        method: 'POST',
        headers: idempotencyHeaders('idem-cancel-filter-mixed'),
        body: { machines: ['m1', 'm2'] },
      },
    );
    const res = await cancelPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cancelled).toBe(1);
    expect(body.machine_ids).toEqual(['m2']);
  });

  it.each([
    ['an empty array', []],
    ['a string, not an array', 'm1'],
    ['an empty machine id', ['m1', '']],
  ])('400 when machines is %s, before anything is read', async (_label, machines) => {
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/cancel`,
      {
        method: 'POST',
        headers: idempotencyHeaders('idem-cancel-badfilter'),
        body: { machines },
      },
    );
    const res = await cancelPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors).toHaveProperty(['body.machines']);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('400 when Idempotency-Key is missing', async () => {
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/cancel`,
      { method: 'POST', body: {} },
    );
    const res = await cancelPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('idempotency_key_required');
  });

});

describe('POST /api/sites/{siteId}/deployments/{deploymentId}/uninstall', () => {
  const TD = 'TouchDesigner 2023.11880';
  const tdRecord = {
    name: TD,
    uninstall_command: '"C:/Program Files/Derivative/TouchDesigner/unins000.exe"',
    installer_type: 'inno',
    install_location: 'C:/Program Files/Derivative/TouchDesigner',
  };
  // answers for the installed_software query, one per looked-up target, in target order.
  const listed = (record: Record<string, unknown>) => ({
    empty: false,
    docs: [{ data: () => record }],
  });
  const notListed = { empty: true, docs: [] };
  // the machine doc each finished target's lookup reads first.
  const machine = (id: string) => docSnapshot(id, { online: true });

  // the list suite above stages a query answer its 400 case never reads; drop it.
  beforeEach(() => mocks.collectionGet.mockReset());

  function uninstallRequest(key: string, body: unknown) {
    return createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/uninstall`,
      { method: 'POST', headers: idempotencyHeaders(key), body },
    );
  }

  it('200 — queues the agent command on each finished target that lists the program, and reports the rest', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'site', id: SITE, permissions: ['admin'] }]),
    );
    queueIdempotencyMiss();
    mocks.get
      .mockResolvedValueOnce(
        docSnapshot(DEPLOYMENT, {
          installer_name: 'TouchDesigner.2023.11880.exe',
          targets: [
            { machineId: 'm1', status: 'completed' },
            { machineId: 'm2', status: 'failed' },
            { machineId: 'm3', status: 'installing' },
          ],
          status: 'in_progress',
        }),
      )
      .mockResolvedValueOnce(machine('m1'))
      .mockResolvedValueOnce(machine('m2'));
    mocks.collectionGet.mockResolvedValueOnce(listed(tdRecord)).mockResolvedValueOnce(notListed);

    const res = await uninstallPOST(uninstallRequest('idem-uninstall-happy', { software_name: TD }), {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      deploymentId: DEPLOYMENT,
      siteId: SITE,
      status: 'in_progress',
      queued: 1,
      machine_ids: ['m1'],
      skipped: [
        { machineId: 'm2', reason: 'software_not_found' },
        { machineId: 'm3', reason: 'install_in_flight' },
      ],
    });
    // exact name only, and two records under it are told apart: a silent uninstall as SYSTEM.
    expect(mocks.where).toHaveBeenCalledWith('name', '==', TD);
    expect(mocks.where).toHaveBeenCalledTimes(2);
    expect(mocks.limit).toHaveBeenCalledWith(2);

    const mergeCalls = mocks.set.mock.calls.filter(isCommandWrite);
    expect(mergeCalls).toHaveLength(1);
    const [commandId, command] = Object.entries(mergeCalls[0][0] as Record<string, unknown>)[0];
    expect(commandId).toMatch(/^uninstall-\d+$/);
    // the machine route's command, plus the deployment_id the reconciler keys on.
    expect(command).toMatchObject({
      type: 'uninstall_software',
      software_name: TD,
      uninstall_command: tdRecord.uninstall_command,
      installer_type: 'inno',
      verify_paths: [tdRecord.install_location],
      deployment_id: DEPLOYMENT,
      auditCorrelationId: 'corr-test',
    });
    expect(Object.keys(command as object).sort()).toEqual(
      [
        'auditCorrelationId',
        'createdAt',
        'deployment_id',
        'expiresAt',
        'installer_type',
        'software_name',
        'timestamp',
        'type',
        'uninstall_command',
        'verify_paths',
      ].sort(),
    );

    // the reconciler moves the targets from the agent's result; the route writes no status.
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mockedEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'deployment_mutated',
        attributes: expect.objectContaining({
          verb: 'uninstall',
          target_count: 1,
          software_name: TD,
          skipped_count: 2,
        }),
      }),
    );
  });

  it('409 no_uninstallable_targets when no target lists the program — queues nothing', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'site', id: SITE, permissions: ['admin'] }]),
    );
    queueIdempotencyMiss();
    mocks.get
      .mockResolvedValueOnce(
        docSnapshot(DEPLOYMENT, {
          installer_name: 'vlc.exe',
          targets: [
            { machineId: 'm1', status: 'completed' },
            { machineId: 'm2', status: 'completed' },
          ],
          status: 'completed',
        }),
      )
      .mockResolvedValueOnce(machine('m1'))
      .mockResolvedValueOnce(machine('m2'));
    mocks.collectionGet.mockResolvedValueOnce(notListed).mockResolvedValueOnce(notListed);

    const res = await uninstallPOST(
      uninstallRequest('idem-uninstall-none', { software_name: 'VLC media player' }),
      { params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }) },
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('no_uninstallable_targets');
    expect(body.skipped).toEqual([
      { machineId: 'm1', reason: 'software_not_found' },
      { machineId: 'm2', reason: 'software_not_found' },
    ]);
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mockedEmit).not.toHaveBeenCalled();
  });

  async function uninstallFromOneTarget(
    key: string,
    machineDoc: ReturnType<typeof docSnapshot>,
    softwareList: unknown,
  ) {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'site', id: SITE, permissions: ['admin'] }]),
    );
    queueIdempotencyMiss();
    mocks.get
      .mockResolvedValueOnce(
        docSnapshot(DEPLOYMENT, {
          installer_name: 'TouchDesigner.exe',
          targets: [{ machineId: 'm1', status: 'completed' }],
          status: 'completed',
        }),
      )
      .mockResolvedValueOnce(machineDoc);
    mocks.collectionGet.mockResolvedValueOnce(softwareList);
    return uninstallPOST(uninstallRequest(key, { software_name: TD }), {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
  }

  it('skips a removed machine, whose software list outlives it, and queues nothing for it', async () => {
    const res = await uninstallFromOneTarget(
      'idem-uninstall-removed',
      docSnapshot('m1', null),
      listed(tdRecord),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).skipped).toEqual([{ machineId: 'm1', reason: 'machine_not_found' }]);
    expect(mocks.collectionGet).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('skips a machine that lists two versions under the name, rather than pick one', async () => {
    const res = await uninstallFromOneTarget('idem-uninstall-two-builds', machine('m1'), {
      empty: false,
      docs: [{ data: () => tdRecord }, { data: () => ({ ...tdRecord, version: 'older' }) }],
    });

    expect(res.status).toBe(409);
    expect((await res.json()).skipped).toEqual([{ machineId: 'm1', reason: 'software_ambiguous' }]);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', {}],
    ['blank', { software_name: '   ' }],
    ['not a string', { software_name: 42 }],
  ])('400 when software_name is %s, before anything is read', async (_label, body) => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'site', id: SITE, permissions: ['admin'] }]),
    );
    const res = await uninstallPOST(uninstallRequest('idem-uninstall-noname', body), {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).errors).toHaveProperty(['body.software_name']);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('404 when deployment not found', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'site', id: SITE, permissions: ['admin'] }]),
    );
    queueIdempotencyMiss();
    mocks.get.mockResolvedValueOnce(docSnapshot(DEPLOYMENT, null));
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/uninstall`,
      {
        method: 'POST',
        headers: idempotencyHeaders('idem-uninstall-not-found'),
        body: { software_name: 'VLC media player' },
      },
    );
    const res = await uninstallPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(404);
  });

  it('409 when deployment has no targets', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'site', id: SITE, permissions: ['admin'] }]),
    );
    queueIdempotencyMiss();
    mocks.get.mockResolvedValueOnce(
      docSnapshot(DEPLOYMENT, {
        installer_name: 'vlc.exe',
        targets: [],
        status: 'completed',
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/uninstall`,
      {
        method: 'POST',
        headers: idempotencyHeaders('idem-uninstall-conflict'),
        body: { software_name: 'VLC media player' },
      },
    );
    const res = await uninstallPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('no_targets');
  });

  it('400 when Idempotency-Key is missing', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'site', id: SITE, permissions: ['admin'] }]),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/uninstall`,
      { method: 'POST', body: { software_name: 'VLC media player' } },
    );
    const res = await uninstallPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('idempotency_key_required');
  });

  // MOVED to __tests__/api/membershipEscalation.test.ts (task 1.4).
  // This suite mocks authorizedSiteHandler, and authorization now lives
  // entirely in that wrapper, so an assertion here could no longer observe
  // it — it would pass whatever the gate did.
});
