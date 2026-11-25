/**
 * Shared Firestore mocks + data factories for API route-handler tests.
 *
 * This module never calls `jest.mock()` itself — Jest hoists those, so each
 * test file must declare them at its own top level and point them at the
 * objects exported here (e.g.
 * `jest.mock('@/lib/firebase-admin', () => ({ getAdminDb: () => mockDbFactory() }))`).
 */

import type { SwoopMode } from '@/lib/swoopMode';

export const mocks = {
  /** doc().get() — called with the document's full path, so an implementation
   *  can answer per-collection (e.g. `users/{uid}` vs the route's own doc). */
  get: jest.fn(),
  /** doc().set() */
  set: jest.fn().mockResolvedValue(undefined),
  /** doc().update() */
  update: jest.fn().mockResolvedValue(undefined),
  /** doc().delete() */
  del: jest.fn().mockResolvedValue(undefined),
  /** db.batch().set() */
  batchSet: jest.fn(),
  /** db.batch().delete() */
  batchDelete: jest.fn(),
  /** Real WriteBatch has update(); rotate-secret batches a set + an update. */
  batchUpdate: jest.fn(),
  /** db.batch().commit() */
  batchCommit: jest.fn().mockResolvedValue(undefined),
  /** collection().orderBy() — chainable */
  orderBy: jest.fn().mockReturnThis(),
  /** collection().limit() — chainable */
  limit: jest.fn().mockReturnThis(),
  /** collection().startAfter() — chainable */
  startAfter: jest.fn().mockReturnThis(),
  /** collection().where() — chainable */
  where: jest.fn().mockReturnThis(),
  /** terminal .get() on a query chain */
  collectionGet: jest.fn(),
  /** explicit data for top-level sites/{siteId} document reads */
  siteDocs: new Map<string, Record<string, unknown> | null>(),
  /**
   * Explicit data for `sites/{siteId}/members/{uid}` reads, keyed
   * `${siteId}/${uid}`. Defaults to ABSENT — site access is membership now, so a
   * suite that wants a caller to have standing has to say so (see `seedMember`).
   *
   * Deliberately not derived from `siteDocs.owner`: synthesising a member row
   * from the legacy owner field would keep these tests green even if production
   * regressed to reading it, which is the whole failure this migration removes.
   */
  memberDocs: new Map<string, Record<string, unknown> | null>(),
  /**
   * Explicit data for `users/{uid}` reads, keyed by uid. Falls through to the
   * `get` catch-all when a uid is absent, so suites that never seed one behave
   * exactly as before.
   *
   * Seeding matters because `mocks.get` is a QUEUE: suites stage route documents
   * with `mockResolvedValueOnce`, and every unaddressed read shifts that queue.
   * The authorization path reads `users/{uid}` on EVERY request now — it used to
   * skip it whenever the caller owned the site — so leaving it on the catch-all
   * silently consumes the document the test staged for the route.
   */
  userDocs: new Map<string, Record<string, unknown> | null>(),
  /** requireAdminOrIdToken */
  requireAdmin: jest.fn().mockResolvedValue({ userId: 'test-admin' }),
};

/** Recursive collection/doc tree. */
function buildCollection(path = ''): Record<string, unknown> {
  return {
    doc: (_id?: string) => buildDoc(`${path}/${_id ?? 'auto'}`),
    orderBy: mocks.orderBy,
    limit: mocks.limit,
    startAfter: mocks.startAfter,
    where: mocks.where,
    get: mocks.collectionGet,
  };
}

function buildDoc(path: string): Record<string, unknown> {
  return {
    get: () => {
      const parts = path.split('/').filter(Boolean);
      if (parts.length === 2 && parts[0] === 'sites') {
        if (mocks.siteDocs.has(parts[1])) {
          return Promise.resolve(docSnapshot(parts[1], mocks.siteDocs.get(parts[1]) ?? null));
        }
        return Promise.resolve(docSnapshot(parts[1], {}));
      }
      // Answered here rather than by the `mocks.get` catch-all, which most suites
      // point at a single user document — a membership read would otherwise come
      // back as that user doc and be parsed as a garbage member row.
      if (parts.length === 4 && parts[0] === 'sites' && parts[2] === 'members') {
        const key = `${parts[1]}/${parts[3]}`;
        return Promise.resolve(docSnapshot(parts[3], mocks.memberDocs.get(key) ?? null));
      }
      if (parts.length === 2 && parts[0] === 'users' && mocks.userDocs.has(parts[1])) {
        return Promise.resolve(docSnapshot(parts[1], mocks.userDocs.get(parts[1]) ?? null));
      }
      return mocks.get(path);
    },
    set: mocks.set,
    update: mocks.update,
    delete: mocks.del,
    collection: (sub: string) => buildCollection(`${path}/${sub}`),
  };
}

function buildLegacyCollection(): Record<string, unknown> {
  return {
    doc: (_id?: string) => ({
      get: mocks.get,
      set: mocks.set,
      update: mocks.update,
      delete: mocks.del,
      collection: buildLegacyCollection,
    }),
    orderBy: mocks.orderBy,
    limit: mocks.limit,
    startAfter: mocks.startAfter,
    where: mocks.where,
    get: mocks.collectionGet,
  };
}

let transactionChain: Promise<unknown> = Promise.resolve();

/** Returns a mock Firestore db object. Use inside jest.mock factory. */
export function mockDbFactory(): Record<string, unknown> {
  return {
    collection: (name: string) => (
      name.includes('/') ? buildLegacyCollection() : buildCollection(name)
    ),
    batch: () => ({
      set: mocks.batchSet,
      update: mocks.batchUpdate,
      delete: mocks.batchDelete,
      commit: mocks.batchCommit,
    }),
    /**
     * Batched multi-document read. Real `getAll` preserves argument order and
     * yields a non-existent snapshot for a missing document rather than omitting
     * it, so callers can zip the results against their inputs by index — which is
     * exactly what the webhook fan-out in lib/roostWebhooks.server.ts does.
     * Delegates to each ref's own `get`, so it shares the `mocks.get` queue.
     */
    getAll: (...refs: Array<{ get: () => Promise<unknown> }>) =>
      Promise.all(refs.map((ref) => ref.get())),
    /**
     * Runs the callback once. `tx.get` reads through the ref, so it shares the
     * `mocks.get` queue; `tx.update` and `tx.set` land on `mocks.update` and
     * `mocks.set`. Transactions run one after another across every db this factory
     * returns, which is what firestore's retry-on-conflict amounts to for two
     * writers of one document.
     */
    runTransaction: (fn: (tx: unknown) => Promise<unknown>) => {
      const run = transactionChain.then(() =>
        fn({
          get: (ref: { get: () => Promise<unknown> }) => ref.get(),
          update: (ref: { update: (data: unknown) => unknown }, data: unknown) => {
            ref.update(data);
          },
          set: (
            ref: { set: (data: unknown, options?: unknown) => unknown },
            data: unknown,
            options?: unknown,
          ) => {
            ref.set(data, options);
          },
        }),
      );
      transactionChain = run.catch(() => undefined);
      return run;
    },
  };
}

/**
 * Give `uid` standing on `siteId`, as `membership.server.ts` would write it.
 * `extra` adds the person's `swoop` mode to the row.
 *
 * Site-scoped capabilities resolve from this row and nothing else, so a suite
 * exercising anything beyond a superadmin has to call it.
 */
export function seedMember(
  siteId: string,
  uid: string,
  role: 'owner' | 'admin' | 'member' = 'admin',
  extra: { swoop?: SwoopMode } = {},
): void {
  mocks.memberDocs.set(`${siteId}/${uid}`, {
    uid,
    role,
    status: 'active',
    addedAt: new Date(0),
    addedBy: 'system:test',
    ...extra,
  });
  // A member needs a live user document to pass the soft-delete check, and
  // seeding it here takes that read off the `mocks.get` queue — see `userDocs`.
  // Global role `member` on purpose: it must grant nothing by itself, so a suite
  // that passes with it is proving the membership row did the work.
  if (!mocks.userDocs.has(uid)) {
    mocks.userDocs.set(uid, { email: `${uid}@example.test`, role: 'member', sites: [] });
  }
}

/** Firestore document snapshot returned by doc().get(). */
export function docSnapshot(
  id: string,
  data: Record<string, unknown> | null
): { exists: boolean; id: string; data: () => Record<string, unknown> | undefined } {
  return {
    exists: data !== null,
    id,
    data: () => data ?? undefined,
  };
}

/** Firestore query snapshot returned by collection().get(). */
export function querySnapshot(
  docs: Array<{ id: string; data: Record<string, unknown> }>
): { docs: Array<{ id: string; data: () => Record<string, unknown> }> } {
  return {
    docs: docs.map((d) => ({
      id: d.id,
      data: () => d.data,
    })),
  };
}

const ALL_PERMISSIONS = ['read', 'write', 'deploy', 'rollback', 'admin'] as const;

/** Default owner uid used by `seedSiteOwner` / `apiKeyAuth`. */
export const SITE_OWNER = 'user-1';

/**
 * Seed `sites/{siteId}.owner` AND the owner's membership row.
 *
 * The field alone grants nothing now — site access resolves from
 * `sites/{siteId}/members/{uid}` — so seeding only the field would produce a
 * fixture whose "owner" is refused by every site-scoped route.
 *
 * Clears both maps so scenarios can't inherit a previous owner's standing.
 */
export function seedSiteOwner(siteId: string, owner: string = SITE_OWNER): void {
  mocks.siteDocs.clear();
  mocks.memberDocs.clear();
  mocks.siteDocs.set(siteId, { owner });
  seedMember(siteId, owner, 'owner');
}

/** `ResolvedAuth` with wildcard api-key scopes, so scope never answers the request. */
export function apiKeyAuth(userId = SITE_OWNER): {
  userId: string;
  keyContext: Record<string, unknown>;
} {
  return {
    userId,
    keyContext: {
      keyId: 'key-billing-test',
      environment: 'live',
      expiresAt: Date.now() + 60_000,
      isLegacy: false,
      scopes: ['site', 'roost', 'machine', 'chat'].map((resource) => ({
        resource,
        id: '*',
        permissions: [...ALL_PERMISSIONS],
      })),
    },
  };
}
