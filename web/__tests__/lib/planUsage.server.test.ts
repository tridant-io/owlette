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
let mockTridantConfigured = false;
// tridant's answer per site, as the resolver turns it into a plan: a failed read is not enforced.
const mockGetSiteEntitlements = jest.fn();
jest.mock('@/lib/plan.server', () => ({
  plansEnforced: () => mockEnforced,
  tridantConfigured: () => mockTridantConfigured,
  resolveSitePlan: async (siteId: string) => {
    const answer = await mockGetSiteEntitlements(siteId);
    return answer?.ok ? { enforced: true, ...answer } : { enforced: false, reason: answer?.reason ?? 'unreachable' };
  },
}));

const mockReportUsage = jest.fn();
jest.mock('@/lib/tridantBilling.server', () => ({
  PRODUCT: { core: 'prd_owlette_core', pro: 'prd_owlette_pro' },
  reportUsage: (...args: unknown[]) => mockReportUsage(...args),
}));

// the batch read fills a cache the resolver mock never reads; here it only matters when it is called.
const mockPrime = jest.fn();
jest.mock('@/lib/tridantEntitlements.server', () => ({
  primeSiteEntitlements: (...args: unknown[]) => mockPrime(...args),
}));

const mockSweepRemovals = jest.fn();
jest.mock('@/lib/tridantSiteRemoval.server', () => ({
  sweepSiteRemovals: (...args: unknown[]) => mockSweepRemovals(...args),
}));

const mockCheckKeys = jest.fn();
jest.mock('@/lib/tridant.server', () => ({
  checkTridantKeys: () => mockCheckKeys(),
}));

const mockStopStranded = jest.fn();
const mockAdopt = jest.fn();
const mockCloseEnded = jest.fn();
jest.mock('@/lib/siteBilling.server', () => ({
  stopStrandedBilling: (...args: unknown[]) => mockStopStranded(...args),
  adoptBilling: (...args: unknown[]) => mockAdopt(...args),
  closeEndedBilling: (...args: unknown[]) => mockCloseEnded(...args),
}));

/** `plan_accounts/{uid}`, for the owner's trial end. */
let mockAccounts: Record<string, { trialEndsAt: number | null; orgId?: string | null }> = {};
const mockRecordTrialEnd = jest.fn();
jest.mock('@/lib/planAccounts.server', () => ({
  getPlanAccount: async (uid: string) => mockAccounts[uid] ?? null,
  recordTrialEnd: (...args: unknown[]) => mockRecordTrialEnd(...args),
  billedFrom: jest.requireActual('@/lib/planAccounts.server').billedFrom,
  movedTrialEnd: jest.requireActual('@/lib/planAccounts.server').movedTrialEnd,
}));

// the reconcile has its own suite; here it only matters which sites reach it, and with what.
const mockReconcile = jest.fn();
jest.mock('@/lib/planTrial.server', () => ({
  reconcileSiteRegistration: (...args: unknown[]) => mockReconcile(...args),
}));

type Doc = Record<string, unknown>;
type FakeSite = { id: string; machines: Record<string, Doc> | 'fail'; data?: Doc };

let mockSites: FakeSite[] = [];
/** billing_usage and plan_snapshot, by document path. */
let mockStore = new Map<string, Doc>();
/** document paths whose writes fail. */
let mockFailWrites = new Set<string>();
let mockSitePages = 0;
/** the fields the sites query projects. */
let mockSiteFields: string[] = [];

const mockIsMap = (value: unknown): value is Doc =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// as firestore merges: maps field by field, all the way down.
function mockMerge(prev: Doc, data: Doc): Doc {
  const next: Doc = { ...prev };
  for (const [key, value] of Object.entries(data)) {
    const union = (value as { __arrayUnion?: unknown[] } | null)?.__arrayUnion;
    if (union) {
      const existing = Array.isArray(prev[key]) ? (prev[key] as unknown[]) : [];
      next[key] = [...existing, ...union.filter((e) => !existing.includes(e))];
    } else if (mockIsMap(value) && mockIsMap(prev[key])) {
      next[key] = mockMerge(prev[key], value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

type SetOptions = { merge?: boolean; mergeFields?: string[] };

function mockApplySet(path: string, data: Doc, options?: SetOptions) {
  if (mockFailWrites.has(path)) throw new Error('write refused');
  const prev = mockStore.get(path) ?? {};
  if (options?.mergeFields) {
    // each named field is replaced whole; the rest of the doc stays.
    mockStore.set(path, { ...prev, ...Object.fromEntries(options.mergeFields.map((field) => [field, data[field]])) });
    return;
  }
  mockStore.set(path, mockMerge(options?.merge ? prev : {}, data));
}

function mockDocRef(path: string): Record<string, unknown> {
  return {
    id: path.split('/').pop(),
    path,
    set: async (data: Doc, options?: SetOptions) => mockApplySet(path, data, options),
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
  return { id: site.id, data: () => site.data ?? {} };
}

/** `sites/{siteId}/machines`; a site not in `mockSites` has none. */
function mockMachines(siteId: string) {
  return {
    select: () => ({
      get: async () => {
        const machines = mockSites.find((site) => site.id === siteId)?.machines ?? {};
        if (machines === 'fail') throw new Error('machines read failed');
        return { docs: Object.entries(machines).map(([id, data]) => ({ id, data: () => data })) };
      },
    }),
  };
}

function mockSitesQuery() {
  const state = { limit: Infinity, after: null as string | null };
  const query = {
    doc: (siteId: string) => ({
      collection: (name: string) => {
        if (name !== 'machines') throw new Error(`unexpected subcollection ${name}`);
        return mockMachines(siteId);
      },
    }),
    orderBy: (field: unknown) => {
      if (field !== '__name__') throw new Error('sites must page by document id');
      return query;
    },
    select: (...fields: string[]) => {
      mockSiteFields = fields;
      return query;
    },
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
import { activeMachinesBetween, ACTIVE_WINDOW_MS, runPlanDaily, stampSiteMachines } from '@/lib/planUsage.server';
import type { TridantKeyCheck } from '@/lib/tridant.server';
import type { UsageEntry, UsageOutcome } from '@/lib/tridantBilling.server';
import type { Entitlements, EntitlementsResult, SiteBillingPeriod } from '@/lib/tridantEntitlements.server';
import type { SiteRemovalSweep } from '@/lib/tridantSiteRemoval.server';

// the scheduled slot: late in the UTC day.
const NOW = new Date('2026-10-08T23:30:00.000Z');
const TODAY = '2026-10-08';
const YESTERDAY = '2026-10-07';
const HOUR_MS = 60 * 60 * 1000;
const PERIOD_START = Date.UTC(2026, 9, 1);
const PERIOD_END = Date.UTC(2026, 10, 1);

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
  trialEndsAt: null,
};
const BILLING: SiteBillingPeriod = {
  periodStart: PERIOD_START,
  periodEnd: PERIOD_END,
  endsAt: null,
  cancelAtPeriodEnd: false,
  productId: 'prd_owlette_core',
  founders: false,
};
const PRO_BILLING: SiteBillingPeriod = { ...BILLING, productId: 'prd_owlette_pro' };
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
  billing: PRO_BILLING,
};
// a running trial reads pro, and is not billed.
const TRIAL: Entitlements = { ...PRO, standing: 'trialing', billing: null, trialEndsAt: Date.UTC(2026, 9, 15) };
const UNREACHABLE: EntitlementsResult = { ok: false, reason: 'unreachable' };
const NO_REMOVALS: SiteRemovalSweep = { removed: 0, pending: 0, dropped: 0, errors: 0 };
const GOOD_KEYS: TridantKeyCheck[] = [
  { keyName: 'TRIDANT_LICENSE_KEY', ok: true, missing: [], expiresAt: null, expiresInDays: null },
  { keyName: 'TRIDANT_RELEASE_KEY', ok: true, missing: [], expiresAt: null, expiresInDays: null },
];

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
  mockAccounts = {};
  mockStore = new Map();
  mockFailWrites = new Set();
  mockSitePages = 0;
  mockSiteFields = [];
  mockReconcile.mockReset();
  mockRecordTrialEnd.mockReset();
  mockRecordTrialEnd.mockResolvedValue(undefined);
  mockEnforced = false;
  mockTridantConfigured = false;
  mockGetSiteEntitlements.mockReset();
  mockReportUsage.mockReset();
  mockReportUsage.mockImplementation(async (entries: UsageEntry[]) => ({
    ok: true,
    results: entries.map(
      ({ siteId }): UsageOutcome => ({
        siteId,
        status: 'recorded',
        recorded: true,
        settling: false,
        settlesAt: null,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      }),
    ),
  }));
  mockPrime.mockReset();
  mockPrime.mockResolvedValue({ primed: 0, failed: false });
  mockSweepRemovals.mockReset();
  mockSweepRemovals.mockResolvedValue(NO_REMOVALS);
  mockCheckKeys.mockReset();
  mockCheckKeys.mockResolvedValue(GOOD_KEYS);
  jest.mocked(logger.warn).mockClear();
  jest.mocked(logger.error).mockClear();
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
    expect(mockPrime).not.toHaveBeenCalled();
    expect(mockGetSiteEntitlements).not.toHaveBeenCalled();
    expect(mockReportUsage).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ machines: 1, snapshots: 2, reported: 0, recorded: 0, errors: 0 });
  });
});

describe('runPlanDaily: batch entitlement read', () => {
  it('reads each page of sites in one call before reading any site of it', async () => {
    mockSites = Array.from({ length: 205 }, (_, i) => ({ id: `site-${String(i).padStart(3, '0')}`, machines: {} }));
    plans({});

    await runPlanDaily(NOW);

    expect(mockPrime.mock.calls.map(([ids]) => [ids.length, ids[0], ids[ids.length - 1]])).toEqual([
      [100, 'site-000', 'site-099'],
      [100, 'site-100', 'site-199'],
      [5, 'site-200', 'site-204'],
    ]);
    // every site of a page is read after its page's prime, and before the next page's.
    const readOrder = (siteId: string) =>
      mockGetSiteEntitlements.mock.invocationCallOrder[mockGetSiteEntitlements.mock.calls.findIndex(([id]) => id === siteId)];
    const [first, second, third] = mockPrime.mock.invocationCallOrder;
    expect(readOrder('site-000')).toBeGreaterThan(first);
    expect(readOrder('site-099')).toBeLessThan(second);
    expect(readOrder('site-100')).toBeGreaterThan(second);
    expect(readOrder('site-199')).toBeLessThan(third);
    expect(readOrder('site-200')).toBeGreaterThan(third);
  });
});

describe('runPlanDaily: site registration', () => {
  beforeEach(() => {
    mockSites = [
      { id: 'billed', machines: {}, data: { owner: 'u2', name: 'stage' } },
      { id: 'trial', machines: {}, data: { owner: 'u1', name: 'lobby' } },
      { id: 'unread', machines: {}, data: { owner: 'u3', name: 'foyer' } },
    ];
  });

  it('hands every site whose plan it read to the reconcile, with the owner and name it registers under', async () => {
    plans({ billed: CORE, trial: TRIAL, unread: UNREACHABLE });

    const summary = await runPlanDaily(NOW);

    expect(mockSiteFields).toEqual(['owner', 'name', 'billing']);
    expect(mockReconcile).toHaveBeenCalledTimes(2);
    // and to the pointer adoption, with the same plan
    expect(mockAdopt.mock.calls.map(([siteId]) => siteId).sort()).toEqual(['billed', 'trial']);
    expect(mockReconcile).toHaveBeenCalledWith(
      'trial',
      { owner: 'u1', name: 'lobby' },
      expect.objectContaining({ enforced: true, resolved: true, orgId: 'org_1', billing: null }),
    );
    expect(mockReconcile).toHaveBeenCalledWith(
      'billed',
      { owner: 'u2', name: 'stage' },
      expect.objectContaining({ billing: BILLING }),
    );
    expect(summary.errors).toBe(0);
  });

  // a record that still says billed once tridant id bills nothing (stripe cancelled the subscription) is closed.
  it('offers every site whose plan it read for closing ended billing, with that plan', async () => {
    plans({ billed: CORE, trial: TRIAL, unread: UNREACHABLE });

    await runPlanDaily(NOW);

    expect(mockCloseEnded.mock.calls.map(([siteId]) => siteId).sort()).toEqual(['billed', 'trial']);
    expect(mockCloseEnded).toHaveBeenCalledWith(
      'trial',
      { owner: 'u1', name: 'lobby' },
      expect.objectContaining({ enforced: true, billing: null }),
    );
  });

  it('offers every site for a stranded-billing stop, whatever the enforcement switch says', async () => {
    mockEnforced = false;

    await runPlanDaily(NOW);

    expect(mockStopStranded.mock.calls.map(([siteId]) => siteId).sort()).toEqual(['billed', 'trial', 'unread']);
  });

  it('asks for nothing while plans are not enforced', async () => {
    await runPlanDaily(NOW);

    expect(mockReconcile).not.toHaveBeenCalled();
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

  // the flags read pro on a site bought at core while its owner's trial runs.
  it('floors by the billed product, not the flags', async () => {
    plans({ core: { ...PRO, billing: BILLING }, 'pro-small': { ...CORE, billing: PRO_BILLING } });

    await runPlanDaily(NOW);

    expect(mockReportUsage).toHaveBeenCalledWith(
      [
        { siteId: 'core', machines: 1 },
        { siteId: 'pro-small', machines: 3 },
      ],
      NOW.getTime(),
    );
  });

  it('saves each billed site’s report with its outcome, for the settle pass', async () => {
    mockReportUsage.mockResolvedValue({
      ok: true,
      results: [
        { siteId: 'core', status: 'recorded', recorded: true },
        { siteId: 'core-idle', status: 'site_not_billed', recorded: false },
        { siteId: 'pro-big', status: 'recorded', recorded: true },
        { siteId: 'pro-small', status: 'recorded', recorded: true },
      ],
    });

    await runPlanDaily(NOW);

    const period = { periodStart: PERIOD_START, periodEnd: PERIOD_END, countedFrom: PERIOD_START };
    const run = { asOf: NOW.getTime(), settled: false, at: '__SERVER_TS__' };
    expect(mockStore.get('billing_usage/pro-small')).toEqual({
      report: { ...period, floor: 3, machines: 3, status: 'recorded', recorded: true, ...run },
    });
    expect(mockStore.get('billing_usage/core-idle')).toEqual({
      report: { ...period, floor: 0, machines: 0, status: 'site_not_billed', recorded: false, ...run },
    });
    expect(mockStore.get('billing_usage/pro-big')?.report).toMatchObject({ floor: 3, machines: 4 });
    // no billing period, nothing to resend.
    for (const site of ['free', 'trial', 'unread']) expect(mockStore.has(`billing_usage/${site}`)).toBe(false);
  });

  it('saves every report with the reason, unrecorded, when the call failed outright', async () => {
    mockReportUsage.mockResolvedValue({ ok: false, reason: 'not_configured' });

    await runPlanDaily(NOW);

    expect(mockStore.get('billing_usage/pro-small')).toEqual({
      report: {
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        countedFrom: PERIOD_START,
        floor: 3,
        machines: 3,
        asOf: NOW.getTime(),
        status: 'not_configured',
        recorded: false,
        settled: false,
        at: '__SERVER_TS__',
      },
    });
    for (const site of ['core', 'core-idle', 'pro-big']) {
      expect(mockStore.get(`billing_usage/${site}`)?.report).toMatchObject({ status: 'not_configured', recorded: false });
    }
  });

  it('replaces an earlier report whole and leaves the rest of the doc', async () => {
    mockStore.set('billing_usage/core', {
      report: { periodEnd: PERIOD_START, settled: true, settlesAt: PERIOD_START + 24 * HOUR_MS },
      kept: true,
    });

    await runPlanDaily(NOW);

    const doc = mockStore.get('billing_usage/core');
    expect(doc?.kept).toBe(true);
    expect(doc?.report).toMatchObject({ periodEnd: PERIOD_END, settled: false });
    expect(doc?.report).not.toHaveProperty('settlesAt');
  });

  it('counts a report it could not save as one error and saves the others', async () => {
    mockFailWrites.add('billing_usage/core');

    const summary = await runPlanDaily(NOW);

    expect(summary).toMatchObject({ reported: 4, recorded: 4, errors: 1 });
    expect(mockStore.has('billing_usage/core')).toBe(false);
    expect(mockStore.get('billing_usage/core-idle')?.report).toMatchObject({ status: 'recorded' });
  });

  // nothing in the trial is billed: a site bought during it is in a period that started at the purchase.
  it("counts a site bought during its owner's trial only from the trial's end", async () => {
    mockSites = [{ id: 'core', machines: { c1: seenAgo(HOUR_MS) }, data: { owner: 'u1' } }];
    mockStore.set('billing_usage/core/days/2026-10-03', { machineIds: ['in-trial'] });
    mockStore.set('billing_usage/core/days/2026-10-05', { machineIds: ['after-trial'] });
    mockAccounts = { u1: { trialEndsAt: Date.UTC(2026, 9, 4, 12) } };
    plans({ core: CORE });

    await runPlanDaily(NOW);

    expect(mockReportUsage).toHaveBeenCalledWith([{ siteId: 'core', machines: 2 }], NOW.getTime());
    expect(mockStore.get('billing_usage/core')?.report).toMatchObject({
      periodStart: PERIOD_START,
      countedFrom: Date.UTC(2026, 9, 4, 12),
    });
  });

  it("counts from the period start once the owner's trial ended before it", async () => {
    mockSites = [{ id: 'core', machines: { c1: seenAgo(HOUR_MS) }, data: { owner: 'u1' } }];
    mockStore.set('billing_usage/core/days/2026-10-03', { machineIds: ['early'] });
    mockAccounts = { u1: { trialEndsAt: Date.UTC(2026, 8, 20) } };
    plans({ core: CORE });

    await runPlanDaily(NOW);

    expect(mockReportUsage).toHaveBeenCalledWith([{ siteId: 'core', machines: 2 }], NOW.getTime());
  });

  describe('a trial tridant id extended', () => {
    const STORED_END = Date.UTC(2026, 9, 4, 12);
    const EXTENDED_END = Date.UTC(2026, 9, 6, 12);
    // billed, and still under its owner's trial, which tridant id moved past the recorded end.
    const EXTENDED: Entitlements = { ...CORE, standing: 'trialing', trialEndsAt: EXTENDED_END };

    beforeEach(() => {
      mockSites = [{ id: 'core', machines: { c1: seenAgo(HOUR_MS) }, data: { owner: 'u1' } }];
      mockStore.set('billing_usage/core/days/2026-10-05', { machineIds: ['in-extension'] });
      mockStore.set('billing_usage/core/days/2026-10-07', { machineIds: ['after-trial'] });
      plans({ core: EXTENDED });
    });

    it('records the new end and counts from it', async () => {
      mockAccounts = { u1: { trialEndsAt: STORED_END, orgId: 'org_1' } };

      const summary = await runPlanDaily(NOW);

      expect(mockRecordTrialEnd).toHaveBeenCalledTimes(1);
      expect(mockRecordTrialEnd).toHaveBeenCalledWith('u1', EXTENDED_END);
      expect(mockReportUsage).toHaveBeenCalledWith([{ siteId: 'core', machines: 2 }], NOW.getTime());
      expect(mockStore.get('billing_usage/core')?.report).toMatchObject({ countedFrom: EXTENDED_END, machines: 2 });
      expect(summary.errors).toBe(0);
    });

    it('still counts from the new end when it cannot record it, and counts the error', async () => {
      mockAccounts = { u1: { trialEndsAt: STORED_END, orgId: 'org_1' } };
      mockRecordTrialEnd.mockRejectedValue(new Error('write refused'));

      const summary = await runPlanDaily(NOW);

      expect(mockReportUsage).toHaveBeenCalledWith([{ siteId: 'core', machines: 2 }], NOW.getTime());
      expect(summary).toMatchObject({ reported: 1, errors: 1 });
    });

    // a transferred site can still sit under its previous owner's organization, and that trial is not this owner's.
    it('ignores the end of a trial under another organization', async () => {
      mockAccounts = { u1: { trialEndsAt: STORED_END, orgId: 'org_2' } };

      await runPlanDaily(NOW);

      expect(mockRecordTrialEnd).not.toHaveBeenCalled();
      expect(mockReportUsage).toHaveBeenCalledWith([{ siteId: 'core', machines: 3 }], NOW.getTime());
      expect(mockStore.get('billing_usage/core')?.report).toMatchObject({ countedFrom: STORED_END });
    });
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

  it('leaves a saved report alone', async () => {
    const report = { periodEnd: PERIOD_END, settled: false };
    mockStore.set('billing_usage/s1', { report });
    mockStore.set('billing_usage/s1/days/2026-01-01', { machineIds: ['m1'] });

    const summary = await runPlanDaily(NOW);

    expect(summary.pruned).toBe(1);
    expect(mockStore.get('billing_usage/s1')).toEqual({ report });
  });
});

describe('runPlanDaily: site removals and keys', () => {
  it.each([false, true])('sweeps the recorded removals once a run and answers the counts (plans enforced: %s)', async (enforced) => {
    mockSites = Array.from({ length: 150 }, (_, i) => ({ id: `site-${String(i).padStart(3, '0')}`, machines: {} }));
    mockEnforced = enforced;
    mockGetSiteEntitlements.mockResolvedValue(FREE);
    mockSweepRemovals.mockResolvedValue({ removed: 1, pending: 2, dropped: 1, errors: 1 });

    const summary = await runPlanDaily(NOW);

    expect(mockSweepRemovals).toHaveBeenCalledTimes(1);
    expect(mockSweepRemovals).toHaveBeenCalledWith(NOW.getTime());
    expect(summary.removals).toEqual({ removed: 1, pending: 2, dropped: 1, errors: 1 });
  });

  it('checks the keys once a run when tridant id is configured, and answers each one', async () => {
    mockSites = Array.from({ length: 150 }, (_, i) => ({ id: `site-${String(i).padStart(3, '0')}`, machines: {} }));
    mockTridantConfigured = true;
    mockCheckKeys.mockResolvedValue([
      { keyName: 'TRIDANT_LICENSE_KEY', ok: true, missing: [], expiresAt: Date.UTC(2027, 0, 1), expiresInDays: 84 },
      { keyName: 'TRIDANT_RELEASE_KEY', ok: true, missing: [], expiresAt: null, expiresInDays: null },
    ]);

    const summary = await runPlanDaily(NOW);

    expect(mockCheckKeys).toHaveBeenCalledTimes(1);
    expect(summary.keys).toEqual([
      { keyName: 'TRIDANT_LICENSE_KEY', ok: true, missing: [], expiresInDays: 84 },
      { keyName: 'TRIDANT_RELEASE_KEY', ok: true, missing: [], expiresInDays: null },
    ]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs a key that cannot do its job at error, with its name, reason and missing scopes only', async () => {
    mockTridantConfigured = true;
    mockCheckKeys.mockResolvedValue([
      { keyName: 'TRIDANT_LICENSE_KEY', ok: false, missing: ['site.write'], expiresAt: null, expiresInDays: 84 },
      { keyName: 'TRIDANT_RELEASE_KEY', ok: false, reason: 'rejected', missing: [], expiresAt: null, expiresInDays: null },
    ]);

    const summary = await runPlanDaily(NOW);

    expect(summary.keys).toEqual([
      { keyName: 'TRIDANT_LICENSE_KEY', ok: false, missing: ['site.write'], expiresInDays: 84 },
      { keyName: 'TRIDANT_RELEASE_KEY', ok: false, missing: [], expiresInDays: null },
    ]);
    expect(jest.mocked(logger.error).mock.calls).toEqual([
      [
        '[plan-daily] tridant key not usable',
        { context: 'planUsage', data: { keyName: 'TRIDANT_LICENSE_KEY', reason: undefined, missing: ['site.write'] } },
      ],
      [
        '[plan-daily] tridant key not usable',
        { context: 'planUsage', data: { keyName: 'TRIDANT_RELEASE_KEY', reason: 'rejected', missing: [] } },
      ],
    ]);
    // a key is a setup problem, not a failed step of the run.
    expect(summary.errors).toBe(0);
  });

  it('reports a release key left blank in the summary only', async () => {
    mockTridantConfigured = true;
    mockCheckKeys.mockResolvedValue([
      { keyName: 'TRIDANT_LICENSE_KEY', ok: true, missing: [], expiresAt: null, expiresInDays: null },
      { keyName: 'TRIDANT_RELEASE_KEY', ok: false, reason: 'not_configured', missing: [], expiresAt: null, expiresInDays: null },
    ]);

    const summary = await runPlanDaily(NOW);

    expect(summary.keys[1]).toEqual({ keyName: 'TRIDANT_RELEASE_KEY', ok: false, missing: [], expiresInDays: null });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('asks for no key check while tridant id is not configured', async () => {
    const summary = await runPlanDaily(NOW);

    expect(mockCheckKeys).not.toHaveBeenCalled();
    expect(summary.keys).toEqual([]);
  });

  it('counts a key check that throws as one error and still prunes', async () => {
    mockTridantConfigured = true;
    mockCheckKeys.mockRejectedValue(new Error('boom'));
    mockStore.set('billing_usage/s1/days/2026-01-01', { machineIds: ['m1'] });

    const summary = await runPlanDaily(NOW);

    expect(summary).toMatchObject({ errors: 1, pruned: 1, keys: [] });
  });
});

describe('stampSiteMachines', () => {
  it('stamps a site from its id alone and answers how many machines it stamped', async () => {
    mockSites = [
      { id: 's1', machines: { late: seenAgo(HOUR_MS), lastNight: seenAgo(25 * HOUR_MS), gone: seenAgo(30 * HOUR_MS) } },
    ];

    expect(await stampSiteMachines('s1', NOW.getTime())).toBe(2);
    expect(machineIds('s1')).toEqual(['late']);
    expect(machineIds('s1', YESTERDAY)).toEqual(['lastNight']);
  });

  it('answers 0 and writes nothing for a site with no machines', async () => {
    expect(await stampSiteMachines('gone', NOW.getTime())).toBe(0);
    expect(mockStore.size).toBe(0);
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
