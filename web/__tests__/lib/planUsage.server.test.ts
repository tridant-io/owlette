/**
 * @jest-environment node
 */

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldPath: { documentId: () => '__name__' },
  FieldValue: {
    arrayUnion: (...elements: unknown[]) => ({ __arrayUnion: elements }),
    serverTimestamp: () => '__SERVER_TS__',
  },
  Timestamp: class {},
}));

const mockResolvePlan = jest.fn();
jest.mock('@/lib/plan.server', () => ({
  ...jest.requireActual('@/lib/plan.server'),
  resolvePlan: (uid: string | null) => mockResolvePlan(uid),
}));

type Doc = Record<string, unknown>;
type FakeSite = { id: string; owner?: unknown; machines: Record<string, Doc> | 'fail' };

let mockSites: FakeSite[] = [];
/** billing_usage and plan_snapshot, by document path. */
let mockStore = new Map<string, Doc>();
let mockSitePages = 0;

function mockApplySet(path: string, data: Doc, options?: { merge?: boolean }) {
  const prev = options?.merge ? mockStore.get(path) ?? {} : {};
  const next: Doc = { ...prev };
  for (const [key, value] of Object.entries(data)) {
    const union = (value as { __arrayUnion?: unknown[] } | null)?.__arrayUnion;
    if (union) {
      const existing = Array.isArray(prev[key]) ? (prev[key] as unknown[]) : [];
      next[key] = [...existing, ...union.filter((e) => !existing.includes(e))];
    } else {
      next[key] = value;
    }
  }
  mockStore.set(path, next);
}

function mockDocRef(path: string): Record<string, unknown> {
  return {
    id: path.split('/').pop(),
    path,
    set: async (data: Doc, options?: { merge?: boolean }) => mockApplySet(path, data, options),
    delete: async () => {
      mockStore.delete(path);
    },
    collection: (name: string) => mockCollectionRef(`${path}/${name}`),
  };
}

function mockMatches(id: string, [field, op, value]: unknown[]): boolean {
  if (field !== '__name__') throw new Error(`unexpected filter field ${String(field)}`);
  if (op === '<') return id < (value as string);
  if (op === '>=') return id >= (value as string);
  if (op === '<=') return id <= (value as string);
  throw new Error(`unexpected operator ${String(op)}`);
}

function mockQuery(path: string, filters: unknown[][]): Record<string, unknown> {
  return {
    where: (...filter: unknown[]) => mockQuery(path, [...filters, filter]),
    get: async () => {
      const docs = [...mockStore.entries()]
        .filter(([p]) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'))
        .map(([p, data]) => ({ id: p.slice(path.length + 1), data: () => data, ref: mockDocRef(p) }))
        .filter((doc) => filters.every((filter) => mockMatches(doc.id, filter)));
      return { size: docs.length, docs };
    },
  };
}

function mockCollectionRef(path: string): Record<string, unknown> {
  return {
    ...mockQuery(path, []),
    doc: (id: string) => mockDocRef(`${path}/${id}`),
    // like the admin sdk, this includes parents that exist only through their subcollections.
    listDocuments: async () => {
      const ids = new Set(
        [...mockStore.keys()].filter((p) => p.startsWith(`${path}/`)).map((p) => p.slice(path.length + 1).split('/')[0]),
      );
      return [...ids].map((id) => mockDocRef(`${path}/${id}`));
    },
  };
}

function mockSiteSnap(site: FakeSite) {
  return {
    id: site.id,
    data: () => (site.owner === undefined ? {} : { owner: site.owner }),
    ref: {
      collection: (name: string) => {
        if (name !== 'machines') throw new Error(`unexpected subcollection ${name}`);
        return {
          select: () => ({
            get: async () => {
              if (site.machines === 'fail') throw new Error('machines read failed');
              return {
                docs: Object.entries(site.machines).map(([id, data]) => ({ id, data: () => data })),
              };
            },
          }),
        };
      },
    },
  };
}

function mockSitesQuery() {
  const state = { limit: Infinity, after: null as string | null };
  const query = {
    orderBy: (field: unknown) => {
      if (field !== '__name__') throw new Error('sites must page by document id');
      return query;
    },
    select: () => query,
    limit: (n: number) => {
      state.limit = n;
      return query;
    },
    startAfter: (snap: { id: string }) => {
      state.after = snap.id;
      return query;
    },
    get: async () => {
      mockSitePages += 1;
      const page = [...mockSites]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .filter((site) => state.after === null || site.id > state.after)
        .slice(0, state.limit);
      return { size: page.length, docs: page.map(mockSiteSnap) };
    },
  };
  return query;
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => (name === 'sites' ? mockSitesQuery() : mockCollectionRef(name)),
  }),
}));

import { activeMachinesBetween, ACTIVE_WINDOW_MS, runPlanDaily } from '@/lib/planUsage.server';
import type { Plan } from '@/lib/plan.server';

const NOW = new Date('2026-10-08T03:00:00.000Z');
const DAY = '2026-10-07';
const HOUR_MS = 60 * 60 * 1000;

const OFF: Plan = { enforced: false, reason: 'enforcement_off' };
const FREE: Plan = {
  enforced: true,
  resolved: false,
  standing: 'expired',
  ent: { 'owlette.machines': '1', 'owlette.sites': '1', 'owlette.control': '0', 'owlette.roost': '0' },
};
const PRO: Plan = {
  enforced: true,
  resolved: true,
  standing: 'active',
  ent: { 'owlette.machines': 'unlimited', 'owlette.sites': 'unlimited', 'owlette.control': '1', 'owlette.roost': '1' },
};

function seenAgo(ms: number) {
  return { lastHeartbeat: { toMillis: () => NOW.getTime() - ms } };
}

function machineIds(payer: string, day = DAY): unknown {
  return mockStore.get(`billing_usage/${payer}/days/${day}`)?.machineIds;
}

beforeEach(() => {
  mockSites = [];
  mockStore = new Map();
  mockSitePages = 0;
  mockResolvePlan.mockReset();
  mockResolvePlan.mockResolvedValue(OFF);
});

describe('runPlanDaily: active machines', () => {
  it('unions each payer’s machines seen in the last 26 h into yesterday’s day doc', async () => {
    mockSites = [
      { id: 's1', owner: 'alice', machines: { m1: seenAgo(HOUR_MS), m2: seenAgo(30 * HOUR_MS) } },
      { id: 's2', owner: 'alice', machines: { m3: seenAgo(25 * HOUR_MS), m1: seenAgo(2 * HOUR_MS) } },
      { id: 's3', owner: 'bob', machines: { m4: seenAgo(0) } },
    ];

    const summary = await runPlanDaily(NOW);

    expect(summary).toMatchObject({ ok: true, day: DAY, sites: 3, payers: 2, machines: 3, errors: 0 });
    expect(machineIds('alice')).toEqual(['m1', 'm3']);
    expect(machineIds('bob')).toEqual(['m4']);
    expect(mockStore.get(`billing_usage/alice/days/${DAY}`)?.updatedAt).toBe('__SERVER_TS__');
  });

  it('counts a heartbeat exactly 26 h old and nothing older', async () => {
    mockSites = [
      {
        id: 's1',
        owner: 'alice',
        machines: { edge: seenAgo(ACTIVE_WINDOW_MS), past: seenAgo(ACTIVE_WINDOW_MS + 1) },
      },
    ];

    await runPlanDaily(NOW);

    expect(machineIds('alice')).toEqual(['edge']);
  });

  it('skips a missing or unreadable heartbeat without failing the run', async () => {
    mockSites = [
      {
        id: 's1',
        owner: 'alice',
        machines: {
          missing: {},
          garbage: { lastHeartbeat: 'not a time' },
          shapeless: { lastHeartbeat: { nope: true } },
          nulled: { lastHeartbeat: null },
          live: seenAgo(HOUR_MS),
        },
      },
    ];

    const summary = await runPlanDaily(NOW);

    expect(machineIds('alice')).toEqual(['live']);
    expect(summary.errors).toBe(0);
  });

  it('ignores sites without a string owner', async () => {
    mockSites = [
      { id: 's1', machines: { m1: seenAgo(HOUR_MS) } },
      { id: 's2', owner: 42, machines: { m2: seenAgo(HOUR_MS) } },
      { id: 's3', owner: '', machines: { m3: seenAgo(HOUR_MS) } },
    ];

    const summary = await runPlanDaily(NOW);

    expect(summary).toMatchObject({ sites: 3, payers: 0, snapshots: 0 });
    expect(mockResolvePlan).not.toHaveBeenCalled();
    expect([...mockStore.keys()]).toEqual([]);
  });

  it('writes no day doc for a payer with nothing active, but still snapshots them', async () => {
    mockSites = [{ id: 's1', owner: 'alice', machines: { m1: seenAgo(48 * HOUR_MS) } }];

    const summary = await runPlanDaily(NOW);

    expect(mockStore.has(`billing_usage/alice/days/${DAY}`)).toBe(false);
    expect(mockStore.get('plan_snapshot/alice')).toBeDefined();
    expect(summary).toMatchObject({ payers: 1, machines: 0, snapshots: 1 });
  });

  it('is idempotent across reruns and adds to an earlier stamp of the same day', async () => {
    mockStore.set(`billing_usage/alice/days/${DAY}`, { machineIds: ['m0'], updatedAt: 'earlier' });
    mockSites = [{ id: 's1', owner: 'alice', machines: { m1: seenAgo(HOUR_MS) } }];

    await runPlanDaily(NOW);
    await runPlanDaily(NOW);

    expect(machineIds('alice')).toEqual(['m0', 'm1']);
  });

  it('pages through every site', async () => {
    mockSites = Array.from({ length: 205 }, (_, i) => ({
      id: `site-${String(i).padStart(3, '0')}`,
      owner: 'alice',
      machines: { [`m${i}`]: seenAgo(HOUR_MS) },
    }));

    const summary = await runPlanDaily(NOW);

    expect(mockSitePages).toBe(3);
    expect(summary).toMatchObject({ sites: 205, payers: 1, machines: 205 });
    expect((machineIds('alice') as string[]).length).toBe(205);
  });

  it('keeps going when one site’s machines can’t be read', async () => {
    mockSites = [
      { id: 's1', owner: 'alice', machines: 'fail' },
      { id: 's2', owner: 'alice', machines: { m2: seenAgo(HOUR_MS) } },
      { id: 's3', owner: 'bob', machines: { m3: seenAgo(HOUR_MS) } },
    ];

    const summary = await runPlanDaily(NOW);

    expect(summary.errors).toBe(1);
    expect(machineIds('alice')).toEqual(['m2']);
    expect(machineIds('bob')).toEqual(['m3']);
    expect(summary.snapshots).toBe(2);
  });
});

describe('runPlanDaily: plan snapshot', () => {
  beforeEach(() => {
    mockSites = [
      { id: 's1', owner: 'free-payer', machines: { m1: seenAgo(HOUR_MS) } },
      { id: 's2', owner: 'pro-payer', machines: {} },
    ];
  });

  it('writes enforced:false with control and roost allowed when enforcement is off', async () => {
    await runPlanDaily(NOW);

    for (const payer of ['free-payer', 'pro-payer']) {
      expect(mockStore.get(`plan_snapshot/${payer}`)).toEqual({
        enforced: false,
        control: true,
        roost: true,
        resolvedAt: '__SERVER_TS__',
      });
    }
  });

  it('writes each payer’s flags from the resolved plan', async () => {
    mockResolvePlan.mockImplementation(async (uid: string) => (uid === 'free-payer' ? FREE : PRO));

    const summary = await runPlanDaily(NOW);

    expect(mockStore.get('plan_snapshot/free-payer')).toEqual({
      enforced: true,
      control: false,
      roost: false,
      resolvedAt: '__SERVER_TS__',
    });
    expect(mockStore.get('plan_snapshot/pro-payer')).toEqual({
      enforced: true,
      control: true,
      roost: true,
      resolvedAt: '__SERVER_TS__',
    });
    expect(mockResolvePlan).toHaveBeenCalledTimes(2);
    expect(summary.snapshots).toBe(2);
  });

  it('replaces the whole snapshot rather than merging into a stale one', async () => {
    mockStore.set('plan_snapshot/free-payer', { enforced: true, control: false, roost: false, stale: 'x' });

    await runPlanDaily(NOW);

    expect(mockStore.get('plan_snapshot/free-payer')).not.toHaveProperty('stale');
  });

  it('records a payer whose plan fails to resolve and finishes the rest', async () => {
    mockResolvePlan.mockImplementation(async (uid: string) => {
      if (uid === 'free-payer') throw new Error('users read failed');
      return PRO;
    });

    const summary = await runPlanDaily(NOW);

    expect(summary).toMatchObject({ errors: 1, snapshots: 1, payers: 2 });
    expect(mockStore.has('plan_snapshot/free-payer')).toBe(false);
    expect(mockStore.get('plan_snapshot/pro-payer')).toMatchObject({ control: true });
    // the usage stamp doesn't depend on the plan.
    expect(machineIds('free-payer')).toEqual(['m1']);
  });
});

describe('runPlanDaily: pruning', () => {
  it('drops day docs older than 100 days for every payer ever stamped, and keeps the rest', async () => {
    // 100 days before 2026-10-08 is 2026-06-30.
    for (const day of ['2026-06-01', '2026-06-29', '2026-06-30', '2026-09-01']) {
      mockStore.set(`billing_usage/alice/days/${day}`, { machineIds: ['m1'] });
    }
    // a former payer who owns no site any more.
    mockStore.set('billing_usage/gone/days/2026-01-01', { machineIds: ['m9'] });
    mockSites = [{ id: 's1', owner: 'alice', machines: { m1: seenAgo(HOUR_MS) } }];

    const summary = await runPlanDaily(NOW);

    expect(summary.pruned).toBe(3);
    expect([...mockStore.keys()].filter((p) => p.startsWith('billing_usage/')).sort()).toEqual([
      'billing_usage/alice/days/2026-06-30',
      'billing_usage/alice/days/2026-09-01',
      `billing_usage/alice/days/${DAY}`,
    ]);
  });
});

describe('activeMachinesBetween', () => {
  beforeEach(() => {
    mockStore.set('billing_usage/alice/days/2026-09-30', { machineIds: ['before'] });
    mockStore.set('billing_usage/alice/days/2026-10-01', { machineIds: ['m1', 'm2'] });
    mockStore.set('billing_usage/alice/days/2026-10-15', { machineIds: ['m2', 'm3'] });
    mockStore.set('billing_usage/alice/days/2026-10-31', { machineIds: ['m3', 'm4', 7] });
    mockStore.set('billing_usage/alice/days/2026-11-01', { machineIds: ['after'] });
    mockStore.set('billing_usage/bob/days/2026-10-02', { machineIds: ['bob-m'] });
    mockStore.set('billing_usage/alice/days/2026-10-20', { machineIds: 'not-an-array' });
  });

  it('counts the distinct union of the days in range, both ends included', async () => {
    const count = await activeMachinesBetween(
      'alice',
      new Date('2026-10-01T00:00:00Z'),
      new Date('2026-10-31T23:59:59Z'),
    );

    expect(count).toBe(4);
  });

  it('is zero for a payer with no days in range', async () => {
    expect(
      await activeMachinesBetween('carol', new Date('2026-10-01T00:00:00Z'), new Date('2026-10-31T00:00:00Z')),
    ).toBe(0);
  });
});
