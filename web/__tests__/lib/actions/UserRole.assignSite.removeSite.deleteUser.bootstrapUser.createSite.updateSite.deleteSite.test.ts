/** @jest-environment node */

const mockEmitMutation = jest.fn();
const mockDeleteCascade = jest.fn();

jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
}));

jest.mock('@/lib/userDeleteCascade.server', () => ({
  performUserDeleteCascade: (...args: unknown[]) => mockDeleteCascade(...args),
  cancelUserCommandsOnSites: jest.fn(async () => 0),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}));

// the resolver has its own suite; here it only matters what createSite does with the answer.
const mockSiteSlotAvailable = jest.fn();
jest.mock('@/lib/plan.server', () => ({
  ...jest.requireActual('@/lib/plan.server'),
  siteSlotAvailable: (uid: string) => mockSiteSlotAvailable(uid),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    arrayUnion: (...items: unknown[]) => ({ __op: 'arrayUnion', items }),
    arrayRemove: (...items: unknown[]) => ({ __op: 'arrayRemove', items }),
    // deleteSite writes its record to the platform audit sink before the delete,
    // and that row is server-timestamped.
    serverTimestamp: () => ({ __op: 'serverTimestamp' }),
  },
}));

import type { Firestore } from 'firebase-admin/firestore';
import { setUserRole } from '@/lib/actions/setUserRole.server';
import { assignSiteToUser } from '@/lib/actions/assignSiteToUser.server';
import { removeSiteFromUser } from '@/lib/actions/removeSiteFromUser.server';
import { deleteUser } from '@/lib/actions/deleteUser.server';
import { bootstrapUser } from '@/lib/actions/bootstrapUser.server';
import { createSite } from '@/lib/actions/createSite.server';
import { updateSite } from '@/lib/actions/updateSite.server';
import { deleteSite } from '@/lib/actions/deleteSite.server';

type StoredDoc = Record<string, unknown> | null;

class FakeDb {
  readonly docs = new Map<string, StoredDoc>();

  collection(path: string): FakeCollection {
    return new FakeCollection(this, path);
  }

  /**
   * Collection-group reads for `deleteUser`'s fleet-wide talon lookup. Matches
   * the last path segment, not a prefix, and exposes `ref.parent.parent.id` so
   * callers can recover the owning site.
   */
  collectionGroup(id: string): FakeCollectionGroup {
    return new FakeCollectionGroup(this, id);
  }

  /**
   * Batched multi-document read, as used by `removeSiteFromUser` to check every
   * named site for ownership in one round trip. Real `getAll` preserves argument
   * order and returns a non-existent snapshot for a missing doc rather than
   * omitting it — both are relied on by the caller's `.filter(exists)`.
   */
  async getAll(...refs: FakeDoc[]) {
    return Promise.all(refs.map((ref) => ref.get()));
  }

  /**
   * Recursive delete — the document and EVERY descendant, which is what makes
   * `deleteSite` a cascade. Firestore does not remove subcollections with their
   * parent, so a fake that deleted only the named key would let the cascade tests
   * pass while production leaked every member row and machine under the site.
   */
  async recursiveDelete(ref: FakeDoc) {
    const prefix = `${ref.path}/`;
    for (const key of [...this.docs.keys()]) {
      // null, not a key removal: that is how the rest of this fake models a
      // deleted document, and mixing the two would make assertions inconsistent
      // depending on which delete path happened to run.
      if (key === ref.path || key.startsWith(prefix)) this.docs.set(key, null);
    }
  }

  /**
   * Write batch — the talon store's all-or-nothing reassign, and createSite's
   * site-doc + owner-membership pair.
   *
   * Models the two real-Firestore behaviours a naive sequential apply misses:
   * `update` on a missing doc fails, and a failed commit writes nothing.
   * `FakeDoc.update` keeps its upsert behaviour (existing tests rely on it), so
   * the strictness lives here at the batch boundary.
   */
  batch() {
    const ops: Array<{
      ref: FakeDoc;
      patch: Record<string, unknown>;
      mode: 'set' | 'update' | 'create' | 'delete';
    }> = [];
    return {
      set: (ref: FakeDoc, patch: Record<string, unknown>) =>
        ops.push({ ref, patch, mode: 'set' }),
      update: (ref: FakeDoc, patch: Record<string, unknown>) =>
        ops.push({ ref, patch, mode: 'update' }),
      // create() differs from set(): it FAILS on an existing document. Modelling
      // that is what lets addMember's owner-overwrite refusal be tested at all.
      create: (ref: FakeDoc, patch: Record<string, unknown>) =>
        ops.push({ ref, patch, mode: 'create' }),
      delete: (ref: FakeDoc) => ops.push({ ref, patch: {}, mode: 'delete' }),
      commit: async () => {
        for (const op of ops) {
          if (op.mode === 'update') {
            const snap = await op.ref.get();
            if (!snap.exists) {
              throw new Error(`NOT_FOUND: no document to update: ${op.ref.path}`);
            }
          }
          if (op.mode === 'create') {
            const snap = await op.ref.get();
            if (snap.exists) {
              const err = new Error('Document already exists') as Error & { code: number };
              err.code = 6;
              throw err;
            }
          }
        }
        for (const op of ops) {
          if (op.mode === 'set' || op.mode === 'create') await op.ref.set(op.patch);
          else if (op.mode === 'delete') await op.ref.delete();
          else await op.ref.update(op.patch);
        }
      },
    };
  }

  async runTransaction<T>(
    callback: (tx: {
      get: (ref: FakeDoc | FakeCollection) => Promise<unknown>;
      update: (ref: FakeDoc, patch: Record<string, unknown>) => Promise<void>;
    }) => Promise<T>,
  ): Promise<T> {
    return callback({
      get: (ref) => ref.get(),
      update: (ref, patch) => ref.update(patch),
      set: (ref: FakeDoc, patch: Record<string, unknown>) => ref.set(patch),
      delete: (ref: FakeDoc) => ref.delete(),
    } as never);
  }

  seed(path: string, data: Record<string, unknown>): void {
    this.docs.set(path, { ...data });
  }

  asFirestore(): Firestore {
    return this as unknown as Firestore;
  }
}

interface FakeQuerySnapshot {
  /** `ref` is present because a real QueryDocumentSnapshot has one, and callers
   *  that batch-delete query results reach for it. Omitting it made a cascade
   *  look untestable when it was the fake that was incomplete. */
  docs: Array<{ id: string; data: () => Record<string, unknown>; ref: FakeDoc }>;
  empty: boolean;
}

/**
 * Minimal collection/query fake: `where` is equality-only, `limit` truncates.
 * Enough for these owner-scoped lookups without a Firestore emulator.
 */
class FakeCollection {
  constructor(
    private readonly db: FakeDb,
    private readonly path: string,
    private readonly filters: Array<[string, unknown]> = [],
    private readonly max: number | null = null,
  ) {}

  doc(id: string): FakeDoc {
    return new FakeDoc(this.db, `${this.path}/${id}`, id);
  }

  where(field: string, op: string, value: unknown): FakeCollection {
    if (op !== '==') throw new Error(`FakeCollection.where: unsupported operator ${op}`);
    return new FakeCollection(this.db, this.path, [...this.filters, [field, value]], this.max);
  }

  limit(n: number): FakeCollection {
    return new FakeCollection(this.db, this.path, this.filters, n);
  }

  async get(): Promise<FakeQuerySnapshot> {
    const prefix = `${this.path}/`;
    let docs = [...this.db.docs.entries()]
      .filter(([path, data]) => data !== null && path.startsWith(prefix))
      .filter(([path]) => !path.slice(prefix.length).includes('/'))
      .filter(([, data]) =>
        this.filters.every(([field, value]) => (data as Record<string, unknown>)[field] === value),
      )
      .map(([path, data]) => ({
        id: path.slice(prefix.length),
        data: () => ({ ...(data as Record<string, unknown>) }),
        ref: new FakeDoc(this.db, path, path.slice(prefix.length)),
      }));
    if (this.max !== null) docs = docs.slice(0, this.max);
    return { docs, empty: docs.length === 0 };
  }
}

/**
 * Collection-group query fake. Equality only; `orderBy` sorts on the field's
 * string form, matching the talon store's `createdBy == uid, orderBy name`.
 */
class FakeCollectionGroup {
  constructor(
    private readonly db: FakeDb,
    private readonly collectionId: string,
    private readonly filters: Array<[string, unknown]> = [],
    private readonly order: string | null = null,
  ) {}

  where(field: string, op: string, value: unknown): FakeCollectionGroup {
    if (op !== '==') throw new Error(`FakeCollectionGroup.where: unsupported operator ${op}`);
    return new FakeCollectionGroup(
      this.db,
      this.collectionId,
      [...this.filters, [field, value]],
      this.order,
    );
  }

  orderBy(field: string): FakeCollectionGroup {
    return new FakeCollectionGroup(this.db, this.collectionId, this.filters, field);
  }

  async get() {
    const docs = [...this.db.docs.entries()]
      .filter(([, data]) => data !== null)
      .filter(([path]) => {
        const segments = path.split('/');
        return segments.length >= 2 && segments[segments.length - 2] === this.collectionId;
      })
      .filter(([, data]) =>
        this.filters.every(([field, value]) => (data as Record<string, unknown>)[field] === value),
      )
      .map(([path, data]) => {
        const segments = path.split('/');
        const grandparentId =
          segments.length >= 3 ? segments[segments.length - 3] : undefined;
        return {
          id: segments[segments.length - 1],
          data: () => ({ ...(data as Record<string, unknown>) }),
          ref: { parent: { parent: grandparentId ? { id: grandparentId } : null } },
        };
      });

    if (this.order) {
      const field = this.order;
      docs.sort((a, b) => String(a.data()[field] ?? '').localeCompare(String(b.data()[field] ?? '')));
    }
    return { docs, empty: docs.length === 0 };
  }
}

class FakeDoc {
  constructor(
    private readonly db: FakeDb,
    private readonly path: string,
    readonly id: string,
  ) {}

  /** Subcollection, e.g. `sites/{siteId}` → `talons`. */
  collection(name: string): FakeCollection {
    return new FakeCollection(this.db, `${this.path}/${name}`);
  }

  async get(): Promise<{
    exists: boolean;
    data: () => Record<string, unknown> | undefined;
    ref: FakeDoc;
  }> {
    const data = this.db.docs.get(this.path);
    return {
      exists: data !== undefined && data !== null,
      data: () => (data ? { ...data } : undefined),
      // A real DocumentSnapshot carries `ref`, and callers that read then write
      // the surviving subset reach for it. Omitting it made `deleteSite`'s
      // exists-filter look broken when it was the fake that was incomplete.
      ref: this,
    };
  }

  async set(data: Record<string, unknown>): Promise<void> {
    this.db.docs.set(this.path, { ...data });
  }

  async update(patch: Record<string, unknown>): Promise<void> {
    const current = this.db.docs.get(this.path);
    const next = current && current !== null ? { ...current } : {};
    for (const [key, value] of Object.entries(patch)) {
      if (isFieldOp(value, 'arrayUnion')) {
        const currentArray = Array.isArray(next[key]) ? [...(next[key] as unknown[])] : [];
        for (const item of value.items) {
          if (!currentArray.includes(item)) currentArray.push(item);
        }
        next[key] = currentArray;
      } else if (isFieldOp(value, 'arrayRemove')) {
        const currentArray = Array.isArray(next[key]) ? [...(next[key] as unknown[])] : [];
        next[key] = currentArray.filter((item) => !value.items.includes(item));
      } else {
        next[key] = value;
      }
    }
    this.db.docs.set(this.path, next);
  }

  async delete(): Promise<void> {
    this.db.docs.set(this.path, null);
  }
}

function isFieldOp(
  value: unknown,
  op: 'arrayUnion' | 'arrayRemove',
): value is { __op: string; items: unknown[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __op?: unknown }).__op === op &&
    Array.isArray((value as { items?: unknown }).items)
  );
}

const ctx = {
  auditActor: 'user:admin',
  // `deleteUser` needs the caller for the talon store's audit context; other
  // action cores ignore the extra field.
  actor: { type: 'user' as const, userId: 'admin', role: 'superadmin' as const, siteRoles: {} },
  endpoint: '/test',
  method: 'POST',
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('setUserRole', () => {
  it('updates a role and emits role-change audit metadata', async () => {
    const db = new FakeDb();
    db.seed('users/admin', { role: 'superadmin' });
    db.seed('users/alice', { role: 'member' });

    const result = await setUserRole(ctx, {
      uid: 'alice',
      role: 'admin',
      db: db.asFirestore(),
    });

    expect(result).toEqual({
      kind: 'updated',
      previousRole: 'member',
      newRole: 'admin',
    });
    expect(db.docs.get('users/alice')?.role).toBe('admin');
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'user_mutated',
        targetId: 'alice',
        attributes: expect.objectContaining({ from: 'member', to: 'admin' }),
      }),
    );
  });

  it('blocks demotion of the last active superadmin', async () => {
    const db = new FakeDb();
    db.seed('users/admin', { role: 'superadmin' });

    const result = await setUserRole(ctx, {
      uid: 'admin',
      role: 'member',
      db: db.asFirestore(),
    });

    expect(result).toEqual({ kind: 'last_superadmin', activeSuperadmins: 1 });
    expect(db.docs.get('users/admin')?.role).toBe('superadmin');
  });
});

describe('assignSiteToUser', () => {
  it('adds site ids via arrayUnion after validating user and sites', async () => {
    const db = new FakeDb();
    db.seed('users/alice', { sites: ['site-a'] });
    db.seed('sites/site-a', { name: 'a' });
    db.seed('sites/site-b', { name: 'b' });

    const result = await assignSiteToUser(ctx, {
      uid: 'alice',
      siteIds: ['site-a', 'site-b'],
      db: db.asFirestore(),
    });

    expect(result).toEqual({
      kind: 'updated',
      assignedSiteIds: ['site-a', 'site-b'],
    });
    expect(db.docs.get('users/alice')?.sites).toEqual(['site-a', 'site-b']);
  });

  it('rejects unknown sites without mutating membership', async () => {
    const db = new FakeDb();
    db.seed('users/alice', { sites: [] });
    db.seed('sites/site-a', { name: 'a' });

    const result = await assignSiteToUser(ctx, {
      uid: 'alice',
      siteIds: ['site-a', 'site-z'],
      db: db.asFirestore(),
    });

    expect(result).toEqual({ kind: 'unknown_sites', unknownSites: ['site-z'] });
    expect(db.docs.get('users/alice')?.sites).toEqual([]);
  });
});

describe('removeSiteFromUser', () => {
  it('removes site ids via arrayRemove and reports cancel sweep count', async () => {
    const db = new FakeDb();
    db.seed('users/alice', { sites: ['site-a', 'site-b', 'site-c'] });

    const result = await removeSiteFromUser(ctx, {
      uid: 'alice',
      siteIds: ['site-a', 'site-b'],
      db: db.asFirestore(),
      cancelCommands: jest.fn(async () => 2),
    });

    expect(result).toEqual({
      kind: 'updated',
      removedSiteIds: ['site-a', 'site-b'],
      cancelledCommandCount: 2,
    });
    expect(db.docs.get('users/alice')?.sites).toEqual(['site-c']);
  });
});

describe('deleteUser', () => {
  /** A db holding one soft-deletable author, one successor, and their talons. */
  function talonDb(): FakeDb {
    const db = new FakeDb();
    db.seed('users/bob', { role: 'admin', sites: ['site-a'] });
    // Bob's authority to inherit the talons is his membership on site-a. The
    // global `admin` above grants nothing on a site.
    db.seed('sites/site-a/members/bob', {
      uid: 'bob',
      role: 'admin',
      status: 'active',
      addedAt: new Date(0),
      addedBy: 'system:test',
    });
    db.seed('sites/site-a/talons/t1', {
      name: 'nightly restart',
      enabled: true,
      outputs: [{ type: 'email' }],
      createdBy: 'alice',
    });
    db.seed('sites/site-a/talons/t2', {
      name: 'morning check',
      enabled: true,
      outputs: [{ type: 'email' }],
      createdBy: 'alice',
    });
    return db;
  }

  it('delegates to the user-delete cascade and audits successful deletes', async () => {
    mockDeleteCascade.mockResolvedValue({
      kind: 'deleted',
      deletedAt: 123,
      transferredSites: ['site-a'],
      revokedKeyIds: ['key-1'],
    });

    const result = await deleteUser(ctx, {
      uid: 'alice',
      successorUid: 'bob',
      db: new FakeDb().asFirestore(),
    });

    expect(result.kind).toBe('deleted');
    expect(mockDeleteCascade).toHaveBeenCalledWith('alice', {
      successorUid: 'bob',
    });
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'user_mutated',
        targetId: 'alice',
        attributes: expect.objectContaining({ verb: 'soft_deleted' }),
      }),
    );
  });

  it('reports the authored-talon count without touching them by default', async () => {
    mockDeleteCascade.mockResolvedValue({
      kind: 'deleted',
      deletedAt: 123,
      transferredSites: [],
      revokedKeyIds: [],
    });
    const db = talonDb();

    const result = await deleteUser(ctx, {
      uid: 'alice',
      successorUid: 'bob',
      db: db.asFirestore(),
    });

    // The count is the warning; without `reassignTalons` nothing moves — an api
    // client that always passed `successorUid` must not suddenly find it
    // rewriting authorship.
    expect(result).toMatchObject({
      kind: 'deleted',
      authoredTalonCount: 2,
      reassignedTalonIds: [],
      talonReassignFailures: [],
    });
    expect(db.docs.get('sites/site-a/talons/t1')?.createdBy).toBe('alice');
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'user_mutated',
        attributes: expect.objectContaining({
          authoredTalonCount: 2,
          reassignedTalonCount: 0,
        }),
      }),
    );
  });

  it('hands the talons to the successor when asked', async () => {
    mockDeleteCascade.mockResolvedValue({
      kind: 'deleted',
      deletedAt: 123,
      transferredSites: [],
      revokedKeyIds: [],
    });
    const db = talonDb();

    const result = await deleteUser(ctx, {
      uid: 'alice',
      successorUid: 'bob',
      reassignTalons: true,
      db: db.asFirestore(),
    });

    expect(result).toMatchObject({
      kind: 'deleted',
      authoredTalonCount: 2,
      talonReassignFailures: [],
    });
    expect((result as { reassignedTalonIds: string[] }).reassignedTalonIds.sort()).toEqual([
      't1',
      't2',
    ]);
    expect(db.docs.get('sites/site-a/talons/t1')?.createdBy).toBe('bob');
    expect(db.docs.get('sites/site-a/talons/t2')?.createdBy).toBe('bob');
  });

  it('records the site when the successor cannot author there, and still deletes', async () => {
    mockDeleteCascade.mockResolvedValue({
      kind: 'deleted',
      deletedAt: 123,
      transferredSites: [],
      revokedKeyIds: [],
    });
    const db = talonDb();
    // bob admins site-a only; the site-b talon is out of reach.
    db.seed('sites/site-b/talons/t3', {
      name: 'atrium sweep',
      enabled: true,
      outputs: [{ type: 'email' }],
      createdBy: 'alice',
    });

    const result = await deleteUser(ctx, {
      uid: 'alice',
      successorUid: 'bob',
      reassignTalons: true,
      db: db.asFirestore(),
    });

    // The account is already gone, so a per-site refusal is reported, not
    // thrown — otherwise nobody learns which automations were left behind.
    expect(result).toMatchObject({ kind: 'deleted', authoredTalonCount: 3 });
    const failures = (result as { talonReassignFailures: { siteId: string }[] })
      .talonReassignFailures;
    expect(failures).toHaveLength(1);
    expect(failures[0].siteId).toBe('site-b');
    expect(db.docs.get('sites/site-b/talons/t3')?.createdBy).toBe('alice');
    expect(db.docs.get('sites/site-a/talons/t1')?.createdBy).toBe('bob');
  });
});

describe('bootstrapUser', () => {
  it('creates the caller user doc with member defaults', async () => {
    const db = new FakeDb();
    const now = new Date('2026-01-02T03:04:05.000Z');

    const result = await bootstrapUser(ctx, {
      uid: 'uid-1',
      email: 'user@example.com',
      displayName: 'User One',
      timezone: 'America/Los_Angeles',
      db: db.asFirestore(),
      now: () => now,
    });

    expect(result).toEqual({
      kind: 'created',
      uid: 'uid-1',
      email: 'user@example.com',
      displayName: 'User One',
      timezone: 'America/Los_Angeles',
      createdAt: now.getTime(),
    });
    expect(db.docs.get('users/uid-1')).toMatchObject({
      email: 'user@example.com',
      role: 'member',
      mfaEnrolled: false,
      requiresMfaSetup: true,
      // Seeded at creation so a new account is never "legacy", i.e. never needs
      // normalizeMfaFactors to backfill the inventory.
      mfaFactors: { totp: false, passkeys: 0 },
      preferences: {
        temperatureUnit: 'C',
        timezone: 'America/Los_Angeles',
      },
    });
    // The legacy `sites[]` field must NOT be seeded. toMatchObject ignores extra
    // keys, so without this explicit check the assertion above would pass either
    // way — and re-seeding it is precisely what stopped wave 6.1's "field is
    // gone" gate from ever converging.
    expect(db.docs.get('users/uid-1')).not.toHaveProperty('sites');
  });

  it('is idempotent when the user doc already exists', async () => {
    const db = new FakeDb();
    db.seed('users/uid-1', { createdAt: 456, role: 'member' });

    const result = await bootstrapUser(ctx, {
      uid: 'uid-1',
      email: 'user@example.com',
      db: db.asFirestore(),
    });

    expect(result).toEqual({ kind: 'already_exists', createdAt: 456 });
  });

  it('sanitises a spam display name before persisting', async () => {
    const db = new FakeDb();
    const now = new Date('2026-01-02T03:04:05.000Z');

    const result = await bootstrapUser(ctx, {
      uid: 'uid-spam',
      email: 'salavat@example.com',
      displayName: '15K lira bonus kapıda! https://bit.ly/trclicko 🔥 Go',
      db: db.asFirestore(),
      now: () => now,
    });

    expect(result.kind).toBe('created');
    const stored = db.docs.get('users/uid-spam') as { displayName: string };
    expect(stored.displayName).toBe('15K lira bonus kapıda! 🔥 Go');
    expect(stored.displayName).not.toContain('bit.ly');
    expect(stored.displayName).not.toMatch(/https?:/i);
  });
});

describe('site CRUD actions', () => {
  const CREATE_NOW = new Date('2026-02-03T04:05:06.000Z');

  beforeEach(() => {
    mockSiteSlotAvailable.mockResolvedValue(true);
  });

  /** Run createSite against `db` with the fixed clock and stable inputs. */
  function runCreateSite(db: FakeDb, siteId = 'site-a') {
    return createSite(ctx, {
      siteId,
      name: '  Main Gallery  ',
      ownerUid: 'owner-1',
      timezone: 'Not/AZone',
      db: db.asFirestore(),
      now: () => CREATE_NOW,
    });
  }

  it('createSite writes the site document and the creator\'s membership together', async () => {
    const db = new FakeDb();
    db.seed('users/owner-1', { sites: [] });

    const result = await runCreateSite(db);

    expect(result).toMatchObject({
      kind: 'created',
      siteId: 'site-a',
      name: 'Main Gallery',
      owner: 'owner-1',
      timezone: 'Not/AZone',
    });
    expect(db.docs.get('sites/site-a')).toMatchObject({
      name: 'Main Gallery',
      owner: 'owner-1',
      timezone: 'Not/AZone',
    });
    // Regression: stamping `owner` alone left the site invisible to its creator,
    // because the client list resolves `users/{uid}.sites[]` and never queries
    // by owner. The membership assertion is the point — an owner-only write
    // passes every other assertion here.
    expect(db.docs.get('users/owner-1')?.sites).toEqual(['site-a']);

    // ...and the NEW shape, in the SAME batch. This was written as a helper in
    // wave 2 and never actually called, so site creation kept minting owners
    // with no member document. That makes the wave 3 backfill target MOVE —
    // every site created after it would need repairing again — and leaves
    // wave 4's fallback counter unable to reach the zero wave 6 waits on.
    expect(db.docs.get('sites/site-a/members/owner-1')).toMatchObject({
      uid: 'owner-1',
      role: 'owner',
      status: 'active',
    });
    // the owner is the payer, so the slot asked about is theirs.
    expect(mockSiteSlotAvailable).toHaveBeenCalledWith('owner-1');
  });

  it('createSite refuses an owner with no site slot left, and writes nothing', async () => {
    const db = new FakeDb();
    db.seed('users/owner-1', { sites: ['existing-site'] });
    mockSiteSlotAvailable.mockResolvedValue(false);

    const result = await runCreateSite(db);

    expect(result).toEqual({ kind: 'plan_limit' });
    expect(db.docs.get('sites/site-a')).toBeUndefined();
    expect(db.docs.get('sites/site-a/members/owner-1')).toBeUndefined();
    expect(db.docs.get('users/owner-1')?.sites).toEqual(['existing-site']);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('createSite answers a taken or invalid id before asking about the plan', async () => {
    const db = new FakeDb();
    db.seed('users/owner-1', { sites: [] });
    db.seed('sites/site-a', { name: 'taken', owner: 'someone-else' });
    mockSiteSlotAvailable.mockResolvedValue(false);

    expect(await runCreateSite(db)).toEqual({ kind: 'already_exists' });
    expect(await runCreateSite(db, 'Not A Valid Id!')).toMatchObject({ kind: 'invalid_site_id' });
    expect(mockSiteSlotAvailable).not.toHaveBeenCalled();
  });

  it('createSite preserves memberships the creator already had', async () => {
    const db = new FakeDb();
    db.seed('users/owner-1', { sites: ['existing-site'] });

    await runCreateSite(db);

    // arrayUnion, not overwrite — a second site must not drop access to the first.
    expect(db.docs.get('users/owner-1')?.sites).toEqual(['existing-site', 'site-a']);
  });

  it('createSite creates no site when the creator has no user document', async () => {
    const db = new FakeDb();

    await expect(runCreateSite(db)).rejects.toThrow();

    // The batch fails as a unit, so no orphaned site doc survives. The route's
    // assertActiveUser makes this unreachable in prod; the guard is here so a
    // future caller that skips it fails loudly instead of recreating the bug.
    expect(db.docs.get('sites/site-a')).toBeUndefined();
  });

  it('updateSite writes whitelisted fields and allows arbitrary timezone strings', async () => {
    const db = new FakeDb();
    db.seed('sites/site-a', { name: 'old', timezone: 'UTC' });

    const result = await updateSite(ctx, {
      siteId: 'site-a',
      name: '  new name  ',
      timezone: 'Not/AZone',
      timeFormat: '24h',
      // The echoed `updated` map is string-or-boolean now; assert the boolean
      // alongside the strings rather than in a separate shape.
      schedulesFollowSiteTime: true,
      db: db.asFirestore(),
    });

    expect(result).toEqual({
      kind: 'updated',
      updated: {
        name: 'new name',
        timezone: 'Not/AZone',
        timeFormat: '24h',
        schedulesFollowSiteTime: true,
      },
    });
    expect(db.docs.get('sites/site-a')).toMatchObject({
      name: 'new name',
      timezone: 'Not/AZone',
      timeFormat: '24h',
      schedulesFollowSiteTime: true,
    });
  });

  describe('updateSite schedulesFollowSiteTime', () => {
    it('enables site time when the stored timezone already covers it', async () => {
      const db = new FakeDb();
      db.seed('sites/site-a', { name: 'a', timezone: 'America/Los_Angeles' });

      const result = await updateSite(ctx, {
        siteId: 'site-a',
        schedulesFollowSiteTime: true,
        db: db.asFirestore(),
      });

      expect(result).toEqual({
        kind: 'updated',
        updated: { schedulesFollowSiteTime: true },
      });
    });

    // NEGATIVE CONTROL for the guard above: same call, same flag, only the
    // timezone removed. If the guard is ever dropped this is the test that
    // fails, and it fails on the exact condition the guard exists for.
    it('refuses to enable site time on a site with no timezone', async () => {
      const db = new FakeDb();
      db.seed('sites/site-a', { name: 'a' });

      const result = await updateSite(ctx, {
        siteId: 'site-a',
        schedulesFollowSiteTime: true,
        db: db.asFirestore(),
      });

      expect(result.kind).toBe('invalid_schedule_tz_flag');
      expect(db.docs.get('sites/site-a')).not.toHaveProperty('schedulesFollowSiteTime');
      expect(mockEmitMutation).not.toHaveBeenCalled();
    });

    it('refuses to enable site time when the stored timezone is blank', async () => {
      const db = new FakeDb();
      db.seed('sites/site-a', { name: 'a', timezone: '   ' });

      const result = await updateSite(ctx, {
        siteId: 'site-a',
        schedulesFollowSiteTime: true,
        db: db.asFirestore(),
      });

      expect(result.kind).toBe('invalid_schedule_tz_flag');
      expect(db.docs.get('sites/site-a')).not.toHaveProperty('schedulesFollowSiteTime');
    });

    it('refuses to enable site time when the same write blanks the timezone', async () => {
      const db = new FakeDb();
      db.seed('sites/site-a', { name: 'a', timezone: 'America/Los_Angeles' });

      const result = await updateSite(ctx, {
        siteId: 'site-a',
        timezone: '',
        schedulesFollowSiteTime: true,
        db: db.asFirestore(),
      });

      // The guard reads the post-write timezone, not the stored one, so a
      // request that clears the timezone cannot smuggle the flag past it.
      expect(result.kind).toBe('invalid_schedule_tz_flag');
      expect(db.docs.get('sites/site-a')).toMatchObject({
        timezone: 'America/Los_Angeles',
      });
    });

    // The escape hatch: a touring site declines, and it owes no timezone to do
    // so. `false` must reach the document — a truthiness check would drop it and
    // leave the site indistinguishable from one that was never asked.
    it('accepts a decline on a site with no timezone at all', async () => {
      const db = new FakeDb();
      db.seed('sites/site-a', { name: 'a' });

      const result = await updateSite(ctx, {
        siteId: 'site-a',
        schedulesFollowSiteTime: false,
        db: db.asFirestore(),
      });

      expect(result).toEqual({
        kind: 'updated',
        updated: { schedulesFollowSiteTime: false },
      });
      expect(db.docs.get('sites/site-a')).toMatchObject({
        schedulesFollowSiteTime: false,
      });
    });

    it('rejects a non-boolean flag before touching the document', async () => {
      const db = new FakeDb();
      db.seed('sites/site-a', { name: 'a', timezone: 'America/Los_Angeles' });

      const result = await updateSite(ctx, {
        siteId: 'site-a',
        schedulesFollowSiteTime: 'true' as unknown as boolean,
        db: db.asFirestore(),
      });

      expect(result.kind).toBe('invalid_schedule_tz_flag');
      expect(db.docs.get('sites/site-a')).not.toHaveProperty('schedulesFollowSiteTime');
    });

    it('leaves the stored decision alone when the flag is omitted', async () => {
      const db = new FakeDb();
      db.seed('sites/site-a', { name: 'a', timezone: 'UTC', schedulesFollowSiteTime: true });

      await updateSite(ctx, {
        siteId: 'site-a',
        name: 'renamed',
        db: db.asFirestore(),
      });

      expect(db.docs.get('sites/site-a')).toMatchObject({
        name: 'renamed',
        schedulesFollowSiteTime: true,
      });
    });
  });

  describe('createSite schedulesFollowSiteTime', () => {
    it('leaves the field off the document when the caller says nothing', async () => {
      const db = new FakeDb();
      db.seed('users/owner-1', { sites: [] });

      const result = await runCreateSite(db);

      // "Never asked" is a state the document must be able to hold: stamping
      // `false` at creation would silently answer the question for the operator.
      expect(db.docs.get('sites/site-a')).not.toHaveProperty('schedulesFollowSiteTime');
      expect(result).toMatchObject({ schedulesFollowSiteTime: false });
    });

    it('records an explicit opt-in on the new site', async () => {
      const db = new FakeDb();
      db.seed('users/owner-1', { sites: [] });

      const result = await createSite(ctx, {
        siteId: 'site-a',
        name: 'Main Gallery',
        ownerUid: 'owner-1',
        timezone: 'America/Los_Angeles',
        schedulesFollowSiteTime: true,
        db: db.asFirestore(),
        now: () => CREATE_NOW,
      });

      expect(result).toMatchObject({ kind: 'created', schedulesFollowSiteTime: true });
      expect(db.docs.get('sites/site-a')).toMatchObject({
        schedulesFollowSiteTime: true,
      });
    });

    it('records an explicit decline on the new site', async () => {
      const db = new FakeDb();
      db.seed('users/owner-1', { sites: [] });

      const result = await createSite(ctx, {
        siteId: 'site-a',
        name: 'Main Gallery',
        ownerUid: 'owner-1',
        schedulesFollowSiteTime: false,
        db: db.asFirestore(),
        now: () => CREATE_NOW,
      });

      expect(result).toMatchObject({ schedulesFollowSiteTime: false });
      expect(db.docs.get('sites/site-a')).toMatchObject({
        schedulesFollowSiteTime: false,
      });
    });
  });

  it('deleteSite cascades: subcollections, member rows and agent credentials', async () => {
    const db = new FakeDb();
    db.seed('sites/site-a', { name: 'a', owner: 'alice' });
    db.seed('sites/site-a/machines/machine-1', { online: true });
    db.seed('sites/site-a/members/alice', { uid: 'alice', role: 'owner', status: 'active' });
    db.seed('sites/site-a/members/bob', { uid: 'bob', role: 'member', status: 'active' });
    db.seed('users/alice', { sites: ['site-a', 'site-z'] });
    db.seed('users/bob', { sites: ['site-a'] });
    db.seed('agent_refresh_tokens/tok-1', { siteId: 'site-a', machineId: 'machine-1' });
    db.seed('agent_refresh_tokens/tok-other', { siteId: 'site-other' });

    const result = await deleteSite(ctx, { siteId: 'site-a', db: db.asFirestore() });

    expect(result).toEqual({ kind: 'deleted', siteId: 'site-a' });
    expect(db.docs.get('sites/site-a')).toBeNull();
    // Subcollections go with it — Firestore would otherwise leave these orphaned
    // under an id nobody can reach.
    expect(db.docs.get('sites/site-a/machines/machine-1')).toBeNull();
    expect(db.docs.get('sites/site-a/members/alice')).toBeNull();

    // The credential is revoked, and only for THIS site.
    expect(db.docs.get('agent_refresh_tokens/tok-1')).toBeNull();
    expect(db.docs.get('agent_refresh_tokens/tok-other')).toEqual({ siteId: 'site-other' });

    // Every member's legacy pointer is cleared, and their other sites survive.
    // A dead id left here strands `membership_fallback` drift forever.
    expect((db.docs.get('users/alice') as { sites: string[] }).sites).toEqual(['site-z']);
    expect((db.docs.get('users/bob') as { sites: string[] }).sites).toEqual([]);

    // The tombstone still lands, so the slug cannot be re-registered.
    expect(db.docs.get('site_ids/site-a')).toBeTruthy();

    // The cascade makes the site invisible to the chunk GC, which enumerates with
    // listDocuments() and so previously still found a site that had only
    // subcollections left. Without this record the R2 prefix is unreachable forever.
    const orphan = db.docs.get('deleted_sites/site-a') as {
      r2PrefixesToReclaim: string[];
      reclaimed: boolean;
    };
    expect(orphan.r2PrefixesToReclaim).toEqual([
      'project-content/site-a',
      'project-manifests/site-a',
    ]);
    expect(orphan.reclaimed).toBe(false);
  });

  it('deleteSite survives a member row whose user document is gone', async () => {
    // A member row can outlive its user: a hard-deleted account, or a site whose
    // declared owner was never a real user. `update()` on a missing document
    // fails the whole batch with NOT_FOUND, which aborted the delete and left the
    // site half-dismantled. Caught by e2e, where site fixtures are owned by a
    // 'someone-else' uid that has no user document.
    const db = new FakeDb();
    db.seed('sites/site-a', { name: 'a', owner: 'someone-else' });
    db.seed('sites/site-a/members/someone-else', {
      uid: 'someone-else',
      role: 'owner',
      status: 'active',
    });
    db.seed('sites/site-a/members/alice', { uid: 'alice', role: 'member', status: 'active' });
    db.seed('users/alice', { sites: ['site-a'] });

    const result = await deleteSite(ctx, { siteId: 'site-a', db: db.asFirestore() });

    expect(result).toEqual({ kind: 'deleted', siteId: 'site-a' });
    expect(db.docs.get('sites/site-a')).toBeNull();
    // The real member is still cleaned up; the phantom one is simply skipped
    // rather than resurrected as a user document.
    expect((db.docs.get('users/alice') as { sites: string[] }).sites).toEqual([]);
    expect(db.docs.get('users/someone-else')).toBeUndefined();
  });

  it('deleteSite revokes agent credentials BEFORE removing the site', async () => {
    // Ordering is the point: a refresh token outlives the site document, so
    // revoking last leaves a window where the site is gone and an agent can still
    // mint access tokens against it.
    const db = new FakeDb();
    db.seed('sites/site-a', { name: 'a' });
    db.seed('agent_refresh_tokens/tok-1', { siteId: 'site-a' });

    const order: string[] = [];
    const real = db.recursiveDelete.bind(db);
    db.recursiveDelete = async (ref: FakeDoc) => {
      order.push('site-deleted');
      return real(ref);
    };
    const realBatch = db.batch.bind(db);
    db.batch = () => {
      const b = realBatch();
      const commit = b.commit;
      b.commit = async () => {
        order.push('batch-committed');
        return commit();
      };
      return b;
    };

    await deleteSite(ctx, { siteId: 'site-a', db: db.asFirestore() });

    expect(order[0]).toBe('batch-committed');
    expect(order[order.length - 1]).toBe('site-deleted');
  });
});
