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
    serverTimestamp: () => '__SERVER_TS__',
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

/** the collection's direct children matching one equality, as a query snapshot. */
function query(colPath: string, field?: string, value?: unknown) {
  const ids = [...docs.entries()]
    .filter(([p, d]) => d !== null && p.startsWith(`${colPath}/`) && !p.slice(colPath.length + 1).includes('/'))
    .filter(([, d]) => field === undefined || (d as Record<string, unknown>)[field] === value)
    .map(([p, d]) => ({ id: p.slice(colPath.length + 1), data: () => d }));
  return { docs: ids };
}

// the plan check lists the successor's sites outside the transaction.
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
    // the billing hand-over's write, after the transaction. one level of field path is all it uses.
    update: async (patch: Record<string, unknown>) => {
      const next: Record<string, unknown> = { ...(docs.get(path) ?? {}) };
      for (const [key, value] of Object.entries(patch)) {
        const [head, field] = key.split('.');
        next[head] = field ? { ...(next[head] as object), [field]: value } : value;
      }
      docs.set(path, next);
      versions.set(path, versionOf(path) + 1);
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

// the real resolver runs over tridant's answer per site.
const mockGetSiteEntitlements = jest.fn();
const mockInvalidate = jest.fn();
jest.mock('@/lib/tridantEntitlements.server', () => ({
  getSiteEntitlements: (siteId: string) => mockGetSiteEntitlements(siteId),
  invalidateSiteEntitlements: (siteId: string) => mockInvalidate(siteId),
}));

const mockStopSite = jest.fn();
jest.mock('@/lib/tridantBilling.server', () => ({
  stopSite: (siteId: string) => mockStopSite(siteId),
}));

const mockRegisterSite = jest.fn();
jest.mock('@/lib/planTrial.server', () => ({
  registerSite: (...args: unknown[]) => mockRegisterSite(...args),
}));

import logger from '@/lib/logger';
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

const FREE = {
  ok: true,
  resolved: false,
  standing: 'expired',
  inGoodStanding: false,
  graceUntil: null,
  ent: { 'owlette.sites': '1', 'owlette.machines': '1' },
  epoch: null,
  orgId: null,
  billing: null,
};
// in good standing with no flags sent, so every feature reads unrestricted: the site reads as pro.
const PAID = { ...FREE, resolved: true, standing: 'active', inGoodStanding: true, orgId: 'org_owner' };
const TRIAL = { ...PAID, standing: 'trialing' };
const CORE = { ...PAID, ent: { ...FREE.ent, 'owlette.control': '1', 'owlette.deployments': '0', 'owlette.roost': '0' } };

/** plans enforced, with tridant's answer per site; a site not named is free. */
function enforcePlans(bySite: Record<string, unknown> = {}) {
  process.env.PLAN_ENFORCEMENT = 'on';
  process.env.TRIDANT_API_URL = 'https://tridant.test';
  process.env.TRIDANT_LICENSE_KEY = 'test-license-key';
  mockGetSiteEntitlements.mockImplementation(async (siteId: string) => bySite[siteId] ?? FREE);
}

beforeEach(() => {
  mockGetSiteEntitlements.mockReset();
  mockInvalidate.mockReset();
  mockStopSite.mockReset().mockResolvedValue({ ok: true, endsAt: 1793600000000 });
  mockRegisterSite.mockReset().mockResolvedValue(null);
  jest.mocked(logger.error).mockClear();
});

afterEach(() => {
  delete process.env.PLAN_ENFORCEMENT;
  delete process.env.TRIDANT_API_URL;
  delete process.env.TRIDANT_LICENSE_KEY;
});

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

  it('writes a scoped successor an owner row with no machine scope and no swoop mode', async () => {
    // an owner reaches the whole site and always controls, so neither field may outlive the handover
    docs.set(member(ALICE), {
      uid: ALICE,
      role: 'admin',
      status: 'active',
      swoop: 'view',
      machineIds: ['m1'],
    });

    const res = await transferSiteOwnership({ ...base, successorUid: ALICE, actorUid: OWNER, actorIsSuperadmin: false });

    expect(res.ok).toBe(true);
    expect(docs.get(member(ALICE))).toEqual({
      uid: ALICE,
      role: 'owner',
      status: 'active',
      addedAt: NOW,
      addedBy: OWNER,
    });
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

describe("transferSiteOwnership — the successor's free site", () => {
  const transferToAlice = (over: Record<string, unknown> = {}) =>
    transferSiteOwnership({ ...base, successorUid: ALICE, actorUid: OWNER, actorIsSuperadmin: false, ...over });

  beforeEach(() => {
    // the successor already owns one site.
    docs.set('sites/site-b', { owner: ALICE, name: 'Site B' });
  });

  it('refuses a free site when the successor already owns a free one, and writes nothing', async () => {
    enforcePlans();
    const before = new Map(docs);

    const res = await transferToAlice();

    expect(res).toEqual({ ok: false, failure: { kind: 'plan_limit', entitlement: 'owlette.sites' } });
    expect([...docs.entries()]).toEqual([...before.entries()]);
    expect(mockStopSite).not.toHaveBeenCalled();
    expect(mockRegisterSite).not.toHaveBeenCalled();
  });

  it.each([
    ['on core', CORE],
    ['on pro', PAID],
    ['in a trial', TRIAL],
  ])('lets a site %s through beside a free one of theirs: only a free site needs room', async (_plan, answer) => {
    enforcePlans({ [SITE]: answer });

    expect(await transferToAlice()).toEqual({ ok: true, previousOwnerUid: OWNER, newOwnerUid: ALICE });
  });

  it("lets a free site through when the successor's sites are billed or in a trial", async () => {
    docs.set('sites/site-c', { owner: ALICE, name: 'Site C' });
    enforcePlans({ 'site-b': CORE, 'site-c': TRIAL });

    expect((await transferToAlice()).ok).toBe(true);
  });

  it("lets a free site through during the successor's trial, beside a free one of theirs", async () => {
    docs.set(`plan_accounts/${ALICE}`, { trialStartedAt: 1, trialEndsAt: Date.now() + 86_400_000 });
    enforcePlans();

    expect((await transferToAlice()).ok).toBe(true);
  });

  it('POSITIVE CONTROL: a successor with no site takes a free one, whatever machines it holds', async () => {
    enforcePlans();
    docs.delete('sites/site-b');
    docs.set(`sites/${SITE}/machines/m1`, { online: true });
    docs.set(`sites/${SITE}/machines/m2`, { online: true });

    expect((await transferToAlice()).ok).toBe(true);
  });

  it('leaves a superadmin successor unrestricted', async () => {
    enforcePlans();
    docs.set(`users/${ALICE}`, { role: 'superadmin', sites: [] });

    expect((await transferToAlice()).ok).toBe(true);
  });

  it('fails open when tridant cannot be read', async () => {
    enforcePlans({ [SITE]: { ok: false, reason: 'unreachable' } });

    expect((await transferToAlice()).ok).toBe(true);
  });

  it("answers every other refusal first, so a non-owner learns nothing of the successor's plan", async () => {
    enforcePlans();

    const res = await transferToAlice({ actorUid: BOB });

    expect(res).toEqual({ ok: false, failure: { kind: 'not_owner' } });
  });

  it('skips the check for an account deletion, and reads no plan for it', async () => {
    enforcePlans();

    expect((await transferToAlice({ skipPlanCheck: true })).ok).toBe(true);
    expect(mockGetSiteEntitlements).not.toHaveBeenCalled();
  });

  it('asks tridant nothing while enforcement is off', async () => {
    const res = await transferToAlice();

    expect(res.ok).toBe(true);
    expect(mockGetSiteEntitlements).not.toHaveBeenCalled();
    expect(mockStopSite).not.toHaveBeenCalled();
    expect(mockRegisterSite).not.toHaveBeenCalled();
  });
});

describe('transferSiteOwnership — billing follows the transfer', () => {
  const ENDS_AT = 1793600000000;
  const pointer = (endsAt: number | null) => ({ tier: 'pro', founders: false, payerUid: OWNER, endsAt, updatedAt: 1 });
  const billed = (endsAt: number | null) =>
    docs.set(`sites/${SITE}`, { owner: OWNER, name: 'Site A', billing: pointer(endsAt) });
  const siteBilling = () => (docs.get(`sites/${SITE}`) as { billing?: unknown }).billing;
  const transferToAlice = (over: Record<string, unknown> = {}) =>
    transferSiteOwnership({ ...base, successorUid: ALICE, actorUid: OWNER, actorIsSuperadmin: false, ...over });

  beforeEach(() => {
    enforcePlans({ [SITE]: PAID });
  });

  it('stops a running site at the period end, records it on the pointer, then offers the site to the successor', async () => {
    billed(null);

    const res = await transferToAlice();

    expect(res.ok).toBe(true);
    expect(mockStopSite).toHaveBeenCalledWith(SITE);
    expect(docs.get(`sites/${SITE}`)).toMatchObject({
      owner: ALICE,
      billing: { ...pointer(ENDS_AT), updatedAt: '__SERVER_TS__' },
    });
    expect(mockInvalidate).toHaveBeenCalledWith(SITE);
    expect(mockRegisterSite).toHaveBeenCalledWith(ALICE, SITE, 'Site A');
    expect(mockStopSite.mock.invocationCallOrder[0]).toBeLessThan(mockRegisterSite.mock.invocationCallOrder[0]);
  });

  it('leaves a site that is already stopping alone, and still registers it', async () => {
    billed(ENDS_AT);

    await transferToAlice();

    expect(mockStopSite).not.toHaveBeenCalled();
    expect(siteBilling()).toEqual(pointer(ENDS_AT));
    expect(mockRegisterSite).toHaveBeenCalledWith(ALICE, SITE, 'Site A');
  });

  it('only registers a site nobody bills', async () => {
    await transferToAlice();

    expect(mockStopSite).not.toHaveBeenCalled();
    expect(siteBilling()).toBeUndefined();
    expect(mockRegisterSite).toHaveBeenCalledWith(ALICE, SITE, 'Site A');
  });

  it('runs for an account deletion too: the departing owner must not keep paying', async () => {
    billed(null);

    await transferToAlice({ skipPlanCheck: true });

    expect(mockStopSite).toHaveBeenCalledWith(SITE);
    expect(mockRegisterSite).toHaveBeenCalledWith(ALICE, SITE, 'Site A');
  });

  it('keeps the transfer when tridant does not take the stop, and logs it without the pointer changing', async () => {
    billed(null);
    mockStopSite.mockResolvedValue({ ok: false, reason: 'unreachable' });

    const res = await transferToAlice();

    expect(res).toEqual({ ok: true, previousOwnerUid: OWNER, newOwnerUid: ALICE });
    expect(siteBilling()).toEqual(pointer(null));
    expect(logger.error).toHaveBeenCalledWith(
      '[plan] billing not stopped for a transferred site',
      expect.objectContaining({ data: expect.objectContaining({ siteId: SITE, reason: 'unreachable' }) }),
    );
    expect(mockRegisterSite).toHaveBeenCalledWith(ALICE, SITE, 'Site A');
  });

  it('treats a site tridant does not bill as nothing to stop', async () => {
    billed(null);
    mockStopSite.mockResolvedValue({ ok: false, reason: 'rejected', status: 404, code: 'site_not_billed' });

    expect((await transferToAlice()).ok).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('never throws once the transfer has landed', async () => {
    billed(null);
    mockStopSite.mockRejectedValue(new Error('boom'));

    expect((await transferToAlice()).ok).toBe(true);
    expect((docs.get(`sites/${SITE}`) as { owner: string }).owner).toBe(ALICE);

    billed(ENDS_AT);
    mockRegisterSite.mockRejectedValue(new Error('boom'));

    expect((await transferToAlice({ successorUid: BOB })).ok).toBe(true);
  });

  it('does nothing after a refused transfer', async () => {
    billed(null);

    const res = await transferToAlice({ actorUid: BOB });

    expect(res.ok).toBe(false);
    expect(mockStopSite).not.toHaveBeenCalled();
    expect(mockRegisterSite).not.toHaveBeenCalled();
  });

  it('still stops and registers a billed site while plans are not enforced', async () => {
    billed(null);
    delete process.env.PLAN_ENFORCEMENT;

    expect((await transferToAlice()).ok).toBe(true);
    // the old owner is being charged whatever the switch says, and the bulk trial start runs before the switch.
    expect(mockStopSite).toHaveBeenCalledWith(SITE);
    expect(mockRegisterSite).toHaveBeenCalledWith(ALICE, SITE, 'Site A');
  });

  it('registers nothing while tridant id is not configured', async () => {
    delete process.env.PLAN_ENFORCEMENT;
    delete process.env.TRIDANT_LICENSE_KEY;

    expect((await transferToAlice()).ok).toBe(true);
    expect(mockRegisterSite).not.toHaveBeenCalled();
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
