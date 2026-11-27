/** @jest-environment node */
/**
 * GET /api/sites?include=machines: the admin site list's machines column, one
 * request for every site the caller lists. each site's machines come from the
 * decision core (`assertUserHasSiteAccess` → `machineIds` → `scopeCovers`), not
 * from the listing, which is only a candidate set: a site the caller cannot
 * reach gets `machines: null`. a superadmin's come from one collection-group
 * read. sessions only: an api key is sent to the per-site route.
 *
 * the fake firestore honours `select()`, so a field the mapper reads but the
 * query leaves out shows up here as a missing fallback.
 */
import { createMockRequest } from './helpers/utils';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: jest.fn(),
  scopeFingerprint: jest.fn(() => 'fp'),
}));
jest.mock('@/lib/rateLimit.server', () => ({
  checkRateLimit: jest.fn(async () => ({ ok: true })),
  rateLimitHeaders: jest.fn(() => ({})),
}));
jest.mock('@/lib/tridantEntitlements.server', () => ({
  getSiteEntitlements: jest.fn(async () => ({ ok: false, reason: 'not_configured' })),
  invalidateSiteEntitlements: jest.fn(),
}));

const mockResolveAuth = jest.fn();
jest.mock('@/lib/apiAuth.server', () => ({
  ...jest.requireActual('@/lib/apiAuth.server'),
  resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
}));

jest.mock('firebase-admin/firestore', () => {
  class MockTimestamp {
    constructor(private readonly ms: number) {}
    static fromMillis(ms: number): MockTimestamp {
      return new MockTimestamp(ms);
    }
    toDate(): Date {
      return new Date(this.ms);
    }
    toMillis(): number {
      return this.ms;
    }
  }
  return { FieldValue: {}, Timestamp: MockTimestamp };
});

// every document by its full path
const store = new Map<string, Record<string, unknown>>();
const reads = { collectionGroup: 0, getAll: 0, users: 0 };

function masked(data: Record<string, unknown>, fields: readonly string[] | null): Record<string, unknown> {
  if (!fields) return data;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const [head, sub] = field.split('.');
    if (!(head in data)) continue;
    if (sub === undefined) out[head] = data[head];
    else {
      const nested = data[head] as Record<string, unknown> | undefined;
      if (nested && sub in nested) out[head] = { ...(out[head] as object), [sub]: nested[sub] };
    }
  }
  return out;
}

function snapshot(path: string, fields: readonly string[] | null = null) {
  const data = store.get(path);
  return {
    id: path.split('/').pop()!,
    exists: data !== undefined,
    ref: docRef(path),
    data: () => (data === undefined ? undefined : masked(data, fields)),
  };
}

function docRef(path: string): Record<string, unknown> {
  const parts = path.split('/');
  return {
    id: parts[parts.length - 1],
    path,
    get parent() {
      return colRef(parts.slice(0, -1).join('/'));
    },
    get: async () => {
      if (parts[0] === 'users') reads.users++;
      return snapshot(path);
    },
    collection: (name: string) => colRef(`${path}/${name}`),
  };
}

type Filter = { field: string; op: string; value: unknown };

function colRef(path: string, filters: Filter[] = [], fields: readonly string[] | null = null): Record<string, unknown> {
  const parts = path.split('/');
  return {
    id: parts[parts.length - 1],
    path,
    get parent() {
      return parts.length > 1 ? docRef(parts.slice(0, -1).join('/')) : null;
    },
    doc: (id: string) => docRef(`${path}/${id}`),
    where: (field: string, op: string, value: unknown) => colRef(path, [...filters, { field, op, value }], fields),
    select: (...selected: string[]) => colRef(path, filters, selected),
    get: async () => {
      const docs = [...store.keys()]
        .filter((p) => p.slice(0, p.lastIndexOf('/')) === path)
        .filter((p) =>
          filters.every(({ field, op, value }) => {
            const id = p.split('/').pop()!;
            const v = field === '__name__' ? id : store.get(p)?.[field];
            return op === 'in' ? (value as unknown[]).includes(v) : v === value;
          }),
        );
      return { docs: docs.map((p) => snapshot(p, fields)) };
    },
  };
}

function collectionGroup(name: string) {
  return {
    select: (...fields: string[]) => ({
      get: async () => {
        reads.collectionGroup++;
        const docs = [...store.keys()].filter((p) => p.split('/').slice(-2, -1)[0] === name);
        return { docs: docs.map((p) => snapshot(p, fields)) };
      },
    }),
  };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => colRef(name),
    collectionGroup,
    getAll: async (...refs: Array<{ get: () => Promise<unknown> }>) => {
      reads.getAll++;
      return Promise.all(refs.map((r) => r.get()));
    },
  }),
  getAdminAuth: () => ({ verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')) }),
  getAdminStorage: () => ({ bucket: () => ({}) }),
}));

import { Timestamp } from 'firebase-admin/firestore';
import { GET } from '@/app/api/sites/route';

const NOW = Date.now();
const FRESH = Timestamp.fromMillis(NOW - 30_000);
const STALE = Timestamp.fromMillis(NOW - 18 * 24 * 60 * 60 * 1000);

function seedSite(id: string, name = id) {
  store.set(`sites/${id}`, { name, owner: 'someone-else', timezone: 'UTC' });
}
function seedUser(uid: string, data: Record<string, unknown>) {
  store.set(`users/${uid}`, { email: `${uid}@example.com`, role: 'member', sites: [], ...data });
}
function seedMember(siteId: string, uid: string, extra: Record<string, unknown> = {}) {
  store.set(`sites/${siteId}/members/${uid}`, { uid, role: 'member', status: 'active', ...extra });
}
function seedMachine(siteId: string, id: string, data: Record<string, unknown>) {
  store.set(`sites/${siteId}/machines/${id}`, data);
}
function session(userId: string) {
  mockResolveAuth.mockResolvedValue({ userId, keyContext: null });
}

async function list(query = '?include=machines') {
  const res = await GET(createMockRequest(`http://localhost/api/sites${query}`));
  return { status: res.status, body: await res.json() };
}
const machinesOf = (body: { sites: { id: string; machines: unknown }[] }, siteId: string) =>
  body.sites.find((s) => s.id === siteId)?.machines;

beforeEach(() => {
  store.clear();
  reads.collectionGroup = 0;
  reads.getAll = 0;
  reads.users = 0;
  mockResolveAuth.mockReset();
  seedSite('site-a', 'Alpha');
  seedSite('site-b', 'Bravo');
  seedMachine('site-a', 'm-fresh', { name: 'FRESH', online: true, lastHeartbeat: FRESH, agent_version: '4.2.7' });
  // what a killed agent leaves: the flag stuck true and a heartbeat 18 days old
  seedMachine('site-a', 'm-stuck', { name: 'STUCK', online: true, lastHeartbeat: STALE, agent_version: '4.1.28' });
  seedMachine('site-a', 'm-asleep', { name: 'ASLEEP', online: true, asleep: true, lastHeartbeat: FRESH });
  // an older agent: its name, heartbeat and version only in the legacy fields
  seedMachine('site-a', 'm-legacy', {
    machine_name: 'LEGACY',
    online: true,
    presence: { lastHeartbeat: FRESH, agent_version: '3.3.7' },
  });
  seedMachine('site-b', 'm-b1', { name: 'B1', online: true, lastHeartbeat: FRESH });
});

describe('a member of the whole site', () => {
  it("lists each machine with the state the per-site route gives it, the legacy fields read", async () => {
    seedUser('alice', { sites: ['site-a'] });
    seedMember('site-a', 'alice');
    session('alice');

    const { status, body } = await list();

    expect(status).toBe(200);
    expect(body.sites.map((s: { id: string }) => s.id)).toEqual(['site-a']);
    expect(machinesOf(body, 'site-a')).toEqual([
      { id: 'm-asleep', name: 'ASLEEP', online: false, asleep: true, lastHeartbeat: FRESH.toDate().toISOString(), agentVersion: null },
      { id: 'm-fresh', name: 'FRESH', online: true, asleep: false, lastHeartbeat: FRESH.toDate().toISOString(), agentVersion: '4.2.7' },
      { id: 'm-legacy', name: 'LEGACY', online: true, asleep: false, lastHeartbeat: FRESH.toDate().toISOString(), agentVersion: '3.3.7' },
      { id: 'm-stuck', name: 'STUCK', online: false, asleep: false, lastHeartbeat: STALE.toDate().toISOString(), agentVersion: '4.1.28' },
    ]);
    // the site fields are the plain listing's
    expect(body.sites[0]).toMatchObject({ id: 'site-a', name: 'Alpha', timezone: 'UTC' });
    expect(reads.collectionGroup).toBe(0);
  });
});

describe('a scoped member', () => {
  it('gets only the machines their scope covers, a scoped id with no machine counting nothing', async () => {
    seedUser('sam', { sites: ['site-a'] });
    seedMember('site-a', 'sam', { machineIds: ['m-fresh', 'm-ghost'] });
    session('sam');

    const { body } = await list();

    expect((machinesOf(body, 'site-a') as { id: string }[]).map((m) => m.id)).toEqual(['m-fresh']);
  });

  it('gets an empty list, not null, for an empty scope', async () => {
    seedUser('sam', { sites: ['site-a'] });
    seedMember('site-a', 'sam', { machineIds: [] });
    session('sam');

    const { body } = await list();

    expect(machinesOf(body, 'site-a')).toEqual([]);
  });

  it("stops at the first MAX_MACHINE_SCOPE ids of the sorted scope, as the switcher's count does", async () => {
    const ids = Array.from({ length: 31 }, (_, i) => `m-scope-${String(i).padStart(2, '0')}`);
    for (const id of ids) seedMachine('site-b', id, { name: id, online: true, lastHeartbeat: FRESH });
    seedUser('sam', { sites: ['site-b'] });
    // more than the members api ever writes: a data error, read as the dashboard reads it
    seedMember('site-b', 'sam', { machineIds: [...ids].reverse() });
    session('sam');

    const { body } = await list();

    const listed = (machinesOf(body, 'site-b') as { id: string }[]).map((m) => m.id);
    expect(listed).toHaveLength(30);
    expect(listed).not.toContain('m-scope-30');
  });
});

describe('a superadmin', () => {
  it("reads every site's machines from one collection-group read, a site they are no member of included", async () => {
    seedUser('root', { role: 'superadmin' });
    seedSite('site-empty', 'Empty');
    // config/{siteId}/machines is a machines collection too; it is not a machine
    store.set('config/site-a/machines/m-fresh', { processes: [] });
    session('root');

    const { body } = await list();

    expect(body.sites.map((s: { id: string }) => s.id)).toEqual(['site-a', 'site-b', 'site-empty']);
    expect((machinesOf(body, 'site-a') as unknown[]).length).toBe(4);
    expect(machinesOf(body, 'site-b')).toEqual([
      { id: 'm-b1', name: 'B1', online: true, asleep: false, lastHeartbeat: FRESH.toDate().toISOString(), agentVersion: null },
    ]);
    expect(machinesOf(body, 'site-empty')).toEqual([]);
    expect(reads.collectionGroup).toBe(1);
    expect(reads.getAll).toBe(0);
  });

  it('gets no machines while their account is deleted', async () => {
    seedUser('root', { role: 'superadmin', deletedAt: NOW });
    session('root');

    const { body } = await list();

    expect(machinesOf(body, 'site-a')).toBeNull();
    expect(reads.collectionGroup).toBe(0);
  });
});

describe('a site the caller cannot reach', () => {
  it('lists the site with machines: null when its listing holds it but no member row grants it', async () => {
    // a legacy sites[] entry the decision core no longer honours
    seedUser('alice', { sites: ['site-a', 'site-b'] });
    seedMember('site-a', 'alice');
    session('alice');

    const { body } = await list();

    expect(body.sites.map((s: { id: string }) => s.id)).toEqual(['site-a', 'site-b']);
    expect(machinesOf(body, 'site-a')).toHaveLength(4);
    expect(machinesOf(body, 'site-b')).toBeNull();
  });

  it('gives every site null while the account is deleted', async () => {
    seedUser('alice', { sites: ['site-a'], deletedAt: NOW });
    seedMember('site-a', 'alice');
    session('alice');

    const { body } = await list();

    expect(machinesOf(body, 'site-a')).toBeNull();
  });
});

describe('an api key', () => {
  it('is refused before anything is read, and pointed at the per-site route', async () => {
    seedUser('alice', { role: 'superadmin' });
    mockResolveAuth.mockResolvedValue({
      userId: 'alice',
      keyContext: { keyId: 'key_test', environment: 'live', isLegacy: false, scopes: null, expiresAt: null },
    });

    const { status, body } = await list();

    expect(status).toBe(403);
    expect(body).toMatchObject({ code: 'api_key_not_permitted' });
    expect(body.detail).toContain('GET /api/sites/{siteId}/machines');
    expect(reads.users).toBe(0);
    expect(reads.collectionGroup).toBe(0);
  });

  it('still lists sites without include', async () => {
    seedUser('alice', { role: 'superadmin' });
    mockResolveAuth.mockResolvedValue({
      userId: 'alice',
      keyContext: { keyId: 'key_test', environment: 'live', isLegacy: false, scopes: null, expiresAt: null },
    });

    const { status, body } = await list('');

    expect(status).toBe(200);
    expect(body.sites.map((s: { id: string }) => s.id)).toEqual(['site-a', 'site-b']);
  });
});

describe('the include parameter', () => {
  it('leaves machines off the plain listing', async () => {
    seedUser('alice', { sites: ['site-a'] });
    seedMember('site-a', 'alice');
    session('alice');

    const { body } = await list('');

    expect(body.sites[0]).not.toHaveProperty('machines');
    expect(reads.getAll).toBe(0);
  });

  it('refuses any other value', async () => {
    seedUser('alice', { sites: ['site-a'] });
    session('alice');

    const { status, body } = await list('?include=processes');

    expect(status).toBe(400);
    expect(body.errors).toEqual({ 'query.include': ['must be "machines"'] });
  });
});
