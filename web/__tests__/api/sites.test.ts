/** @jest-environment node */

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
  return {
    ...actual,
    resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
  };
});

jest.mock('@/lib/rateLimit.server', () => ({
  checkRateLimit: jest.fn(async () => ({ ok: true })),
  rateLimitHeaders: jest.fn(() => ({})),
}));

jest.mock('@/lib/securityConfig.server', () => ({
  securityConfig: {
    read: jest.fn(async () => ({
      capability_enforcement: true,
      rate_limit_enforcement: true,
    })),
  },
}));

const mockGetEntitlements = jest.fn();
jest.mock('@/lib/tridantEntitlements.server', () => ({
  getEntitlements: (uid: string) => mockGetEntitlements(uid),
}));

jest.mock('firebase-admin/firestore', () => {
  class MockTimestamp {
    private readonly ms: number;

    constructor(ms: number) {
      this.ms = ms;
    }

    static fromDate(d: Date): MockTimestamp {
      return new MockTimestamp(d.getTime());
    }

    toMillis(): number {
      return this.ms;
    }
  }

  return {
    FieldValue: {
      serverTimestamp: () => ({ __op: 'serverTimestamp' }),
      arrayUnion: (...items: unknown[]) => ({ __op: 'arrayUnion', items }),
    },
    Timestamp: MockTimestamp,
  };
});

interface DocStore {
  data: Record<string, unknown> | null;
}

interface WhereClause {
  field: string;
  op: string;
  value: unknown;
}

const docStore: Record<string, DocStore> = {};
const collectionDocs: Record<string, Array<{ id: string; data: Record<string, unknown> }>> = {};
let autoId = 0;

function pathFor(parts: string[]): string {
  return parts.join('/');
}

function applyFieldOps(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && '__op' in value) {
      const op = (value as { __op: string }).__op;
      if (op === 'serverTimestamp') {
        next[key] = Date.now();
        continue;
      }
      if (op === 'arrayUnion') {
        const items = (value as { items: unknown[] }).items;
        const current = Array.isArray(next[key]) ? [...(next[key] as unknown[])] : [];
        for (const item of items) {
          if (!current.includes(item)) current.push(item);
        }
        next[key] = current;
        continue;
      }
    }
    next[key] = value;
  }
  return next;
}

function syncCollection(parts: string[], docId: string, data: Record<string, unknown> | null): void {
  const colPath = pathFor(parts.slice(0, -1));
  if (!collectionDocs[colPath]) collectionDocs[colPath] = [];
  const idx = collectionDocs[colPath].findIndex((d) => d.id === docId);
  if (data === null) {
    if (idx >= 0) collectionDocs[colPath].splice(idx, 1);
  } else if (idx >= 0) {
    collectionDocs[colPath][idx] = { id: docId, data };
  } else {
    collectionDocs[colPath].push({ id: docId, data });
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
    collection: (name: string) => makeCollectionRef([...parts, name]),
  };
  return ref;
}

function makeCollectionRef(parts: string[]): unknown {
  const path = pathFor(parts);
  const wheres: WhereClause[] = [];

  const ref: Record<string, unknown> = {
    doc: (id?: string) => makeDocRef([...parts, id ?? `auto-${++autoId}`]),
    where: (field: string, op: string, value: unknown) => {
      wheres.push({ field, op, value });
      return ref;
    },
    orderBy: () => ref,
    limit: () => ref,
    startAfter: () => ref,
    select: () => ref,
    count: () => ({
      get: async () => {
        const snap = await (ref.get as () => Promise<{ docs: unknown[] }>)();
        return { data: () => ({ count: snap.docs.length }) };
      },
    }),
    get: jest.fn(async () => {
      let docs = (collectionDocs[path] || []).slice();
      for (const w of wheres) {
        docs = docs.filter((d) => {
          const fieldValue = w.field === '__name__' ? d.id : d.data[w.field];
          if (w.op === '==') return fieldValue === w.value;
          if (w.op === 'in') return Array.isArray(w.value) && w.value.includes(fieldValue);
          if (w.op === 'array-contains') {
            return Array.isArray(fieldValue) && fieldValue.includes(w.value);
          }
          return true;
        });
      }
      return {
        empty: docs.length === 0,
        docs: docs.map((d) => ({
          id: d.id,
          exists: true,
          data: () => d.data,
          ref: makeDocRef([...parts, d.id]),
        })),
      };
    }),
  };
  return ref;
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    // Batched read used by lib/sitePolicy.server.ts. Real getAll preserves
    // argument order and yields a non-existent snapshot for a missing doc,
    // so delegating to each ref's own get() matches its observable shape.
    /** Recursive delete — `deleteSite` cascades the site document AND every
     *  subcollection under it, so a fake that dropped only the named key would
     *  let the cascade pass here while leaking member rows in production. */
    recursiveDelete: async (ref: { path?: string }) => {
      const path = ref.path ?? '';
      for (const key of Object.keys(docStore)) {
        if (key === path || key.startsWith(`${path}/`)) docStore[key] = { data: null };
      }
    },
    getAll: (...refs: Array<{ get: () => Promise<unknown> }>) =>
      Promise.all(refs.map((r) => r.get())),
    collection: (name: string) => makeCollectionRef([name]),
    // Mirrors a real WriteBatch: buffer the writes, then replay them on
    // commit through the same doc refs, so batched writes land in docStore
    // exactly as direct ones do. createSite writes the site doc and the
    // owner's membership as one batch.
    batch: () => {
      const ops: Array<() => Promise<void>> = [];
      return {
        set: (ref: { set: (data: unknown) => Promise<void> }, data: unknown) => {
          ops.push(() => ref.set(data));
        },
        update: (
          ref: { update: (patch: Record<string, unknown>) => Promise<void> },
          patch: Record<string, unknown>,
        ) => {
          ops.push(() => ref.update(patch));
        },
        delete: (ref: { delete: () => Promise<void> }) => {
          ops.push(() => ref.delete());
        },
        commit: async () => {
          for (const op of ops) await op();
        },
      };
    },
    // the ownership transfer's transaction. writes land as they are made; nothing here races.
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        get: (ref: { get: () => Promise<unknown> }) => ref.get(),
        set: (ref: { set: (data: unknown) => Promise<void> }, data: unknown) => ref.set(data),
        update: (
          ref: { update: (patch: Record<string, unknown>) => Promise<void> },
          patch: Record<string, unknown>,
        ) => ref.update(patch),
      }),
  }),
  getAdminAuth: () => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')),
  }),
  getAdminStorage: () => ({ bucket: () => ({}) }),
}));

import { GET as sitesGET, POST as sitesPOST } from '@/app/api/sites/route';
import {
  GET as siteGET,
  PATCH as sitePATCH,
  DELETE as siteDELETE,
} from '@/app/api/sites/[siteId]/route';
import { POST as transferPOST } from '@/app/api/sites/[siteId]/transfer-ownership/route';

type Scope = {
  resource: 'site' | 'roost' | 'machine' | 'chat' | 'user' | 'installer';
  id: string;
  permissions: string[];
};

/**
 * Membership rows for a seeded fixture, as `membership.server.ts` writes them.
 *
 * Site access resolves from these and nothing else, so seeding `users/{uid}.sites`
 * alone now grants nothing. The GLOBAL role is mirrored onto each site because
 * that is what it used to confer there; superadmins get no rows, matching
 * production, where they reach every site by role instead.
 */
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
    docStore[`sites/${siteId}/members/${uid}`] = {
      data: {
        uid,
        role: owns ? 'owner' : globalRole === 'admin' ? 'admin' : 'member',
        status: 'active',
        addedAt: new Date(0),
        addedBy: 'system:test',
      },
    };
  }
}

function seedUser(uid: string, data: Record<string, unknown> = {}): void {
  const merged = {
    email: `${uid}@example.com`,
    role: 'member',
    sites: [],
    ...data,
  };
  const path = `users/${uid}`;
  docStore[path] = { data: merged };
  seedMembershipFor(uid, merged);
  syncCollection(['users', uid], uid, merged);
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
  docStore[`sites/${siteId}/members/${owner}`] = {
    data: {
      uid: owner,
      role: 'owner',
      status: 'active',
      addedAt: new Date(0),
      addedBy: 'system:test',
    },
  };
}

function seedSite(siteId: string, data: Record<string, unknown> = {}): void {
  const merged = {
    name: siteId,
    owner: 'owner-uid',
    timezone: 'UTC',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...data,
  };
  const path = `sites/${siteId}`;
  docStore[path] = { data: merged };
  seedOwnerMembership(siteId, merged);
  syncCollection(['sites', siteId], siteId, merged);
}

function authedSession(userId: string, role: string, sites: string[] = []): void {
  seedUser(userId, { role, sites });
  mockResolveAuth.mockResolvedValue({ userId, keyContext: null });
}

function authedKey(
  userId: string,
  role: string,
  scopes: Scope[] | null,
  options: { isLegacy?: boolean; sites?: string[] } = {},
): void {
  seedUser(userId, { role, sites: options.sites ?? [] });
  mockResolveAuth.mockResolvedValue({
    userId,
    keyContext: {
      keyId: 'key_test',
      environment: 'live',
      isLegacy: options.isLegacy === true,
      scopes,
      expiresAt: null,
    },
  });
}

function siteScope(id: string, permission: string): Scope {
  return { resource: 'site', id, permissions: [permission] };
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(docStore)) delete docStore[key];
  for (const key of Object.keys(collectionDocs)) delete collectionDocs[key];
  autoId = 0;
});

describe('GET /api/sites', () => {
  it('lists assigned and owned sites for session callers', async () => {
    authedSession('alice', 'member', ['site-b']);
    seedSite('site-a', { name: 'Alpha', owner: 'alice' });
    seedSite('site-b', { name: 'Beta', owner: 'other' });
    seedSite('site-c', { name: 'Gamma', owner: 'other' });

    const res = await sitesGET(createMockRequest('http://localhost/api/sites'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sites.map((s: { id: string }) => s.id)).toEqual(['site-a', 'site-b']);
  });

  it('limits scoped API keys to explicit site scopes', async () => {
    authedKey('admin-uid', 'superadmin', [siteScope('site-b', 'read')]);
    seedSite('site-a', { name: 'Alpha' });
    seedSite('site-b', { name: 'Beta' });

    const res = await sitesGET(createMockRequest('http://localhost/api/sites'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sites.map((s: { id: string }) => s.id)).toEqual(['site-b']);
  });

  it('does not expose all account sites to non-site-scoped API keys', async () => {
    authedKey('admin-uid', 'superadmin', [
      { resource: 'roost', id: 'roost_alpha', permissions: ['read'] },
    ]);
    seedSite('site-a', { name: 'Alpha' });
    seedSite('site-b', { name: 'Beta' });

    const res = await sitesGET(createMockRequest('http://localhost/api/sites'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sites).toEqual([]);
  });

  it('keeps legacy unscoped keys on the account view with a deprecation header', async () => {
    authedKey('admin-uid', 'superadmin', null, { isLegacy: true });
    seedSite('site-a', { name: 'Alpha' });
    seedSite('site-b', { name: 'Beta' });

    const res = await sitesGET(createMockRequest('http://localhost/api/sites'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sites.map((s: { id: string }) => s.id)).toEqual(['site-a', 'site-b']);
    expect(res.headers.get('X-Roost-Deprecation')).toContain('legacy-key-scope-missing');
  });
});

describe('/api/sites/{siteId}', () => {
  it('returns site detail for a caller with site read scope', async () => {
    authedKey('admin-uid', 'superadmin', [siteScope('site-a', 'read')]);
    seedSite('site-a', { name: 'Alpha', owner: 'admin-uid', plan: 'pro' });

    const res = await siteGET(
      createMockRequest('http://localhost/api/sites/site-a'),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      id: 'site-a',
      name: 'Alpha',
      owner: 'admin-uid',
      plan: 'pro',
      timezone: 'UTC',
    });
  });

  it('creates a site and replays matching idempotency keys', async () => {
    authedKey('admin-uid', 'superadmin', [siteScope('*', 'admin')]);
    const request = () =>
      createMockRequest('http://localhost/api/sites', {
        method: 'POST',
        headers: { 'Idempotency-Key': 'create-site-a' },
        body: { siteId: 'site-new', name: 'New Site', timezone: 'America/Los_Angeles' },
      });

    const first = await sitesPOST(request());
    const second = await sitesPOST(request());
    const body = await second.json();

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get('Idempotent-Replayed')).toBe('true');
    expect(body.siteId).toBe('site-new');
    expect(docStore['sites/site-new']?.data?.name).toBe('New Site');
    // The creator must end up a member, not merely the owner: the client
    // site list resolves `users/{uid}.sites[]`, so an owner-only write leaves
    // the site invisible to the person who just created it. Asserted at the
    // route boundary because that is the path a real signup takes.
    expect(docStore['users/admin-uid']?.data?.sites).toContain('site-new');
    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
  });

  it('rejects site creation for API keys without site admin scope', async () => {
    authedKey('admin-uid', 'superadmin', [
      { resource: 'roost', id: '*', permissions: ['admin'] },
    ]);

    const res = await sitesPOST(
      createMockRequest('http://localhost/api/sites', {
        method: 'POST',
        body: { siteId: 'site-new', name: 'New Site' },
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe('scope_insufficient');
    expect(docStore['sites/site-new']).toBeUndefined();
  });

  it('updates site settings through the site admin surface', async () => {
    authedKey('admin-uid', 'superadmin', [siteScope('site-a', 'admin')]);
    seedSite('site-a', { name: 'Old Name', owner: 'admin-uid' });

    const res = await sitePATCH(
      createMockRequest('http://localhost/api/sites/site-a', {
        method: 'PATCH',
        // `schedulesFollowSiteTime: false` rides along as a boolean: the echoed
        // `updated` map is no longer string-valued, and `false` in particular
        // must survive the whole route → action → response path rather than
        // being dropped by a truthiness check somewhere in it.
        body: { name: 'New Name', timeFormat: '24h', schedulesFollowSiteTime: false },
      }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.changed).toBe(true);
    expect(body.updated).toEqual({
      name: 'New Name',
      timeFormat: '24h',
      schedulesFollowSiteTime: false,
    });
    expect(docStore['sites/site-a']?.data).toMatchObject({
      name: 'New Name',
      timeFormat: '24h',
      schedulesFollowSiteTime: false,
    });
  });

  it('enables site time when the same request supplies the timezone', async () => {
    authedKey('admin-uid', 'superadmin', [siteScope('site-a', 'admin')]);
    seedSite('site-a', { owner: 'admin-uid', timezone: '' });

    const res = await sitePATCH(
      createMockRequest('http://localhost/api/sites/site-a', {
        method: 'PATCH',
        body: { timezone: 'America/Los_Angeles', schedulesFollowSiteTime: true },
      }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.updated).toEqual({
      timezone: 'America/Los_Angeles',
      schedulesFollowSiteTime: true,
    });
    expect(docStore['sites/site-a']?.data).toMatchObject({
      timezone: 'America/Los_Angeles',
      schedulesFollowSiteTime: true,
    });
  });

  it('rejects enabling site time on a site with no timezone', async () => {
    authedKey('admin-uid', 'superadmin', [siteScope('site-a', 'admin')]);
    seedSite('site-a', { owner: 'admin-uid', timezone: '' });

    const res = await sitePATCH(
      createMockRequest('http://localhost/api/sites/site-a', {
        method: 'PATCH',
        body: { schedulesFollowSiteTime: true },
      }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.errors?.['body.schedulesFollowSiteTime']).toBeDefined();
    // Nothing written: a site that claimed site time without one would leave the
    // agent endpoint returning null and schedules quietly on machine clocks.
    expect(docStore['sites/site-a']?.data?.schedulesFollowSiteTime).toBeUndefined();
  });

  it('creates a site with the flag left unset when the request omits it', async () => {
    authedKey('admin-uid', 'superadmin', [siteScope('*', 'admin')]);

    const res = await sitesPOST(
      createMockRequest('http://localhost/api/sites', {
        method: 'POST',
        body: { siteId: 'site-new', name: 'New Site', timezone: 'America/Los_Angeles' },
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.schedulesFollowSiteTime).toBe(false);
    // Absent, not `false`: the document keeps the "never asked" state so the
    // site can still be prompted to opt in.
    expect(docStore['sites/site-new']?.data).not.toHaveProperty('schedulesFollowSiteTime');
  });

  it('deletes a site through the site admin surface', async () => {
    authedKey('admin-uid', 'superadmin', [siteScope('site-a', 'admin')]);
    seedSite('site-a', { owner: 'admin-uid' });

    const res = await siteDELETE(
      createMockRequest('http://localhost/api/sites/site-a', { method: 'DELETE' }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ siteId: 'site-a', deleted: true });
    expect(docStore['sites/site-a']?.data).toBeNull();
  });

  /*
   * DELETE moved from SITE_MEMBER_MANAGE to SITE_DELETE, a capability NO role
   * holds — so it resolves only through the ownership short-circuit or the
   * superadmin grant. The test above cannot show that: its caller is superadmin
   * AND owner, so it passes identically under the old capability. These three
   * pin the boundary that actually moved.
   */
  it('refuses DELETE for a site admin who is not the owner, but still allows PATCH', async () => {
    authedKey('admin-uid', 'admin', [siteScope('site-a', 'admin')], { sites: ['site-a'] });
    seedSite('site-a', { owner: 'someone-else', name: 'Site A' });

    const del = await siteDELETE(
      createMockRequest('http://localhost/api/sites/site-a', { method: 'DELETE' }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );
    expect(del.status).toBe(403);
    expect(docStore['sites/site-a']?.data).not.toBeNull();

    // The same actor still administers the site — only destruction narrowed.
    const patch = await sitePATCH(
      createMockRequest('http://localhost/api/sites/site-a', {
        method: 'PATCH',
        body: { name: 'Renamed' },
      }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );
    expect(patch.status).toBe(200);
  });

  it('allows DELETE for a member who OWNS the site (self-serve owners are role member)', async () => {
    authedKey('owner-uid', 'member', [siteScope('site-a', 'admin')], { sites: ['site-a'] });
    seedSite('site-a', { owner: 'owner-uid' });

    const res = await siteDELETE(
      createMockRequest('http://localhost/api/sites/site-a', { method: 'DELETE' }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );

    expect(res.status).toBe(200);
    expect(docStore['sites/site-a']?.data).toBeNull();
  });

  it('allows a superadmin to delete a site they do not own', async () => {
    authedKey('super-uid', 'superadmin', [siteScope('site-a', 'admin')]);
    seedSite('site-a', { owner: 'someone-else' });

    const res = await siteDELETE(
      createMockRequest('http://localhost/api/sites/site-a', { method: 'DELETE' }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );

    expect(res.status).toBe(200);
    expect(docStore['sites/site-a']?.data).toBeNull();
  });
});

describe('plan limits on sites', () => {
  const FREE = {
    ok: true,
    resolved: false,
    standing: 'expired',
    inGoodStanding: false,
    ent: { 'owlette.sites': '1', 'owlette.machines': '1' },
    epoch: 0,
  };

  beforeEach(() => {
    process.env.PLAN_ENFORCEMENT = 'on';
    process.env.TRIDANT_API_URL = 'https://tridant.test';
    process.env.TRIDANT_LICENSE_KEY = 'test-license-key';
    mockGetEntitlements.mockResolvedValue(FREE);
  });

  afterEach(() => {
    delete process.env.PLAN_ENFORCEMENT;
    delete process.env.TRIDANT_API_URL;
    delete process.env.TRIDANT_LICENSE_KEY;
  });

  const createRequest = (siteId: string) =>
    createMockRequest('http://localhost/api/sites', {
      method: 'POST',
      body: { siteId, name: 'Second Site' },
    });

  const transferRequest = (siteId: string, successorUid: string) =>
    transferPOST(
      createMockRequest(`http://localhost/api/sites/${siteId}/transfer-ownership`, {
        method: 'POST',
        body: { successorUid },
      }),
      { params: Promise.resolve({ siteId }) },
    );

  function seedMachine(siteId: string, machineId: string): void {
    const parts = ['sites', siteId, 'machines', machineId];
    docStore[pathFor(parts)] = { data: { online: true } };
    syncCollection(parts, machineId, { online: true });
  }

  it("refuses a free payer's second site with 402 plan_required, writing nothing", async () => {
    seedSite('site-a', { owner: 'free-uid' });
    authedSession('free-uid', 'member', ['site-a']);

    const res = await sitesPOST(createRequest('site-b'));
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body).toMatchObject({
      code: 'plan_required',
      detail: "your plan doesn't cover another site. upgrade for more sites.",
      entitlement: 'owlette.sites',
      upgradeUrl: '/settings/plan',
    });
    expect(mockGetEntitlements).toHaveBeenCalledWith('free-uid');
    expect(docStore['sites/site-b']).toBeUndefined();
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it("POSITIVE CONTROL: a free payer's first site is created", async () => {
    authedSession('free-uid', 'member');

    const res = await sitesPOST(createRequest('site-b'));

    expect(res.status).toBe(201);
    expect(docStore['sites/site-b']?.data?.owner).toBe('free-uid');
  });

  it('creates a second site without asking tridant while enforcement is off', async () => {
    delete process.env.PLAN_ENFORCEMENT;
    seedSite('site-a', { owner: 'free-uid' });
    authedSession('free-uid', 'member', ['site-a']);

    const res = await sitesPOST(createRequest('site-b'));

    expect(res.status).toBe(201);
    expect(mockGetEntitlements).not.toHaveBeenCalled();
  });

  it('refuses a transfer to a free payer who already owns a site', async () => {
    seedSite('site-x', { owner: 'owner-uid' });
    seedSite('site-a', { owner: 'free-uid' });
    seedUser('free-uid', { sites: ['site-a'] });
    authedSession('owner-uid', 'member', ['site-x']);

    const res = await transferRequest('site-x', 'free-uid');
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body).toMatchObject({
      code: 'plan_required',
      detail: "the new owner's plan covers no more sites. they need to upgrade before taking this one.",
      entitlement: 'owlette.sites',
    });
    expect(docStore['sites/site-x']?.data?.owner).toBe('owner-uid');
  });

  it("refuses a transfer that would put a free payer past their machines", async () => {
    seedSite('site-x', { owner: 'owner-uid' });
    seedMachine('site-x', 'machine-1');
    seedMachine('site-x', 'machine-2');
    seedUser('free-uid');
    authedSession('owner-uid', 'member', ['site-x']);

    const res = await transferRequest('site-x', 'free-uid');
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body).toMatchObject({
      code: 'plan_required',
      detail: "the new owner's plan doesn't cover this site's machines. they need to upgrade before taking this one.",
      entitlement: 'owlette.machines',
    });
    expect(docStore['sites/site-x']?.data?.owner).toBe('owner-uid');
  });

  it('POSITIVE CONTROL: a free payer with room takes the site', async () => {
    seedSite('site-x', { owner: 'owner-uid' });
    seedMachine('site-x', 'machine-1');
    seedUser('free-uid');
    authedSession('owner-uid', 'member', ['site-x']);

    const res = await transferRequest('site-x', 'free-uid');

    expect(res.status).toBe(200);
    expect(docStore['sites/site-x']?.data?.owner).toBe('free-uid');
  });
});
