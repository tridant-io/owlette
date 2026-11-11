/** @jest-environment node */

/**
 * Unit tests for `web/lib/membership.server.ts` — Wave 2 task 2.1 of
 * dev/active/per-site-roles.
 *
 * The three invariants under test each closed a live escalation path, so each has
 * a NEGATIVE CONTROL asserting the opposite case still succeeds. A guard that
 * refuses everything passes an it-refuses test just as well as a correct one.
 */

import { FieldValue } from 'firebase-admin/firestore';

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    arrayUnion: (...v: unknown[]) => ({ __arrayUnion: v }),
    arrayRemove: (...v: unknown[]) => ({ __arrayRemove: v }),
    delete: () => ({ __delete: true }),
  },
}));

// --- in-memory Firestore double ---------------------------------------------

type Doc = Record<string, unknown> | null;

const docs = new Map<string, Doc>();
const batchOps: Array<{ op: string; path: string; data?: unknown }> = [];
const txOps: Array<{ op: string; path: string; data?: unknown }> = [];

/** Set by a test to make the next batch.commit() fail like a real create() would. */
let commitError: unknown = null;

function snap(path: string) {
  const data = docs.get(path) ?? null;
  return { exists: data !== null, id: path.split('/').pop(), data: () => data ?? undefined };
}

function ref(path: string) {
  return { __path: path };
}

function pathOf(r: unknown): string {
  return (r as { __path: string }).__path;
}

/** an update() as firestore applies it, with the mocked FieldValue sentinels resolved */
function applyUpdate(path: string, data: Record<string, unknown>) {
  const current = docs.get(path);
  if (!current) throw new Error(`no document to update: ${path}`);
  const next: Record<string, unknown> = { ...current };
  for (const [field, value] of Object.entries(data)) {
    const sentinel = value as { __delete?: true; __arrayRemove?: unknown[]; __arrayUnion?: unknown[] };
    const list = Array.isArray(next[field]) ? (next[field] as unknown[]) : [];
    if (sentinel?.__delete) delete next[field];
    else if (sentinel?.__arrayRemove) next[field] = list.filter((v) => !sentinel.__arrayRemove!.includes(v));
    else if (sentinel?.__arrayUnion) next[field] = [...new Set([...list, ...sentinel.__arrayUnion])];
    else next[field] = value;
  }
  docs.set(path, next);
}

function collection(name: string, parent = ''): unknown {
  const base = parent ? `${parent}/${name}` : name;
  return {
    doc: (id: string) => ({
      ...ref(`${base}/${id}`),
      collection: (sub: string) => collection(sub, `${base}/${id}`),
    }),
    // an array-contains `where` across this collection's own documents only
    where: (field: string, op: string, value: unknown) => ({
      get: async () => {
        if (op !== 'array-contains') throw new Error(`unsupported op ${op}`);
        const hits = [...docs].filter(([path, data]) => {
          const isChild = path.startsWith(`${base}/`) && !path.slice(base.length + 1).includes('/');
          const list = data?.[field];
          return isChild && Array.isArray(list) && list.includes(value);
        });
        return {
          empty: hits.length === 0,
          size: hits.length,
          docs: hits.map(([path, data]) => ({ ref: ref(path), data: () => data ?? undefined })),
        };
      },
    }),
  };
}

const db = {
  collection: (name: string) => collection(name),
  // an equality `where` across every `{parent}/{name}/{id}` document in `docs`
  collectionGroup: (name: string) => ({
    where: (field: string, _op: string, value: unknown) => ({
      get: async () => ({
        docs: [...docs].flatMap(([path, data]) => {
          const [parentId, group] = path.split('/').slice(-3, -1);
          if (group !== name || data?.[field] !== value) return [];
          return [{ ref: { parent: { parent: { id: parentId } } }, data: () => data ?? undefined }];
        }),
      }),
    }),
  }),
  batch: () => {
    // a batch applies only its own writes; batchOps still records every batch's
    const start = batchOps.length;
    return {
      create: (r: unknown, data: unknown) => batchOps.push({ op: 'create', path: pathOf(r), data }),
      set: (r: unknown, data: unknown) => batchOps.push({ op: 'set', path: pathOf(r), data }),
      update: (r: unknown, data: unknown) => batchOps.push({ op: 'update', path: pathOf(r), data }),
      delete: (r: unknown) => batchOps.push({ op: 'delete', path: pathOf(r) }),
      commit: async () => {
        if (commitError) throw commitError;
        const ops = batchOps.slice(start);
        // Apply create() semantics so a second create on the same path throws.
        for (const o of ops) {
          if (o.op === 'create' && docs.get(o.path)) {
            const e = new Error('Document already exists') as Error & { code: number };
            e.code = 6;
            throw e;
          }
        }
        for (const o of ops) {
          if (o.op === 'create' || o.op === 'set') docs.set(o.path, o.data as Doc);
          if (o.op === 'update') applyUpdate(o.path, o.data as Record<string, unknown>);
          if (o.op === 'delete') docs.delete(o.path);
        }
      },
    };
  },
  runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    const start = txOps.length;
    const tx = {
      get: async (r: unknown) => snap(pathOf(r)),
      set: (r: unknown, d: unknown) => txOps.push({ op: 'set', path: pathOf(r), data: d }),
      update: (r: unknown, d: unknown) => txOps.push({ op: 'update', path: pathOf(r), data: d }),
      delete: (r: unknown) => txOps.push({ op: 'delete', path: pathOf(r) }),
    };
    const result = await fn(tx);
    for (const o of txOps.slice(start)) {
      if (o.op === 'set') docs.set(o.path, o.data as Doc);
      if (o.op === 'update') applyUpdate(o.path, o.data as Record<string, unknown>);
      if (o.op === 'delete') docs.delete(o.path);
    }
    return result;
  },
} as unknown as FirebaseFirestore.Firestore;

jest.mock('@/lib/firebase-admin', () => ({ getAdminDb: () => db }));

import {
  addMember,
  updateMember,
  removeMember,
  addOwnerToBatch,
  listUserSiteIds,
  pruneMachineFromMembers,
  ASSIGNABLE_ROLES,
} from '@/lib/membership.server';

const SITE = 'site-a';
const OWNER = 'uid_owner';
const ALICE = 'uid_alice';
const NOW = new Date('2026-09-06T00:00:00.000Z');
const memberPath = (uid: string) => `sites/${SITE}/members/${uid}`;

beforeEach(() => {
  docs.clear();
  batchOps.length = 0;
  txOps.length = 0;
  commitError = null;
  docs.set(`sites/${SITE}`, { owner: OWNER, name: 'Site A' });
  docs.set(`users/${ALICE}`, { role: 'member', sites: [] });
  docs.set(`users/${OWNER}`, { role: 'member', sites: [SITE] });
  docs.set(memberPath(OWNER), { uid: OWNER, role: 'owner', status: 'active' });
});

describe('addMember', () => {
  it('writes the member document AND the legacy sites[] entry in one batch', async () => {
    const res = await addMember({ siteId: SITE, uid: ALICE, role: 'member', addedBy: OWNER, now: () => NOW });

    expect(res.ok).toBe(true);
    // Both shapes, one commit — the dual-write invariant.
    expect(batchOps.map((o) => `${o.op} ${o.path}`)).toEqual([
      `create ${memberPath(ALICE)}`,
      `update users/${ALICE}`,
    ]);
    expect(docs.get(memberPath(ALICE))).toEqual({
      uid: ALICE,
      role: 'member',
      status: 'active',
      addedAt: NOW,
      addedBy: OWNER,
    });
    expect(batchOps[1].data).toEqual({ sites: FieldValue.arrayUnion(SITE) });
  });

  it('uses create(), not set() — so it cannot overwrite an existing row', async () => {
    await addMember({ siteId: SITE, uid: ALICE, role: 'member', addedBy: OWNER, now: () => NOW });
    expect(batchOps.every((o) => o.op !== 'set')).toBe(true);
  });

  it('refuses to overwrite the OWNER row (the site-takeover path)', async () => {
    const res = await addMember({ siteId: SITE, uid: OWNER, role: 'admin', addedBy: ALICE, now: () => NOW });

    expect(res).toEqual({ ok: false, failure: { kind: 'already_member' } });
    // The owner row is untouched — still 'owner', not downgraded to 'admin'.
    expect((docs.get(memberPath(OWNER)) as { role: string }).role).toBe('owner');
  });

  it('refuses a second add of the same member', async () => {
    await addMember({ siteId: SITE, uid: ALICE, role: 'member', addedBy: OWNER, now: () => NOW });
    batchOps.length = 0;
    const res = await addMember({ siteId: SITE, uid: ALICE, role: 'admin', addedBy: OWNER, now: () => NOW });
    expect(res).toEqual({ ok: false, failure: { kind: 'already_member' } });
  });

  it('rejects a role outside admin|member', async () => {
    const res = await addMember({
      siteId: SITE,
      uid: ALICE,
      // Only reachable from unvalidated input; the type forbids it at call sites.
      role: 'owner' as unknown as 'admin',
      addedBy: OWNER,
      now: () => NOW,
    });
    expect(res).toEqual({ ok: false, failure: { kind: 'invalid_role' } });
    expect(batchOps).toHaveLength(0);
  });

  it('rethrows a commit failure that is not ALREADY_EXISTS', async () => {
    commitError = new Error('network down');
    await expect(
      addMember({ siteId: SITE, uid: ALICE, role: 'member', addedBy: OWNER, now: () => NOW }),
    ).rejects.toThrow('network down');
  });

  it('writes the swoop mode it is given', async () => {
    const res = await addMember({
      siteId: SITE,
      uid: ALICE,
      role: 'member',
      swoop: 'control',
      addedBy: OWNER,
      now: () => NOW,
    });

    expect(res.ok).toBe(true);
    expect(docs.get(memberPath(ALICE))).toEqual({
      uid: ALICE,
      role: 'member',
      status: 'active',
      addedAt: NOW,
      addedBy: OWNER,
      swoop: 'control',
    });
  });

  it('without a swoop mode writes exactly the five fields, so the role decides', async () => {
    await addMember({ siteId: SITE, uid: ALICE, role: 'admin', addedBy: OWNER, now: () => NOW });

    // keys, not toEqual: toEqual passes a `swoop: undefined` that firestore would refuse
    expect(Object.keys(docs.get(memberPath(ALICE)) ?? {}).sort()).toEqual([
      'addedAt',
      'addedBy',
      'role',
      'status',
      'uid',
    ]);
  });

  it('writes the machine scope it is given, sorted', async () => {
    const res = await addMember({
      siteId: SITE,
      uid: ALICE,
      role: 'member',
      machineIds: ['m2', 'm1'],
      addedBy: OWNER,
      now: () => NOW,
    });

    expect(res.ok).toBe(true);
    expect(docs.get(memberPath(ALICE))).toEqual({
      uid: ALICE,
      role: 'member',
      status: 'active',
      addedAt: NOW,
      addedBy: OWNER,
      machineIds: ['m1', 'm2'],
    });
  });

  it('refuses an empty scope or one past 30 machines, and writes nothing', async () => {
    const tooMany = Array.from({ length: 31 }, (_, i) => `m${i}`);

    for (const machineIds of [[], tooMany]) {
      const res = await addMember({
        siteId: SITE,
        uid: ALICE,
        role: 'member',
        machineIds,
        addedBy: OWNER,
        now: () => NOW,
      });
      expect(res).toEqual({ ok: false, failure: { kind: 'invalid_machine_ids' } });
    }
    expect(batchOps).toHaveLength(0);
    expect(docs.has(memberPath(ALICE))).toBe(false);

    // NEGATIVE CONTROL: exactly 30 is a scope, not a refusal
    const ok = await addMember({
      siteId: SITE,
      uid: ALICE,
      role: 'member',
      machineIds: tooMany.slice(0, 30),
      addedBy: OWNER,
      now: () => NOW,
    });
    expect(ok.ok).toBe(true);
  });
});

describe('updateMember', () => {
  beforeEach(() => {
    docs.set(memberPath(ALICE), { uid: ALICE, role: 'member', status: 'active' });
  });

  it('promotes a member to admin', async () => {
    const res = await updateMember({ siteId: SITE, uid: ALICE, role: 'admin' });
    expect(res.ok).toBe(true);
    expect(txOps).toEqual([{ op: 'update', path: memberPath(ALICE), data: { role: 'admin' } }]);
  });

  it('refuses to demote the OWNER (admin-demotes-owner)', async () => {
    const res = await updateMember({ siteId: SITE, uid: OWNER, role: 'member' });
    expect(res).toEqual({ ok: false, failure: { kind: 'is_owner' } });
    expect(txOps).toHaveLength(0);
  });

  it('cannot assign owner — the admin-promotes-self-to-owner path', async () => {
    const res = await updateMember({
      siteId: SITE,
      uid: ALICE,
      role: 'owner' as unknown as 'admin',
    });
    expect(res).toEqual({ ok: false, failure: { kind: 'invalid_role' } });
    expect(txOps).toHaveLength(0);
    // NEGATIVE CONTROL: the same call with a legal role does write, so the
    // refusal above is about the role and not a blanket failure.
    const ok = await updateMember({ siteId: SITE, uid: ALICE, role: 'admin' });
    expect(ok.ok).toBe(true);
  });

  it('refuses a uid that is not a member', async () => {
    const res = await updateMember({ siteId: SITE, uid: 'uid_stranger', role: 'admin' });
    expect(res).toEqual({ ok: false, failure: { kind: 'not_member' } });
  });

  it('exports exactly admin and member as assignable', () => {
    expect([...ASSIGNABLE_ROLES]).toEqual(['admin', 'member']);
  });

  it('sets a swoop mode, and null deletes the field rather than storing null', async () => {
    const set = await updateMember({ siteId: SITE, uid: ALICE, swoop: 'control' });
    expect(set.ok).toBe(true);
    expect(txOps).toEqual([{ op: 'update', path: memberPath(ALICE), data: { swoop: 'control' } }]);

    txOps.length = 0;
    const cleared = await updateMember({ siteId: SITE, uid: ALICE, swoop: null });
    expect(cleared.ok).toBe(true);
    expect(txOps).toEqual([
      { op: 'update', path: memberPath(ALICE), data: { swoop: FieldValue.delete() } },
    ]);
  });

  it('a role-only change keeps an existing swoop mode', async () => {
    docs.set(memberPath(ALICE), { uid: ALICE, role: 'admin', status: 'active', swoop: 'control' });

    const res = await updateMember({ siteId: SITE, uid: ALICE, role: 'member' });

    // the write names the role alone, so the stored mode is left where it was
    expect(txOps).toEqual([{ op: 'update', path: memberPath(ALICE), data: { role: 'member' } }]);
    expect(res).toEqual({
      ok: true,
      value: {
        before: { role: 'admin', swoop: 'control', machineIds: null },
        after: { role: 'member', swoop: 'control', machineIds: null },
      },
    });
  });

  it('returns the access before and after the write', async () => {
    const res = await updateMember({ siteId: SITE, uid: ALICE, role: 'admin', swoop: 'view' });

    expect(res).toEqual({
      ok: true,
      value: {
        before: { role: 'member', swoop: null, machineIds: null },
        after: { role: 'admin', swoop: 'view', machineIds: null },
      },
    });
    expect(txOps).toEqual([
      { op: 'update', path: memberPath(ALICE), data: { role: 'admin', swoop: 'view' } },
    ]);
  });

  it('writes nothing when given none of the three', async () => {
    docs.set(memberPath(ALICE), {
      uid: ALICE,
      role: 'member',
      status: 'active',
      swoop: 'view',
      machineIds: ['m1'],
    });

    const res = await updateMember({ siteId: SITE, uid: ALICE });

    expect(res).toEqual({
      ok: true,
      value: {
        before: { role: 'member', swoop: 'view', machineIds: ['m1'] },
        after: { role: 'member', swoop: 'view', machineIds: ['m1'] },
      },
    });
    expect(txOps).toHaveLength(0);
  });

  it('a machine scope alone keeps the role and the swoop mode', async () => {
    docs.set(memberPath(ALICE), { uid: ALICE, role: 'admin', status: 'active', swoop: 'view' });

    const res = await updateMember({ siteId: SITE, uid: ALICE, machineIds: ['m2', 'm1'] });

    expect(txOps).toEqual([
      { op: 'update', path: memberPath(ALICE), data: { machineIds: ['m1', 'm2'] } },
    ]);
    expect(res).toEqual({
      ok: true,
      value: {
        before: { role: 'admin', swoop: 'view', machineIds: null },
        after: { role: 'admin', swoop: 'view', machineIds: ['m1', 'm2'] },
      },
    });
    expect(docs.get(memberPath(ALICE))).toEqual({
      uid: ALICE,
      role: 'admin',
      status: 'active',
      swoop: 'view',
      machineIds: ['m1', 'm2'],
    });
  });

  it('a role-only or swoop-only change keeps an existing machine scope', async () => {
    docs.set(memberPath(ALICE), { uid: ALICE, role: 'member', status: 'active', machineIds: ['m1'] });

    // a scoped member promoted to admin stays scoped: scoped admins exist
    const promoted = await updateMember({ siteId: SITE, uid: ALICE, role: 'admin' });
    expect(promoted).toEqual({
      ok: true,
      value: {
        before: { role: 'member', swoop: null, machineIds: ['m1'] },
        after: { role: 'admin', swoop: null, machineIds: ['m1'] },
      },
    });

    const moded = await updateMember({ siteId: SITE, uid: ALICE, swoop: 'control' });
    expect(moded).toEqual({
      ok: true,
      value: {
        before: { role: 'admin', swoop: null, machineIds: ['m1'] },
        after: { role: 'admin', swoop: 'control', machineIds: ['m1'] },
      },
    });

    expect(txOps.map((o) => o.data)).toEqual([{ role: 'admin' }, { swoop: 'control' }]);
    expect(docs.get(memberPath(ALICE))).toEqual({
      uid: ALICE,
      role: 'admin',
      status: 'active',
      swoop: 'control',
      machineIds: ['m1'],
    });
  });

  it('null deletes the machine scope, so the person reaches the whole site', async () => {
    docs.set(memberPath(ALICE), { uid: ALICE, role: 'member', status: 'active', machineIds: ['m1'] });

    const res = await updateMember({ siteId: SITE, uid: ALICE, machineIds: null });

    expect(txOps).toEqual([
      { op: 'update', path: memberPath(ALICE), data: { machineIds: FieldValue.delete() } },
    ]);
    expect(res).toEqual({
      ok: true,
      value: {
        before: { role: 'member', swoop: null, machineIds: ['m1'] },
        after: { role: 'member', swoop: null, machineIds: null },
      },
    });
    expect(docs.get(memberPath(ALICE))).not.toHaveProperty('machineIds');
  });

  it('writes role, swoop and machine scope together in one call', async () => {
    const res = await updateMember({
      siteId: SITE,
      uid: ALICE,
      role: 'admin',
      swoop: 'view',
      machineIds: ['m3', 'm1', 'm3'],
    });

    expect(txOps).toEqual([
      {
        op: 'update',
        path: memberPath(ALICE),
        data: { role: 'admin', swoop: 'view', machineIds: ['m1', 'm3'] },
      },
    ]);
    expect(res).toEqual({
      ok: true,
      value: {
        before: { role: 'member', swoop: null, machineIds: null },
        after: { role: 'admin', swoop: 'view', machineIds: ['m1', 'm3'] },
      },
    });
  });

  it('refuses an empty scope or one past 30 machines, and writes nothing', async () => {
    const tooMany = Array.from({ length: 31 }, (_, i) => `m${i}`);

    for (const machineIds of [[], tooMany]) {
      const res = await updateMember({ siteId: SITE, uid: ALICE, role: 'admin', machineIds });
      expect(res).toEqual({ ok: false, failure: { kind: 'invalid_machine_ids' } });
    }
    expect(txOps).toHaveLength(0);
    expect(docs.get(memberPath(ALICE))).toEqual({ uid: ALICE, role: 'member', status: 'active' });
  });

  it('refuses the owner row whatever is sent', async () => {
    const changes = [
      { role: 'member' },
      { role: 'admin' },
      { swoop: 'none' },
      { swoop: 'control' },
      { swoop: null },
      { role: 'member', swoop: 'none' },
      { machineIds: ['m1'] },
      { machineIds: null },
      { role: 'member', swoop: 'none', machineIds: ['m1'] },
      {},
    ] as const;

    for (const change of changes) {
      const res = await updateMember({ siteId: SITE, uid: OWNER, ...change });
      expect(res).toEqual({ ok: false, failure: { kind: 'is_owner' } });
    }
    expect(txOps).toHaveLength(0);
    expect(docs.get(memberPath(OWNER))).toEqual({ uid: OWNER, role: 'owner', status: 'active' });
  });
});

describe('removeMember', () => {
  beforeEach(() => {
    docs.set(memberPath(ALICE), { uid: ALICE, role: 'member', status: 'active' });
    docs.set(`users/${ALICE}`, { role: 'member', sites: [SITE] });
  });

  it('removes the member document AND the legacy sites[] entry', async () => {
    const res = await removeMember({ siteId: SITE, uid: ALICE });
    expect(res.ok).toBe(true);
    expect(txOps).toEqual([
      { op: 'delete', path: memberPath(ALICE) },
      { op: 'update', path: `users/${ALICE}`, data: { sites: FieldValue.arrayRemove(SITE) } },
    ]);
    expect(docs.has(memberPath(ALICE))).toBe(false);
  });

  it('refuses the owner by the LEGACY field, even with no member row', async () => {
    docs.delete(memberPath(OWNER));
    const res = await removeMember({ siteId: SITE, uid: OWNER });
    expect(res).toEqual({ ok: false, failure: { kind: 'is_owner' } });
    expect(txOps).toHaveLength(0);
  });

  it('refuses the owner by the MEMBER ROW, even when the legacy field disagrees', async () => {
    // The divergence this wave exists to end: legacy field names someone else.
    docs.set(`sites/${SITE}`, { owner: 'uid_someone_else' });
    const res = await removeMember({ siteId: SITE, uid: OWNER });
    expect(res).toEqual({ ok: false, failure: { kind: 'is_owner' } });
  });

  it('still removes legacy-only membership that predates the member subcollection', async () => {
    docs.delete(memberPath(ALICE));
    const res = await removeMember({ siteId: SITE, uid: ALICE });
    expect(res.ok).toBe(true);
    // No delete of a row that never existed; the legacy write still happens.
    expect(txOps).toEqual([
      { op: 'update', path: `users/${ALICE}`, data: { sites: FieldValue.arrayRemove(SITE) } },
    ]);
  });

  it('STILL removes when the site is gone — the orphan-cleanup path', async () => {
    // A missing site has no owner to protect, and the membership left pointing
    // at it is the dangling entry that lets a re-registered slug inherit the
    // previous tenant's members. ManageUserSitesDialog's cleanup path depends on
    // this working. (The members DELETE endpoint still 404s on a missing site —
    // it checks that itself, before calling here.)
    docs.delete(`sites/${SITE}`);
    const res = await removeMember({ siteId: SITE, uid: ALICE });
    expect(res.ok).toBe(true);
    expect(txOps).toEqual([
      { op: 'delete', path: memberPath(ALICE) },
      { op: 'update', path: `users/${ALICE}`, data: { sites: FieldValue.arrayRemove(SITE) } },
    ]);
  });
});

describe('addOwnerToBatch', () => {
  it('contributes the owner row to a caller-owned batch without committing', () => {
    const batch = db.batch();
    addOwnerToBatch(batch, { siteId: SITE, ownerUid: ALICE, now: NOW });

    expect(batchOps).toEqual([
      {
        op: 'set',
        path: memberPath(ALICE),
        data: { uid: ALICE, role: 'owner', status: 'active', addedAt: NOW, addedBy: ALICE },
      },
    ]);
    // Nothing applied — createSite's own commit is what makes it atomic.
    expect(docs.has(memberPath(ALICE))).toBe(false);
  });
});

describe('pruneMachineFromMembers', () => {
  it('takes the machine out of every scope that holds it, and leaves [] rather than the whole site', async () => {
    docs.set(memberPath(ALICE), { uid: ALICE, role: 'admin', status: 'active', machineIds: ['m1', 'm2'] });
    docs.set(memberPath('uid_bob'), { uid: 'uid_bob', role: 'member', status: 'active', machineIds: ['m1'] });
    docs.set(memberPath('uid_carol'), { uid: 'uid_carol', role: 'member', status: 'active', machineIds: ['m2'] });
    // collection scope: the same id on another site is that site's machine
    docs.set(`sites/site-b/members/${ALICE}`, { uid: ALICE, role: 'member', status: 'active', machineIds: ['m1'] });

    const pruned = await pruneMachineFromMembers({ siteId: SITE, machineId: 'm1' });

    expect(pruned).toBe(2);
    expect(batchOps).toEqual([
      { op: 'update', path: memberPath(ALICE), data: { machineIds: FieldValue.arrayRemove('m1') } },
      { op: 'update', path: memberPath('uid_bob'), data: { machineIds: FieldValue.arrayRemove('m1') } },
    ]);
    expect(docs.get(memberPath(ALICE))).toHaveProperty('machineIds', ['m2']);
    // the field stays: absent would widen bob to the whole site
    expect(docs.get(memberPath('uid_bob'))).toHaveProperty('machineIds', []);
    expect(docs.get(memberPath('uid_carol'))).toHaveProperty('machineIds', ['m2']);
    expect(docs.get(`sites/site-b/members/${ALICE}`)).toHaveProperty('machineIds', ['m1']);
    expect(docs.get(memberPath(OWNER))).toEqual({ uid: OWNER, role: 'owner', status: 'active' });
  });

  it('writes nothing when no scope holds the machine', async () => {
    expect(await pruneMachineFromMembers({ siteId: SITE, machineId: 'm1' })).toBe(0);
    expect(batchOps).toHaveLength(0);
  });
});

describe('listUserSiteIds', () => {
  it('lists a site only where the row grants a site role, as every gate reads it', async () => {
    docs.set(`sites/site-admin/members/${ALICE}`, { uid: ALICE, role: 'admin', status: 'active' });
    docs.set(`sites/site-viewer/members/${ALICE}`, { uid: ALICE, role: 'viewer', status: 'active' });
    docs.set(`sites/site-invited/members/${ALICE}`, { uid: ALICE, role: 'admin', status: 'invited' });

    expect(await listUserSiteIds(ALICE)).toEqual(['site-admin']);
  });
});
