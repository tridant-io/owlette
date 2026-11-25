/** @jest-environment node */

import { createMockRequest } from './helpers/utils';
import {
  mocks,
  mockDbFactory,
  docSnapshot,
  querySnapshot,
  seedMember
} from './helpers/firestore-mock';
import { verifySignature } from '@/lib/webhookSignature';

const mockEmitMutation = jest.fn();

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

// Shared tx state — one roost across the runTransaction callback, so we can
// assert what the route writes.

const txState = {
  exists: true as boolean,
  currentVersionId: null as string | null,
  previousVersionId: null as string | null,
  versionCounter: 0,
  deletedAt: null as unknown,
  targets: [] as string[],
  extractPath: null as string | null,
  /** Captured `tx.update(roostRef, ...)` payloads, in call order. */
  roostUpdates: [] as Array<Record<string, unknown>>,
  /** Captured `tx.set(rolloutRef, ...)` payloads, in call order. */
  rolloutSets: [] as Array<{
    payload: Record<string, unknown>;
    options?: Record<string, unknown>;
  }>,
  /** Captured `tx.delete(...)` calls. Rollback must not delete rollouts. */
  txDeletes: [] as unknown[],
};

const mockRunTransaction = jest.fn(
  async (cb: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
    const tx = {
      get: async () => {
        if (!txState.exists) {
          return docSnapshot('rst_test', null);
        }
        return docSnapshot('rst_test', {
          currentVersionId: txState.currentVersionId,
          previousVersionId: txState.previousVersionId,
          versionCounter: txState.versionCounter,
          deletedAt: txState.deletedAt,
          name: 'lobby roost',
          targets: txState.targets,
          extractPath: txState.extractPath,
        });
      },
      set: jest.fn((
        _ref: unknown,
        payload: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => {
        txState.rolloutSets.push({ payload, options });
      }),
      update: jest.fn((_ref: unknown, payload: Record<string, unknown>) => {
        txState.roostUpdates.push(payload);
      }),
      delete: jest.fn((ref: unknown) => {
        txState.txDeletes.push(ref);
      }),
    };
    const result = await cb(tx);
    return result;
  },
);

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => {
    const base = mockDbFactory() as Record<string, unknown>;
    return { ...base, runTransaction: mockRunTransaction };
  },
  getAdminAuth: () => ({ verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')) }),
}));

// Resolver mock — controllable per test.

const mockResolveVersion = jest.fn();
jest.mock('@/lib/resolveVersion', () => {
  const actual = jest.requireActual('@/lib/resolveVersion');
  return {
    ...actual,
    resolveVersion: (...a: unknown[]) => mockResolveVersion(...a),
  };
});

// Auth mock — controls whether the scope check passes.

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

import {
  ResolveVersionError,
  VersionNotFoundError,
  VersionRefMalformedError,
} from '@/lib/resolveVersion';
import { POST as rollbackPOST } from '@/app/api/roosts/[roostId]/rollback/route';

const SITE = 'site-alpha';
const ROOST = 'rst_test_0000000001';

function fakeVersionDoc(
  id: string,
  data: Record<string, unknown>,
): {
  exists: boolean;
  id: string;
  data: () => Record<string, unknown>;
} {
  return {
    exists: true,
    id,
    data: () => data,
  };
}

function authedAsOperator() {
  // operator preset: ['read','write','deploy','rollback'] on roost:*
  mockResolveAuth.mockResolvedValue({
    userId: 'user-operator',
    keyContext: {
      keyId: 'key-operator',
      environment: 'live',
      isLegacy: false,
      scopes: [
        { resource: 'roost', id: '*', permissions: ['read', 'write', 'deploy', 'rollback'] },
      ],
    },
  });
  mockAssertSite.mockResolvedValue({ siteId: SITE, siteData: {}, machineIds: null });
}

function authedAsReadOnly() {
  mocks.siteDocs.set(SITE, { owner: 'user-readonly' });
  seedMember(SITE, 'user-readonly', 'owner');
  // readonly preset: ['read'] on roost:*
  mockResolveAuth.mockResolvedValue({
    userId: 'user-readonly',
    keyContext: {
      keyId: 'key-readonly',
      environment: 'live',
      isLegacy: false,
      scopes: [{ resource: 'roost', id: '*', permissions: ['read'] }],
    },
  });
  mockAssertSite.mockResolvedValue({ siteId: SITE, siteData: {}, machineIds: null });
}

async function rollback(body: Record<string, unknown>): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const req = createMockRequest(`http://localhost/api/roosts/${ROOST}/rollback`, {
    method: 'POST',
    body,
    headers: { 'Roost-Version': '2026-04-22' },
  });
  const res = await rollbackPOST(req, { params: Promise.resolve({ roostId: ROOST }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  jest.clearAllMocks();
  authedAsOperator();
  txState.exists = true;
  txState.currentVersionId = null;
  txState.previousVersionId = null;
  txState.versionCounter = 0;
  txState.deletedAt = null;
  txState.targets = [];
  txState.extractPath = null;
  txState.roostUpdates.length = 0;
  txState.rolloutSets.length = 0;
  txState.txDeletes.length = 0;
  mocks.set.mockResolvedValue(undefined);
  mocks.update.mockResolvedValue(undefined);
  mocks.batchSet.mockClear();
  mocks.batchDelete.mockClear();
  mocks.batchCommit.mockResolvedValue(undefined);
  mocks.siteDocs.clear();
  mocks.memberDocs.clear();
  mocks.userDocs.clear();
  mocks.siteDocs.set(SITE, { owner: 'user-operator' });
  seedMember(SITE, 'user-operator', 'owner');
  mocks.get.mockResolvedValue(docSnapshot('idem', null)); // idempotency cache miss
  // no webhook subscriptions unless a test seeds some
  mocks.collectionGet.mockResolvedValue(querySnapshot([]));
});

// Happy paths

describe('POST /rollback — happy paths', () => {
  it('default target = "previous": flips currentVersionId to v4, previousVersionId to v5', async () => {
    txState.versionCounter = 5;
    txState.currentVersionId = 'vrs_v5_id';
    txState.previousVersionId = 'vrs_v4_id';

    mockResolveVersion.mockResolvedValue({
      versionId: 'vrs_v4_id',
      versionNumber: 4,
      doc: fakeVersionDoc('vrs_v4_id', {
        versionUrl: 'https://r2.test/v4.json',
        description: 'pre-prod build',
        totalFiles: 3,
        totalSize: 4096,
      }),
    });

    const res = await rollback({ siteId: SITE });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      roostId: ROOST,
      siteId: SITE,
      currentVersionId: 'vrs_v4_id',
      currentVersionNumber: 4,
      previousVersionId: 'vrs_v5_id',
    });

    // Resolver was called with the default 'previous' alias.
    expect(mockResolveVersion).toHaveBeenCalledWith({
      roostId: ROOST,
      siteId: SITE,
      ref: 'previous',
    });

    // Roost doc denormalises summary fields (versionUrl, description, totalFiles,
    // totalSize) so the dispatcher + list view skip a sub-collection read.
    expect(txState.roostUpdates).toHaveLength(1);
    const update = txState.roostUpdates[0]!;
    expect(update).toMatchObject({
      currentVersionId: 'vrs_v4_id',
      currentVersionNumber: 4,
      currentVersionDescription: 'pre-prod build',
      previousVersionId: 'vrs_v5_id',
      versionUrl: 'https://r2.test/v4.json',
      totalFiles: 3,
      totalSize: 4096,
    });
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'roost_mutated',
        siteId: SITE,
        actor: 'apiKey:key-operator',
        targetId: 'vrs_v4_id',
        attributes: expect.objectContaining({
          verb: 'rollback',
          endpoint: `/api/roosts/${ROOST}/rollback`,
          method: 'POST',
          roostId: ROOST,
          targetVersion: 'previous',
          fromVersionId: 'vrs_v5_id',
          toVersionId: 'vrs_v4_id',
          toVersionNumber: 4,
        }),
      }),
    );
  });

  it('dispatches nonce rollback sync_pull commands and does not delete the rollout doc', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    txState.versionCounter = 5;
    txState.currentVersionId = 'vrs_v5_id';
    txState.previousVersionId = 'vrs_v4_id';
    txState.targets = ['machine-a', 'machine-b'];
    txState.extractPath = '~/Owlette/roosts/lobby';

    mockResolveVersion.mockResolvedValue({
      versionId: 'vrs_v4_id',
      versionNumber: 4,
      doc: fakeVersionDoc('vrs_v4_id', {
        versionUrl: 'https://r2.test/v4.json',
        description: 'pre-prod build',
        totalFiles: 3,
        totalSize: 4096,
      }),
    });

    const res = await rollback({ siteId: SITE });
    nowSpy.mockRestore();

    expect(res.status).toBe(200);
    expect(txState.txDeletes).toHaveLength(0);
    expect(txState.rolloutSets).toHaveLength(1);
    expect(txState.rolloutSets[0]).toMatchObject({
      payload: expect.objectContaining({
        stage: 'complete',
        versionId: 'vrs_v4_id',
        versionUrl: 'https://r2.test/v4.json',
        extractRoot: '~/Owlette/roosts/lobby',
        canary: ['machine-a', 'machine-b'],
        fleet: [],
        pendingCommandsDispatched: true,
        rollback: true,
        rollbackFromVersionId: 'vrs_v5_id',
        rollbackBy: 'user-operator',
        rollbackNonce: 'loyw3v28',
      }),
      options: { merge: true },
    });

    const rollbackCmdId = `roost_rollback_${ROOST}_vrs_v4_id_loyw3v28`;
    const deterministicCmdId = `roost_sync_${ROOST}_vrs_v4_id`;
    const pendingWrites = mocks.batchSet.mock.calls
      .map((call) => call[1] as Record<string, unknown>)
      .filter((payload) => rollbackCmdId in payload);
    const completedClears = mocks.batchSet.mock.calls
      .map((call) => call[1] as Record<string, unknown>)
      .filter((payload) => !(rollbackCmdId in payload));

    expect(pendingWrites).toHaveLength(2);
    for (const payload of pendingWrites) {
      expect(Object.keys(payload)).toEqual([rollbackCmdId, deterministicCmdId]);
      expect(payload[rollbackCmdId]).toMatchObject({
        type: 'sync_pull',
        site_id: SITE,
        roost_id: ROOST,
        version_id: 'vrs_v4_id',
        version_url: 'https://r2.test/v4.json',
        extract_root: '~/Owlette/roosts/lobby',
        rollback: true,
        rollback_requested_by: 'user-operator',
      });
    }

    expect(completedClears).toHaveLength(2);
    for (const payload of completedClears) {
      expect(Object.keys(payload)).toEqual([deterministicCmdId]);
    }
    expect(mocks.batchDelete).toHaveBeenCalledTimes(2);
    expect(mocks.batchCommit).toHaveBeenCalledTimes(1);
  });

  it('explicit number target: targetVersion=3 flips to v3', async () => {
    txState.versionCounter = 5;
    txState.currentVersionId = 'vrs_v5_id';

    mockResolveVersion.mockResolvedValue({
      versionId: 'vrs_v3_id',
      versionNumber: 3,
      doc: fakeVersionDoc('vrs_v3_id', {
        versionUrl: 'https://r2.test/v3.json',
        description: null,
        totalFiles: 2,
        totalSize: 1024,
      }),
    });

    const res = await rollback({ siteId: SITE, targetVersion: 3 });
    expect(res.status).toBe(200);
    expect(res.body.currentVersionId).toBe('vrs_v3_id');
    expect(res.body.currentVersionNumber).toBe(3);
    expect(res.body.previousVersionId).toBe('vrs_v5_id');

    // Resolver receives the raw input as a string — server is the single
    // source of truth for ref grammar (numbers, '#3', 'v3', etc).
    expect(mockResolveVersion).toHaveBeenCalledWith({
      roostId: ROOST,
      siteId: SITE,
      ref: '3',
    });
  });

  it('explicit alias "first": resolves to v1', async () => {
    txState.versionCounter = 5;
    txState.currentVersionId = 'vrs_v5_id';

    mockResolveVersion.mockResolvedValue({
      versionId: 'vrs_v1_id',
      versionNumber: 1,
      doc: fakeVersionDoc('vrs_v1_id', {
        versionUrl: 'https://r2.test/v1.json',
        description: 'initial publish',
        totalFiles: 1,
        totalSize: 512,
      }),
    });

    const res = await rollback({ siteId: SITE, targetVersion: 'first' });
    expect(res.status).toBe(200);
    expect(res.body.currentVersionId).toBe('vrs_v1_id');
    expect(res.body.currentVersionNumber).toBe(1);
    expect(mockResolveVersion).toHaveBeenCalledWith({
      roostId: ROOST,
      siteId: SITE,
      ref: 'first',
    });
  });

  it('writes happen inside ONE transaction (atomic pointer flip)', async () => {
    txState.versionCounter = 2;
    txState.currentVersionId = 'vrs_v2_id';
    mockResolveVersion.mockResolvedValue({
      versionId: 'vrs_v1_id',
      versionNumber: 1,
      doc: fakeVersionDoc('vrs_v1_id', { versionUrl: 'u', totalFiles: 1, totalSize: 1 }),
    });
    await rollback({ siteId: SITE });
    expect(mockRunTransaction).toHaveBeenCalledTimes(1);
    expect(txState.roostUpdates).toHaveLength(1);
  });
});

// Error cases

describe('POST /rollback — error cases', () => {
  it('targetVersion="current" against the actual current version → 400 rollback_no_op', async () => {
    txState.versionCounter = 5;
    txState.currentVersionId = 'vrs_v5_id';
    mockResolveVersion.mockResolvedValue({
      versionId: 'vrs_v5_id',
      versionNumber: 5,
      doc: fakeVersionDoc('vrs_v5_id', { versionUrl: 'u', totalFiles: 1, totalSize: 1 }),
    });

    const res = await rollback({ siteId: SITE, targetVersion: 'current' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('rollback_no_op');
    // No firestore update should have landed even though tx ran.
    expect(txState.roostUpdates).toHaveLength(0);
  });

  it('targetVersion=non-existent vrs_* id → 404 version_not_found', async () => {
    txState.currentVersionId = 'vrs_v5_id';
    mockResolveVersion.mockRejectedValue(
      new VersionNotFoundError('version vrs_does_not_exist not found on roost rst_test'),
    );

    const res = await rollback({
      siteId: SITE,
      targetVersion: 'vrs_does_not_exist',
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('version_not_found');
    expect(mockRunTransaction).not.toHaveBeenCalled();
  });

  it('targetVersion=malformed string → 400 version_ref_malformed', async () => {
    mockResolveVersion.mockRejectedValue(
      new VersionRefMalformedError("versionRef 'not-a-thing' is malformed"),
    );

    const res = await rollback({ siteId: SITE, targetVersion: 'not-a-thing' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('version_ref_malformed');
    expect(mockRunTransaction).not.toHaveBeenCalled();
  });

  it('targetVersion=object → 400 validation, resolver never called', async () => {
    const res = await rollback({
      siteId: SITE,
      targetVersion: { not: 'a string or number' },
    });
    expect(res.status).toBe(400);
    expect(mockResolveVersion).not.toHaveBeenCalled();
    expect(mockRunTransaction).not.toHaveBeenCalled();
  });

  it('roost soft-deleted (deletedAt set) → 404', async () => {
    txState.exists = true;
    txState.deletedAt = new Date('2026-04-01T00:00:00Z');
    txState.currentVersionId = 'vrs_v5_id';
    mockResolveVersion.mockResolvedValue({
      versionId: 'vrs_v3_id',
      versionNumber: 3,
      doc: fakeVersionDoc('vrs_v3_id', { versionUrl: 'u', totalFiles: 1, totalSize: 1 }),
    });

    const res = await rollback({ siteId: SITE, targetVersion: 3 });
    expect(res.status).toBe(404);
    expect(txState.roostUpdates).toHaveLength(0);
  });

  it('roost not found → 404', async () => {
    txState.exists = false;
    mockResolveVersion.mockResolvedValue({
      versionId: 'vrs_v3_id',
      versionNumber: 3,
      doc: fakeVersionDoc('vrs_v3_id', { versionUrl: 'u', totalFiles: 1, totalSize: 1 }),
    });

    const res = await rollback({ siteId: SITE, targetVersion: 3 });
    expect(res.status).toBe(404);
    expect(txState.roostUpdates).toHaveLength(0);
  });

  it('read-only api key (no rollback scope) → 403 scope_insufficient', async () => {
    authedAsReadOnly();
    txState.currentVersionId = 'vrs_v5_id';

    const res = await rollback({ siteId: SITE, targetVersion: 3 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('scope_insufficient');
    // Auth is checked before the resolver runs — bail-fast prevents leaking
    // version existence to a caller that can't roll back anyway.
    expect(mockResolveVersion).not.toHaveBeenCalled();
    expect(mockRunTransaction).not.toHaveBeenCalled();
  });

  it('missing siteId in body → 400 validation', async () => {
    const res = await rollback({ targetVersion: 3 });
    expect(res.status).toBe(400);
    expect(mockResolveVersion).not.toHaveBeenCalled();
  });
});

// Sanity: ResolveVersionError subclasses round-trip via instanceof

describe('POST /rollback — error narrowing', () => {
  it('treats every ResolveVersionError as a 4xx with its own code (not a 500)', async () => {
    // A subclass that's not VersionNotFoundError / VersionRefMalformedError
    // should still map cleanly via the base-class check.
    class WeirdError extends ResolveVersionError {
      constructor() {
        super('something weird', 'version_weird', 400);
      }
    }
    mockResolveVersion.mockRejectedValue(new WeirdError());

    const res = await rollback({ siteId: SITE, targetVersion: 7 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('version_weird');
  });
});

// version.rolled_back webhook emission

describe('POST /rollback — version.rolled_back webhook', () => {
  const SIGNING_SECRET = 'whsec_' + 'a'.repeat(48);

  /** Delivery records written to `webhook_deliveries` by the emitter. */
  function deliveryWrites(): Array<Record<string, unknown>> {
    return mocks.set.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter(
        (payload) =>
          !!payload && typeof payload === 'object' && 'subscriptionId' in payload,
      );
  }

  function seedTargetVersion(): void {
    txState.versionCounter = 5;
    txState.currentVersionId = 'vrs_v5_id';
    txState.previousVersionId = 'vrs_v4_id';
    mockResolveVersion.mockResolvedValue({
      versionId: 'vrs_v4_id',
      versionNumber: 4,
      doc: fakeVersionDoc('vrs_v4_id', {
        versionUrl: 'https://r2.test/v4.json',
        description: 'pre-prod build',
        totalFiles: 3,
        totalSize: 4096,
      }),
    });
  }

  it('queues one signed delivery per subscribed webhook', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    seedTargetVersion();
    mocks.collectionGet.mockResolvedValue(
      querySnapshot([
        {
          id: 'wh_alpha',
          data: {
            url: 'https://hooks.example.test/roost',
            events: ['version.rolled_back'],
            signingSecret: SIGNING_SECRET,
            paused: false,
          },
        },
      ]),
    );

    const res = await rollback({ siteId: SITE });
    nowSpy.mockRestore();
    expect(res.status).toBe(200);

    // Subscriptions are looked up on the site, filtered by event name.
    expect(mocks.where).toHaveBeenCalledWith(
      'events',
      'array-contains',
      'version.rolled_back',
    );

    const writes = deliveryWrites();
    expect(writes).toHaveLength(1);
    const record = writes[0]!;
    expect(record).toMatchObject({
      subscriptionId: 'wh_alpha',
      siteId: SITE,
      url: 'https://hooks.example.test/roost',
      event: 'version.rolled_back',
      attempt: 0,
      state: 'pending',
      nextAttemptAt: 1_700_000_000_000,
      createdAt: 1_700_000_000_000,
      secret: SIGNING_SECRET,
    });

    // Record id is `<content-hash>__<subscriptionId>` so two subscribers
    // to the same event get separately-tracked deliveries.
    const headers = record.headers as Record<string, string>;
    expect(record.id).toBe(`${headers['Roost-Delivery']}__wh_alpha`);
    expect(headers['Roost-Event']).toBe('version.rolled_back');
    expect(headers['Content-Type']).toBe('application/json');

    // Envelope matches the dispatcher's production shape: no top-level
    // `id` (dedup rides the Roost-Delivery header), canonical key order.
    const canonicalBody = record.canonicalBody as string;
    expect(canonicalBody).toBe(
      JSON.stringify({
        data: {
          fromVersion: 'vrs_v5_id',
          roostId: ROOST,
          siteId: SITE,
          toVersion: 'vrs_v4_id',
          triggeredBy: 'user-operator',
        },
        event: 'version.rolled_back',
        occurredAt: new Date(1_700_000_000_000).toISOString(),
        siteId: SITE,
      }),
    );

    // The signature a receiver would verify actually verifies.
    expect(
      verifySignature(canonicalBody, SIGNING_SECRET, headers['Roost-Signature'], {
        nowMs: 1_700_000_000_000,
      }).ok,
    ).toBe(true);
  });

  it('skips paused, soft-deleted, and secret-less subscriptions', async () => {
    seedTargetVersion();
    mocks.collectionGet.mockResolvedValue(
      querySnapshot([
        {
          id: 'wh_paused',
          data: {
            url: 'https://hooks.example.test/paused',
            events: ['version.rolled_back'],
            signingSecret: SIGNING_SECRET,
            paused: true,
          },
        },
        {
          id: 'wh_deleted',
          data: {
            url: 'https://hooks.example.test/deleted',
            events: ['version.rolled_back'],
            signingSecret: SIGNING_SECRET,
            deletedAt: new Date('2026-01-01T00:00:00Z'),
          },
        },
        {
          id: 'wh_no_secret',
          data: {
            url: 'https://hooks.example.test/no-secret',
            events: ['version.rolled_back'],
          },
        },
        {
          id: 'wh_legacy',
          data: {
            url: 'https://hooks.example.test/legacy',
            events: ['version.rolled_back'],
            secret: 'legacy-secret-value',
            enabled: true,
          },
        },
      ]),
    );

    const res = await rollback({ siteId: SITE });
    expect(res.status).toBe(200);

    const writes = deliveryWrites();
    expect(writes).toHaveLength(1);
    // Pre-public-api records carry `secret`/`enabled` instead of
    // `signingSecret`/`paused` — both shapes are honored.
    expect(writes[0]).toMatchObject({
      subscriptionId: 'wh_legacy',
      secret: 'legacy-secret-value',
    });
  });

  it('writes nothing when the site has no matching subscription', async () => {
    seedTargetVersion();
    const res = await rollback({ siteId: SITE });
    expect(res.status).toBe(200);
    expect(deliveryWrites()).toHaveLength(0);
  });

  it('still returns 200 when the delivery store is unavailable', async () => {
    seedTargetVersion();
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mocks.collectionGet.mockRejectedValue(new Error('firestore unavailable'));

    const res = await rollback({ siteId: SITE });
    expect(res.status).toBe(200);
    expect(res.body.currentVersionId).toBe('vrs_v4_id');
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('[roostWebhooks]'),
    );
    errSpy.mockRestore();
  });

  it('does not emit when the rollback itself is rejected', async () => {
    txState.versionCounter = 5;
    txState.currentVersionId = 'vrs_v5_id';
    mockResolveVersion.mockResolvedValue({
      versionId: 'vrs_v5_id',
      versionNumber: 5,
      doc: fakeVersionDoc('vrs_v5_id', { versionUrl: 'u', totalFiles: 1, totalSize: 1 }),
    });

    const res = await rollback({ siteId: SITE, targetVersion: 'current' });
    expect(res.status).toBe(400);
    expect(deliveryWrites()).toHaveLength(0);
  });
});

// billing gate — rollback is pro-only (wave 0.6)
