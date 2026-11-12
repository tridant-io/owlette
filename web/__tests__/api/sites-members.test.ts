/** @jest-environment node */

/**
 * HTTP-shape tests for GET/POST /api/sites/{siteId}/members and
 * DELETE .../members/{uid}. Uses the path-keyed `docStore` mock style from
 * `installer-public.test.ts`.
 */

import { createMockRequest } from './helpers/utils';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

// Bypass the capability/rate/audit wrapper and let the route's inner
// `requireSiteAuthAndScope` handle auth shape. The wrapper is covered by
// `__tests__/lib/authorizedHandler.test.ts`.
jest.mock('@/lib/authorizedHandler.server', () => ({
  authorizedSiteHandler:
    () =>
    (handler: (...args: unknown[]) => unknown) =>
    async (
      request: unknown,
      routeContext: { params: Promise<{ siteId: string }> },
    ) => {
      const params = await routeContext.params;
      return handler(
        request,
        {
          actor: {
            type: 'user',
            userId: 'user-1',
            role: 'admin',
            siteRoles: { [params.siteId]: 'admin' },
            machineScopes: { [params.siteId]: null },
          },
          siteId: params.siteId,
          correlationId: 'corr-test',
          // The wrapper has always supplied these; the routes only started
          // reading them from ctx once task 1.4 removed the inner gate that
          // used to hand them over separately.
          auth: { userId: 'user-1', keyContext: null },
          scopeCheck: { isLegacy: false },
        },
        routeContext,
      );
    },
}));

const mockEmitMutation = jest.fn();
jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: (...a: unknown[]) => mockEmitMutation(...a),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

// Swoop revocation is fired and not awaited, so the route only owes it the
// call; what it then does is `__tests__/lib/swoop/lease.test.ts`.
const mockRevokeSwoopSessions = jest.fn(async () => ({ revokedSids: [] }));
jest.mock('@/lib/swoop/revokeViewerSessions.server', () => ({
  revokeSwoopSessionsForUser: (...a: unknown[]) => mockRevokeSwoopSessions(...a),
}));

const mockResolveAuth = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
  };
});

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    arrayUnion: (...items: unknown[]) => ({ __op: 'arrayUnion', items }),
    arrayRemove: (...items: unknown[]) => ({ __op: 'arrayRemove', items }),
    serverTimestamp: () => ({ __op: 'serverTimestamp' }),
    delete: () => ({ __op: 'delete' }),
  },
  Timestamp: { fromDate: (d: Date) => ({ toMillis: () => d.getTime() }) },
}));

// Firestore mock — keyed by collection path

interface DocStore {
  data: Record<string, unknown> | null;
}

const docStore: Record<string, DocStore> = {};
const collectionDocs: Record<
  string,
  Array<{ id: string; data: Record<string, unknown> }>
> = {};

function pathFor(parts: string[]): string {
  return parts.join('/');
}

function applyFieldOps(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && '__op' in (value as object)) {
      const op = (value as { __op: string }).__op;
      const items = (value as { items?: unknown[] }).items ?? [];
      const current = Array.isArray(next[key])
        ? (next[key] as unknown[]).slice()
        : [];
      if (op === 'arrayUnion') {
        for (const it of items) {
          if (!current.includes(it)) current.push(it);
        }
        next[key] = current;
      } else if (op === 'arrayRemove') {
        next[key] = current.filter((x) => !items.includes(x));
      } else if (op === 'serverTimestamp') {
        next[key] = Date.now();
      } else if (op === 'delete') {
        delete next[key];
      } else {
        next[key] = value;
      }
    } else {
      next[key] = value;
    }
  }
  return next;
}

function syncCollection(parts: string[], docId: string, data: Record<string, unknown> | null): void {
  const colPath = pathFor(parts.slice(0, -1));
  if (!collectionDocs[colPath]) collectionDocs[colPath] = [];
  const idx = collectionDocs[colPath].findIndex((d) => d.id === docId);
  if (data === null) {
    if (idx >= 0) collectionDocs[colPath].splice(idx, 1);
  } else {
    if (idx >= 0) collectionDocs[colPath][idx] = { id: docId, data };
    else collectionDocs[colPath].push({ id: docId, data });
  }
}

function makeDocRef(parts: string[]): unknown {
  const path = pathFor(parts);
  const docId = parts[parts.length - 1];
  const ref: Record<string, unknown> = {
    id: docId,
    path,
    get: jest.fn(async () => {
      const entry = docStore[path];
      return {
        exists: !!entry && entry.data !== null,
        id: docId,
        data: () => entry?.data ?? undefined,
      };
    }),
    set: jest.fn(async (data: Record<string, unknown>) => {
      docStore[path] = { data };
      syncCollection(parts, docId, data);
    }),
    update: jest.fn(async (patch: Record<string, unknown>) => {
      const existing = docStore[path]?.data ?? {};
      const next = applyFieldOps(existing, patch);
      docStore[path] = { data: next };
      syncCollection(parts, docId, next);
    }),
    delete: jest.fn(async () => {
      docStore[path] = { data: null };
      syncCollection(parts, docId, null);
    }),
    collection: (sub: string) => makeCollectionRef([...parts, sub]),
  };
  return ref;
}

interface WhereClause {
  field: string;
  op: string;
  value: unknown;
}

function makeCollectionRef(parts: string[]): unknown {
  const path = pathFor(parts);
  const wheres: WhereClause[] = [];

  const filtered = () => {
    let docs = (collectionDocs[path] || []).slice();
    for (const w of wheres) {
      if (w.op === '==') {
        docs = docs.filter((d) => d.data[w.field] === w.value);
      } else if (w.op === 'array-contains') {
        docs = docs.filter((d) => {
          const arr = d.data[w.field];
          return Array.isArray(arr) && arr.includes(w.value);
        });
      }
    }
    return docs;
  };

  const ref: Record<string, unknown> = {
    doc: (id: string) => makeDocRef([...parts, id]),
    where: (field: string, op: string, value: unknown) => {
      wheres.push({ field, op, value });
      return ref;
    },
    orderBy: () => ref,
    limit: () => ref,
    startAfter: () => ref,
    // Aggregate read — the member-removal route counts the departing member's
    // talons this way before it touches `sites[]`.
    count: () => ({
      get: jest.fn(async () => ({ data: () => ({ count: filtered().length }) })),
    }),
    get: jest.fn(async () => ({
      docs: filtered().map((d) => ({
        id: d.id,
        exists: true,
        data: () => d.data,
        ref: makeDocRef([...parts, d.id]),
      })),
    })),
  };
  return ref;
}

const mockRunTransaction = jest.fn(
  async (cb: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
    const tx = {
      get: async (refOrQuery: { get: () => Promise<unknown> }) =>
        refOrQuery.get(),
      set: (
        ref: { set: (data: Record<string, unknown>) => Promise<void> },
        data: Record<string, unknown>,
      ) => ref.set(data),
      update: (
        ref: { update: (patch: Record<string, unknown>) => Promise<void> },
        patch: Record<string, unknown>,
      ) => ref.update(patch),
      // removeMember deletes the member row inside its transaction.
      delete: (ref: { delete: () => Promise<void> }) => ref.delete(),
    };
    return cb(tx);
  },
);

/** Write batch — the talon store commits a reassignment through one. */
function makeBatch() {
  const ops: Array<() => Promise<void>> = [];
  return {
    set: (ref: { set: (d: Record<string, unknown>) => Promise<void> }, data: Record<string, unknown>) =>
      ops.push(() => ref.set(data)),
    // create() is what makes addMember refuse to overwrite an existing row, so
    // the fake must model how it DIFFERS from set(): it fails when the document
    // already exists, with the ALREADY_EXISTS code the helper matches on. A
    // create() that behaved like set() would let the site-takeover guard pass
    // its tests while being absent in effect.
    create: (
      ref: { set: (d: Record<string, unknown>) => Promise<void>; path: string },
      data: Record<string, unknown>,
    ) =>
      ops.push(async () => {
        if (docStore[ref.path] !== undefined) {
          const err = new Error('Document already exists') as Error & { code: number };
          err.code = 6;
          throw err;
        }
        await ref.set(data);
      }),
    update: (
      ref: { update: (p: Record<string, unknown>) => Promise<void> },
      patch: Record<string, unknown>,
    ) => ops.push(() => ref.update(patch)),
    delete: (ref: { delete: () => Promise<void> }) => ops.push(() => ref.delete()),
    commit: async () => {
      for (const op of ops) await op();
    },
  };
}

/**
 * Admin Auth email→uid directory. `seedAuthEmail` registers an address; anything
 * else rejects with the real `auth/user-not-found` code the route branches on.
 */
const authEmailToUid: Record<string, string> = {};
/** sign-in shape by address; an address with none carries no provider data. */
const authEmailRecord: Record<string, { emailVerified: boolean; providerData: Array<{ providerId: string }> }> = {};
const mockGetUserByEmail = jest.fn(async (email: string) => {
  const uid = authEmailToUid[email];
  if (!uid) {
    const err = new Error(`no user record for ${email}`) as Error & {
      code?: string;
    };
    err.code = 'auth/user-not-found';
    throw err;
  }
  return { uid, email, ...authEmailRecord[email] };
});

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    // Batched read used by lib/sitePolicy.server.ts. Real getAll preserves
    // argument order and yields a non-existent snapshot for a missing doc,
    // so delegating to each ref's own get() matches its observable shape.
    getAll: (...refs: Array<{ get: () => Promise<unknown> }>) =>
      Promise.all(refs.map((r) => r.get())),
    collection: (name: string) => makeCollectionRef([name]),
    runTransaction: mockRunTransaction,
    batch: makeBatch,
  }),
  getAdminAuth: () => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')),
    getUserByEmail: (email: string) => mockGetUserByEmail(email),
  }),
  getAdminStorage: () => ({ bucket: () => ({}) }),
}));

// Imports come AFTER mocks

import {
  GET as membersGET,
  POST as membersPOST,
} from '@/app/api/sites/[siteId]/members/route';
import {
  DELETE as memberDELETE,
  PATCH as memberPATCH,
} from '@/app/api/sites/[siteId]/members/[uid]/route';

const SITE = 'site-alpha';

// Fixtures

function authedAsSuperadminWithKey(perm: 'read' | 'write' | 'admin' = 'admin'): void {
  mockResolveAuth.mockResolvedValue({
    userId: 'admin-uid',
    keyContext: {
      keyId: 'key_test',
      environment: 'live',
      isLegacy: false,
      scopes: [{ resource: 'site', id: '*', permissions: [perm] }],
      expiresAt: null,
    },
  });
  seedUser('admin-uid', { role: 'superadmin' });
}

/**
 * Membership rows for a seeded fixture, as `membership.server.ts` writes them.
 *
 * Site access resolves from these and nothing else, so seeding `users/{uid}.sites`
 * alone now grants nothing. The GLOBAL role is mirrored onto each site because
 * that is what it used to confer there; superadmins get no rows, matching
 * production, where they reach every site by role instead.
 */
/** Set one fixture's per-site role explicitly, overriding the global mirror. */
function seedMemberRow(
  siteId: string,
  uid: string,
  role: 'owner' | 'admin' | 'member',
  extra: Record<string, unknown> = {},
): void {
  const data = { uid, role, status: 'active', addedAt: new Date(0), addedBy: 'system:test', ...extra };
  docStore[`sites/${siteId}/members/${uid}`] = { data };
  // Registered for collection reads too: GET /members lists the subcollection,
  // so a row only in docStore is invisible to the route under test.
  syncCollection(['sites', siteId, 'members', uid], uid, data);
}

function seedMembershipFor(uid: string, merged: Record<string, unknown>): void {
  const globalRole = typeof merged.role === 'string' ? merged.role : 'member';
  if (globalRole === 'superadmin') return;
  const sites = Array.isArray(merged.sites) ? (merged.sites as string[]) : [];
  for (const siteId of sites) {
    // `sites/{siteId}.owner` WAS the ownership grant, so a fixture the site
    // points at becomes an owner row — not the mirrored global role. Self-serve
    // owners carry global role `member`, and mirroring that would leave them
    // without SITE_DELETE on the site they own.
    const owns =
      (docStore[`sites/${siteId}`] as { data?: { owner?: unknown } } | undefined)?.data?.owner === uid;
    const memberData = {
      uid,
      role: owns ? 'owner' : globalRole === 'admin' ? 'admin' : 'member',
      status: 'active',
      addedAt: new Date(0),
      addedBy: 'system:test',
    };
    docStore[`sites/${siteId}/members/${uid}`] = { data: memberData };
    syncCollection(['sites', siteId, 'members', uid], uid, memberData);
  }
}

function seedUser(uid: string, data: Record<string, unknown>): void {
  const path = `users/${uid}`;
  const merged = {
    email: `${uid}@example.com`,
    role: 'member',
    sites: [],
    ...data,
  };
  docStore[path] = { data: merged };
  seedMembershipFor(uid, merged);
  if (!collectionDocs['users']) collectionDocs['users'] = [];
  const idx = collectionDocs['users'].findIndex((d) => d.id === uid);
  if (idx >= 0) collectionDocs['users'][idx] = { id: uid, data: merged };
  else collectionDocs['users'].push({ id: uid, data: merged });
}

/** Register an address in the Admin Auth directory so it resolves to `uid`. */
function seedAuthEmail(
  email: string,
  uid: string,
  signIn?: { provider: 'password' | 'google.com'; emailVerified: boolean },
): void {
  authEmailToUid[email] = uid;
  if (signIn) {
    authEmailRecord[email] = {
      emailVerified: signIn.emailVerified,
      providerData: [{ providerId: signIn.provider }],
    };
  }
}

/**
 * The owner's membership row. `sites/{siteId}.owner` WAS the ownership grant, so
 * declaring an owner has to produce the row that now carries it — and it is done
 * here as well as in `seedUser` because fixtures seed users and sites in either
 * order, and whichever runs second must still leave the owner with `owner`.
 */
function seedOwnerMembership(siteId: string, merged: Record<string, unknown>): void {
  const owner = merged.owner;
  if (typeof owner !== 'string' || owner.length === 0) return;
  const ownerRow = {
    uid: owner,
    role: 'owner',
    status: 'active',
    addedAt: new Date(0),
    addedBy: 'system:test',
  };
  docStore[`sites/${siteId}/members/${owner}`] = { data: ownerRow };
  syncCollection(['sites', siteId, 'members', owner], owner, ownerRow);
}

function seedSite(siteId: string, data: Record<string, unknown> = {}): void {
  const path = `sites/${siteId}`;
  const merged = { owner: 'admin-uid', ...data };
  docStore[path] = { data: merged };
  seedOwnerMembership(siteId, merged);
  if (!collectionDocs['sites']) collectionDocs['sites'] = [];
  const idx = collectionDocs['sites'].findIndex((d) => d.id === siteId);
  if (idx >= 0) collectionDocs['sites'][idx] = { id: siteId, data: merged };
  else collectionDocs['sites'].push({ id: siteId, data: merged });
}

/** a machine of the site, for the existence check a machine scope must pass. */
function seedMachine(siteId: string, machineId: string): void {
  docStore[`sites/${siteId}/machines/${machineId}`] = { data: { machineId } };
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(docStore)) delete docStore[k];
  for (const k of Object.keys(collectionDocs)) delete collectionDocs[k];
  for (const k of Object.keys(authEmailToUid)) delete authEmailToUid[k];
  for (const k of Object.keys(authEmailRecord)) delete authEmailRecord[k];
});

// GET /api/sites/{siteId}/members

describe('GET /api/sites/{siteId}/members', () => {
  it('lists the per-site role from the member ROW, not the global role', async () => {
    authedAsSuperadminWithKey();
    seedSite(SITE, { owner: 'owner-bob' });
    seedUser('owner-bob', { role: 'admin', sites: [] });
    // alice is a global MEMBER holding a site-admin row: the exact combination
    // the old derive-from-global-role listing could not represent.
    seedUser('alice', { role: 'member', sites: [SITE] });
    seedMemberRow(SITE, 'alice', 'admin');
    seedUser('member-charlie', { role: 'member', sites: [SITE] });

    const req = createMockRequest(`http://localhost/api/sites/${SITE}/members`);
    const res = await membersGET(req, {
      params: Promise.resolve({ siteId: SITE }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    const byUid: Record<string, { role: string }> = {};
    for (const m of body.members) {
      byUid[m.uid] = m;
    }
    expect(byUid['owner-bob']?.role).toBe('owner');
    expect(byUid['alice']?.role).toBe('admin');
    expect(byUid['member-charlie']?.role).toBe('member');
  });

  it('never exposes a member\'s other site memberships', async () => {
    authedAsSuperadminWithKey();
    seedSite(SITE, { owner: 'owner-bob' });
    // owner-bob is NOT in the membership query (empty sites[]) so he comes back
    // through the owner-append branch — both code paths must be scrubbed.
    seedUser('owner-bob', { role: 'admin', sites: [] });
    seedUser('alice', { role: 'admin', sites: [SITE, 'site-other-org'] });

    const req = createMockRequest(`http://localhost/api/sites/${SITE}/members`);
    const res = await membersGET(req, {
      params: Promise.resolve({ siteId: SITE }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    const byUid: Record<string, Record<string, unknown>> = {};
    for (const m of body.members) {
      byUid[m.uid as string] = m;
    }
    // Queried member.
    expect(byUid['alice']).toBeDefined();
    expect(byUid['alice']).not.toHaveProperty('sites');
    // Appended owner.
    expect(byUid['owner-bob']).toBeDefined();
    expect(byUid['owner-bob']).not.toHaveProperty('sites');
    // Nothing anywhere in the payload names the other org's site.
    expect(JSON.stringify(body)).not.toContain('site-other-org');
    // The fields callers do rely on survive.
    expect(byUid['alice']).toEqual({
      uid: 'alice',
      email: 'alice@example.com',
      role: 'admin',
      globalRole: 'admin',
      displayName: null,
      swoop: null,
      machineIds: null,
    });
  });

  it('carries each member’s swoop mode: null by role, the stored mode, none when malformed, null for the owner', async () => {
    authedAsSuperadminWithKey();
    seedSite(SITE, { owner: 'owner-bob' });
    seedUser('owner-bob', { role: 'member', sites: [] });
    // a mode hand-written onto the owner's row still reads null: the owner always controls
    seedMemberRow(SITE, 'owner-bob', 'owner', { swoop: 'none' });
    seedUser('alice', { role: 'member', sites: [SITE] });
    seedUser('carol', { role: 'member', sites: [] });
    seedMemberRow(SITE, 'carol', 'member', { swoop: 'control' });
    seedUser('dave', { role: 'member', sites: [] });
    seedMemberRow(SITE, 'dave', 'admin', { swoop: 'everything' });

    const res = await membersGET(
      createMockRequest(`http://localhost/api/sites/${SITE}/members`),
      { params: Promise.resolve({ siteId: SITE }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    const swoopByUid = Object.fromEntries(
      (body.members as Array<{ uid: string; swoop: unknown }>).map((m) => [m.uid, m.swoop]),
    );
    expect(swoopByUid).toEqual({
      'owner-bob': null,
      alice: null,
      carol: 'control',
      dave: 'none',
    });
  });

  it('carries each member’s machine scope beside their swoop mode: null for the whole site, else the list', async () => {
    authedAsSuperadminWithKey();
    seedSite(SITE, { owner: 'owner-bob' });
    seedUser('owner-bob', { role: 'member', sites: [] });
    seedUser('alice', { role: 'member', sites: [SITE] });
    seedUser('carol', { role: 'member', sites: [] });
    seedMemberRow(SITE, 'carol', 'admin', { swoop: 'control', machineIds: ['m2', 'm1'] });
    seedUser('dave', { role: 'member', sites: [] });
    // a malformed scope reads as no machines, as the rules read it
    seedMemberRow(SITE, 'dave', 'member', { machineIds: 'm1' });

    const res = await membersGET(
      createMockRequest(`http://localhost/api/sites/${SITE}/members`),
      { params: Promise.resolve({ siteId: SITE }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    const accessByUid = Object.fromEntries(
      (body.members as Array<{ uid: string; swoop: unknown; machineIds: unknown }>).map((m) => [
        m.uid,
        { swoop: m.swoop, machineIds: m.machineIds },
      ]),
    );
    expect(accessByUid).toEqual({
      'owner-bob': { swoop: null, machineIds: null },
      alice: { swoop: null, machineIds: null },
      carol: { swoop: 'control', machineIds: ['m1', 'm2'] },
      dave: { swoop: null, machineIds: [] },
    });
  });

  it('returns 404 when site does not exist', async () => {
    authedAsSuperadminWithKey();

    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/members`,
    );
    const res = await membersGET(req, {
      params: Promise.resolve({ siteId: SITE }),
    });

    expect(res.status).toBe(404);
  });

  // MOVED to __tests__/api/membershipEscalation.test.ts (task 1.4).
  // This suite mocks authorizedSiteHandler, and authorization now lives
  // entirely in that wrapper, so an assertion here could no longer observe
  // it — it would pass whatever the gate did.

  // MOVED to __tests__/api/membershipEscalation.test.ts (task 1.4).
  // This suite mocks authorizedSiteHandler, and authorization now lives
  // entirely in that wrapper, so an assertion here could no longer observe
  // it — it would pass whatever the gate did.
});

// POST /api/sites/{siteId}/members

describe('POST /api/sites/{siteId}/members', () => {
  it('adds member by extending users.sites[] + emits site_member_mutated', async () => {
    authedAsSuperadminWithKey();
    seedSite(SITE);
    seedUser('alice', { role: 'admin', sites: [] });

    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/members`,
      { method: 'POST', body: { uid: 'alice', role: 'admin' } },
    );
    const res = await membersPOST(req, {
      params: Promise.resolve({ siteId: SITE }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.uid).toBe('alice');
    expect(body.requestedRole).toBe('admin');
    expect(body.roleHonored).toBe(true);
    expect(docStore['users/alice']?.data?.sites).toContain(SITE);
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'site_member_mutated',
        siteId: SITE,
        targetId: 'alice',
        attributes: expect.objectContaining({ verb: 'member_added' }),
      }),
    );
  });

  it('adding a global member as site admin writes a real admin row and SAYS so', async () => {
    // This test previously asserted `roleHonored: false` — while `addMember`
    // wrote a genuine site-admin row carrying the whole SITE_ADMIN_CAPABILITIES
    // set. The response, the dashboard toast, both SDKs and the audit row all
    // stated the inverse of what happened, and it was invisible afterwards
    // because GET derived the role from the global one.
    authedAsSuperadminWithKey();
    seedSite(SITE);
    seedUser('alice', { role: 'member', sites: [] });

    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/members`,
      { method: 'POST', body: { uid: 'alice', role: 'admin' } },
    );
    const res = await membersPOST(req, {
      params: Promise.resolve({ siteId: SITE }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.roleHonored).toBe(true);
    // The GLOBAL role is untouched and still reported — it simply no longer
    // decides anything on this site.
    expect(body.globalRole).toBe('member');
    expect(docStore['users/alice']?.data?.role).toBe('member');
    // The row that actually grants.
    expect(docStore[`sites/${SITE}/members/alice`]?.data?.role).toBe('admin');
  });

  it('removes an ex-owner whose grant is a member ROW with no legacy array entry', async () => {
    // transferSiteOwnership demotes the outgoing owner by writing a member row
    // and never touches `users/{uid}.sites[]`. Gating removal on that array
    // reported `wasMember: false` and toasted "no longer has access" while the
    // row — the thing that actually grants — stayed live.
    authedAsSuperadminWithKey();
    seedSite(SITE, { owner: 'someone-else' });
    seedUser('ex-owner', { role: 'member', sites: [] });
    seedMemberRow(SITE, 'ex-owner', 'admin');

    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/members/ex-owner`,
      { method: 'DELETE' },
    );
    const res = await memberDELETE(req, {
      params: Promise.resolve({ siteId: SITE, uid: 'ex-owner' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.wasMember).toBe(true);
    expect(docStore[`sites/${SITE}/members/ex-owner`]?.data).toBeFalsy();
  });

  it('returns 404 for unknown uid', async () => {
    authedAsSuperadminWithKey();
    seedSite(SITE);

    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/members`,
      { method: 'POST', body: { uid: 'ghost', role: 'admin' } },
    );
    const res = await membersPOST(req, {
      params: Promise.resolve({ siteId: SITE }),
    });

    expect(res.status).toBe(404);
  });

  it('rejects invalid role with 400', async () => {
    authedAsSuperadminWithKey();
    seedSite(SITE);
    seedUser('alice', { role: 'admin' });

    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/members`,
      { method: 'POST', body: { uid: 'alice', role: 'wizard' } },
    );
    const res = await membersPOST(req, {
      params: Promise.resolve({ siteId: SITE }),
    });

    expect(res.status).toBe(400);
  });

  it('rejects missing uid with 400', async () => {
    authedAsSuperadminWithKey();
    seedSite(SITE);

    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/members`,
      { method: 'POST', body: { role: 'admin' } },
    );
    const res = await membersPOST(req, {
      params: Promise.resolve({ siteId: SITE }),
    });

    expect(res.status).toBe(400);
  });

  it('writes the swoop mode it is given on the new row, and audits it', async () => {
    authedAsSuperadminWithKey();
    seedSite(SITE);
    seedUser('alice', { role: 'member', sites: [] });

    const res = await membersPOST(
      createMockRequest(`http://localhost/api/sites/${SITE}/members`, {
        method: 'POST',
        body: { uid: 'alice', role: 'member', swoop: 'control' },
      }),
      { params: Promise.resolve({ siteId: SITE }) },
    );

    expect(res.status).toBe(200);
    expect(docStore[`sites/${SITE}/members/alice`]?.data).toMatchObject({
      role: 'member',
      swoop: 'control',
    });
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({ verb: 'member_added', requestedSwoop: 'control' }),
      }),
    );
  });

  it('writes no swoop field without one, so the role decides', async () => {
    authedAsSuperadminWithKey();
    seedSite(SITE);
    seedUser('alice', { role: 'member', sites: [] });

    const res = await membersPOST(
      createMockRequest(`http://localhost/api/sites/${SITE}/members`, {
        method: 'POST',
        body: { uid: 'alice', role: 'admin' },
      }),
      { params: Promise.resolve({ siteId: SITE }) },
    );

    expect(res.status).toBe(200);
    expect(docStore[`sites/${SITE}/members/alice`]?.data?.role).toBe('admin');
    expect(docStore[`sites/${SITE}/members/alice`]?.data).not.toHaveProperty('swoop');
    expect(mockEmitMutation.mock.calls[0][0].attributes).not.toHaveProperty('requestedSwoop');
  });

  it('rejects a swoop outside none, view and control with 400 body.swoop, null included', async () => {
    authedAsSuperadminWithKey();
    seedSite(SITE);
    seedUser('alice', { role: 'member', sites: [] });

    for (const swoop of ['bogus', 'CONTROL', null, 1]) {
      const res = await membersPOST(
        createMockRequest(`http://localhost/api/sites/${SITE}/members`, {
          method: 'POST',
          body: { uid: 'alice', role: 'member', swoop },
        }),
        { params: Promise.resolve({ siteId: SITE }) },
      );

      expect(res.status).toBe(400);
      expect((await res.json()).errors).toEqual({
        'body.swoop': ['must be one of: none, view, control'],
      });
    }
    expect(docStore[`sites/${SITE}/members/alice`]).toBeUndefined();
  });

  describe('machine scope', () => {
    function postMember(body: Record<string, unknown>) {
      return membersPOST(
        createMockRequest(`http://localhost/api/sites/${SITE}/members`, { method: 'POST', body }),
        { params: Promise.resolve({ siteId: SITE }) },
      );
    }

    beforeEach(() => {
      authedAsSuperadminWithKey();
      seedSite(SITE);
      seedMachine(SITE, 'm1');
      seedMachine(SITE, 'm2');
      seedUser('alice', { role: 'member', sites: [] });
    });

    it('writes the list sorted on the new row, and audits it', async () => {
      const res = await postMember({ uid: 'alice', role: 'member', machineIds: ['m2', 'm1'] });

      expect(res.status).toBe(200);
      expect((await res.json()).roleHonored).toBe(true);
      expect(docStore[`sites/${SITE}/members/alice`]?.data).toMatchObject({
        role: 'member',
        machineIds: ['m1', 'm2'],
      });
      expect(mockEmitMutation.mock.calls[0][0].attributes).toMatchObject({
        verb: 'member_added',
        requestedMachineIds: ['m1', 'm2'],
      });
    });

    it('writes no machineIds without one, so the row reaches the whole site', async () => {
      const res = await postMember({ uid: 'alice', role: 'member' });

      expect(res.status).toBe(200);
      expect(docStore[`sites/${SITE}/members/alice`]?.data).not.toHaveProperty('machineIds');
      expect(mockEmitMutation.mock.calls[0][0].attributes).not.toHaveProperty('requestedMachineIds');
    });

    it('refuses a machine that is not on this site, naming it on body.machineIds', async () => {
      const res = await postMember({ uid: 'alice', role: 'member', machineIds: ['m1', 'ghost'] });

      expect(res.status).toBe(400);
      expect((await res.json()).errors).toEqual({
        'body.machineIds': ['unknown machine: ghost'],
      });
      expect(docStore[`sites/${SITE}/members/alice`]).toBeUndefined();
    });

    it('refuses [], 31 ids, null and any other shape with 400 body.machineIds', async () => {
      const thirtyOne = Array.from({ length: 31 }, (_, i) => `m${i}`);
      for (const machineIds of [[], thirtyOne, null, 'm1', [3], ['bad id']]) {
        const res = await postMember({ uid: 'alice', role: 'member', machineIds });

        expect(res.status).toBe(400);
        expect(Object.keys((await res.json()).errors)).toEqual(['body.machineIds']);
      }
      expect(docStore[`sites/${SITE}/members/alice`]).toBeUndefined();
    });

    it('refuses scoping yourself with 403 cannot_modify_own_membership', async () => {
      // user-1 is the actor the mocked wrapper hands every handler here
      seedUser('user-1', { role: 'member', sites: [] });

      const res = await postMember({ uid: 'user-1', role: 'member', machineIds: ['m1'] });

      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('cannot_modify_own_membership');
      expect(docStore[`sites/${SITE}/members/user-1`]).toBeUndefined();
    });

    it('refuses the owner with 409 target_is_owner', async () => {
      seedSite(SITE, { owner: 'owner-uid' });
      seedUser('owner-uid', { role: 'member', sites: [SITE] });

      const res = await postMember({ uid: 'owner-uid', role: 'admin', machineIds: ['m1'] });

      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('target_is_owner');
      expect(docStore[`sites/${SITE}/members/owner-uid`]?.data).not.toHaveProperty('machineIds');
    });

    it('re-adding an existing member answers 200 roleHonored false, and writes no scope', async () => {
      seedMemberRow(SITE, 'alice', 'admin');

      const res = await postMember({ uid: 'alice', role: 'member', machineIds: ['m1'] });

      expect(res.status).toBe(200);
      expect((await res.json()).roleHonored).toBe(false);
      expect(docStore[`sites/${SITE}/members/alice`]?.data).toMatchObject({ role: 'admin' });
      expect(docStore[`sites/${SITE}/members/alice`]?.data).not.toHaveProperty('machineIds');
    });
  });

  // add-by-email — the dashboard affordance; resolves to the same uid path

  describe('by email', () => {
    it('resolves the address through Admin Auth and adds the member', async () => {
      authedAsSuperadminWithKey();
      seedSite(SITE);
      seedUser('alice', { role: 'admin', sites: [] });
      seedAuthEmail('alice@example.com', 'alice');

      const req = createMockRequest(
        `http://localhost/api/sites/${SITE}/members`,
        { method: 'POST', body: { email: 'alice@example.com', role: 'admin' } },
      );
      const res = await membersPOST(req, {
        params: Promise.resolve({ siteId: SITE }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.uid).toBe('alice');
      expect(body.requestedRole).toBe('admin');
      expect(body.roleHonored).toBe(true);
      expect(body.globalRole).toBe('admin');
      expect(docStore['users/alice']?.data?.sites).toContain(SITE);
      expect(mockEmitMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'site_member_mutated',
          siteId: SITE,
          targetId: 'alice',
          attributes: expect.objectContaining({ verb: 'member_added' }),
        }),
      );
    });

    it('trims and lowercases before the directory lookup', async () => {
      authedAsSuperadminWithKey();
      seedSite(SITE);
      seedUser('alice', { role: 'member', sites: [] });
      seedAuthEmail('alice@example.com', 'alice');

      const req = createMockRequest(
        `http://localhost/api/sites/${SITE}/members`,
        {
          method: 'POST',
          body: { email: '  Alice@Example.COM \n', role: 'member' },
        },
      );
      const res = await membersPOST(req, {
        params: Promise.resolve({ siteId: SITE }),
      });
      const body = await res.json();

      expect(mockGetUserByEmail).toHaveBeenCalledWith('alice@example.com');
      expect(res.status).toBe(200);
      expect(body.uid).toBe('alice');
      expect(docStore['users/alice']?.data?.sites).toContain(SITE);
    });

    it('returns 404 for an address with no auth user', async () => {
      authedAsSuperadminWithKey();
      seedSite(SITE);

      const req = createMockRequest(
        `http://localhost/api/sites/${SITE}/members`,
        { method: 'POST', body: { email: 'ghost@example.com', role: 'admin' } },
      );
      const res = await membersPOST(req, {
        params: Promise.resolve({ siteId: SITE }),
      });
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.code).toBe('not_found');
    });

    // an address is only an alias for whoever registered it, and a password
    // account has not shown it owns the address until it verifies
    it('refuses a password account whose email is not verified, and adds nothing', async () => {
      authedAsSuperadminWithKey();
      seedSite(SITE);
      seedUser('alice', { role: 'member', sites: [] });
      seedAuthEmail('alice@example.com', 'alice', { provider: 'password', emailVerified: false });

      const res = await membersPOST(
        createMockRequest(`http://localhost/api/sites/${SITE}/members`, {
          method: 'POST',
          body: { email: 'alice@example.com', role: 'member' },
        }),
        { params: Promise.resolve({ siteId: SITE }) },
      );
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.code).toBe('email_unverified');
      expect(body.detail).toBe(
        'alice@example.com has not verified their email address yet. ask them to verify it, then add them again',
      );
      expect(docStore[`sites/${SITE}/members/alice`]).toBeUndefined();
      expect(docStore['users/alice']?.data?.sites).toEqual([]);
      expect(mockEmitMutation).not.toHaveBeenCalled();
    });

    it.each([
      ['a verified password account', { provider: 'password', emailVerified: true }],
      ['a google account', { provider: 'google.com', emailVerified: true }],
      ['a google account its provider left unverified', { provider: 'google.com', emailVerified: false }],
    ] as const)('adds %s by email', async (_who, signIn) => {
      authedAsSuperadminWithKey();
      seedSite(SITE);
      seedUser('alice', { role: 'member', sites: [] });
      seedAuthEmail('alice@example.com', 'alice', signIn);

      const res = await membersPOST(
        createMockRequest(`http://localhost/api/sites/${SITE}/members`, {
          method: 'POST',
          body: { email: 'alice@example.com', role: 'member' },
        }),
        { params: Promise.resolve({ siteId: SITE }) },
      );

      expect(res.status).toBe(200);
      expect(docStore['users/alice']?.data?.sites).toContain(SITE);
    });

    it('returns 400 when the resolved user is soft-deleted', async () => {
      authedAsSuperadminWithKey();
      seedSite(SITE);
      seedUser('alice', { role: 'admin', sites: [], deletedAt: 1700000000000 });
      seedAuthEmail('alice@example.com', 'alice');

      const req = createMockRequest(
        `http://localhost/api/sites/${SITE}/members`,
        { method: 'POST', body: { email: 'alice@example.com', role: 'admin' } },
      );
      const res = await membersPOST(req, {
        params: Promise.resolve({ siteId: SITE }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.errors).toHaveProperty(['body.email']);
      expect(docStore['users/alice']?.data?.sites).toEqual([]);
    });

    it('rejects uid and email together with 400 (no directory lookup)', async () => {
      authedAsSuperadminWithKey();
      seedSite(SITE);
      seedUser('alice', { role: 'admin', sites: [] });
      seedAuthEmail('alice@example.com', 'alice');

      const req = createMockRequest(
        `http://localhost/api/sites/${SITE}/members`,
        {
          method: 'POST',
          body: { uid: 'alice', email: 'alice@example.com', role: 'admin' },
        },
      );
      const res = await membersPOST(req, {
        params: Promise.resolve({ siteId: SITE }),
      });

      expect(res.status).toBe(400);
      expect(mockGetUserByEmail).not.toHaveBeenCalled();
      expect(docStore['users/alice']?.data?.sites).toEqual([]);
    });

    it('rejects neither uid nor email with 400', async () => {
      authedAsSuperadminWithKey();
      seedSite(SITE);

      const req = createMockRequest(
        `http://localhost/api/sites/${SITE}/members`,
        { method: 'POST', body: { role: 'admin' } },
      );
      const res = await membersPOST(req, {
        params: Promise.resolve({ siteId: SITE }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.errors).toHaveProperty(['body.uid']);
      expect(body.errors).toHaveProperty(['body.email']);
    });

    it('rejects an implausible address before hitting Admin Auth', async () => {
      authedAsSuperadminWithKey();
      seedSite(SITE);

      const req = createMockRequest(
        `http://localhost/api/sites/${SITE}/members`,
        { method: 'POST', body: { email: '   ', role: 'admin' } },
      );
      const res = await membersPOST(req, {
        params: Promise.resolve({ siteId: SITE }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.errors).toHaveProperty(['body.email']);
      expect(mockGetUserByEmail).not.toHaveBeenCalled();
    });
  });
});

// DELETE /api/sites/{siteId}/members/{uid}

describe('DELETE /api/sites/{siteId}/members/{uid}', () => {
  it('removes membership from users.sites[] + emits audit', async () => {
    authedAsSuperadminWithKey();
    seedSite(SITE);
    seedUser('alice', { role: 'admin', sites: [SITE, 'site-other'] });

    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/members/alice`,
      { method: 'DELETE' },
    );
    const res = await memberDELETE(req, {
      params: Promise.resolve({ siteId: SITE, uid: 'alice' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.wasMember).toBe(true);
    expect(docStore['users/alice']?.data?.sites).toEqual(['site-other']);
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'site_member_mutated',
        siteId: SITE,
        targetId: 'alice',
        attributes: expect.objectContaining({ verb: 'member_removed' }),
      }),
    );
  });

  it('revokes the removed member’s live swoop sessions', async () => {
    // The lease alone drops them within five minutes; this is the <= 2 s half
    // of the same decision (PROTOCOL.md §10).
    authedAsSuperadminWithKey();
    seedSite(SITE);
    seedUser('alice', { role: 'admin', sites: [SITE] });

    const res = await memberDELETE(
      createMockRequest(`http://localhost/api/sites/${SITE}/members/alice`, {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ siteId: SITE, uid: 'alice' }) },
    );

    expect(res.status).toBe(200);
    expect(mockRevokeSwoopSessions).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: SITE, uid: 'alice', reason: 'member_removed' }),
    );
  });

  it('does not revoke when there was no membership to remove', async () => {
    authedAsSuperadminWithKey();
    seedSite(SITE);
    seedUser('alice', { role: 'admin', sites: [] });

    await memberDELETE(
      createMockRequest(`http://localhost/api/sites/${SITE}/members/alice`, {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ siteId: SITE, uid: 'alice' }) },
    );

    expect(mockRevokeSwoopSessions).not.toHaveBeenCalled();
  });

  it('refuses to remove the site owner (409 cannot_remove_owner)', async () => {
    authedAsSuperadminWithKey();
    seedSite(SITE, { owner: 'alice' });
    seedUser('alice', { role: 'admin', sites: [SITE] });

    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/members/alice`,
      { method: 'DELETE' },
    );
    const res = await memberDELETE(req, {
      params: Promise.resolve({ siteId: SITE, uid: 'alice' }),
    });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('cannot_remove_owner');
    expect(docStore['users/alice']?.data?.sites).toContain(SITE);
  });

  it('idempotent: removing a non-member returns 200 wasMember=false', async () => {
    authedAsSuperadminWithKey();
    seedSite(SITE);
    seedUser('alice', { role: 'admin', sites: [] });

    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/members/alice`,
      { method: 'DELETE' },
    );
    const res = await memberDELETE(req, {
      params: Promise.resolve({ siteId: SITE, uid: 'alice' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.wasMember).toBe(false);
  });

  it('returns 404 when user does not exist', async () => {
    authedAsSuperadminWithKey();
    seedSite(SITE);

    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/members/ghost`,
      { method: 'DELETE' },
    );
    const res = await memberDELETE(req, {
      params: Promise.resolve({ siteId: SITE, uid: 'ghost' }),
    });

    expect(res.status).toBe(404);
  });

  // talons the departing member authored

  describe('authored talons', () => {
    function seedTalon(talonId: string, data: Record<string, unknown>): void {
      const path = `sites/${SITE}/talons/${talonId}`;
      const merged = {
        name: talonId,
        enabled: true,
        outputs: [{ type: 'email' }],
        ...data,
      };
      docStore[path] = { data: merged };
      const colPath = `sites/${SITE}/talons`;
      if (!collectionDocs[colPath]) collectionDocs[colPath] = [];
      collectionDocs[colPath].push({ id: talonId, data: merged });
    }

    it('reports the count of talons the member wrote, and leaves them alone', async () => {
      authedAsSuperadminWithKey();
      seedSite(SITE);
      seedUser('alice', { role: 'admin', sites: [SITE] });
      seedTalon('t1', { createdBy: 'alice' });
      seedTalon('t2', { createdBy: 'alice' });
      seedTalon('t3', { createdBy: 'bob' });

      const req = createMockRequest(
        `http://localhost/api/sites/${SITE}/members/alice`,
        { method: 'DELETE' },
      );
      const res = await memberDELETE(req, {
        params: Promise.resolve({ siteId: SITE, uid: 'alice' }),
      });
      const body = await res.json();

      // The count is the warning a blind api client gets; nothing moves without
      // an explicit successor.
      expect(res.status).toBe(200);
      expect(body.talonCount).toBe(2);
      expect(body.reassignedTalonIds).toEqual([]);
      expect(docStore[`sites/${SITE}/talons/t1`]?.data?.createdBy).toBe('alice');
      expect(mockEmitMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'site_member_mutated',
          attributes: expect.objectContaining({
            verb: 'member_removed',
            talonCount: 2,
            reassignedTalonCount: 0,
          }),
        }),
      );
    });

    it('reassigns to the named successor before removing membership', async () => {
      authedAsSuperadminWithKey();
      seedSite(SITE);
      seedUser('alice', { role: 'admin', sites: [SITE] });
      seedUser('bob', { role: 'admin', sites: [SITE] });
      seedTalon('t1', { createdBy: 'alice' });

      const req = createMockRequest(
        `http://localhost/api/sites/${SITE}/members/alice?talonSuccessorUid=bob`,
        { method: 'DELETE' },
      );
      const res = await memberDELETE(req, {
        params: Promise.resolve({ siteId: SITE, uid: 'alice' }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.reassignedTalonIds).toEqual(['t1']);
      expect(docStore[`sites/${SITE}/talons/t1`]?.data?.createdBy).toBe('bob');
      expect(docStore['users/alice']?.data?.sites).toEqual([]);
    });

    it('leaves membership intact when the successor is refused', async () => {
      authedAsSuperadminWithKey();
      seedSite(SITE);
      seedUser('alice', { role: 'admin', sites: [SITE] });
      // A member cannot author a talon, so they cannot inherit one either.
      seedUser('carol', { role: 'member', sites: [SITE] });
      seedTalon('t1', { createdBy: 'alice' });

      const req = createMockRequest(
        `http://localhost/api/sites/${SITE}/members/alice?talonSuccessorUid=carol`,
        { method: 'DELETE' },
      );
      const res = await memberDELETE(req, {
        params: Promise.resolve({ siteId: SITE, uid: 'alice' }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.code).toBe('successor_invalid');
      // Order matters: reassign fails, so the removal never happens.
      expect(docStore['users/alice']?.data?.sites).toEqual([SITE]);
      expect(docStore[`sites/${SITE}/talons/t1`]?.data?.createdBy).toBe('alice');
    });

    it('rejects a malformed talonSuccessorUid', async () => {
      authedAsSuperadminWithKey();
      seedSite(SITE);
      seedUser('alice', { role: 'admin', sites: [SITE] });

      const req = createMockRequest(
        `http://localhost/api/sites/${SITE}/members/alice?talonSuccessorUid=${encodeURIComponent('../escape')}`,
        { method: 'DELETE' },
      );
      const res = await memberDELETE(req, {
        params: Promise.resolve({ siteId: SITE, uid: 'alice' }),
      });

      expect(res.status).toBe(400);
      expect(docStore['users/alice']?.data?.sites).toEqual([SITE]);
    });
  });
});

// ---------------------------------------------------------------------------
// Wave 2 task 2.3 — the membership endpoints now go through the single writer
// in lib/membership.server.ts, and PATCH exists for the first time.
// ---------------------------------------------------------------------------

describe('PATCH /api/sites/{siteId}/members/{uid} — per-site role change', () => {
  it('promotes a member to site admin WITHOUT touching their global role', async () => {
    // The whole point of per-site roles: before this endpoint existed, making
    // someone an admin "here" meant promoting them globally, on every site they
    // belong to. That is the leak this closes.
    authedAsSuperadminWithKey();
    seedSite(SITE);
    seedUser('alice', { role: 'member', sites: [SITE] });
    docStore[`sites/${SITE}/members/alice`] = {
      data: { uid: 'alice', role: 'member', status: 'active' },
    };

    const res = await memberPATCH(
      createMockRequest(`http://localhost/api/sites/${SITE}/members/alice`, {
        method: 'PATCH',
        body: { role: 'admin' },
      }),
      { params: Promise.resolve({ siteId: SITE, uid: 'alice' }) },
    );

    expect(res.status).toBe(200);
    expect(docStore[`sites/${SITE}/members/alice`]?.data?.role).toBe('admin');
    // Global role untouched.
    expect(docStore['users/alice']?.data?.role).toBe('member');
  });

  it('a demotion revokes only the sessions that member holds control in', async () => {
    // Demoting to `member` loses MACHINE_REMOTE_CONTROL and nothing else, so a
    // watch they may still have is left alone.
    authedAsSuperadminWithKey();
    seedSite(SITE);
    seedUser('alice', { role: 'member', sites: [SITE] });
    docStore[`sites/${SITE}/members/alice`] = {
      data: { uid: 'alice', role: 'admin', status: 'active' },
    };

    const res = await memberPATCH(
      createMockRequest(`http://localhost/api/sites/${SITE}/members/alice`, {
        method: 'PATCH',
        body: { role: 'member' },
      }),
      { params: Promise.resolve({ siteId: SITE, uid: 'alice' }) },
    );

    expect(res.status).toBe(200);
    expect(mockRevokeSwoopSessions).toHaveBeenCalledWith(
      expect.objectContaining({ uid: 'alice', reason: 'role_changed', controlOnly: true }),
    );
  });

  it('a promotion revokes nothing', async () => {
    authedAsSuperadminWithKey();
    seedSite(SITE);
    seedUser('alice', { role: 'member', sites: [SITE] });
    docStore[`sites/${SITE}/members/alice`] = {
      data: { uid: 'alice', role: 'member', status: 'active' },
    };

    await memberPATCH(
      createMockRequest(`http://localhost/api/sites/${SITE}/members/alice`, {
        method: 'PATCH',
        body: { role: 'admin' },
      }),
      { params: Promise.resolve({ siteId: SITE, uid: 'alice' }) },
    );

    expect(mockRevokeSwoopSessions).not.toHaveBeenCalled();
  });

  it('refuses to change the OWNER\'s role (409 cannot_change_owner_role)', async () => {
    authedAsSuperadminWithKey();
    seedSite(SITE, { owner: 'owner-uid' });
    seedUser('owner-uid', { role: 'member', sites: [SITE] });
    docStore[`sites/${SITE}/members/owner-uid`] = {
      data: { uid: 'owner-uid', role: 'owner', status: 'active' },
    };

    const res = await memberPATCH(
      createMockRequest(`http://localhost/api/sites/${SITE}/members/owner-uid`, {
        method: 'PATCH',
        body: { role: 'member' },
      }),
      { params: Promise.resolve({ siteId: SITE, uid: 'owner-uid' }) },
    );

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('cannot_change_owner_role');
    // Unchanged — the demote-the-owner path writes nothing.
    expect(docStore[`sites/${SITE}/members/owner-uid`]?.data?.role).toBe('owner');
  });

  it('cannot assign owner — an admin may not promote anyone into ownership', async () => {
    authedAsSuperadminWithKey();
    seedSite(SITE);
    seedUser('alice', { role: 'member', sites: [SITE] });
    docStore[`sites/${SITE}/members/alice`] = {
      data: { uid: 'alice', role: 'member', status: 'active' },
    };

    const res = await memberPATCH(
      createMockRequest(`http://localhost/api/sites/${SITE}/members/alice`, {
        method: 'PATCH',
        body: { role: 'owner' },
      }),
      { params: Promise.resolve({ siteId: SITE, uid: 'alice' }) },
    );

    expect(res.status).toBe(400);
    expect(docStore[`sites/${SITE}/members/alice`]?.data?.role).toBe('member');
  });

  it('404s for a uid with no membership on this site', async () => {
    authedAsSuperadminWithKey();
    seedSite(SITE);
    seedUser('stranger', { role: 'member', sites: [] });

    const res = await memberPATCH(
      createMockRequest(`http://localhost/api/sites/${SITE}/members/stranger`, {
        method: 'PATCH',
        body: { role: 'admin' },
      }),
      { params: Promise.resolve({ siteId: SITE, uid: 'stranger' }) },
    );

    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/sites/{siteId}/members/{uid} — swoop mode', () => {
  const alicePath = `sites/${SITE}/members/alice`;

  function seedAlice(row: Record<string, unknown>): void {
    seedUser('alice', { role: 'member', sites: [SITE] });
    docStore[alicePath] = { data: { uid: 'alice', status: 'active', ...row } };
  }

  function patchAlice(body: Record<string, unknown>) {
    return memberPATCH(
      createMockRequest(`http://localhost/api/sites/${SITE}/members/alice`, {
        method: 'PATCH',
        body,
      }),
      { params: Promise.resolve({ siteId: SITE, uid: 'alice' }) },
    );
  }

  /** the one revocation's arguments, read whole so an absent key is visible. */
  function revokeArgs(): Record<string, unknown> {
    expect(mockRevokeSwoopSessions).toHaveBeenCalledTimes(1);
    return (mockRevokeSwoopSessions.mock.calls[0] as unknown as [Record<string, unknown>])[0];
  }

  beforeEach(() => {
    authedAsSuperadminWithKey();
    seedSite(SITE);
  });

  it('sets a member to control, and revokes nothing', async () => {
    seedAlice({ role: 'member' });

    const res = await patchAlice({ swoop: 'control' });

    expect(res.status).toBe(200);
    expect(docStore[alicePath]?.data?.swoop).toBe('control');
    expect(mockRevokeSwoopSessions).not.toHaveBeenCalled();
  });

  it('holding an admin to watch ends only the seats they control, as a swoop change', async () => {
    seedAlice({ role: 'admin' });

    const res = await patchAlice({ swoop: 'view' });

    expect(res.status).toBe(200);
    expect(revokeArgs()).toMatchObject({
      siteId: SITE,
      uid: 'alice',
      reason: 'swoop_changed',
      controlOnly: true,
    });
  });

  it('no swoop ends every seat they hold, watch included', async () => {
    seedAlice({ role: 'member' });

    const res = await patchAlice({ swoop: 'none' });

    expect(res.status).toBe(200);
    const args = revokeArgs();
    expect(args).toMatchObject({ uid: 'alice', reason: 'swoop_changed' });
    expect(args).not.toHaveProperty('controlOnly');
  });

  it('null deletes the field, so their role decides again', async () => {
    seedAlice({ role: 'member', swoop: 'control' });

    const res = await patchAlice({ swoop: null });

    expect(res.status).toBe(200);
    expect(docStore[alicePath]?.data).not.toHaveProperty('swoop');
    expect(docStore[alicePath]?.data?.role).toBe('member');
    // a member's default is watch, so the control they had is what ends
    expect(revokeArgs()).toMatchObject({ reason: 'swoop_changed', controlOnly: true });
  });

  it('demoting an admin set to control keeps the mode, and revokes nothing', async () => {
    seedAlice({ role: 'admin', swoop: 'control' });

    const res = await patchAlice({ role: 'member' });

    expect(res.status).toBe(200);
    expect(docStore[alicePath]?.data).toMatchObject({ role: 'member', swoop: 'control' });
    expect(mockRevokeSwoopSessions).not.toHaveBeenCalled();
  });

  it('refuses a body with none of role, swoop and machineIds', async () => {
    seedAlice({ role: 'member' });

    const res = await patchAlice({});

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toBe('role, swoop or machineIds is required');
    expect(body.errors).toEqual({
      'body.role': ['provide at least one of role, swoop, machineIds'],
      'body.swoop': ['provide at least one of role, swoop, machineIds'],
      'body.machineIds': ['provide at least one of role, swoop, machineIds'],
    });
  });

  it('refuses a swoop outside none, view, control and null on body.swoop', async () => {
    seedAlice({ role: 'member' });

    const res = await patchAlice({ swoop: 'bogus' });

    expect(res.status).toBe(400);
    expect((await res.json()).errors).toEqual({
      'body.swoop': ['must be one of: none, view, control, or null for the role default'],
    });
    expect(docStore[alicePath]?.data).not.toHaveProperty('swoop');
  });

  it('refuses the owner’s row with 409, the swoop mode included', async () => {
    seedSite(SITE, { owner: 'owner-uid' });
    seedUser('owner-uid', { role: 'member', sites: [SITE] });

    const res = await memberPATCH(
      createMockRequest(`http://localhost/api/sites/${SITE}/members/owner-uid`, {
        method: 'PATCH',
        body: { swoop: 'none' },
      }),
      { params: Promise.resolve({ siteId: SITE, uid: 'owner-uid' }) },
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('cannot_change_owner_role');
    expect(body.detail).toBe(
      "the owner's role, swoop and access come with ownership; transfer ownership via POST /api/sites/{siteId}/transfer-ownership instead",
    );
    expect(docStore[`sites/${SITE}/members/owner-uid`]?.data).not.toHaveProperty('swoop');
  });

  it('refuses your own row with 403 before reading the body', async () => {
    // user-1 is the actor the mocked wrapper hands every handler here
    seedUser('user-1', { role: 'member', sites: [SITE] });
    const req = createMockRequest(`http://localhost/api/sites/${SITE}/members/user-1`, {
      method: 'PATCH',
      body: { swoop: 'control' },
    });

    const res = await memberPATCH(req, { params: Promise.resolve({ siteId: SITE, uid: 'user-1' }) });

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('cannot_modify_own_membership');
    expect(req.bodyUsed).toBe(false);
    expect(docStore[`sites/${SITE}/members/user-1`]?.data).not.toHaveProperty('swoop');
  });

  it('answers with the access as written, and audits a role, a swoop and an access change apart', async () => {
    seedAlice({ role: 'member' });
    seedMachine(SITE, 'm1');

    const roleOnly = await patchAlice({ role: 'admin' });
    expect(await roleOnly.json()).toEqual({
      siteId: SITE,
      uid: 'alice',
      role: 'admin',
      swoop: null,
      machineIds: null,
    });

    const both = await patchAlice({ role: 'member', swoop: 'control' });
    expect(await both.json()).toEqual({
      siteId: SITE,
      uid: 'alice',
      role: 'member',
      swoop: 'control',
      machineIds: null,
    });

    const swoopOnly = await patchAlice({ swoop: null });
    expect(await swoopOnly.json()).toEqual({
      siteId: SITE,
      uid: 'alice',
      role: 'member',
      swoop: null,
      machineIds: null,
    });

    const accessOnly = await patchAlice({ machineIds: ['m1'] });
    expect(await accessOnly.json()).toEqual({
      siteId: SITE,
      uid: 'alice',
      role: 'member',
      swoop: null,
      machineIds: ['m1'],
    });

    const attributes = mockEmitMutation.mock.calls.map(([event]) => event.attributes);
    expect(attributes).toEqual([
      expect.objectContaining({ method: 'PATCH', verb: 'member_role_changed', role: 'admin' }),
      expect.objectContaining({ verb: 'member_role_changed', role: 'member', swoop: 'control' }),
      expect.objectContaining({ verb: 'member_swoop_changed', swoop: null }),
      expect.objectContaining({ verb: 'member_access_changed', machineIds: ['m1'] }),
    ]);
    expect(attributes[0]).not.toHaveProperty('swoop');
    expect(attributes[0]).not.toHaveProperty('machineIds');
    expect(attributes[2]).not.toHaveProperty('role');
    expect(attributes[3]).not.toHaveProperty('role');
    expect(attributes[3]).not.toHaveProperty('swoop');
  });
});

describe('PATCH /api/sites/{siteId}/members/{uid} — machine scope', () => {
  const alicePath = `sites/${SITE}/members/alice`;

  function seedAlice(row: Record<string, unknown>): void {
    seedUser('alice', { role: 'member', sites: [SITE] });
    docStore[alicePath] = { data: { uid: 'alice', status: 'active', ...row } };
  }

  function patchAlice(body: Record<string, unknown>) {
    return memberPATCH(
      createMockRequest(`http://localhost/api/sites/${SITE}/members/alice`, {
        method: 'PATCH',
        body,
      }),
      { params: Promise.resolve({ siteId: SITE, uid: 'alice' }) },
    );
  }

  /** the one revocation's arguments, read whole so an absent key is visible. */
  function revokeArgs(): Record<string, unknown> {
    expect(mockRevokeSwoopSessions).toHaveBeenCalledTimes(1);
    return (mockRevokeSwoopSessions.mock.calls[0] as unknown as [Record<string, unknown>])[0];
  }

  beforeEach(() => {
    authedAsSuperadminWithKey();
    seedSite(SITE);
    seedMachine(SITE, 'm1');
    seedMachine(SITE, 'm2');
  });

  it('machineIds alone writes the sorted list, keeps role and swoop, and ends the seats outside it', async () => {
    seedAlice({ role: 'admin', swoop: 'view' });

    const res = await patchAlice({ machineIds: ['m2', 'm1'] });

    expect(res.status).toBe(200);
    expect(docStore[alicePath]?.data).toMatchObject({
      role: 'admin',
      swoop: 'view',
      machineIds: ['m1', 'm2'],
    });
    const args = revokeArgs();
    expect(args).toMatchObject({
      siteId: SITE,
      uid: 'alice',
      reason: 'scope_changed',
      keepMachineIds: ['m1', 'm2'],
    });
    expect(args).not.toHaveProperty('controlOnly');
  });

  it('null deletes the field, so they reach the whole site again, and revokes nothing', async () => {
    seedAlice({ role: 'member', swoop: 'control', machineIds: ['m1'] });

    const res = await patchAlice({ machineIds: null });

    expect(res.status).toBe(200);
    expect(docStore[alicePath]?.data).not.toHaveProperty('machineIds');
    expect(docStore[alicePath]?.data).toMatchObject({ role: 'member', swoop: 'control' });
    expect(mockRevokeSwoopSessions).not.toHaveBeenCalled();
  });

  it('holding an admin to watch on fewer machines is ONE revocation carrying both filters', async () => {
    seedAlice({ role: 'admin' });

    const res = await patchAlice({ swoop: 'view', machineIds: ['m1'] });

    expect(res.status).toBe(200);
    expect(revokeArgs()).toMatchObject({
      reason: 'swoop_changed',
      controlOnly: true,
      keepMachineIds: ['m1'],
    });
  });

  it('no swoop on fewer machines is one revocation with neither filter: every seat ends', async () => {
    seedAlice({ role: 'admin' });

    const res = await patchAlice({ swoop: 'none', machineIds: ['m1'] });

    expect(res.status).toBe(200);
    const args = revokeArgs();
    expect(args).toMatchObject({ reason: 'swoop_changed' });
    expect(args).not.toHaveProperty('controlOnly');
    expect(args).not.toHaveProperty('keepMachineIds');
  });

  it('demoting a scoped admin ends their control seats as a role change, and keeps the scope', async () => {
    seedAlice({ role: 'admin', machineIds: ['m1'] });

    const res = await patchAlice({ role: 'member' });

    expect(res.status).toBe(200);
    expect(docStore[alicePath]?.data).toMatchObject({ role: 'member', machineIds: ['m1'] });
    const args = revokeArgs();
    expect(args).toMatchObject({ reason: 'role_changed', controlOnly: true });
    // the scope did not narrow, so nothing outside it is singled out
    expect(args).not.toHaveProperty('keepMachineIds');
  });

  it('widening from one machine to the whole site revokes nothing', async () => {
    seedAlice({ role: 'member', machineIds: ['m1'] });

    const res = await patchAlice({ machineIds: null });

    expect(res.status).toBe(200);
    expect(mockRevokeSwoopSessions).not.toHaveBeenCalled();
  });

  it('narrowing from two machines to one keeps the one; re-sending the same list revokes nothing', async () => {
    seedAlice({ role: 'member', machineIds: ['m1', 'm2'] });

    const narrowed = await patchAlice({ machineIds: ['m1'] });

    expect(narrowed.status).toBe(200);
    expect(revokeArgs()).toMatchObject({ reason: 'scope_changed', keepMachineIds: ['m1'] });

    mockRevokeSwoopSessions.mockClear();
    const same = await patchAlice({ machineIds: ['m1'] });

    expect(same.status).toBe(200);
    expect(mockRevokeSwoopSessions).not.toHaveBeenCalled();
  });

  it('refuses a machine that is not on this site, or a list that is not 1-30 ids, before any write', async () => {
    seedAlice({ role: 'member' });

    const unknown = await patchAlice({ machineIds: ['ghost', 'm1'] });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).errors).toEqual({ 'body.machineIds': ['unknown machine: ghost'] });

    for (const machineIds of [[], 'm1', [3]]) {
      const res = await patchAlice({ machineIds });
      expect(res.status).toBe(400);
      expect(Object.keys((await res.json()).errors)).toEqual(['body.machineIds']);
    }
    expect(docStore[alicePath]?.data).not.toHaveProperty('machineIds');
  });

  it('refuses the owner’s row with 409, the machine scope included', async () => {
    seedSite(SITE, { owner: 'owner-uid' });
    seedUser('owner-uid', { role: 'member', sites: [SITE] });

    const res = await memberPATCH(
      createMockRequest(`http://localhost/api/sites/${SITE}/members/owner-uid`, {
        method: 'PATCH',
        body: { machineIds: ['m1'] },
      }),
      { params: Promise.resolve({ siteId: SITE, uid: 'owner-uid' }) },
    );

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('cannot_change_owner_role');
    expect(docStore[`sites/${SITE}/members/owner-uid`]?.data).not.toHaveProperty('machineIds');
  });

  it('refuses scoping your own row with 403 before reading the body', async () => {
    // user-1 is the actor the mocked wrapper hands every handler here
    seedUser('user-1', { role: 'member', sites: [SITE] });
    const req = createMockRequest(`http://localhost/api/sites/${SITE}/members/user-1`, {
      method: 'PATCH',
      body: { machineIds: ['m1'] },
    });

    const res = await memberPATCH(req, { params: Promise.resolve({ siteId: SITE, uid: 'user-1' }) });

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('cannot_modify_own_membership');
    expect(req.bodyUsed).toBe(false);
    expect(docStore[`sites/${SITE}/members/user-1`]?.data).not.toHaveProperty('machineIds');
  });
});

describe('POST /api/sites/{siteId}/members — owner guard', () => {
  it('refuses to re-add the site OWNER as a lesser member', async () => {
    // create() alone does not protect a site that predates the members
    // subcollection: its owner has no row to collide with until the Wave 3
    // backfill, so without this explicit check the owner would be handed a
    // `member` row and silently demoted in the new shape.
    authedAsSuperadminWithKey();
    seedSite(SITE, { owner: 'owner-uid' });
    seedUser('owner-uid', { role: 'member', sites: [SITE] });

    const res = await membersPOST(
      createMockRequest(`http://localhost/api/sites/${SITE}/members`, {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-owner-readd' },
        body: { uid: 'owner-uid', role: 'member' },
      }),
      { params: Promise.resolve({ siteId: SITE }) },
    );

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('target_is_owner');
    // The owner's row is untouched — still `owner`, not downgraded. It exists
    // now (ownership IS a member row), so absence is no longer the assertion.
    expect(docStore[`sites/${SITE}/members/owner-uid`]?.data?.role).toBe('owner');
  });
});
