/** @jest-environment node */

/**
 * ESCALATION SUITE — Wave 2 task 2.5 of dev/active/per-site-roles.
 *
 * Every path the adversarial pass named, driven through the real routes with the
 * real authorization wrappers. Each refusal is paired with a POSITIVE CONTROL —
 * the same call under legitimate conditions — because a guard that refuses
 * everything passes an it-refuses test exactly as well as a correct one.
 *
 * The Firestore double models the ONE property these guards depend on: a
 * transaction aborts when a document it READ was written by another that
 * committed first. Without it, two racing transfers would both "succeed".
 *
 * NEGATIVE CONTROLS RUN 2026-09-06: four of the six guards redden their own test
 * when removed. The other two paths are guarded twice and either layer alone
 * suffices — role=owner (route role validation + changeRole's ASSIGNABLE_ROLES)
 * and remove-owner (the route's early 409 + removeMember's owner vetoes).
 * Removing both reddens that test; removing either alone does not. So deleting
 * one layer will NOT redden this suite — the request is still correctly refused.
 */

import { createMockRequest } from './helpers/utils';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockEmitMutation = jest.fn();
jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: (...a: unknown[]) => mockEmitMutation(...a),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

const mockResolveAuth = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return { ...actual, resolveAuth: (...a: unknown[]) => mockResolveAuth(...a) };
});

jest.mock('@/lib/rateLimit.server', () => ({
  checkRateLimit: jest.fn(async () => ({ ok: true })),
  rateLimitHeaders: jest.fn(() => ({})),
}));

/**
 * Flippable, because the interesting escalation is the one that only exists
 * while the operator break-glass is ON: `capability_enforcement === false`
 * skips the capability check for everything outside BYPASS_EXEMPT_CAPABILITIES,
 * and SITE_MEMBER_MANAGE is outside it. Every block below leaves this `true`
 * (reset in `beforeEach`) except the one that says otherwise.
 */
let mockCapabilityEnforcement = true;

jest.mock('@/lib/securityConfig.server', () => ({
  securityConfig: {
    read: jest.fn(async () => ({
      capability_enforcement: mockCapabilityEnforcement,
      rate_limit_enforcement: true,
    })),
  },
}));

jest.mock('@/lib/auditLog.server', () => ({
  generateCorrelationId: () => 'corr_esc',
  writeAuditEntry: async () => {},
  writeAuditEntryBlocking: async () => {},
  writeGlobalAuditEntryBlocking: async () => {},
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    arrayUnion: (...items: unknown[]) => ({ __op: 'arrayUnion', items }),
    arrayRemove: (...items: unknown[]) => ({ __op: 'arrayRemove', items }),
    serverTimestamp: () => ({ __op: 'serverTimestamp' }),
    delete: () => ({ __op: 'delete' }),
  },
  Timestamp: { fromDate: (d: Date) => ({ toMillis: () => d.getTime() }) },
}));

// Talon store: this suite is about membership, not automations.
jest.mock('@/lib/talons/store.server', () => ({
  countTalonsAuthoredBy: jest.fn(async () => 0),
  reassignTalons: jest.fn(async () => ({ reassignedTalonIds: [] })),
  TalonStoreError: class TalonStoreError extends Error {},
}));

// --- Firestore double with optimistic concurrency ---------------------------

const docs = new Map<string, Record<string, unknown> | null>();
/** Bumped on every committed write so a reader can detect being overtaken. */
const versions = new Map<string, number>();

function versionOf(p: string): number {
  return versions.get(p) ?? 0;
}

function bump(p: string): void {
  versions.set(p, versionOf(p) + 1);
}

function applyOps(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...existing };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && '__op' in (v as object)) {
      const op = (v as { __op: string }).__op;
      const items = (v as { items?: unknown[] }).items ?? [];
      const cur = Array.isArray(next[k]) ? (next[k] as unknown[]).slice() : [];
      if (op === 'arrayUnion') {
        for (const it of items) if (!cur.includes(it)) cur.push(it);
        next[k] = cur;
      } else if (op === 'arrayRemove') {
        next[k] = cur.filter((x) => !items.includes(x));
      } else if (op === 'serverTimestamp') {
        next[k] = 1;
      } else if (op === 'delete') {
        delete next[k];
      } else {
        next[k] = v;
      }
    } else {
      next[k] = v;
    }
  }
  return next;
}

function snapOf(path: string) {
  const data = docs.get(path) ?? null;
  return {
    exists: data !== null,
    id: path.split('/').pop() as string,
    data: () => data ?? undefined,
  };
}

function docRef(path: string): Record<string, unknown> {
  return {
    id: path.split('/').pop(),
    path,
    get: async () => snapOf(path),
    set: async (d: Record<string, unknown>) => {
      docs.set(path, d);
      bump(path);
    },
    update: async (p: Record<string, unknown>) => {
      docs.set(path, applyOps(docs.get(path) ?? {}, p));
      bump(path);
    },
    delete: async () => {
      docs.delete(path);
      bump(path);
    },
    collection: (sub: string) => collRef(`${path}/${sub}`),
  };
}

function collRef(path: string): Record<string, unknown> {
  const wheres: Array<{ f: string; op: string; v: unknown }> = [];
  const ref: Record<string, unknown> = {
    doc: (id: string) => docRef(`${path}/${id}`),
    where: (f: string, op: string, v: unknown) => {
      wheres.push({ f, op, v });
      return ref;
    },
    orderBy: () => ref,
    limit: () => ref,
    get: async () => {
      const prefix = `${path}/`;
      let rows = [...docs.entries()]
        .filter(([k, v]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/') && v)
        .map(([k, v]) => ({ id: k.slice(prefix.length), data: v as Record<string, unknown> }));
      for (const w of wheres) {
        if (w.op === '==') rows = rows.filter((r) => r.data[w.f] === w.v);
        else if (w.op === 'array-contains') {
          rows = rows.filter((r) => Array.isArray(r.data[w.f]) && (r.data[w.f] as unknown[]).includes(w.v));
        }
      }
      return {
        docs: rows.map((r) => ({
          id: r.id,
          exists: true,
          data: () => r.data,
          ref: docRef(`${path}/${r.id}`),
        })),
      };
    },
  };
  return ref;
}

const db = {
  collection: (n: string) => collRef(n),
  getAll: (...refs: Array<{ get: () => Promise<unknown> }>) =>
    Promise.all(refs.map((r) => r.get())),
  batch: () => {
    const ops: Array<{ op: string; path: string; data?: Record<string, unknown> }> = [];
    return {
      create: (r: { path: string }, d: Record<string, unknown>) =>
        ops.push({ op: 'create', path: r.path, data: d }),
      set: (r: { path: string }, d: Record<string, unknown>) =>
        ops.push({ op: 'set', path: r.path, data: d }),
      update: (r: { path: string }, d: Record<string, unknown>) =>
        ops.push({ op: 'update', path: r.path, data: d }),
      delete: (r: { path: string }) => ops.push({ op: 'delete', path: r.path }),
      commit: async () => {
        // create() FAILS on an existing document. Modelling that difference is
        // the entire reason addMember cannot overwrite an owner row.
        for (const o of ops) {
          if (o.op === 'create' && docs.get(o.path)) {
            const e = new Error('Document already exists') as Error & { code: number };
            e.code = 6;
            throw e;
          }
        }
        for (const o of ops) {
          if (o.op === 'create' || o.op === 'set') docs.set(o.path, o.data ?? {});
          else if (o.op === 'delete') docs.delete(o.path);
          else docs.set(o.path, applyOps(docs.get(o.path) ?? {}, o.data ?? {}));
          bump(o.path);
        }
      },
    };
  },
  runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const readVersions = new Map<string, number>();
      const writes: Array<{ op: string; path: string; data?: Record<string, unknown> }> = [];
      const tx = {
        get: async (r: { path: string }) => {
          readVersions.set(r.path, versionOf(r.path));
          return snapOf(r.path);
        },
        set: (r: { path: string }, d: Record<string, unknown>) =>
          writes.push({ op: 'set', path: r.path, data: d }),
        update: (r: { path: string }, d: Record<string, unknown>) =>
          writes.push({ op: 'update', path: r.path, data: d }),
        delete: (r: { path: string }) => writes.push({ op: 'delete', path: r.path }),
      };
      const result = await fn(tx);
      // Yield, so a concurrently-started transaction can interleave here — the
      // window a real race exploits.
      await Promise.resolve();
      if ([...readVersions].some(([p, v]) => versionOf(p) !== v)) continue;
      for (const w of writes) {
        if (w.op === 'set') docs.set(w.path, w.data ?? {});
        else if (w.op === 'delete') docs.delete(w.path);
        else docs.set(w.path, applyOps(docs.get(w.path) ?? {}, w.data ?? {}));
        bump(w.path);
      }
      return result;
    }
    throw new Error('too much contention');
  },
};

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => db,
  getAdminAuth: () => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')),
    getUserByEmail: jest.fn().mockRejectedValue(
      Object.assign(new Error('nf'), { code: 'auth/user-not-found' }),
    ),
  }),
  getAdminStorage: () => ({ bucket: () => ({}) }),
}));

import { GET as membersGET, POST as membersPOST } from '@/app/api/sites/[siteId]/members/route';
import {
  DELETE as memberDELETE,
  PATCH as memberPATCH,
} from '@/app/api/sites/[siteId]/members/[uid]/route';
import { POST as transferPOST } from '@/app/api/sites/[siteId]/transfer-ownership/route';
import { POST as uninstallPOST } from '@/app/api/sites/[siteId]/deployments/[deploymentId]/uninstall/route';

const SITE = 'site-alpha';
const OWNER = 'uid_owner';
const ADMIN = 'uid_admin';
const MEMBER = 'uid_member';
const OUTSIDER = 'uid_outsider';

function seedUser(uid: string, data: Record<string, unknown> = {}): void {
  docs.set(`users/${uid}`, { email: `${uid}@example.test`, role: 'member', sites: [], ...data });
}

function seedMemberRow(uid: string, role: string): void {
  docs.set(`sites/${SITE}/members/${uid}`, { uid, role, status: 'active' });
}

/** Session auth (no api key), so scope checks are bypassed and only role matters. */
function authAs(uid: string): void {
  mockResolveAuth.mockResolvedValue({ userId: uid, keyContext: null });
}

/** api-key auth carrying exactly `perms` on every site. */
function authAsKey(uid: string, perms: Array<'read' | 'write' | 'admin'>): void {
  mockResolveAuth.mockResolvedValue({
    userId: uid,
    keyContext: {
      keyId: 'key_esc',
      environment: 'live',
      isLegacy: false,
      scopes: [{ resource: 'site', id: '*', permissions: perms }],
      expiresAt: null,
    },
  });
}

const params = (extra: Record<string, string> = {}) => ({
  params: Promise.resolve({ siteId: SITE, ...extra }),
});

beforeEach(() => {
  jest.clearAllMocks();
  docs.clear();
  versions.clear();
  mockCapabilityEnforcement = true;

  docs.set(`sites/${SITE}`, { owner: OWNER, name: 'Alpha' });
  // The owner is a self-serve owner: GLOBAL role `member`, which is the shape
  // bootstrapUser creates and the reason the ownership short-circuit exists.
  seedUser(OWNER, { role: 'member', sites: [SITE] });
  seedMemberRow(OWNER, 'owner');
  seedUser(ADMIN, { role: 'admin', sites: [SITE] });
  seedMemberRow(ADMIN, 'admin');
  // A plain read-only member, and the target every "someone ELSE's row" control
  // below acts on — self-targeting is refused outright now (block 10).
  seedUser(MEMBER, { role: 'member', sites: [SITE] });
  seedMemberRow(MEMBER, 'member');
  seedUser(OUTSIDER, { role: 'member', sites: [] });
});

describe('1. a site admin cannot promote THEMSELVES to owner', () => {
  it('refuses PATCH role=owner on their own row', async () => {
    // 403 where this once asserted 400: the self-guard (block 10) is the first
    // line in the handler and fires before role validation. Both refusals are
    // correct and the assertion that matters is unchanged — nothing moved.
    authAs(ADMIN);
    const res = await memberPATCH(
      createMockRequest(`http://localhost/api/sites/${SITE}/members/${ADMIN}`, {
        method: 'PATCH',
        body: { role: 'owner' },
      }),
      params({ uid: ADMIN }),
    );

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('cannot_modify_own_membership');
    expect((docs.get(`sites/${SITE}/members/${ADMIN}`) as { role: string }).role).toBe('admin');
    expect((docs.get(`sites/${SITE}`) as { owner: string }).owner).toBe(OWNER);
  });

  it("refuses role=owner on someone ELSE's row too", async () => {
    // The ASSIGNABLE_ROLES ceiling itself, on the only kind of target that still
    // reaches it. Without this the self-guard would be the only thing tested and
    // `'owner'` could quietly become assignable.
    authAs(ADMIN);
    const res = await memberPATCH(
      createMockRequest(`http://localhost/api/sites/${SITE}/members/${MEMBER}`, {
        method: 'PATCH',
        body: { role: 'owner' },
      }),
      params({ uid: MEMBER }),
    );

    expect(res.status).toBe(400);
    expect((docs.get(`sites/${SITE}/members/${MEMBER}`) as { role: string }).role).toBe('member');
    expect((docs.get(`sites/${SITE}`) as { owner: string }).owner).toBe(OWNER);
  });

  it('POSITIVE CONTROL: the same admin CAN set a legal role', async () => {
    // On another member's row: an admin has no legal way to change their own.
    authAs(ADMIN);
    const res = await memberPATCH(
      createMockRequest(`http://localhost/api/sites/${SITE}/members/${MEMBER}`, {
        method: 'PATCH',
        body: { role: 'admin' },
      }),
      params({ uid: MEMBER }),
    );
    expect(res.status).toBe(200);
  });
});

describe('2. a site admin cannot demote the owner', () => {
  it('refuses with 409 cannot_change_owner_role', async () => {
    authAs(ADMIN);
    const res = await memberPATCH(
      createMockRequest(`http://localhost/api/sites/${SITE}/members/${OWNER}`, {
        method: 'PATCH',
        body: { role: 'member' },
      }),
      params({ uid: OWNER }),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('cannot_change_owner_role');
    expect((docs.get(`sites/${SITE}/members/${OWNER}`) as { role: string }).role).toBe('owner');
  });

  it('POSITIVE CONTROL: the same admin CAN change a non-owner', async () => {
    seedUser('uid_other', { role: 'member', sites: [SITE] });
    seedMemberRow('uid_other', 'member');
    authAs(ADMIN);

    const res = await memberPATCH(
      createMockRequest(`http://localhost/api/sites/${SITE}/members/uid_other`, {
        method: 'PATCH',
        body: { role: 'admin' },
      }),
      params({ uid: 'uid_other' }),
    );
    expect(res.status).toBe(200);
  });
});

describe('3. POST /members cannot be used as an upsert on the owner row', () => {
  it('refuses re-adding the owner at a lesser role', async () => {
    authAs(ADMIN);
    const res = await membersPOST(
      createMockRequest(`http://localhost/api/sites/${SITE}/members`, {
        method: 'POST',
        headers: { 'Idempotency-Key': 'esc-owner-upsert' },
        body: { uid: OWNER, role: 'member' },
      }),
      params(),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('target_is_owner');
    expect((docs.get(`sites/${SITE}/members/${OWNER}`) as { role: string }).role).toBe('owner');
  });

  it('POSITIVE CONTROL: adding a NON-owner still succeeds', async () => {
    authAs(ADMIN);
    const res = await membersPOST(
      createMockRequest(`http://localhost/api/sites/${SITE}/members`, {
        method: 'POST',
        headers: { 'Idempotency-Key': 'esc-add-ok' },
        body: { uid: OUTSIDER, role: 'member' },
      }),
      params(),
    );

    expect(res.status).toBe(200);
    expect((docs.get(`sites/${SITE}/members/${OUTSIDER}`) as { role: string }).role).toBe('member');
  });
});

describe('4. two concurrent ownership transfers leave exactly one owner', () => {
  it('serialises, and the loser is REFUSED rather than silently applied', async () => {
    seedUser('uid_succ_a', { role: 'admin', sites: [] });
    seedUser('uid_succ_b', { role: 'admin', sites: [] });
    authAs(OWNER);

    const fire = (successorUid: string, key: string) =>
      transferPOST(
        createMockRequest(`http://localhost/api/sites/${SITE}/transfer-ownership`, {
          method: 'POST',
          headers: { 'Idempotency-Key': key },
          body: { successorUid },
        }),
        params(),
      );

    const [a, b] = await Promise.all([
      fire('uid_succ_a', 'esc-t-a'),
      fire('uid_succ_b', 'esc-t-b'),
    ]);

    const finalOwner = (docs.get(`sites/${SITE}`) as { owner: string }).owner;
    expect(['uid_succ_a', 'uid_succ_b']).toContain(finalOwner);

    const owners = [OWNER, 'uid_succ_a', 'uid_succ_b'].filter(
      (u) => (docs.get(`sites/${SITE}/members/${u}`) as { role?: string } | undefined)?.role === 'owner',
    );
    expect(owners).toEqual([finalOwner]);
    // The loser re-read the owner inside its retry: the actor no longer owned the site.
    // found the actor was no longer the owner.
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBeGreaterThanOrEqual(400);
  });
});

describe('5. the site owner cannot be removed', () => {
  it('refuses DELETE on the owner with 409 cannot_remove_owner', async () => {
    authAs(ADMIN);
    const res = await memberDELETE(
      createMockRequest(`http://localhost/api/sites/${SITE}/members/${OWNER}`, {
        method: 'DELETE',
      }),
      params({ uid: OWNER }),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('cannot_remove_owner');
    expect((docs.get(`users/${OWNER}`) as { sites: string[] }).sites).toContain(SITE);
    expect(docs.has(`sites/${SITE}/members/${OWNER}`)).toBe(true);
  });

  it('POSITIVE CONTROL: a non-owner member IS removable', async () => {
    authAs(ADMIN);
    seedUser('uid_plain', { role: 'member', sites: [SITE] });
    seedMemberRow('uid_plain', 'member');

    const res = await memberDELETE(
      createMockRequest(`http://localhost/api/sites/${SITE}/members/uid_plain`, {
        method: 'DELETE',
      }),
      params({ uid: 'uid_plain' }),
    );

    expect(res.status).toBe(200);
    expect((docs.get('users/uid_plain') as { sites: string[] }).sites).not.toContain(SITE);
  });
});

/**
 * Every call here targets MEMBER, not the key owner's own row. It used to target
 * the key owner, which now trips the self-guard (block 10) and would have made
 * the positive control unreachable and the refusals ambiguous — a 403 from the
 * scope check and a 403 from the self-guard are indistinguishable at the status
 * line. Targeting someone else keeps these about the scope TIER, as titled.
 */
describe('6. an api-key caller cannot reach a role change without site admin scope', () => {
  it('refuses a site=*:write key on PATCH', async () => {
    // A `write` key is the interesting case: enough for most mutations on the
    // site, and a natural thing to hand a CI job.
    authAsKey(ADMIN, ['write']);
    const res = await memberPATCH(
      createMockRequest(`http://localhost/api/sites/${SITE}/members/${MEMBER}`, {
        method: 'PATCH',
        body: { role: 'admin' },
      }),
      params({ uid: MEMBER }),
    );

    expect(res.status).toBe(403);
    expect((docs.get(`sites/${SITE}/members/${MEMBER}`) as { role: string }).role).toBe('member');
  });

  it('refuses a read-only key', async () => {
    authAsKey(ADMIN, ['read']);
    const res = await memberPATCH(
      createMockRequest(`http://localhost/api/sites/${SITE}/members/${MEMBER}`, {
        method: 'PATCH',
        body: { role: 'admin' },
      }),
      params({ uid: MEMBER }),
    );
    expect(res.status).toBe(403);
  });

  it('refuses an ADMIN-only key too — the outer gate wants write', async () => {
    // Not a mistake: the route is double-gated. The OUTER gate
    // (authorizedSiteHandler's default api-key scope) wants `write` and the inner
    // one wants `admin`, so an admin-only key clears the inner and is refused by
    // the outer. Wave 1 task 1.4 collapses these — change this test deliberately.
    authAsKey(ADMIN, ['admin']);
    const res = await memberPATCH(
      createMockRequest(`http://localhost/api/sites/${SITE}/members/${MEMBER}`, {
        method: 'PATCH',
        body: { role: 'admin' },
      }),
      params({ uid: MEMBER }),
    );
    expect(res.status).toBe(403);
  });

  it('POSITIVE CONTROL: a key holding BOTH write and admin succeeds', async () => {
    // Proves the refusals above are about the scope TIER, not a blanket api-key denial.
    authAsKey(ADMIN, ['write', 'admin']);
    const res = await memberPATCH(
      createMockRequest(`http://localhost/api/sites/${SITE}/members/${MEMBER}`, {
        method: 'PATCH',
        body: { role: 'admin' },
      }),
      params({ uid: MEMBER }),
    );
    expect(res.status).toBe(200);
    expect((docs.get(`sites/${SITE}/members/${MEMBER}`) as { role: string }).role).toBe('admin');
  });
});

describe('7. an outsider cannot reach the membership surface at all', () => {
  it('collapses to 404 rather than confirming the site exists', async () => {
    authAs(OUTSIDER);
    const res = await memberPATCH(
      createMockRequest(`http://localhost/api/sites/${SITE}/members/${ADMIN}`, {
        method: 'PATCH',
        body: { role: 'member' },
      }),
      params({ uid: ADMIN }),
    );

    expect(res.status).toBe(404);
    expect((docs.get(`sites/${SITE}/members/${ADMIN}`) as { role: string }).role).toBe('admin');
  });
});

describe('8. the scope conjunction survives the gate collapse (task 1.4)', () => {
  it('a read-only key is refused where the route needs read AND admin', async () => {
    // GET /members declares apiKeyPermission ['read','admin']. Permissions are
    // NOT hierarchical -- scopeMatches is exact membership -- so holding one is
    // never enough. Before 1.4 this conjunction was an accident of two gates;
    // it is now stated once on the wrapper, and this pins that it still holds.
    authAsKey(ADMIN, ['read']);
    const res = await membersGET(
      createMockRequest(`http://localhost/api/sites/${SITE}/members`, { method: 'GET' }),
      params(),
    );
    expect(res.status).toBe(403);
  });

  it('an admin-only key is refused on the same route', async () => {
    authAsKey(ADMIN, ['admin']);
    const res = await membersGET(
      createMockRequest(`http://localhost/api/sites/${SITE}/members`, { method: 'GET' }),
      params(),
    );
    expect(res.status).toBe(403);
  });

  it('POSITIVE CONTROL: read AND admin together succeed', async () => {
    authAsKey(ADMIN, ['read', 'admin']);
    const res = await membersGET(
      createMockRequest(`http://localhost/api/sites/${SITE}/members`, { method: 'GET' }),
      params(),
    );
    expect(res.status).toBe(200);
  });
});

/**
 * Moved here from __tests__/api/sites-deployments.test.ts and
 * __tests__/api/sites-members.test.ts by task 1.4.
 *
 * Those suites MOCK authorizedSiteHandler. While authorization lived partly in
 * the handler body (the inner _shared gate), a mocked wrapper still left the
 * scope check running, so they could assert it. Collapsing the gates moved
 * authorization entirely into the wrapper, which those mocks replace — so the
 * assertions silently became vacuous there and had to move somewhere the real
 * wrapper runs. This suite is that place.
 */
describe('9. privileged-scope contracts, with the REAL wrapper', () => {
  it('uninstall refuses a key holding write but not admin', async () => {
    authAsKey(ADMIN, ['write']);
    const res = await uninstallPOST(
      createMockRequest(
        `http://localhost/api/sites/${SITE}/deployments/dep-1/uninstall`,
        { method: 'POST', body: {} },
      ),
      { params: Promise.resolve({ siteId: SITE, deploymentId: 'dep-1' }) },
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('scope_insufficient');
  });

  it('uninstall refuses a key holding admin but not write', async () => {
    // The other half of the conjunction, which the old mocked test could not see.
    authAsKey(ADMIN, ['admin']);
    const res = await uninstallPOST(
      createMockRequest(
        `http://localhost/api/sites/${SITE}/deployments/dep-1/uninstall`,
        { method: 'POST', body: {} },
      ),
      { params: Promise.resolve({ siteId: SITE, deploymentId: 'dep-1' }) },
    );
    expect(res.status).toBe(403);
  });

  it('GET /members refuses a session caller who is not a site admin', async () => {
    // Was "rejects non-admin caller with 404" in the mocked suite. The 404 is
    // deliberate masking — a non-member must not learn the site exists.
    authAs(OUTSIDER);
    const res = await membersGET(
      createMockRequest(`http://localhost/api/sites/${SITE}/members`, { method: 'GET' }),
      params(),
    );
    expect(res.status).toBe(404);
  });
});

/**
 * 10. NOBODY may act on their OWN membership row.
 *
 * The escalation this closes: with `capability_enforcement === false` — the 4h
 * operator break-glass in `global/security_config` — the capability check is
 * skipped for every capability outside BYPASS_EXEMPT_CAPABILITIES, and
 * SITE_MEMBER_MANAGE is outside it. Browser sessions never reach `requireScope`
 * at all, so nothing else stood between a plain site `member` and
 * `PATCH /members/{ownUid} {"role":"admin"}`. `changeRole` refuses only an OWNER
 * as a target, and `'admin'` is an accepted value, so the write landed.
 *
 * What made that more than a capability bypass: the caller ends up holding
 * MACHINE_REMOTE_CONTROL and MACHINE_REMOTE_VIEW ON MERIT, so every swoop
 * exemption then passes legitimately. Those exemptions exist so breaking glass
 * cannot GRANT screen access; this route went around them by changing what the
 * caller is. Hence a guard that does not consult the kill switch at all.
 *
 * NEGATIVE CONTROL RUN 2026-09-19: deleting `refuseSelfMembershipChange`'s two
 * call sites reddens this block (the member PATCH returns 200 and the row
 * becomes `admin`). Unlike blocks 1 and 5 this path is guarded ONCE, so the
 * guard is the only thing holding it.
 */
describe('10. a caller cannot modify their own membership row', () => {
  describe('with the kill switch OFF — the case that was reachable', () => {
    beforeEach(() => {
      mockCapabilityEnforcement = false;
    });

    it('refuses a plain member promoting THEMSELVES to admin', async () => {
      authAs(MEMBER);
      const res = await memberPATCH(
        createMockRequest(`http://localhost/api/sites/${SITE}/members/${MEMBER}`, {
          method: 'PATCH',
          body: { role: 'admin' },
        }),
        params({ uid: MEMBER }),
      );

      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('cannot_modify_own_membership');
      expect((docs.get(`sites/${SITE}/members/${MEMBER}`) as { role: string }).role).toBe('member');
    });

    it('refuses a plain member removing their own row', async () => {
      authAs(MEMBER);
      const res = await memberDELETE(
        createMockRequest(`http://localhost/api/sites/${SITE}/members/${MEMBER}`, {
          method: 'DELETE',
        }),
        params({ uid: MEMBER }),
      );

      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('cannot_modify_own_membership');
      expect(docs.has(`sites/${SITE}/members/${MEMBER}`)).toBe(true);
      expect((docs.get(`users/${MEMBER}`) as { sites: string[] }).sites).toContain(SITE);
    });

    it("POSITIVE CONTROL: break-glass reach is intact on someone ELSE's row", async () => {
      // The reason the fix is a self-guard rather than adding SITE_MEMBER_MANAGE
      // to BYPASS_EXEMPT_CAPABILITIES: an operator who broke the glass on purpose
      // still administers the site. Only the caller's own row is off limits.
      authAs(ADMIN);
      const res = await memberPATCH(
        createMockRequest(`http://localhost/api/sites/${SITE}/members/${MEMBER}`, {
          method: 'PATCH',
          body: { role: 'admin' },
        }),
        params({ uid: MEMBER }),
      );

      expect(res.status).toBe(200);
      expect((docs.get(`sites/${SITE}/members/${MEMBER}`) as { role: string }).role).toBe('admin');
    });
  });

  describe('with the kill switch ON — the same rule, not a kill-switch patch', () => {
    it('refuses an admin changing their own role', async () => {
      authAs(ADMIN);
      const res = await memberPATCH(
        createMockRequest(`http://localhost/api/sites/${SITE}/members/${ADMIN}`, {
          method: 'PATCH',
          body: { role: 'member' },
        }),
        params({ uid: ADMIN }),
      );

      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('cannot_modify_own_membership');
      expect((docs.get(`sites/${SITE}/members/${ADMIN}`) as { role: string }).role).toBe('admin');
    });

    it('refuses an admin removing their own row', async () => {
      // The server half of the UI's existing "cannot remove yourself" pre-flight.
      authAs(ADMIN);
      const res = await memberDELETE(
        createMockRequest(`http://localhost/api/sites/${SITE}/members/${ADMIN}`, {
          method: 'DELETE',
        }),
        params({ uid: ADMIN }),
      );

      expect(res.status).toBe(403);
      expect(docs.has(`sites/${SITE}/members/${ADMIN}`)).toBe(true);
      expect((docs.get(`users/${ADMIN}`) as { sites: string[] }).sites).toContain(SITE);
    });

    it('refuses the OWNER on their own row — stepping down is transfer-ownership', async () => {
      // Nothing is lost: `changeRole` already refused an owner as a target, so
      // the owner never had a way to demote themselves here. They now get the
      // self-refusal first, and ownership still moves only through
      // POST /api/sites/{siteId}/transfer-ownership.
      authAs(OWNER);
      const res = await memberPATCH(
        createMockRequest(`http://localhost/api/sites/${SITE}/members/${OWNER}`, {
          method: 'PATCH',
          body: { role: 'member' },
        }),
        params({ uid: OWNER }),
      );

      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('cannot_modify_own_membership');
      expect((docs.get(`sites/${SITE}/members/${OWNER}`) as { role: string }).role).toBe('owner');
      expect((docs.get(`sites/${SITE}`) as { owner: string }).owner).toBe(OWNER);
    });

    it('refuses an api key on its OWN owner\'s row, scopes notwithstanding', async () => {
      // A key is the user's credential; it must not reach what their session
      // cannot. Block 6's positive control proves this exact key succeeds on
      // another member's row, so this 403 is the self-guard and not the scope.
      authAsKey(ADMIN, ['write', 'admin']);
      const res = await memberPATCH(
        createMockRequest(`http://localhost/api/sites/${SITE}/members/${ADMIN}`, {
          method: 'PATCH',
          body: { role: 'member' },
        }),
        params({ uid: ADMIN }),
      );

      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('cannot_modify_own_membership');
      expect((docs.get(`sites/${SITE}/members/${ADMIN}`) as { role: string }).role).toBe('admin');
    });
  });
});

/**
 * 11. POST /members cannot mint an admin while the break-glass is open.
 *
 * The sibling of block 10, and the worse half. Block 10's guard is keyed on the
 * caller's OWN row, so it does nothing here: the target is someone else.
 *
 * With `capability_enforcement === false` a plain site `member` on a browser
 * session reached this handler — SITE_MEMBER_MANAGE is outside
 * BYPASS_EXEMPT_CAPABILITIES and sessions never reach `requireScope`. Nothing in
 * the handler stopped them. Its owner guard only refuses the OWNER as a target,
 * and `addMember`'s `create()` only refuses a target that already HAS a row —
 * neither compares the requested role against the caller's standing. So the
 * member adds a second account they control (one is a `POST /api/users/bootstrap`
 * away: per-IP rate limit and Turnstile, no invite) at `role: 'admin'`.
 *
 * What makes this worse than a bypass is PERSISTENCE. The alt is a site admin ON
 * MERIT, so the grant survives the switch being turned back on, and from the alt
 * the original account is promoted through `PATCH /members/{uid}` with
 * enforcement fully ON. A 4h break-glass window becomes permanent site admin,
 * including MACHINE_REMOTE_CONTROL and SWOOP_SETTINGS_MANAGE — two of the three
 * capabilities the exempt set exists to keep the kill switch from handing out.
 *
 * NEGATIVE CONTROL RUN 2026-09-19: removing the `hasCapability` call in the POST
 * handler reddens this block (the member's add returns 200 and the alt's row is
 * written as `admin`). It is the only thing holding this path.
 */
describe('11. POST /members cannot mint an admin for a third party', () => {
  /** An ordinary bootstrapped account with no row on this site — the "alt". */
  const ALT = OUTSIDER;

  describe('with the kill switch OFF — the case that was reachable', () => {
    beforeEach(() => {
      mockCapabilityEnforcement = false;
    });

    it('refuses a plain member adding an alt account as admin', async () => {
      authAs(MEMBER);
      const res = await membersPOST(
        createMockRequest(`http://localhost/api/sites/${SITE}/members`, {
          method: 'POST',
          headers: { 'Idempotency-Key': 'esc-alt-admin' },
          body: { uid: ALT, role: 'admin' },
        }),
        params(),
      );

      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('site_member_manage_required');
      expect(docs.has(`sites/${SITE}/members/${ALT}`)).toBe(false);
      expect((docs.get(`users/${ALT}`) as { sites: string[] }).sites).not.toContain(SITE);
    });

    it('refuses a plain member adding an alt at role=member too', async () => {
      // Not a rule about the ROLE — a read-only member has no business writing
      // membership at all, and a plain member row is a foothold that also
      // outlives the window.
      authAs(MEMBER);
      const res = await membersPOST(
        createMockRequest(`http://localhost/api/sites/${SITE}/members`, {
          method: 'POST',
          headers: { 'Idempotency-Key': 'esc-alt-member' },
          body: { uid: ALT, role: 'member' },
        }),
        params(),
      );

      expect(res.status).toBe(403);
      expect(docs.has(`sites/${SITE}/members/${ALT}`)).toBe(false);
    });

    it('POSITIVE CONTROL: an admin with the switch off still adds members', async () => {
      // Break-glass reach is intact for whoever legitimately holds the
      // capability — the same argument as block 10's positive control.
      authAs(ADMIN);
      const res = await membersPOST(
        createMockRequest(`http://localhost/api/sites/${SITE}/members`, {
          method: 'POST',
          headers: { 'Idempotency-Key': 'esc-alt-ok' },
          body: { uid: ALT, role: 'admin' },
        }),
        params(),
      );

      expect(res.status).toBe(200);
      expect((docs.get(`sites/${SITE}/members/${ALT}`) as { role: string }).role).toBe('admin');
    });
  });

  it('CONTROL: with the switch ON the wrapper already refused the member', async () => {
    // Pins that the handler check is a SECOND line and not a replacement: with
    // enforcement on, the denial comes from the wrapper, without a problem code.
    authAs(MEMBER);
    const res = await membersPOST(
      createMockRequest(`http://localhost/api/sites/${SITE}/members`, {
        method: 'POST',
        headers: { 'Idempotency-Key': 'esc-alt-enforced' },
        body: { uid: ALT, role: 'admin' },
      }),
      params(),
    );

    expect(res.status).toBe(403);
    expect(docs.has(`sites/${SITE}/members/${ALT}`)).toBe(false);
  });
});

/**
 * 12. `roleHonored` reports what happened to the ROW.
 *
 * It was hardcoded `true`. `addMember` uses `create()`, so adding someone who is
 * ALREADY a member writes nothing and leaves their existing role alone — and the
 * route still answers 200, deliberately, because it is documented idempotent.
 * With `roleHonored` pinned true, that no-op was indistinguishable from a real
 * promotion in the response, in the dashboard toast and in the audit row — which
 * is the row someone reads after a break-glass to find out what was granted.
 */
describe('12. roleHonored reports what happened to the row', () => {
  it('reports false when the member already existed and nothing was written', async () => {
    authAs(ADMIN);
    const res = await membersPOST(
      createMockRequest(`http://localhost/api/sites/${SITE}/members`, {
        method: 'POST',
        headers: { 'Idempotency-Key': 'esc-honored-noop' },
        body: { uid: MEMBER, role: 'admin' },
      }),
      params(),
    );

    // Still 200: clients rely on the idempotent add, and nothing was clobbered.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requestedRole).toBe('admin');
    expect(body.roleHonored).toBe(false);
    // The row is the proof: it kept the role it had.
    expect((docs.get(`sites/${SITE}/members/${MEMBER}`) as { role: string }).role).toBe('member');
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'site_member_mutated',
        targetId: MEMBER,
        attributes: expect.objectContaining({
          verb: 'member_added',
          requestedRole: 'admin',
          roleHonored: false,
        }),
      }),
    );
  });

  it('POSITIVE CONTROL: reports true when the row was really created', async () => {
    authAs(ADMIN);
    const res = await membersPOST(
      createMockRequest(`http://localhost/api/sites/${SITE}/members`, {
        method: 'POST',
        headers: { 'Idempotency-Key': 'esc-honored-real' },
        body: { uid: OUTSIDER, role: 'admin' },
      }),
      params(),
    );

    expect(res.status).toBe(200);
    expect((await res.json()).roleHonored).toBe(true);
    expect((docs.get(`sites/${SITE}/members/${OUTSIDER}`) as { role: string }).role).toBe('admin');
  });
});
