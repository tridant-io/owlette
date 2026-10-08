/** @jest-environment node */

/**
 * Unit tests for `web/lib/actions/transferSiteOwnership.server.ts` — Wave 2 task
 * 2.2 of dev/active/per-site-roles.
 *
 * The task's stated acceptance criterion is the CONCURRENCY test at the bottom:
 * two transfers fired at once must leave exactly one owner. The Firestore double
 * below therefore models the one property that makes that true — a transaction
 * aborts if a document it READ was written by another transaction that committed
 * first. Without that, a concurrency test over a naive fake proves nothing.
 */

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    arrayUnion: (...v: unknown[]) => ({ __arrayUnion: v }),
    arrayRemove: (...v: unknown[]) => ({ __arrayRemove: v }),
  },
}));

type Doc = Record<string, unknown> | null;

const docs = new Map<string, Doc>();
/** Bumped on every committed write, so a reader can detect it was overtaken. */
const versions = new Map<string, number>();

class AbortedError extends Error {}

function versionOf(path: string): number {
  return versions.get(path) ?? 0;
}

/** the collection's direct children matching one equality, as an id-only query snapshot. */
function query(colPath: string, field?: string, value?: unknown) {
  const ids = [...docs.entries()]
    .filter(([p, d]) => d !== null && p.startsWith(`${colPath}/`) && !p.slice(colPath.length + 1).includes('/'))
    .filter(([, d]) => field === undefined || (d as Record<string, unknown>)[field] === value)
    .map(([p]) => ({ id: p.slice(colPath.length + 1) }));
  return { docs: ids };
}

// the plan check counts the successor's sites and machines outside the transaction.
function collection(colPath: string) {
  return {
    doc: (id: string) => ref(`${colPath}/${id}`),
    select: () => ({ get: async () => query(colPath) }),
    where: (field: string, _op: string, value: unknown) => ({
      select: () => ({ get: async () => query(colPath, field, value) }),
    }),
  };
}

function ref(path: string) {
  return {
    __path: path,
    get: async () => {
      const data = docs.get(path) ?? null;
      return { exists: data !== null, data: () => data ?? undefined };
    },
    collection: (sub: string) => collection(`${path}/${sub}`),
  };
}

function pathOf(r: unknown): string {
  return (r as { __path: string }).__path;
}

const db = {
  collection: (name: string) => collection(name),
  /**
   * Optimistic-concurrency transaction. Records the version of every document
   * read; at commit time, if any of them changed, the whole attempt is discarded
   * — which is precisely how Firestore serialises two racing transfers.
   */
  runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const readVersions = new Map<string, number>();
      const writes: Array<{ op: string; path: string; data?: Doc }> = [];
      const tx = {
        get: async (r: unknown) => {
          const p = pathOf(r);
          readVersions.set(p, versionOf(p));
          const data = docs.get(p) ?? null;
          return { exists: data !== null, id: p.split('/').pop(), data: () => data ?? undefined };
        },
        set: (r: unknown, d: Doc) => writes.push({ op: 'set', path: pathOf(r), data: d }),
        update: (r: unknown, d: Doc) => writes.push({ op: 'update', path: pathOf(r), data: d }),
        delete: (r: unknown) => writes.push({ op: 'delete', path: pathOf(r) }),
      };

      const result = await fn(tx);

      // Yield, so a concurrently-started transaction can interleave here — the
      // window a real race would exploit.
      await Promise.resolve();

      const stale = [...readVersions].some(([p, v]) => versionOf(p) !== v);
      if (stale) continue;

      for (const w of writes) {
        if (w.op === 'delete') docs.delete(w.path);
        else if (w.op === 'set') docs.set(w.path, w.data);
        else docs.set(w.path, { ...(docs.get(w.path) ?? {}), ...(w.data ?? {}) });
        versions.set(w.path, versionOf(w.path) + 1);
      }
      return result;
    }
    throw new AbortedError('too much contention');
  },
} as unknown as FirebaseFirestore.Firestore;

jest.mock('@/lib/firebase-admin', () => ({ getAdminDb: () => db }));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGetEntitlements = jest.fn();
jest.mock('@/lib/tridantEntitlements.server', () => ({
  getEntitlements: (uid: string) => mockGetEntitlements(uid),
}));

import { transferSiteOwnership } from '@/lib/actions/transferSiteOwnership.server';

const SITE = 'site-a';
const OWNER = 'uid_owner';
const ALICE = 'uid_alice';
const BOB = 'uid_bob';
const NOW = new Date('2026-09-06T00:00:00.000Z');
const member = (uid: string) => `sites/${SITE}/members/${uid}`;

beforeEach(() => {
  docs.clear();
  versions.clear();
  docs.set(`sites/${SITE}`, { owner: OWNER, name: 'Site A' });
  docs.set(`users/${OWNER}`, { role: 'member', sites: [SITE] });
  docs.set(`users/${ALICE}`, { role: 'member', sites: [] });
  docs.set(`users/${BOB}`, { role: 'admin', sites: [] });
  docs.set(member(OWNER), { uid: OWNER, role: 'owner', status: 'active' });
});

const base = { siteId: SITE, now: () => NOW };

describe('transferSiteOwnership — the happy path', () => {
  it('moves ownership in BOTH shapes and demotes the outgoing owner to admin', async () => {
    const res = await transferSiteOwnership({
      ...base,
      successorUid: ALICE,
      actorUid: OWNER,
      actorIsSuperadmin: false,
    });

    expect(res).toEqual({ ok: true, previousOwnerUid: OWNER, newOwnerUid: ALICE });
    expect((docs.get(`sites/${SITE}`) as { owner: string }).owner).toBe(ALICE);
    expect((docs.get(member(ALICE)) as { role: string }).role).toBe('owner');
    expect((docs.get(member(OWNER)) as { role: string }).role).toBe('admin');
    // The successor gains legacy membership; arrayUnion is what lands.
    expect(docs.get(`users/${ALICE}`)).toMatchObject({ sites: { __arrayUnion: [SITE] } });
  });

  it('keeps the outgoing owner as a member — handing over is not eviction', async () => {
    await transferSiteOwnership({ ...base, successorUid: ALICE, actorUid: OWNER, actorIsSuperadmin: false });
    expect((docs.get(`users/${OWNER}`) as { sites: string[] }).sites).toContain(SITE);
    expect(docs.has(member(OWNER))).toBe(true);
  });

  it('creates an admin row for an outgoing owner who predates the members subcollection', async () => {
    docs.delete(member(OWNER));
    const res = await transferSiteOwnership({ ...base, successorUid: ALICE, actorUid: OWNER, actorIsSuperadmin: false });
    expect(res.ok).toBe(true);
    // set(), not update() — update() on a missing doc fails the whole transaction.
    expect(docs.get(member(OWNER))).toMatchObject({ uid: OWNER, role: 'admin', status: 'active' });
  });

  it('lets a superadmin transfer a site they do not own', async () => {
    const res = await transferSiteOwnership({ ...base, successorUid: ALICE, actorUid: 'uid_sa', actorIsSuperadmin: true });
    expect(res.ok).toBe(true);
    expect((docs.get(`sites/${SITE}`) as { owner: string }).owner).toBe(ALICE);
  });
});

describe('transferSiteOwnership — refusals', () => {
  it('refuses a site admin who is not the owner', async () => {
    const res = await transferSiteOwnership({ ...base, successorUid: ALICE, actorUid: BOB, actorIsSuperadmin: false });
    expect(res).toEqual({ ok: false, failure: { kind: 'not_owner' } });
    expect((docs.get(`sites/${SITE}`) as { owner: string }).owner).toBe(OWNER);
  });

  it('refuses SELF-succession instead of reporting a false success', async () => {
    // The user-delete cascade accepts successorUid === uid and answers success
    // while stranding the site on a soft-deleted owner. This must not repeat.
    const res = await transferSiteOwnership({ ...base, successorUid: OWNER, actorUid: OWNER, actorIsSuperadmin: false });
    expect(res).toEqual({ ok: false, failure: { kind: 'successor_already_owner' } });
  });

  it('refuses a soft-deleted successor', async () => {
    docs.set(`users/${ALICE}`, { role: 'member', sites: [], deletedAt: 1700000000000 });
    const res = await transferSiteOwnership({ ...base, successorUid: ALICE, actorUid: OWNER, actorIsSuperadmin: false });
    expect(res).toEqual({ ok: false, failure: { kind: 'successor_inactive' } });
    expect((docs.get(`sites/${SITE}`) as { owner: string }).owner).toBe(OWNER);
  });

  it('refuses an unknown successor', async () => {
    const res = await transferSiteOwnership({ ...base, successorUid: 'uid_ghost', actorUid: OWNER, actorIsSuperadmin: false });
    expect(res).toEqual({ ok: false, failure: { kind: 'successor_not_found' } });
  });

  it('refuses a missing site', async () => {
    docs.delete(`sites/${SITE}`);
    const res = await transferSiteOwnership({ ...base, successorUid: ALICE, actorUid: OWNER, actorIsSuperadmin: false });
    expect(res).toEqual({ ok: false, failure: { kind: 'site_not_found' } });
  });

  it('refuses an ownerless site rather than inventing an owner', async () => {
    docs.set(`sites/${SITE}`, { name: 'Site A' });
    const res = await transferSiteOwnership({ ...base, successorUid: ALICE, actorUid: OWNER, actorIsSuperadmin: true });
    expect(res).toEqual({ ok: false, failure: { kind: 'site_has_no_owner' } });
  });

  it('writes NOTHING on any refusal', async () => {
    const before = new Map(docs);
    await transferSiteOwnership({ ...base, successorUid: ALICE, actorUid: BOB, actorIsSuperadmin: false });
    expect([...docs.entries()]).toEqual([...before.entries()]);
  });
});

describe("transferSiteOwnership — the successor's plan", () => {
  const FREE = {
    ok: true,
    resolved: false,
    standing: 'expired',
    inGoodStanding: false,
    ent: { 'owlette.sites': '1', 'owlette.machines': '1' },
    epoch: 0,
  };
  const machine = (siteId: string, machineId: string) =>
    docs.set(`sites/${siteId}/machines/${machineId}`, { online: true });

  beforeEach(() => {
    process.env.PLAN_ENFORCEMENT = 'on';
    process.env.TRIDANT_API_URL = 'https://tridant.test';
    process.env.TRIDANT_LICENSE_KEY = 'test-license-key';
    mockGetEntitlements.mockReset().mockResolvedValue(FREE);
  });

  afterEach(() => {
    delete process.env.PLAN_ENFORCEMENT;
    delete process.env.TRIDANT_API_URL;
    delete process.env.TRIDANT_LICENSE_KEY;
  });

  it('refuses a free successor who already owns a site, and writes nothing', async () => {
    docs.set('sites/site-b', { owner: ALICE, name: 'Site B' });
    const before = new Map(docs);

    const res = await transferSiteOwnership({ ...base, successorUid: ALICE, actorUid: OWNER, actorIsSuperadmin: false });

    expect(res).toEqual({ ok: false, failure: { kind: 'plan_limit', entitlement: 'owlette.sites' } });
    expect(mockGetEntitlements).toHaveBeenCalledWith(ALICE);
    expect([...docs.entries()]).toEqual([...before.entries()]);
  });

  it("refuses a free successor when the site brings more machines than the plan covers", async () => {
    machine(SITE, 'm1');
    machine(SITE, 'm2');

    const res = await transferSiteOwnership({ ...base, successorUid: ALICE, actorUid: OWNER, actorIsSuperadmin: false });

    expect(res).toEqual({ ok: false, failure: { kind: 'plan_limit', entitlement: 'owlette.machines' } });
    expect((docs.get(`sites/${SITE}`) as { owner: string }).owner).toBe(OWNER);
  });

  it('POSITIVE CONTROL: a free successor takes a first site with one machine', async () => {
    machine(SITE, 'm1');

    const res = await transferSiteOwnership({ ...base, successorUid: ALICE, actorUid: OWNER, actorIsSuperadmin: false });

    expect(res).toEqual({ ok: true, previousOwnerUid: OWNER, newOwnerUid: ALICE });
  });

  it('does not count a machine the successor already pays for', async () => {
    // already over a one-machine limit; a site bringing only m1 adds nothing to bill.
    mockGetEntitlements.mockResolvedValue({
      ...FREE,
      ent: { 'owlette.sites': 'unlimited', 'owlette.machines': '1' },
    });
    docs.set('sites/site-b', { owner: ALICE, name: 'Site B' });
    machine('site-b', 'm1');
    machine('site-b', 'm2');
    machine(SITE, 'm1');

    const res = await transferSiteOwnership({ ...base, successorUid: ALICE, actorUid: OWNER, actorIsSuperadmin: false });

    expect(res.ok).toBe(true);
  });

  it('leaves a superadmin successor unrestricted', async () => {
    docs.set(`users/${ALICE}`, { role: 'superadmin', sites: [] });
    docs.set('sites/site-b', { owner: ALICE, name: 'Site B' });
    machine(SITE, 'm1');
    machine(SITE, 'm2');

    const res = await transferSiteOwnership({ ...base, successorUid: ALICE, actorUid: OWNER, actorIsSuperadmin: false });

    expect(res.ok).toBe(true);
  });

  it("answers every other refusal first, so a non-owner learns nothing of the successor's plan", async () => {
    docs.set('sites/site-b', { owner: ALICE, name: 'Site B' });

    const res = await transferSiteOwnership({ ...base, successorUid: ALICE, actorUid: BOB, actorIsSuperadmin: false });

    expect(res).toEqual({ ok: false, failure: { kind: 'not_owner' } });
  });

  it('asks tridant nothing while enforcement is off', async () => {
    delete process.env.PLAN_ENFORCEMENT;
    docs.set('sites/site-b', { owner: ALICE, name: 'Site B' });
    machine(SITE, 'm1');
    machine(SITE, 'm2');

    const res = await transferSiteOwnership({ ...base, successorUid: ALICE, actorUid: OWNER, actorIsSuperadmin: false });

    expect(res.ok).toBe(true);
    expect(mockGetEntitlements).not.toHaveBeenCalled();
  });
});

describe('transferSiteOwnership — concurrency (the task 2.2 acceptance criterion)', () => {
  it('two simultaneous transfers leave EXACTLY ONE owner', async () => {
    const [a, b] = await Promise.all([
      transferSiteOwnership({ ...base, successorUid: ALICE, actorUid: OWNER, actorIsSuperadmin: false }),
      transferSiteOwnership({ ...base, successorUid: BOB, actorUid: OWNER, actorIsSuperadmin: false }),
    ]);

    const finalOwner = (docs.get(`sites/${SITE}`) as { owner: string }).owner;
    expect([ALICE, BOB]).toContain(finalOwner);

    // Exactly one member row says 'owner'.
    const owners = [OWNER, ALICE, BOB].filter(
      (uid) => (docs.get(member(uid)) as { role?: string } | undefined)?.role === 'owner',
    );
    expect(owners).toEqual([finalOwner]);

    // The loser must not have half-applied: whichever transfer did not win,
    // its successor holds no owner row.
    const loser = finalOwner === ALICE ? BOB : ALICE;
    expect((docs.get(member(loser)) as { role?: string } | undefined)?.role).not.toBe('owner');

    // EXACTLY ONE call succeeds, and the other is REFUSED — it is not silently
    // applied and not reported as a success. The losing transaction aborts on
    // the contended site document, retries, re-reads the owner INSIDE the new
    // attempt, and finds the actor is no longer the owner. That refusal is the
    // point: a transfer decided against a stale owner must never land.
    const outcomes = [a, b];
    expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
    const refused = outcomes.find((r) => !r.ok) as { ok: false; failure: { kind: string } };
    expect(refused.failure.kind).toBe('not_owner');
  });

  it('a transfer racing a soft-delete of its successor does not strand the site', async () => {
    const transfer = transferSiteOwnership({ ...base, successorUid: ALICE, actorUid: OWNER, actorIsSuperadmin: false });
    // Soft-delete Alice mid-flight; the read of users/{alice} inside the
    // transaction is what makes this abort-and-retry rather than interleave.
    docs.set(`users/${ALICE}`, { role: 'member', sites: [], deletedAt: 1700000000000 });
    versions.set(`users/${ALICE}`, versionOf(`users/${ALICE}`) + 1);

    const res = await transfer;
    const owner = (docs.get(`sites/${SITE}`) as { owner: string }).owner;

    // Either the transfer won the race outright, or it retried and refused.
    // What must never happen is the site landing on the deleted account.
    if (res.ok) {
      expect(owner).toBe(ALICE);
    } else {
      expect(res.failure.kind).toBe('successor_inactive');
      expect(owner).toBe(OWNER);
    }
  });
});
