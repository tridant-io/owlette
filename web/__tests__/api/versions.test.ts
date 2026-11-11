/** @jest-environment node */

import { createMockRequest } from './helpers/utils';
import {
  mocks,
  docSnapshot,
  querySnapshot,
  seedMember
} from './helpers/firestore-mock';
import { verifySignature } from '@/lib/webhookSignature';

const mockEmitMutation = jest.fn();

function mockBuildCollection(
  path = '',
  parent: Record<string, unknown> | null = null,
): Record<string, unknown> {
  const parts = path.split('/').filter(Boolean);
  const collection: Record<string, unknown> = {
    __path: path,
    id: parts[parts.length - 1] ?? path,
    parent,
    orderBy: mocks.orderBy,
    limit: mocks.limit,
    startAfter: mocks.startAfter,
    where: mocks.where,
    get: mocks.collectionGet,
  };
  collection.doc = (id = 'auto') => mockBuildDoc(`${path}/${id}`, collection);
  return collection;
}

function mockBuildDoc(
  path: string,
  parent: Record<string, unknown> | null,
): Record<string, unknown> {
  const parts = path.split('/').filter(Boolean);
  const ref: Record<string, unknown> = {
    __path: path,
    id: parts[parts.length - 1] ?? path,
    parent,
    get: () => {
      if (parts.length === 2 && parts[0] === 'sites') {
        if (mocks.siteDocs.has(parts[1])) {
          return Promise.resolve(docSnapshot(parts[1], mocks.siteDocs.get(parts[1]) ?? null));
        }
        return Promise.resolve(docSnapshot(parts[1], {}));
      }
      // Same two interceptions as helpers/firestore-mock: membership and the
      // user document are path-addressed so the authorization reads do not
      // consume documents this suite staged on the `mocks.get` queue.
      if (parts.length === 4 && parts[0] === 'sites' && parts[2] === 'members') {
        const key = `${parts[1]}/${parts[3]}`;
        return Promise.resolve(docSnapshot(parts[3], mocks.memberDocs.get(key) ?? null));
      }
      if (parts.length === 2 && parts[0] === 'users' && mocks.userDocs.has(parts[1])) {
        return Promise.resolve(docSnapshot(parts[1], mocks.userDocs.get(parts[1]) ?? null));
      }
      return mocks.get();
    },
    set: mocks.set,
    update: mocks.update,
    delete: mocks.del,
  };
  ref.collection = (sub: string) => mockBuildCollection(`${path}/${sub}`, ref);
  return ref;
}

function mockPathDbFactory(): Record<string, unknown> {
  return {
    collection: (name: string) => mockBuildCollection(name),
    batch: () => ({
      set: mocks.batchSet,
      delete: mocks.batchDelete,
      commit: mocks.batchCommit,
    }),
    // Order-preserving batched read, as `lib/roostWebhooks.server.ts` relies on
    // when it zips per-subscription secrets against its candidate list.
    getAll: (...refs: Array<{ get: () => Promise<unknown> }>) =>
      Promise.all(refs.map((ref) => ref.get())),
  };
}

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

// Shared across mock-tx invocations: lets two sequential publishes against the
// same roost be simulated without a real Firestore.
const txState = {
  versionCounter: 0,
  currentVersionId: null as string | null,
  previousVersionId: null as string | null,
  /** Captured `tx.set(versionRef, ...)` payloads, in call order. */
  versionWrites: [] as Array<Record<string, unknown>>,
  /** Captured `tx.set(roostRef, ...)` payloads, in call order. */
  roostWrites: [] as Array<Record<string, unknown>>,
  /** Stored version docs keyed by versionId for transaction reads. */
  versionDocs: new Map<string, Record<string, unknown>>(),
};

function isVersionDocWrite(payload: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(payload, 'versionId');
}

function transactionSnapshotFor(
  ref: unknown,
  roostData: Record<string, unknown>,
): ReturnType<typeof docSnapshot> {
  const path =
    typeof (ref as { __path?: unknown }).__path === 'string'
      ? ((ref as { __path: string }).__path)
      : '';
  if (path.includes('/versions/')) {
    const versionId = path.split('/').filter(Boolean).pop() ?? 'version';
    return docSnapshot(versionId, txState.versionDocs.get(versionId) ?? null);
  }
  return docSnapshot('rst_test', roostData);
}

const mockRunTransaction = jest.fn(
  async (cb: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
    const tx = {
      get: async (ref: unknown) =>
        transactionSnapshotFor(ref, {
          versionCounter: txState.versionCounter,
          currentVersionId: txState.currentVersionId,
          previousVersionId: txState.previousVersionId,
          name: 'lobby roost',
          targets: [],
        }),
      set: jest.fn((_ref: unknown, payload: Record<string, unknown>) => {
        if (isVersionDocWrite(payload)) {
          txState.versionWrites.push(payload);
          if (typeof payload.versionId === 'string') {
            txState.versionDocs.set(payload.versionId, { ...payload });
          }
        } else {
          txState.roostWrites.push(payload);
        }
      }),
      update: jest.fn(),
    };
    const result = await cb(tx);
    return result;
  },
);

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => {
    const base = mockPathDbFactory() as Record<string, unknown>;
    return { ...base, runTransaction: mockRunTransaction };
  },
  getAdminAuth: () => ({ verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')) }),
}));

// All chunks present, and no signed-url call reaches a real bucket.
jest.mock('@/lib/r2Client.server', () => ({
  hasChunk: jest.fn().mockResolvedValue(true),
  bucketFor: jest.fn(() => 'test-bucket'),
  currentEnv: jest.fn(() => 'test'),
  versionKey: jest.fn((roostId: string, vid: string) => `project-manifests/${roostId}/${vid}`),
  putVersionBody: jest.fn().mockResolvedValue(undefined),
  presignGetVersion: jest.fn().mockResolvedValue('https://r2.test/version-url'),
  getVersionBody: jest.fn().mockResolvedValue({ ok: false }),
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

import { POST as createPOST } from '@/app/api/roosts/[roostId]/versions/route';
import { PATCH as patchVersion } from '@/app/api/roosts/[roostId]/versions/[versionRef]/route';

const SITE = 'site-alpha';
const ROOST = 'rst_test_0000000001';
const CHUNK_HASH = 'a'.repeat(64);

function buildVersionEnvelope(hash = CHUNK_HASH): Record<string, unknown> {
  // Minimal body that passes the route's validation: schemaVersion, mediaType,
  // config object, non-empty files[] each with a 64-hex hash and positive size.
  return {
    schemaVersion: 2,
    mediaType: 'application/vnd.owlette.version.v1+json',
    config: {},
    files: [
      {
        path: 'main.toe',
        size: 4,
        chunks: [{ hash, size: 4 }],
      },
    ],
  };
}

function authed() {
  mockResolveAuth.mockResolvedValue({ userId: 'user-1', keyContext: null });
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
  mocks.get.mockResolvedValue(docSnapshot('user-1', {
    role: 'admin',
    sites: [SITE],
  }));
  txState.versionCounter = 0;
  txState.currentVersionId = null;
  txState.previousVersionId = null;
  txState.versionWrites.length = 0;
  txState.roostWrites.length = 0;
  txState.versionDocs.clear();
  mocks.set.mockResolvedValue(undefined);
  mocks.update.mockResolvedValue(undefined);
  // no webhook subscriptions unless a test seeds some
  mocks.collectionGet.mockResolvedValue(querySnapshot([]));
});

// POST /api/roosts/{id}/versions — monotonic versionNumber

describe('POST /versions — version-number monotonicity', () => {
  async function publish(
    hash = CHUNK_HASH,
    fields: Record<string, unknown> = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const req = createMockRequest(`http://localhost/api/roosts/${ROOST}/versions`, {
      method: 'POST',
      body: { siteId: SITE, version: buildVersionEnvelope(hash), ...fields },
    });
    const res = await createPOST(req, { params: Promise.resolve({ roostId: ROOST }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('first publish lands as versionNumber=1 with versionCounter=1 on roost', async () => {
    const res = await publish();
    expect(res.status).toBe(201);
    expect(res.body.versionNumber).toBe(1);
    expect(txState.versionWrites[0]!.versionNumber).toBe(1);
    expect(txState.roostWrites[0]!.versionCounter).toBe(1);
    expect(txState.roostWrites[0]!.currentVersionNumber).toBe(1);
    expect(mocks.batchSet).toHaveBeenCalledWith(
      expect.objectContaining({}),
      expect.objectContaining({
        digest: CHUNK_HASH,
        source: 'version',
        roostId: ROOST,
        versionId: res.body.versionId,
        versionNumber: 1,
        fileCount: 1,
        pathCount: 1,
        totalBytes: 4,
        createdBy: 'user-1',
      }),
      { merge: true },
    );
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'roost_mutated',
        siteId: SITE,
        actor: 'user:user-1',
        targetId: res.body.versionId,
        attributes: expect.objectContaining({
          verb: 'version_publish',
          endpoint: `/api/roosts/${ROOST}/versions`,
          method: 'POST',
          roostId: ROOST,
          versionNumber: 1,
          previousVersionId: null,
          totalFiles: 1,
          totalSize: 4,
        }),
      }),
    );
  });

  it('two sequential publishes yield monotonic 1 → 2 (no collision, no gap)', async () => {
    const r1 = await publish();
    expect(r1.body.versionNumber).toBe(1);

    // Simulate the post-tx state for the next publish.
    txState.versionCounter = 1;
    txState.previousVersionId = txState.currentVersionId;
    txState.currentVersionId = String(r1.body.versionId);

    const r2 = await publish('b'.repeat(64));
    expect(r2.body.versionNumber).toBe(2);
    expect(txState.versionWrites[1]!.versionNumber).toBe(2);
    expect(txState.roostWrites[1]!.versionCounter).toBe(2);
  });

  it('three publishes in a row stay monotonic 1, 2, 3', async () => {
    for (const n of [1, 2, 3]) {
      const r = await publish(String.fromCharCode(96 + n).repeat(64));
      expect(r.body.versionNumber).toBe(n);
      txState.versionCounter = n;
      txState.previousVersionId = txState.currentVersionId;
      txState.currentVersionId = String(r.body.versionId);
    }
    expect(txState.versionWrites.map((v) => v.versionNumber)).toEqual([1, 2, 3]);
    expect(txState.roostWrites.map((v) => v.versionCounter)).toEqual([1, 2, 3]);
  });

  it('the version doc + roost doc are written in the SAME transaction', async () => {
    // Both `tx.set` calls happen in the SAME runTransaction callback.
    await publish();
    expect(mockRunTransaction).toHaveBeenCalledTimes(1);
    expect(txState.versionWrites).toHaveLength(1);
    expect(txState.roostWrites).toHaveLength(1);
  });

  /**
   * Concurrent publish race: two parallel publishes must serialize via
   * Firestore's optimistic CAS — counter ends at exactly 2, both callers get
   * distinct monotonic versionNumbers. mockRunTransaction has no retry
   * simulation, so this test patches in a CAS guard that re-runs the loser.
   */
  it('two parallel publishes serialize: counter goes 0→2 exactly once each', async () => {
    // CAS-aware runTransaction: read txState at entry, gate the commit on the
    // version being unchanged at commit time.
    mockRunTransaction.mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const versionCounterAtRead = txState.versionCounter;
          const currentAtRead = txState.currentVersionId;
          const previousAtRead = txState.previousVersionId;
          const pendingVersionWrites: Array<Record<string, unknown>> = [];
          const pendingRoostWrites: Array<Record<string, unknown>> = [];
          const tx = {
            get: async (ref: unknown) =>
              transactionSnapshotFor(ref, {
                versionCounter: versionCounterAtRead,
                currentVersionId: currentAtRead,
                previousVersionId: previousAtRead,
                name: 'lobby roost',
                targets: [],
              }),
            set: jest.fn(
              (_ref: unknown, payload: Record<string, unknown>) => {
                if (isVersionDocWrite(payload)) {
                  pendingVersionWrites.push(payload);
                } else {
                  pendingRoostWrites.push(payload);
                }
              },
            ),
            update: jest.fn(),
          };
          const result = await cb(tx);
          // Commit only if txState.versionCounter has not moved since entry.
          if (txState.versionCounter === versionCounterAtRead) {
            for (const w of pendingVersionWrites) {
              txState.versionWrites.push(w);
              if (typeof w.versionId === 'string') {
                txState.versionDocs.set(w.versionId, { ...w });
              }
            }
            for (const w of pendingRoostWrites) {
              txState.roostWrites.push(w);
              if (typeof w.versionCounter === 'number') {
                txState.versionCounter = w.versionCounter as number;
              }
              if (typeof w.currentVersionId === 'string') {
                txState.previousVersionId = txState.currentVersionId;
                txState.currentVersionId = w.currentVersionId as string;
              }
            }
            return result;
          }
          // Stale — re-run.
        }
        throw new Error('runTransaction failed after 3 attempts');
      },
    );

    const [a, b] = await Promise.all([
      publish('a'.repeat(64)),
      publish('b'.repeat(64)),
    ]);

    // Both publishes must succeed (the loser is retried internally).
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    // versionNumber must be distinct and monotonic.
    const numbers = [a.body.versionNumber, b.body.versionNumber].sort();
    expect(numbers).toEqual([1, 2]);

    // Exactly 2: 1 would mean one commit overwrote the other.
    expect(txState.versionCounter).toBe(2);

    // Two writes to each side of the transaction (one per publish).
    expect(txState.versionWrites).toHaveLength(2);
    expect(txState.roostWrites).toHaveLength(2);
  });

  it('identical content already at head is a no-op, not a new version number', async () => {
    const first = await publish();
    expect(first.status).toBe(201);
    expect(first.body.versionNumber).toBe(1);

    txState.versionCounter = 1;
    txState.previousVersionId = null;
    txState.currentVersionId = String(first.body.versionId);
    mockEmitMutation.mockClear();
    mocks.batchSet.mockClear();

    const second = await publish();

    expect(second.status).toBe(200);
    expect(second.body.versionId).toBe(first.body.versionId);
    expect(second.body.versionNumber).toBe(1);
    expect(second.body.previousVersionId).toBeNull();
    expect(txState.versionWrites).toHaveLength(1);
    expect(txState.roostWrites).toHaveLength(1);
    expect(mockEmitMutation).not.toHaveBeenCalled();
    expect(mocks.batchSet).not.toHaveBeenCalled();
  });

  it('same content at head still applies explicitly-provided deploy config (no version bump)', async () => {
    // Regression for the silent-target-drop bug: republishing identical bytes
    // that are already the head must still honor a changed target/name set.
    const first = await publish();
    expect(first.status).toBe(201);

    txState.versionCounter = 1;
    txState.previousVersionId = null;
    txState.currentVersionId = String(first.body.versionId);
    const roostWritesBefore = txState.roostWrites.length;
    const versionWritesBefore = txState.versionWrites.length;
    mockEmitMutation.mockClear();

    const second = await publish(undefined, { targets: ['machine-7'], name: 'lobby v2' });

    // Still a versioning no-op: same version, no counter bump, no new version doc.
    expect(second.status).toBe(200);
    expect(second.body.versionId).toBe(first.body.versionId);
    expect(second.body.versionNumber).toBe(1);
    expect(txState.versionWrites).toHaveLength(versionWritesBefore);

    // ...but the roost doc was updated with the restated config.
    expect(txState.roostWrites).toHaveLength(roostWritesBefore + 1);
    const w = txState.roostWrites[txState.roostWrites.length - 1]!;
    expect(w.targets).toEqual(['machine-7']);
    expect(w.name).toBe('lobby v2');
    expect(w).not.toHaveProperty('versionCounter');
    expect(w).not.toHaveProperty('versionId');

    // ...and the config update is audited (verb=config_update), not silent.
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'roost_mutated',
        attributes: expect.objectContaining({ verb: 'config_update' }),
      }),
    );
  });

  async function publishTwoVersionHistory(): Promise<{
    v1: { status: number; body: Record<string, unknown> };
    v2: { status: number; body: Record<string, unknown> };
  }> {
    const v1 = await publish('a'.repeat(64));
    txState.versionCounter = 1;
    txState.previousVersionId = null;
    txState.currentVersionId = String(v1.body.versionId);

    const v2 = await publish('b'.repeat(64));
    txState.versionCounter = 2;
    txState.previousVersionId = String(v1.body.versionId);
    txState.currentVersionId = String(v2.body.versionId);

    return { v1, v2 };
  }

  it('promotes an existing non-current version without rewriting history', async () => {
    const { v1, v2 } = await publishTwoVersionHistory();
    expect(v1.status).toBe(201);
    expect(v2.status).toBe(201);

    mockEmitMutation.mockClear();
    mocks.batchSet.mockClear();
    const versionWriteCount = txState.versionWrites.length;
    const versionDocCount = txState.versionDocs.size;

    const promoted = await publish('a'.repeat(64), {
      name: 'promoted lobby',
      targets: ['machine-1'],
      extractPath: 'show/scene',
    });

    expect(promoted.status).toBe(200);
    expect(promoted.body.versionId).toBe(v1.body.versionId);
    expect(promoted.body.versionNumber).toBe(1);
    expect(promoted.body.currentVersionId).toBe(v1.body.versionId);
    expect(promoted.body.previousVersionId).toBe(v2.body.versionId);

    expect(txState.versionWrites).toHaveLength(versionWriteCount);
    expect(txState.versionDocs.size).toBe(versionDocCount);
    expect(txState.versionDocs.get(String(v1.body.versionId))!.versionNumber).toBe(1);
    expect(txState.versionCounter).toBe(2);

    const roostWrite = txState.roostWrites[txState.roostWrites.length - 1]!;
    expect(roostWrite.currentVersionId).toBe(v1.body.versionId);
    expect(roostWrite.previousVersionId).toBe(v2.body.versionId);
    expect(roostWrite.currentVersionNumber).toBe(1);
    expect(roostWrite).not.toHaveProperty('versionCounter');
    expect(roostWrite.name).toBe('promoted lobby');
    expect(roostWrite.targets).toEqual(['machine-1']);
    expect(roostWrite.extractPath).toBe('show/scene');

    expect(mocks.batchSet).not.toHaveBeenCalled();
    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'roost_mutated',
        siteId: SITE,
        targetId: v1.body.versionId,
        attributes: expect.objectContaining({
          verb: 'version_promote',
          roostId: ROOST,
          versionNumber: 1,
          previousVersionId: v2.body.versionId,
        }),
      }),
    );
  });

  it('promote respects expectedCurrentVersionId CAS', async () => {
    const { v1 } = await publishTwoVersionHistory();

    mockEmitMutation.mockClear();
    mocks.batchSet.mockClear();
    const versionWriteCount = txState.versionWrites.length;
    const roostWriteCount = txState.roostWrites.length;

    const stale = await publish('a'.repeat(64), {
      expectedCurrentVersionId: v1.body.versionId,
    });

    expect(stale.status).toBe(412);
    expect(stale.body.code).toBe('version_stale');
    expect(txState.versionWrites).toHaveLength(versionWriteCount);
    expect(txState.roostWrites).toHaveLength(roostWriteCount);
    expect(mocks.batchSet).not.toHaveBeenCalled();
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });
});

// POST /versions - expectedCurrentVersionId CAS

describe('POST /versions - expectedCurrentVersionId CAS', () => {
  async function publish(
    fields: Record<string, unknown> = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const req = createMockRequest(`http://localhost/api/roosts/${ROOST}/versions`, {
      method: 'POST',
      body: { siteId: SITE, version: buildVersionEnvelope(), ...fields },
    });
    const res = await createPOST(req, { params: Promise.resolve({ roostId: ROOST }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('accepts explicit null when the roost is still empty', async () => {
    const res = await publish({ expectedCurrentVersionId: null });

    expect(res.status).toBe(201);
    expect(res.body.previousVersionId).toBeNull();
    expect(txState.versionWrites).toHaveLength(1);
    expect(txState.roostWrites).toHaveLength(1);
  });

  it('rejects explicit null when a head already exists', async () => {
    txState.versionCounter = 3;
    txState.currentVersionId = 'vrs_existing';

    const res = await publish({ expectedCurrentVersionId: null });

    expect(res.status).toBe(412);
    expect(res.body.code).toBe('version_stale');
    expect(txState.versionWrites).toHaveLength(0);
    expect(txState.roostWrites).toHaveLength(0);
  });

  it('skips CAS when expectedCurrentVersionId is absent', async () => {
    txState.versionCounter = 3;
    txState.currentVersionId = 'vrs_existing';

    const res = await publish();

    expect(res.status).toBe(201);
    expect(txState.versionWrites[0]!.parentVersionId).toBe('vrs_existing');
    expect(txState.roostWrites[0]!.previousVersionId).toBe('vrs_existing');
  });

  it('rejects a config-only republish-at-head when expectedCurrentVersionId is stale', async () => {
    // The no-op branch must still honor CAS, not slip past on a stale head.
    const first = await publish();
    expect(first.status).toBe(201);
    txState.versionCounter = 1;
    txState.currentVersionId = String(first.body.versionId);
    const roostWritesBefore = txState.roostWrites.length;

    const res = await publish({ expectedCurrentVersionId: 'vrs_stale', targets: ['machine-9'] });

    expect(res.status).toBe(412);
    expect(res.body.code).toBe('version_stale');
    // No config write slipped through the CAS guard.
    expect(txState.roostWrites).toHaveLength(roostWritesBefore);
  });

  it('rejects non-string non-null expectedCurrentVersionId', async () => {
    const res = await publish({ expectedCurrentVersionId: 123 });

    expect(res.status).toBe(400);
    expect(mockRunTransaction).not.toHaveBeenCalled();
  });
});

// POST /versions — description round-trip + 500-char cap

describe('POST /versions — description field', () => {
  async function publishWith(description: unknown): Promise<{
    status: number;
    body: Record<string, unknown>;
  }> {
    const req = createMockRequest(`http://localhost/api/roosts/${ROOST}/versions`, {
      method: 'POST',
      body: { siteId: SITE, version: buildVersionEnvelope(), description },
    });
    const res = await createPOST(req, { params: Promise.resolve({ roostId: ROOST }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('description round-trips: provided string lands on the version doc', async () => {
    const desc = 'fixed broken lobby video';
    const res = await publishWith(desc);
    expect(res.status).toBe(201);
    expect(txState.versionWrites[0]!.description).toBe(desc);
    expect(txState.roostWrites[0]!.currentVersionDescription).toBe(desc);
  });

  it('description omitted → stored as null on version doc', async () => {
    const req = createMockRequest(`http://localhost/api/roosts/${ROOST}/versions`, {
      method: 'POST',
      body: { siteId: SITE, version: buildVersionEnvelope() }, // no description field
    });
    const res = await createPOST(req, { params: Promise.resolve({ roostId: ROOST }) });
    expect(res.status).toBe(201);
    expect(txState.versionWrites[0]!.description).toBeNull();
  });

  it('description as whitespace-only → stored as null (normalised)', async () => {
    const res = await publishWith('   \n\t  ');
    expect(res.status).toBe(201);
    expect(txState.versionWrites[0]!.description).toBeNull();
  });

  it('description over 500 chars → 400 validation error, no transaction runs', async () => {
    const tooLong = 'x'.repeat(501);
    const res = await publishWith(tooLong);
    expect(res.status).toBe(400);
    expect(mockRunTransaction).not.toHaveBeenCalled();
  });

  it('description exactly 500 chars → accepted', async () => {
    const exact = 'y'.repeat(500);
    const res = await publishWith(exact);
    expect(res.status).toBe(201);
    expect((txState.versionWrites[0]!.description as string).length).toBe(500);
  });

  it('description as a non-string → 400 validation error', async () => {
    const res = await publishWith({ not: 'a string' });
    expect(res.status).toBe(400);
    expect(mockRunTransaction).not.toHaveBeenCalled();
  });
});

// PATCH /versions/{ref} — description edit + immutability guard

describe('PATCH /versions/{ref} — description edit', () => {
  async function patch(body: Record<string, unknown>): Promise<{
    status: number;
    body: Record<string, unknown>;
  }> {
    const req = createMockRequest(
      `http://localhost/api/roosts/${ROOST}/versions/vrs_target_001`,
      { method: 'PATCH', body },
    );
    const res = await patchVersion(req, {
      params: Promise.resolve({ roostId: ROOST, versionRef: 'vrs_target_001' }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('updates description; non-description fields rejected with version_content_immutable', async () => {
    const res = await patch({ siteId: SITE, files: [{ path: 'malicious.toe' }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('version_content_immutable');
  });

  it('rejects PATCH with no description field (description is required)', async () => {
    const res = await patch({ siteId: SITE });
    expect(res.status).toBe(400);
  });

  it('description over 500 chars → 400, no firestore write', async () => {
    const res = await patch({ siteId: SITE, description: 'z'.repeat(501) });
    expect(res.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('PATCH with sibling field like manifestId (the old name) is rejected', async () => {
    // A caller using the pre-rename field name must be told it is immutable,
    // not silently accepted.
    const res = await patch({ siteId: SITE, manifestId: 'old_name' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('version_content_immutable');
  });
});

// POST /versions — version.published webhook

describe('POST /versions — version.published webhook', () => {
  const SIGNING_SECRET = 'whsec_' + 'b'.repeat(48);

  /** Delivery records written to `webhook_deliveries` by the emitter. */
  function deliveryWrites(): Array<Record<string, unknown>> {
    return mocks.set.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter(
        (payload) =>
          !!payload && typeof payload === 'object' && 'subscriptionId' in payload,
      );
  }

  function seedSubscription(): void {
    mocks.collectionGet.mockResolvedValue(
      querySnapshot([
        {
          id: 'wh_alpha',
          data: {
            url: 'https://hooks.example.test/roost',
            events: ['version.published'],
            signingSecret: SIGNING_SECRET,
            paused: false,
          },
        },
      ]),
    );
  }

  async function publish(
    hash = CHUNK_HASH,
    fields: Record<string, unknown> = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const req = createMockRequest(`http://localhost/api/roosts/${ROOST}/versions`, {
      method: 'POST',
      body: { siteId: SITE, version: buildVersionEnvelope(hash), ...fields },
    });
    const res = await createPOST(req, { params: Promise.resolve({ roostId: ROOST }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('queues one signed delivery per subscribed webhook on a fresh publish', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    seedSubscription();

    const res = await publish(CHUNK_HASH, { description: 'fixed broken lobby video' });
    nowSpy.mockRestore();
    expect(res.status).toBe(201);

    // Subscriptions are looked up on the site, filtered by event name.
    expect(mocks.where).toHaveBeenCalledWith(
      'events',
      'array-contains',
      'version.published',
    );

    const writes = deliveryWrites();
    expect(writes).toHaveLength(1);
    const record = writes[0]!;
    expect(record).toMatchObject({
      subscriptionId: 'wh_alpha',
      siteId: SITE,
      url: 'https://hooks.example.test/roost',
      event: 'version.published',
      attempt: 0,
      state: 'pending',
      nextAttemptAt: 1_700_000_000_000,
      createdAt: 1_700_000_000_000,
      secret: SIGNING_SECRET,
    });

    const headers = record.headers as Record<string, string>;
    expect(record.id).toBe(`${headers['Roost-Delivery']}__wh_alpha`);
    expect(headers['Roost-Event']).toBe('version.published');

    // Envelope matches the documented event body (docs/api/webhooks.mdx) in the
    // dispatcher's canonical key order.
    const canonicalBody = record.canonicalBody as string;
    expect(canonicalBody).toBe(
      JSON.stringify({
        data: {
          createdBy: 'user-1',
          description: 'fixed broken lobby video',
          roostId: ROOST,
          siteId: SITE,
          totalFiles: 1,
          totalSize: 4,
          versionId: res.body.versionId,
          versionNumber: 1,
        },
        event: 'version.published',
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

  it('writes nothing when the site has no matching subscription', async () => {
    const res = await publish();
    expect(res.status).toBe(201);
    expect(deliveryWrites()).toHaveLength(0);
  });

  it('does not emit when the finalize is rejected on a stale expected head', async () => {
    seedSubscription();
    txState.versionCounter = 3;
    txState.currentVersionId = 'vrs_existing';

    const res = await publish(CHUNK_HASH, { expectedCurrentVersionId: 'vrs_stale' });

    expect(res.status).toBe(412);
    expect(res.body.code).toBe('version_stale');
    expect(deliveryWrites()).toHaveLength(0);
  });

  it('does not emit when the body fails validation', async () => {
    seedSubscription();
    const req = createMockRequest(`http://localhost/api/roosts/${ROOST}/versions`, {
      method: 'POST',
      body: { siteId: SITE, version: { schemaVersion: 1 } },
    });
    const res = await createPOST(req, { params: Promise.resolve({ roostId: ROOST }) });

    expect(res.status).toBe(400);
    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(deliveryWrites()).toHaveLength(0);
  });

  it('does not emit for a no-op republish of the bytes already at head', async () => {
    const first = await publish();
    expect(first.status).toBe(201);

    txState.versionCounter = 1;
    txState.currentVersionId = String(first.body.versionId);
    seedSubscription();
    mocks.set.mockClear();

    const second = await publish();

    expect(second.status).toBe(200);
    expect(deliveryWrites()).toHaveLength(0);
  });

  it('does not emit for a promote — the version was published earlier', async () => {
    const v1 = await publish('a'.repeat(64));
    txState.versionCounter = 1;
    txState.currentVersionId = String(v1.body.versionId);

    const v2 = await publish('b'.repeat(64));
    txState.versionCounter = 2;
    txState.previousVersionId = String(v1.body.versionId);
    txState.currentVersionId = String(v2.body.versionId);

    seedSubscription();
    mocks.set.mockClear();

    const promoted = await publish('a'.repeat(64));

    expect(promoted.status).toBe(200);
    expect(promoted.body.versionId).toBe(v1.body.versionId);
    expect(deliveryWrites()).toHaveLength(0);
  });

  it('still returns 201 when the delivery store is unavailable', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mocks.collectionGet.mockRejectedValue(new Error('firestore unavailable'));

    const res = await publish();

    expect(res.status).toBe(201);
    expect(res.body.versionNumber).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[roostWebhooks]'));
    errSpy.mockRestore();
  });
});

// billing gate — publishing is pro-only (wave 0.6)
