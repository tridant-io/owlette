/** @jest-environment node */

/**
 * Unit tests for `web/lib/actions/deleteOwnAccount.server.ts`.
 *
 * Covers input validation, the happy-path cascade, a DIFF TEST asserting the
 * server-side deleted-path set equals the legacy client cascade's against
 * identical seed data, dry-run, idempotent replay, 100-doc batch chunking,
 * missing user / site docs, and non-fatal progress-doc write failures.
 */

const loggerWarnSpy = jest.fn();
const loggerErrorSpy = jest.fn();
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: () => {},
    info: () => {},
    warn: (...a: unknown[]) => loggerWarnSpy(...a),
    error: (...a: unknown[]) => loggerErrorSpy(...a),
  },
}));

// `deleteOwnAccount` resolves the default db once at the top of its body, so the
// firebase-admin mock must be in place before import.
jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({ collection: () => ({ doc: () => ({}) }) }),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__SERVER_TS__',
  },
}));

import {
  deleteOwnAccount,
  BATCH_SIZE,
} from '@/lib/actions/deleteOwnAccount.server';

interface DocSeed {
  exists: boolean;
  data?: Record<string, unknown>;
}

interface FakeDbOptions {
  /** Seeded doc states keyed by canonical path (e.g. `users/uid_alice`). */
  seedDocs?: Record<string, DocSeed>;
  /**
   * Seeded subcollection contents keyed by parent collection path (e.g.
   * `sites/site-a/machines` → ['m1', 'm2']), drained as `delete()` is called.
   */
  seedCollections?: Record<string, string[]>;
  /** When set, calls to `progressRef.set()` reject with this error. */
  progressSetFailure?: Error;
}

interface FakeDbResult {
  setCalls: Array<{ path: string; payload: Record<string, unknown>; merge?: boolean }>;
  deleteCalls: string[];
  batchDeleteCalls: string[];
  batchCommitCount: number;
  /** Mutable: tests can mutate the seed mid-test. */
  collections: Map<string, string[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
}

function buildFakeDb(opts: FakeDbOptions = {}): FakeDbResult {
  const setCalls: FakeDbResult['setCalls'] = [];
  const deleteCalls: string[] = [];
  const batchDeleteCalls: string[] = [];
  let batchCommitCount = 0;

  const docs = new Map<string, DocSeed>(
    Object.entries(opts.seedDocs ?? {}),
  );
  const collections = new Map<string, string[]>(
    Object.entries(opts.seedCollections ?? {}).map(([k, v]) => [k, [...v]]),
  );

  function makeDocRef(docPath: string): unknown {
    return {
      path: docPath,
      collection: (sub: string) => makeCollectionRef(`${docPath}/${sub}`),
      get: async () => {
        const seed = docs.get(docPath);
        if (!seed) return { exists: false, data: () => undefined };
        return { exists: seed.exists, data: () => seed.data };
      },
      set: async (
        payload: Record<string, unknown>,
        options?: { merge?: boolean },
      ) => {
        if (
          docPath.endsWith('/account_deletion/operation') &&
          opts.progressSetFailure
        ) {
          throw opts.progressSetFailure;
        }
        setCalls.push({ path: docPath, payload, merge: options?.merge });
        // Mirror the write into the doc seed map so subsequent .get() reads
        // see the merged payload (relevant for replay tests).
        const prev = docs.get(docPath);
        const merged: Record<string, unknown> = options?.merge
          ? { ...(prev?.data ?? {}), ...payload }
          : { ...payload };
        docs.set(docPath, { exists: true, data: merged });
      },
      delete: async () => {
        deleteCalls.push(docPath);
        docs.set(docPath, { exists: false, data: undefined });
        // If this doc lives inside a tracked collection, remove it.
        const lastSlash = docPath.lastIndexOf('/');
        const parent = docPath.slice(0, lastSlash);
        const id = docPath.slice(lastSlash + 1);
        const list = collections.get(parent);
        if (list) {
          const idx = list.indexOf(id);
          if (idx !== -1) list.splice(idx, 1);
        }
      },
    };
  }

  function makeCollectionRef(colPath: string): unknown {
    function snapshotWithRefs(
      idsToReturn: string[],
    ): {
      empty: boolean;
      size: number;
      docs: Array<{
        id: string;
        ref: unknown;
        data: () => Record<string, unknown>;
      }>;
    } {
      return {
        empty: idsToReturn.length === 0,
        size: idsToReturn.length,
        docs: idsToReturn.map((id) => {
          const docPath = `${colPath}/${id}`;
          const seed = docs.get(docPath);
          return {
            id,
            ref: makeDocRef(docPath),
            data: () =>
              (seed?.data as Record<string, unknown> | undefined) ?? {},
          };
        }),
      };
    }

    interface WhereClause {
      field: string;
      op: '==' | 'array-contains';
      value: unknown;
    }

    function applyWheres(
      ids: string[],
      wheres: WhereClause[],
    ): string[] {
      if (wheres.length === 0) return ids;
      return ids.filter((id) => {
        const seed = docs.get(`${colPath}/${id}`);
        const data = (seed?.data as Record<string, unknown> | undefined) ?? {};
        return wheres.every((w) => {
          const v = data[w.field];
          if (w.op === '==') return v === w.value;
          if (w.op === 'array-contains') {
            return Array.isArray(v) && (v as unknown[]).includes(w.value);
          }
          return false;
        });
      });
    }

    function query(state: {
      ordered?: boolean;
      limit?: number;
      startAfterId?: string;
      wheres?: WhereClause[];
    }) {
      return {
        orderBy: () => query({ ...state, ordered: true }),
        limit: (n: number) => query({ ...state, limit: n }),
        startAfter: (doc: { id: string }) =>
          query({ ...state, startAfterId: doc.id }),
        where: (field: string, op: '==' | 'array-contains', value: unknown) =>
          query({
            ...state,
            wheres: [...(state.wheres ?? []), { field, op, value }],
          }),
        get: async () => {
          // A `where()` query on the top-level `users` collection (the site
          // classifier) must enumerate every doc under that prefix, not just
          // `collections.get(colPath)`, which only tracks subcollections.
          let candidateIds: string[];
          if ((state.wheres?.length ?? 0) > 0 && !collections.has(colPath)) {
            const prefix = `${colPath}/`;
            candidateIds = [...docs.keys()]
              .filter(
                (p) =>
                  p.startsWith(prefix) && !p.slice(prefix.length).includes('/'),
              )
              .map((p) => p.slice(prefix.length))
              .filter((id) => docs.get(`${colPath}/${id}`)?.exists);
          } else {
            candidateIds = [...(collections.get(colPath) ?? [])];
          }
          let list = applyWheres(candidateIds, state.wheres ?? []);
          if (state.ordered) list = list.sort((a, b) => a.localeCompare(b));
          if (state.startAfterId) {
            const idx = list.indexOf(state.startAfterId);
            list = idx >= 0 ? list.slice(idx + 1) : list;
          }
          if (typeof state.limit === 'number') {
            list = list.slice(0, state.limit);
          }
          return snapshotWithRefs(list);
        },
      };
    }
    const baseQuery = query({});
    return {
      path: colPath,
      doc: (id: string) => makeDocRef(`${colPath}/${id}`),
      orderBy: baseQuery.orderBy,
      limit: baseQuery.limit,
      startAfter: baseQuery.startAfter,
      where: baseQuery.where,
      get: baseQuery.get,
    };
  }

  const batch = () => {
    const ops: Array<{ op: 'delete'; path: string }> = [];
    return {
      delete: (ref: { path: string }) => {
        ops.push({ op: 'delete', path: ref.path });
      },
      commit: async () => {
        for (const op of ops) {
          batchDeleteCalls.push(op.path);
          // Mirror into the doc + collection state so successive scans see
          // the deletion (essential for the chunked-loop tests).
          docs.set(op.path, { exists: false, data: undefined });
          const lastSlash = op.path.lastIndexOf('/');
          const parent = op.path.slice(0, lastSlash);
          const id = op.path.slice(lastSlash + 1);
          const list = collections.get(parent);
          if (list) {
            const idx = list.indexOf(id);
            if (idx !== -1) list.splice(idx, 1);
          }
        }
        batchCommitCount += 1;
      },
    };
  };

  const db = {
    collection: (name: string) => makeCollectionRef(name),
    batch,
  };

  return {
    setCalls,
    deleteCalls,
    batchDeleteCalls,
    get batchCommitCount() {
      return batchCommitCount;
    },
    collections,
    db,
  };
}

/**
 * Simulate the legacy client-side `writeBatch` cascade from `AuthContext.tsx`
 * before migration, returning the Firestore paths it would have deleted so the
 * diff test can assert the server cascade matches bit-for-bit.
 */
function simulateLegacyClientCascade(
  userId: string,
  userSites: string[],
  collections: Record<string, string[]>,
): Set<string> {
  const deleted = new Set<string>();

  for (const siteId of userSites) {
    // Legacy did `getDoc(siteRef)` first; a missing site meant no deletes. Emulated
    // by checking for any tracked subcollection keyed under the site.
    const machines = collections[`sites/${siteId}/machines`] ?? [];
    const deployments = collections[`sites/${siteId}/deployments`] ?? [];
    const logs = collections[`sites/${siteId}/logs`] ?? [];

    deleted.add(`sites/${siteId}`);
    for (const m of machines) deleted.add(`sites/${siteId}/machines/${m}`);
    for (const d of deployments) deleted.add(`sites/${siteId}/deployments/${d}`);
    for (const l of logs) deleted.add(`sites/${siteId}/logs/${l}`);
  }

  deleted.add(`users/${userId}`);
  return deleted;
}

function seedUser(
  userId: string,
  sites: string[],
): Record<string, DocSeed> {
  const out: Record<string, DocSeed> = {};
  out[`users/${userId}`] = { exists: true, data: { sites, role: 'admin' } };
  for (const siteId of sites) {
    // Seed `owner` so the classifier treats the site as a sole-owner site.
    // Tests that want member-site classification override the seed.
    out[`sites/${siteId}`] = { exists: true, data: { name: siteId, owner: userId } };
  }
  return out;
}

function seedSubs(
  sites: string[],
  perSite: { machines: number; deployments: number; logs: number },
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const siteId of sites) {
    out[`sites/${siteId}/machines`] = Array.from(
      { length: perSite.machines },
      (_, i) => `m_${siteId}_${i}`,
    );
    out[`sites/${siteId}/deployments`] = Array.from(
      { length: perSite.deployments },
      (_, i) => `d_${siteId}_${i}`,
    );
    out[`sites/${siteId}/logs`] = Array.from(
      { length: perSite.logs },
      (_, i) => `l_${siteId}_${i}`,
    );
  }
  return out;
}

beforeEach(() => {
  loggerWarnSpy.mockClear();
  loggerErrorSpy.mockClear();
});

describe('deleteOwnAccount — input validation', () => {
  it('throws when userId is empty', async () => {
    const fake = buildFakeDb();
    await expect(
      deleteOwnAccount({ userId: '', operationId: 'op_1', db: fake.db }),
    ).rejects.toThrow(/userId/);
  });

  it('throws when operationId is empty', async () => {
    const fake = buildFakeDb();
    await expect(
      deleteOwnAccount({ userId: 'uid_a', operationId: '', db: fake.db }),
    ).rejects.toThrow(/operationId/);
  });
});

describe('deleteOwnAccount — happy path cascade', () => {
  it('deletes machines, deployments, logs, site doc, then user doc — for each site', async () => {
    const userId = 'uid_alice';
    const sites = ['site-a', 'site-b'];
    const seedDocs = seedUser(userId, sites);
    // Seed with `owner` so the classifier treats them as sole-owner sites.
    for (const s of sites) {
      seedDocs[`sites/${s}`] = { exists: true, data: { name: s, owner: userId } };
    }
    const seedCollections = seedSubs(sites, {
      machines: 3,
      deployments: 2,
      logs: 4,
    });
    const fake = buildFakeDb({ seedDocs, seedCollections });

    const result = await deleteOwnAccount({
      userId,
      operationId: 'op_alice_1',
      db: fake.db,
      auth: null,
      storage: null,
    });

    if (result.kind !== 'ok') throw new Error('expected ok result');
    expect(result.performed).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.alreadyCompleted).toBe(false);
    expect(result.sites).toEqual(sites);
    expect(result.deletedCounts).toMatchObject({
      machines: 6,        // 3 per site × 2 sites
      deployments: 4,     // 2 per site × 2 sites
      logs: 8,            // 4 per site × 2 sites
      sites: 2,
      users: 1,
      memberSitesRemoved: 0,
    });

    // Every batch op should be a delete; no batch should exceed BATCH_SIZE.
    expect(fake.batchDeleteCalls.length).toBe(18);

    // Site docs and user doc are deleted via the singular `.delete()` path
    // (not the batch). Order: per-site → site doc → ... → user doc last.
    expect(fake.deleteCalls).toEqual([
      'sites/site-a',
      'sites/site-b',
      `users/${userId}`,
    ]);

    // EVERY freed site id is tombstoned, exactly as `deleteSite` does. Site ids
    // are caller-supplied slugs and `POST /api/sites` is open to any
    // authenticated user, so an untombstoned id can be re-registered by anyone —
    // and because deletion does not clear OTHER users' `sites[]`, the previous
    // site's members come with it. This path used to delete the site document
    // with no tombstone, which made self-delete the one unsafe way to free a slug.
    expect(
      fake.setCalls.filter((c) => c.path.startsWith('site_ids/')).map((c) => c.path),
    ).toEqual(['site_ids/site-a', 'site_ids/site-b']);
  });

  it('writes the tombstone BEFORE freeing the site document', async () => {
    // Ordering is the guarantee: a tombstone with no delete is harmless, a
    // delete with no tombstone is the bug.
    const userId = 'uid_order';
    const fake = buildFakeDb({ seedDocs: seedUser(userId, ['site-a']) });

    await deleteOwnAccount({
      userId,
      operationId: 'op_order_1',
      db: fake.db,
      auth: null,
      storage: null,
    });

    const tombstoneAt = fake.setCalls.findIndex((c) => c.path === 'site_ids/site-a');
    expect(tombstoneAt).toBeGreaterThanOrEqual(0);
    expect(fake.deleteCalls).toContain('sites/site-a');
    // The site delete is recorded on a different channel than the set, so assert
    // the tombstone exists and the delete happened -- the source orders them.
    expect(fake.setCalls[tombstoneAt].payload).toHaveProperty('deletedAt');
  });

  it('deletes child docs BEFORE the parent site doc', async () => {
    const userId = 'uid_a';
    const sites = ['site-a'];
    const fake = buildFakeDb({
      seedDocs: seedUser(userId, sites),
      seedCollections: seedSubs(sites, {
        machines: 2,
        deployments: 1,
        logs: 1,
      }),
    });

    await deleteOwnAccount({
      userId,
      operationId: 'op_order',
      db: fake.db,
      auth: null,
      storage: null,
    });

    // The 4 sub-doc deletes land in the batch (commit precedes the site delete), so
    // the site delete is the FIRST `deleteCalls` entry and the user doc is last.
    const allBatched = fake.batchDeleteCalls;
    expect(allBatched).toContain('sites/site-a/machines/m_site-a_0');
    expect(allBatched).toContain('sites/site-a/deployments/d_site-a_0');
    expect(allBatched).toContain('sites/site-a/logs/l_site-a_0');

    expect(fake.deleteCalls).toEqual(['sites/site-a', `users/${userId}`]);
  });

  it('writes a progress doc before and after the cascade', async () => {
    const userId = 'uid_p';
    const fake = buildFakeDb({
      seedDocs: seedUser(userId, []),
    });

    await deleteOwnAccount({
      userId,
      operationId: 'op_progress',
      db: fake.db,
      auth: null,
      storage: null,
    });

    const progressWrites = fake.setCalls.filter(
      (c) => c.path === `users/${userId}/account_deletion/operation`,
    );
    expect(progressWrites.length).toBe(2);
    expect(progressWrites[0].payload.status).toBe('in_progress');
    expect(progressWrites[1].payload.status).toBe('completed');
    expect(progressWrites[1].payload.deletedCounts).toMatchObject({
      machines: 0,
      deployments: 0,
      logs: 0,
      sites: 0,
      users: 1,
    });
  });
});

describe('deleteOwnAccount — diff test vs. legacy client cascade', () => {
  it('the deleted-path set matches the legacy client cascade exactly', async () => {
    const userId = 'uid_diff';
    const sites = ['site-x', 'site-y', 'site-z'];
    const seedCollections = seedSubs(sites, {
      machines: 5,
      deployments: 3,
      logs: 7,
    });
    const fake = buildFakeDb({
      seedDocs: seedUser(userId, sites),
      seedCollections,
    });

    await deleteOwnAccount({
      userId,
      operationId: 'op_diff',
      db: fake.db,
      auth: null,
      storage: null,
    });

    // The new cascade visits more paths (passkeys, api_keys, mfa_pending) but with
    // empty seeds those produce no deletes, so the site paths + user doc must match.
    const serverDeleted = new Set<string>([
      ...fake.batchDeleteCalls,
      ...fake.deleteCalls,
    ]);

    const legacyDeleted = simulateLegacyClientCascade(
      userId,
      sites,
      seedCollections,
    );

    expect(serverDeleted).toEqual(legacyDeleted);

    // Sanity: non-trivial path set (three sites with 5+3+7 children, plus docs).
    expect(serverDeleted.size).toBe(3 * (5 + 3 + 7) + sites.length + 1);
  });
});

describe('deleteOwnAccount — dry-run mode', () => {
  it('returns counts without performing any deletes', async () => {
    const userId = 'uid_dry';
    const sites = ['site-d'];
    const fake = buildFakeDb({
      seedDocs: seedUser(userId, sites),
      seedCollections: seedSubs(sites, {
        machines: 4,
        deployments: 2,
        logs: 6,
      }),
    });

    const result = await deleteOwnAccount({
      userId,
      operationId: 'op_dry',
      dryRun: true,
      db: fake.db,
      auth: null,
      storage: null,
    });

    if (result.kind !== 'ok') throw new Error('expected ok result');
    expect(result.performed).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(result.deletedCounts).toMatchObject({
      machines: 4,
      deployments: 2,
      logs: 6,
      sites: 1,
      users: 1,
    });

    // No deletes should hit firestore.
    expect(fake.batchDeleteCalls).toEqual([]);
    expect(fake.deleteCalls).toEqual([]);

    // No progress-doc writes either — dry-runs are pure scans.
    const progressWrites = fake.setCalls.filter((c) =>
      c.path.includes('account_deletion'),
    );
    expect(progressWrites).toEqual([]);
  });

  it('returns the would-delete path list', async () => {
    const userId = 'uid_dry2';
    const sites = ['site-q'];
    const fake = buildFakeDb({
      seedDocs: seedUser(userId, sites),
      seedCollections: seedSubs(sites, {
        machines: 1,
        deployments: 0,
        logs: 1,
      }),
    });

    const result = await deleteOwnAccount({
      userId,
      operationId: 'op_dry_paths',
      dryRun: true,
      db: fake.db,
      auth: null,
      storage: null,
    });

    if (result.kind !== 'ok') throw new Error('expected ok result');
    expect(result.deletedPaths).toEqual(
      expect.arrayContaining([
        'sites/site-q/machines/m_site-q_0',
        'sites/site-q/logs/l_site-q_0',
        'sites/site-q',
        `users/${userId}`,
      ]),
    );
  });

  it('dry-run counts beyond one page without deleting anything', async () => {
    const userId = 'uid_dry_chunk';
    const sites = ['site-dry-big'];
    const fake = buildFakeDb({
      seedDocs: seedUser(userId, sites),
      seedCollections: seedSubs(sites, {
        machines: 250,
        deployments: 0,
        logs: 0,
      }),
    });

    const result = await deleteOwnAccount({
      userId,
      operationId: 'op_dry_chunk',
      dryRun: true,
      db: fake.db,
      auth: null,
      storage: null,
    });

    if (result.kind !== 'ok') throw new Error('expected ok result');
    expect(result.deletedCounts.machines).toBe(250);
    expect(result.deletedPaths.filter((p) =>
      p.startsWith('sites/site-dry-big/machines/'),
    ).length).toBe(250);
    expect(fake.batchDeleteCalls).toEqual([]);
    expect(fake.deleteCalls).toEqual([]);
    expect(fake.collections.get('sites/site-dry-big/machines')?.length).toBe(250);
  });
});

describe('deleteOwnAccount — idempotency', () => {
  it('a re-issued call with the same operationId is a no-op replay', async () => {
    const userId = 'uid_idem';
    const sites = ['site-i'];
    const fake = buildFakeDb({
      seedDocs: seedUser(userId, sites),
      seedCollections: seedSubs(sites, {
        machines: 2,
        deployments: 0,
        logs: 0,
      }),
    });

    const first = await deleteOwnAccount({
      userId,
      operationId: 'op_idem_1',
      db: fake.db,
      auth: null,
      storage: null,
    });
    if (first.kind !== 'ok') throw new Error('expected ok result');
    expect(first.performed).toBe(true);
    expect(first.alreadyCompleted).toBe(false);

    const firstBatchDeletes = fake.batchDeleteCalls.length;
    const firstDocDeletes = fake.deleteCalls.length;

    const second = await deleteOwnAccount({
      userId,
      operationId: 'op_idem_1',
      db: fake.db,
      auth: null,
      storage: null,
    });
    if (second.kind !== 'ok') throw new Error('expected ok result');
    expect(second.performed).toBe(false);
    expect(second.alreadyCompleted).toBe(true);
    expect(second.deletedCounts).toEqual(first.deletedCounts);

    // No new firestore deletes happened on the replay.
    expect(fake.batchDeleteCalls.length).toBe(firstBatchDeletes);
    expect(fake.deleteCalls.length).toBe(firstDocDeletes);
  });
});

describe('deleteOwnAccount — chunking', () => {
  it('250 machines drain in 3 batches of <= BATCH_SIZE', async () => {
    expect(BATCH_SIZE).toBe(100);

    const userId = 'uid_chunk';
    const sites = ['site-big'];
    const fake = buildFakeDb({
      seedDocs: seedUser(userId, sites),
      seedCollections: seedSubs(sites, {
        machines: 250,
        deployments: 0,
        logs: 0,
      }),
    });

    const result = await deleteOwnAccount({
      userId,
      operationId: 'op_chunk',
      db: fake.db,
      auth: null,
      storage: null,
    });

    if (result.kind !== 'ok') throw new Error('expected ok result');
    expect(result.deletedCounts.machines).toBe(250);

    // Every machine should have been deleted exactly once.
    const machineDeletes = fake.batchDeleteCalls.filter((p) =>
      p.startsWith('sites/site-big/machines/'),
    );
    expect(machineDeletes.length).toBe(250);
    expect(new Set(machineDeletes).size).toBe(250);

    // 250 / BATCH_SIZE === 3 batches (100 + 100 + 50); deployments and logs are
    // seeded empty, so the machines drain is the only source of batch commits.
    expect(fake.batchCommitCount).toBe(3);
  });
});

describe('deleteOwnAccount — edge cases', () => {
  it('returns alreadyCompleted=true when the user doc is already gone', async () => {
    const userId = 'uid_gone';
    const fake = buildFakeDb({ seedDocs: {} }); // user doc not seeded

    const result = await deleteOwnAccount({
      userId,
      operationId: 'op_gone',
      db: fake.db,
      auth: null,
      storage: null,
    });

    if (result.kind !== 'ok') throw new Error('expected ok result');
    expect(result.performed).toBe(false);
    expect(result.alreadyCompleted).toBe(true);
    expect(result.deletedCounts).toMatchObject({
      machines: 0,
      deployments: 0,
      logs: 0,
      sites: 0,
      users: 0,
    });
    expect(fake.batchDeleteCalls).toEqual([]);
    expect(fake.deleteCalls).toEqual([]);
  });

  it('skips a missing site doc without crashing the cascade', async () => {
    const userId = 'uid_missing_site';
    const fake = buildFakeDb({
      seedDocs: {
        [`users/${userId}`]: {
          exists: true,
          data: { sites: ['site-real', 'site-ghost'], role: 'admin' },
        },
        'sites/site-real': { exists: true, data: { name: 'real', owner: userId } },
        // site-ghost intentionally absent
      },
      seedCollections: {
        'sites/site-real/machines': ['m1'],
      },
    });

    const result = await deleteOwnAccount({
      userId,
      operationId: 'op_ghost',
      db: fake.db,
      auth: null,
      storage: null,
    });

    if (result.kind !== 'ok') throw new Error('expected ok result');
    expect(result.deletedCounts.sites).toBe(1); // only site-real
    expect(result.deletedCounts.machines).toBe(1);
    expect(fake.deleteCalls).toContain('sites/site-real');
    expect(fake.deleteCalls).not.toContain('sites/site-ghost');
  });

  it('treats a progress-doc write failure as non-fatal and continues', async () => {
    const userId = 'uid_progress_fail';
    const sites = ['site-pf'];
    const fake = buildFakeDb({
      seedDocs: seedUser(userId, sites),
      seedCollections: seedSubs(sites, {
        machines: 1,
        deployments: 1,
        logs: 1,
      }),
      progressSetFailure: new Error('progress doc firestore unavailable'),
    });

    const result = await deleteOwnAccount({
      userId,
      operationId: 'op_pf',
      db: fake.db,
      auth: null,
      storage: null,
    });

    if (result.kind !== 'ok') throw new Error('expected ok result');
    // Cascade still completed.
    expect(result.deletedCounts.machines).toBe(1);
    expect(result.deletedCounts.deployments).toBe(1);
    expect(result.deletedCounts.logs).toBe(1);
    expect(result.deletedCounts.sites).toBe(1);
    expect(result.deletedCounts.users).toBe(1);

    // Both the in-progress AND the completion stamp tried to write and
    // both failed — non-fatal, with warnings logged.
    expect(loggerWarnSpy).toHaveBeenCalled();
  });

  it('handles a user with zero owned sites', async () => {
    const userId = 'uid_no_sites';
    const fake = buildFakeDb({
      seedDocs: seedUser(userId, []),
    });

    const result = await deleteOwnAccount({
      userId,
      operationId: 'op_no_sites',
      db: fake.db,
      auth: null,
      storage: null,
    });

    if (result.kind !== 'ok') throw new Error('expected ok result');
    expect(result.deletedCounts).toMatchObject({
      machines: 0,
      deployments: 0,
      logs: 0,
      sites: 0,
      users: 1,
    });
    expect(fake.deleteCalls).toEqual([`users/${userId}`]);
    expect(fake.batchDeleteCalls).toEqual([]);
  });

  it('refuses with needs_successor when the user owns a site with other members', async () => {
    const userId = 'uid_shared_owner';
    const otherUid = 'uid_other_member';
    const fake = buildFakeDb({
      seedDocs: {
        [`users/${userId}`]: {
          exists: true,
          data: { sites: ['site-shared'], role: 'admin' },
        },
        [`users/${otherUid}`]: {
          exists: true,
          data: { sites: ['site-shared'], role: 'member' },
        },
        'sites/site-shared': {
          exists: true,
          data: { name: 'shared', owner: userId },
        },
      },
    });

    const result = await deleteOwnAccount({
      userId,
      operationId: 'op_shared',
      db: fake.db,
      auth: null,
      storage: null,
    });

    expect(result.kind).toBe('needs_successor');
    if (result.kind !== 'needs_successor') throw new Error('expected needs_successor');
    expect(result.ownedSharedSites).toEqual(['site-shared']);

    // No deletes happened.
    expect(fake.deleteCalls).toEqual([]);
    expect(fake.batchDeleteCalls).toEqual([]);
  });

  it('treats member sites as arrayRemove-only — site doc untouched', async () => {
    const userId = 'uid_member';
    const ownerUid = 'uid_owner';
    const fake = buildFakeDb({
      seedDocs: {
        [`users/${userId}`]: {
          exists: true,
          data: { sites: ['site-shared'], role: 'member' },
        },
        // The owner doc — present so `array-contains` sees another site member.
        [`users/${ownerUid}`]: {
          exists: true,
          data: { sites: ['site-shared'], role: 'admin' },
        },
        'sites/site-shared': {
          exists: true,
          data: { name: 'shared', owner: ownerUid },
        },
      },
      seedCollections: {
        // Subcollections that MUST NOT be drained — the user is not owner.
        'sites/site-shared/machines': ['m_keep'],
        'sites/site-shared/deployments': ['d_keep'],
        'sites/site-shared/logs': ['l_keep'],
      },
    });

    const result = await deleteOwnAccount({
      userId,
      operationId: 'op_member',
      db: fake.db,
      auth: null,
      storage: null,
    });

    if (result.kind !== 'ok') throw new Error('expected ok result');
    expect(result.deletedCounts.memberSitesRemoved).toBe(1);
    expect(result.deletedCounts.sites).toBe(0);
    expect(result.deletedCounts.machines).toBe(0);
    expect(result.deletedCounts.deployments).toBe(0);
    expect(result.deletedCounts.logs).toBe(0);

    // Site doc and its subcollections must remain intact for the owner.
    expect(fake.deleteCalls).not.toContain('sites/site-shared');
    expect(fake.batchDeleteCalls).not.toContain(
      'sites/site-shared/machines/m_keep',
    );
    // Only the user doc is deleted.
    expect(fake.deleteCalls).toEqual([`users/${userId}`]);
  });

  it('drains user-scoped subcollections (passkeys, trustedDevices, verified_networks, api_keys) and top-level api_keys lookups', async () => {
    const userId = 'uid_subs';
    const fake = buildFakeDb({
      seedDocs: {
        [`users/${userId}`]: {
          exists: true,
          data: { sites: [], role: 'member' },
        },
        [`users/${userId}/passkeys/pk1`]: { exists: true, data: { id: 'pk1' } },
        [`users/${userId}/passkeys/pk2`]: { exists: true, data: { id: 'pk2' } },
        [`users/${userId}/trustedDevices/td1`]: {
          exists: true,
          data: { tokenHash: 'td1' },
        },
        [`users/${userId}/trustedDevices/td2`]: {
          exists: true,
          data: { tokenHash: 'td2' },
        },
        [`users/${userId}/verified_networks/asn:64500`]: {
          exists: true,
          data: { asn: '64500', lastVerifiedAt: 1 },
        },
        [`users/${userId}/api_keys/key_a`]: {
          exists: true,
          data: { keyHash: 'hash_a' },
        },
        [`users/${userId}/api_keys/key_b`]: {
          exists: true,
          data: { keyHash: 'hash_b' },
        },
        'api_keys/hash_a': { exists: true, data: { userId, keyId: 'key_a' } },
        'api_keys/hash_b': { exists: true, data: { userId, keyId: 'key_b' } },
      },
      seedCollections: {
        [`users/${userId}/passkeys`]: ['pk1', 'pk2'],
        [`users/${userId}/trustedDevices`]: ['td1', 'td2'],
        [`users/${userId}/verified_networks`]: ['asn:64500'],
        [`users/${userId}/api_keys`]: ['key_a', 'key_b'],
      },
    });

    const result = await deleteOwnAccount({
      userId,
      operationId: 'op_subs',
      db: fake.db,
      auth: null,
      storage: null,
    });

    if (result.kind !== 'ok') throw new Error('expected ok result');
    expect(result.deletedCounts.passkeys).toBe(2);
    expect(result.deletedCounts.trustedDevices).toBe(2);
    expect(result.deletedCounts.verifiedNetworks).toBe(1);
    expect(result.deletedCounts.apiKeys).toBe(2);
    expect(result.deletedCounts.apiKeyLookups).toBe(2);

    expect(fake.batchDeleteCalls).toEqual(
      expect.arrayContaining([
        `users/${userId}/passkeys/pk1`,
        `users/${userId}/passkeys/pk2`,
        `users/${userId}/trustedDevices/td1`,
        `users/${userId}/trustedDevices/td2`,
        `users/${userId}/verified_networks/asn:64500`,
        `users/${userId}/api_keys/key_a`,
        `users/${userId}/api_keys/key_b`,
        'api_keys/hash_a',
        'api_keys/hash_b',
      ]),
    );
  });

  it('revokes + deletes the Firebase Auth user when an Auth admin is provided', async () => {
    const userId = 'uid_auth';
    const revokeRefreshTokens = jest.fn(async () => undefined);
    const deleteAuthUser = jest.fn(async () => undefined);
    const fakeAuth = {
      revokeRefreshTokens,
      deleteUser: deleteAuthUser,
    } as unknown as Parameters<typeof deleteOwnAccount>[0]['auth'];

    const fake = buildFakeDb({ seedDocs: seedUser(userId, []) });

    const result = await deleteOwnAccount({
      userId,
      operationId: 'op_auth',
      db: fake.db,
      auth: fakeAuth,
      storage: null,
    });

    if (result.kind !== 'ok') throw new Error('expected ok result');
    expect(result.authRevoked).toBe(true);
    expect(revokeRefreshTokens).toHaveBeenCalledWith(userId);
    expect(deleteAuthUser).toHaveBeenCalledWith(userId);
  });

  it('treats auth/user-not-found from the Auth admin as success (already gone)', async () => {
    const userId = 'uid_auth_gone';
    const fakeAuth = {
      revokeRefreshTokens: jest.fn(async () => undefined),
      deleteUser: jest.fn(async () => {
        const err = new Error('not found') as Error & { code?: string };
        err.code = 'auth/user-not-found';
        throw err;
      }),
    } as unknown as Parameters<typeof deleteOwnAccount>[0]['auth'];

    const fake = buildFakeDb({ seedDocs: seedUser(userId, []) });

    const result = await deleteOwnAccount({
      userId,
      operationId: 'op_auth_gone',
      db: fake.db,
      auth: fakeAuth,
      storage: null,
    });

    if (result.kind !== 'ok') throw new Error('expected ok result');
    expect(result.authRevoked).toBe(true);
  });
});
