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

let mockEnforced = false;
// tridant's answer per site, as the resolver turns it into a plan: a failed read is not enforced.
const mockGetSiteEntitlements = jest.fn();
jest.mock('@/lib/plan.server', () => ({
  plansEnforced: () => mockEnforced,
  resolveSitePlan: async (siteId: string) => {
    const answer = await mockGetSiteEntitlements(siteId);
    return answer?.ok ? { enforced: true, ...answer } : { enforced: false, reason: answer?.reason ?? 'unreachable' };
  },
}));

const mockReportUsage = jest.fn();
jest.mock('@/lib/tridantBilling.server', () => ({
  reportUsage: (...args: unknown[]) => mockReportUsage(...args),
}));

type Doc = Record<string, unknown>;
type FakeSite = { id: string; machines: Record<string, Doc> | 'fail' };

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
    data: () => ({}),
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

import logger from '@/lib/logger';
import { activeMachinesBetween, ACTIVE_WINDOW_MS, runPlanDaily } from '@/lib/planUsage.server';
import type { UsageEntry, UsageOutcome } from '@/lib/tridantBilling.server';
import type { Entitlements, EntitlementsResult } from '@/lib/tridantEntitlements.server';

// the scheduled slot: late in the UTC day.
const NOW = new Date('2026-10-08T23:30:00.000Z');
const TODAY = '2026-10-08';
const YESTERDAY = '2026-10-07';
const HOUR_MS = 60 * 60 * 1000;
const PERIOD_START = Date.UTC(2026, 9, 1);

const FREE: Entitlements = {
  ok: true,
  resolved: false,
  standing: 'expired',
  inGoodStanding: false,
  graceUntil: null,
  ent: { 'owlette.control': '0', 'owlette.deployments': '0', 'owlette.roost': '0' },
  epoch: null,
  orgId: null,
  billing: null,
};
const BILLING = { periodStart: PERIOD_START, periodEnd: Date.UTC(2026, 10, 1), endsAt: null, cancelAtPeriodEnd: false };
const CORE: Entitlements = {
  ...FREE,
  resolved: true,
  standing: 'active',
  inGoodStanding: true,
  ent: { 'owlette.control': '1', 'owlette.deployments': '0', 'owlette.roost': '0' },
  orgId: 'org_1',
  billing: BILLING,
};
const PRO: Entitlements = {
  ...CORE,
  ent: { 'owlette.control': '1', 'owlette.deployments': '1', 'owlette.roost': '1' },
};
// a running trial reads pro, and is not billed.
const TRIAL: Entitlements = { ...PRO, standing: 'trialing', billing: null };
const UNREACHABLE: EntitlementsResult = { ok: false, reason: 'unreachable' };

function seenAgo(ms: number) {
  return { lastHeartbeat: { toMillis: () => NOW.getTime() - ms } };
}

function machineIds(siteId: string, day = TODAY): unknown {
  return mockStore.get(`billing_usage/${siteId}/days/${day}`)?.machineIds;
}

function plans(bySite: Record<string, EntitlementsResult>) {
  mockEnforced = true;
  mockGetSiteEntitlements.mockImplementation(async (siteId: string) => bySite[siteId] ?? FREE);
}

beforeEach(() => {
  mockSites = [];
  mockStore = new Map();
  mockSitePages = 0;
  mockEnforced = false;
  mockGetSiteEntitlements.mockReset();
  mockReportUsage.mockReset();
  mockReportUsage.mockImplementation(async (entries: UsageEntry[]) => ({
    ok: true,
    results: entries.map(({ siteId }): UsageOutcome => ({ siteId, status: 'recorded', recorded: true })),
  }));
  jest.mocked(logger.warn).mockClear();
});

describe('runPlanDaily: active machines', () => {
  it('stamps each site’s machines on the UTC day of their heartbeat, today or yesterday', async () => {
    mockSites = [
      {
        id: 's1',
        machines: {
          late: seenAgo(HOUR_MS),
          midnight: seenAgo(23.5 * HOUR_MS),
          lastNight: seenAgo(25 * HOUR_MS),
          gone: seenAgo(30 * HOUR_MS),
        },
      },
      { id: 's2', machines: { late: seenAgo(2 * HOUR_MS) } },
    ];

    const summary = await runPlanDaily(NOW);

    expect(summary).toMatchObject({ ok: true, day: TODAY, sites: 2, machines: 4, errors: 0 });
    expect(machineIds('s1')).toEqual(['late', 'midnight']);
    expect(machineIds('s1', YESTERDAY)).toEqual(['lastNight']);
    // the same machine id under two sites is each site's own.
    expect(machineIds('s2')).toEqual(['late']);
    expect(mockStore.get(`billing_usage/s1/days/${TODAY}`)?.updatedAt).toBe('__SERVER_TS__');
  });

  it('keeps a machine last seen before midnight out of the next day when the run lands after it', async () => {
    mockSites = [{ id: 's1', machines: { m1: { lastHeartbeat: { toMillis: () => Date.UTC(2026, 9, 31, 23, 50) } } } }];

    await runPlanDaily(new Date('2026-11-01T00:30:00.000Z'));

    expect(machineIds('s1', '2026-10-31')).toEqual(['m1']);
    expect(mockStore.has('billing_usage/s1/days/2026-11-01')).toBe(false);
  });

  it('counts a heartbeat exactly 26 h old and nothing older', async () => {
    mockSites = [
      { id: 's1', machines: { edge: seenAgo(ACTIVE_WINDOW_MS), past: seenAgo(ACTIVE_WINDOW_MS + 1) } },
    ];

    await runPlanDaily(NOW);

    expect(machineIds('s1', YESTERDAY)).toEqual(['edge']);
  });

  it('skips a missing or unreadable heartbeat without failing the run', async () => {
    mockSites = [
      {
        id: 's1',
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

    expect(machineIds('s1')).toEqual(['live']);
    expect(summary.errors).toBe(0);
  });

  it('writes no day doc for a site with nothing active, but still snapshots it', async () => {
    mockSites = [{ id: 's1', machines: { m1: seenAgo(48 * HOUR_MS) } }];

    const summary = await runPlanDaily(NOW);

    expect([...mockStore.keys()]).toEqual(['plan_snapshot/s1']);
    expect(summary).toMatchObject({ sites: 1, machines: 0, snapshots: 1 });
  });

  it('is idempotent across reruns and adds to an earlier stamp of the same day', async () => {
    mockStore.set(`billing_usage/s1/days/${TODAY}`, { machineIds: ['m0'], updatedAt: 'earlier' });
    mockSites = [{ id: 's1', machines: { m1: seenAgo(HOUR_MS) } }];

    await runPlanDaily(NOW);
    await runPlanDaily(NOW);

    expect(machineIds('s1')).toEqual(['m0', 'm1']);
  });

  it('pages through every site', async () => {
    mockSites = Array.from({ length: 205 }, (_, i) => ({
      id: `site-${String(i).padStart(3, '0')}`,
      machines: { [`m${i}`]: seenAgo(HOUR_MS) },
    }));

    const summary = await runPlanDaily(NOW);

    expect(mockSitePages).toBe(3);
    expect(summary).toMatchObject({ sites: 205, machines: 205, snapshots: 205 });
    expect(machineIds('site-204')).toEqual(['m204']);
  });

  it('keeps going when one site’s machines can’t be read', async () => {
    mockSites = [
      { id: 's1', machines: 'fail' },
      { id: 's2', machines: { m2: seenAgo(HOUR_MS) } },
    ];

    const summary = await runPlanDaily(NOW);

    expect(summary.errors).toBe(1);
    expect(machineIds('s2')).toEqual(['m2']);
    expect(summary.snapshots).toBe(2);
  });
});

describe('runPlanDaily: plan snapshot', () => {
  beforeEach(() => {
    mockSites = [
      { id: 'free-site', machines: { m1: seenAgo(HOUR_MS) } },
      { id: 'core-site', machines: {} },
      { id: 'pro-site', machines: {} },
    ];
  });

  it('writes each site’s flags from its own answer, read once', async () => {
    plans({ 'core-site': CORE, 'pro-site': PRO });

    const summary = await runPlanDaily(NOW);

    expect(mockStore.get('plan_snapshot/free-site')).toEqual({
      enforced: true,
      control: false,
      roost: false,
      resolvedAt: '__SERVER_TS__',
    });
    expect(mockStore.get('plan_snapshot/core-site')).toEqual({
      enforced: true,
      control: true,
      roost: false,
      resolvedAt: '__SERVER_TS__',
    });
    expect(mockStore.get('plan_snapshot/pro-site')).toEqual({
      enforced: true,
      control: true,
      roost: true,
      resolvedAt: '__SERVER_TS__',
    });
    expect(mockGetSiteEntitlements.mock.calls.flat().sort()).toEqual(['core-site', 'free-site', 'pro-site']);
    expect(summary.snapshots).toBe(3);
  });

  it('writes enforced:false with control and roost allowed when the read fails, and stamps anyway', async () => {
    plans({ 'free-site': UNREACHABLE, 'pro-site': PRO });

    const summary = await runPlanDaily(NOW);

    expect(mockStore.get('plan_snapshot/free-site')).toEqual({
      enforced: false,
      control: true,
      roost: true,
      resolvedAt: '__SERVER_TS__',
    });
    expect(mockStore.get('plan_snapshot/pro-site')).toMatchObject({ enforced: true, roost: true });
    expect(machineIds('free-site')).toEqual(['m1']);
    expect(summary).toMatchObject({ snapshots: 3, errors: 0 });
  });

  it('finishes the run and still reports the other sites when one plan read throws', async () => {
    plans({ 'pro-site': PRO });
    mockGetSiteEntitlements.mockImplementation(async (siteId: string) => {
      if (siteId === 'free-site') throw new Error('firestore unavailable');
      return siteId === 'pro-site' ? PRO : FREE;
    });

    const summary = await runPlanDaily(NOW);

    expect(mockStore.get('plan_snapshot/free-site')).toMatchObject({ enforced: false, control: true, roost: true });
    expect(mockStore.get('plan_snapshot/pro-site')).toMatchObject({ enforced: true });
    expect(mockReportUsage).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ snapshots: 3, errors: 1 });
  });

  it('withholds only a flag tridant id sent as off', async () => {
    plans({ 'core-site': { ...CORE, ent: { 'owlette.roost': '0' } } });

    await runPlanDaily(NOW);

    expect(mockStore.get('plan_snapshot/core-site')).toMatchObject({ enforced: true, control: true, roost: false });
  });

  it('replaces the whole snapshot rather than merging into a stale one', async () => {
    mockStore.set('plan_snapshot/free-site', { enforced: true, control: false, roost: false, stale: 'x' });

    await runPlanDaily(NOW);

    expect(mockStore.get('plan_snapshot/free-site')).not.toHaveProperty('stale');
  });
});

describe('runPlanDaily: enforcement off', () => {
  it('stamps and snapshots every site as unenforced, asks tridant id nothing and reports nothing', async () => {
    mockSites = [
      { id: 's1', machines: { m1: seenAgo(HOUR_MS) } },
      { id: 's2', machines: {} },
    ];
    mockGetSiteEntitlements.mockResolvedValue(PRO);

    const summary = await runPlanDaily(NOW);

    for (const site of ['s1', 's2']) {
      expect(mockStore.get(`plan_snapshot/${site}`)).toEqual({
        enforced: false,
        control: true,
        roost: true,
        resolvedAt: '__SERVER_TS__',
      });
    }
    expect(machineIds('s1')).toEqual(['m1']);
    expect(mockGetSiteEntitlements).not.toHaveBeenCalled();
    expect(mockReportUsage).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ machines: 1, snapshots: 2, reported: 0, recorded: 0, errors: 0 });
  });
});

describe('runPlanDaily: usage report', () => {
  beforeEach(() => {
    mockSites = [
      { id: 'core', machines: { c1: seenAgo(HOUR_MS) } },
      { id: 'core-idle', machines: {} },
      { id: 'free', machines: { f1: seenAgo(HOUR_MS) } },
      { id: 'pro-big', machines: { b1: seenAgo(HOUR_MS), b2: seenAgo(HOUR_MS), b3: seenAgo(25 * HOUR_MS) } },
      { id: 'pro-small', machines: { p1: seenAgo(HOUR_MS) } },
      { id: 'trial', machines: { t1: seenAgo(HOUR_MS) } },
      { id: 'unread', machines: { u1: seenAgo(HOUR_MS) } },
    ];
    // earlier days of the period count, the day before it does not.
    mockStore.set('billing_usage/pro-big/days/2026-10-01', { machineIds: ['b3', 'b4'] });
    mockStore.set('billing_usage/pro-small/days/2026-10-02', { machineIds: ['p2'] });
    mockStore.set('billing_usage/core/days/2026-09-30', { machineIds: ['before'] });
    plans({ core: CORE, 'core-idle': CORE, 'pro-big': PRO, 'pro-small': PRO, trial: TRIAL, unread: UNREACHABLE });
  });

  it('reports each billed site’s machines since its period start in one call, pro floored at 3', async () => {
    const summary = await runPlanDaily(NOW);

    expect(mockReportUsage).toHaveBeenCalledTimes(1);
    expect(mockReportUsage).toHaveBeenCalledWith(
      [
        { siteId: 'core', machines: 1 },
        { siteId: 'core-idle', machines: 0 },
        { siteId: 'pro-big', machines: 4 },
        { siteId: 'pro-small', machines: 3 },
      ],
      NOW.getTime(),
    );
    expect(summary).toMatchObject({ reported: 4, recorded: 4, errors: 0 });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('skips a billed site whose answer carries no period start', async () => {
    plans({ core: { ...CORE, billing: { ...BILLING, periodStart: null } } });

    const summary = await runPlanDaily(NOW);

    expect(mockReportUsage).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ reported: 0, recorded: 0 });
  });

  it('logs an entry tridant id did not record, with its site and status, and finishes the run', async () => {
    mockReportUsage.mockResolvedValue({
      ok: true,
      results: [
        { siteId: 'core', status: 'recorded', recorded: true },
        { siteId: 'core-idle', status: 'site_not_billed', recorded: false },
        { siteId: 'pro-big', status: 'period_rolled_over', recorded: false },
        { siteId: 'pro-small', status: 'recorded', recorded: true },
      ],
    });

    const summary = await runPlanDaily(NOW);

    expect(summary).toMatchObject({ ok: true, reported: 4, recorded: 2, errors: 0 });
    expect(jest.mocked(logger.warn).mock.calls.map(([, meta]) => meta?.data)).toEqual([
      { siteId: 'core-idle', status: 'site_not_billed' },
      { siteId: 'pro-big', status: 'period_rolled_over' },
    ]);
  });

  it('counts a report tridant id never answered as one error and still prunes', async () => {
    mockStore.set('billing_usage/core/days/2026-01-01', { machineIds: ['old'] });
    mockReportUsage.mockResolvedValue({ ok: false, reason: 'not_configured' });

    const summary = await runPlanDaily(NOW);

    expect(summary).toMatchObject({ ok: true, reported: 4, recorded: 0, errors: 1, pruned: 1 });
  });
});

describe('runPlanDaily: pruning', () => {
  it('drops day docs older than 100 days under every parent, and keeps the rest', async () => {
    // 100 days before 2026-10-08 is 2026-06-30.
    for (const day of ['2026-06-01', '2026-06-29', '2026-06-30', '2026-09-01']) {
      mockStore.set(`billing_usage/s1/days/${day}`, { machineIds: ['m1'] });
    }
    // a deleted site, or a payer from the owner-keyed days.
    mockStore.set('billing_usage/gone/days/2026-01-01', { machineIds: ['m9'] });
    mockSites = [{ id: 's1', machines: { m1: seenAgo(HOUR_MS) } }];

    const summary = await runPlanDaily(NOW);

    expect(summary.pruned).toBe(3);
    expect([...mockStore.keys()].filter((p) => p.startsWith('billing_usage/')).sort()).toEqual([
      'billing_usage/s1/days/2026-06-30',
      'billing_usage/s1/days/2026-09-01',
      `billing_usage/s1/days/${TODAY}`,
    ]);
  });
});

describe('activeMachinesBetween', () => {
  beforeEach(() => {
    mockStore.set('billing_usage/s1/days/2026-09-30', { machineIds: ['before'] });
    mockStore.set('billing_usage/s1/days/2026-10-01', { machineIds: ['m1', 'm2'] });
    mockStore.set('billing_usage/s1/days/2026-10-15', { machineIds: ['m2', 'm3'] });
    mockStore.set('billing_usage/s1/days/2026-10-31', { machineIds: ['m3', 'm4', 7] });
    mockStore.set('billing_usage/s1/days/2026-11-01', { machineIds: ['after'] });
    mockStore.set('billing_usage/s2/days/2026-10-02', { machineIds: ['other-site'] });
    mockStore.set('billing_usage/s1/days/2026-10-20', { machineIds: 'not-an-array' });
  });

  it('counts the distinct union of the days in range, both ends included', async () => {
    // a period that starts mid-day still counts the whole of its first day.
    const count = await activeMachinesBetween('s1', Date.UTC(2026, 9, 1, 14), Date.UTC(2026, 9, 31, 23, 30));

    expect(count).toBe(4);
  });

  it('is zero for a site with no days in range', async () => {
    expect(await activeMachinesBetween('s3', Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 31))).toBe(0);
  });
});
