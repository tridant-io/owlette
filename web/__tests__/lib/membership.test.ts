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

function collection(name: string, parent = ''): unknown {
  const base = parent ? `${parent}/${name}` : name;
  return {
    doc: (id: string) => ({
      ...ref(`${base}/${id}`),
      collection: (sub: string) => collection(sub, `${base}/${id}`),
    }),
  };
}

const db = {
  collection: (name: string) => collection(name),
  batch: () => ({
    create: (r: unknown, data: unknown) => batchOps.push({ op: 'create', path: pathOf(r), data }),
    set: (r: unknown, data: unknown) => batchOps.push({ op: 'set', path: pathOf(r), data }),
    update: (r: unknown, data: unknown) => batchOps.push({ op: 'update', path: pathOf(r), data }),
    delete: (r: unknown) => batchOps.push({ op: 'delete', path: pathOf(r) }),
    commit: async () => {
      if (commitError) throw commitError;
      // Apply create() semantics so a second create on the same path throws.
      for (const o of batchOps) {
        if (o.op === 'create' && docs.get(o.path)) {
          const e = new Error('Document already exists') as Error & { code: number };
          e.code = 6;
          throw e;
        }
      }
      for (const o of batchOps) {
        if (o.op === 'create' || o.op === 'set') docs.set(o.path, o.data as Doc);
        if (o.op === 'delete') docs.delete(o.path);
      }
    },
  }),
  runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      get: async (r: unknown) => snap(pathOf(r)),
      set: (r: unknown, d: unknown) => txOps.push({ op: 'set', path: pathOf(r), data: d }),
      update: (r: unknown, d: unknown) => txOps.push({ op: 'update', path: pathOf(r), data: d }),
      delete: (r: unknown) => txOps.push({ op: 'delete', path: pathOf(r) }),
    };
    const result = await fn(tx);
    for (const o of txOps) {
      if (o.op === 'set') docs.set(o.path, o.data as Doc);
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
        before: { role: 'admin', swoop: 'control' },
        after: { role: 'member', swoop: 'control' },
      },
    });
  });

  it('returns the access before and after the write', async () => {
    const res = await updateMember({ siteId: SITE, uid: ALICE, role: 'admin', swoop: 'view' });

    expect(res).toEqual({
      ok: true,
      value: {
        before: { role: 'member', swoop: null },
        after: { role: 'admin', swoop: 'view' },
      },
    });
    expect(txOps).toEqual([
      { op: 'update', path: memberPath(ALICE), data: { role: 'admin', swoop: 'view' } },
    ]);
  });

  it('writes nothing when given neither field', async () => {
    docs.set(memberPath(ALICE), { uid: ALICE, role: 'member', status: 'active', swoop: 'view' });

    const res = await updateMember({ siteId: SITE, uid: ALICE });

    expect(res).toEqual({
      ok: true,
      value: {
        before: { role: 'member', swoop: 'view' },
        after: { role: 'member', swoop: 'view' },
      },
    });
    expect(txOps).toHaveLength(0);
  });

  it('refuses the owner row whatever is sent', async () => {
    const changes = [
      { role: 'member' },
      { role: 'admin' },
      { swoop: 'none' },
      { swoop: 'control' },
      { swoop: null },
      { role: 'member', swoop: 'none' },
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
