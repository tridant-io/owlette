/** @jest-environment node */

import { NextRequest } from 'next/server';

// Mocks — must precede the route import (jest hoists jest.mock).

const runTalonMock = jest.fn();
const getSiteTimezoneMock = jest.fn();
const getTalonMock = jest.fn();
/** The hoot follow-up pass; its own behaviour is covered by followupSweep.test.ts. */
const fireDueFollowupsMock = jest.fn();
/** The plan pause; its own behaviour is covered by planPause.server.test.ts. */
const pausedByPlanMock = jest.fn();

/**
 * Talon docs keyed `${siteId}/${talonId}`. The claim transaction reads and
 * writes THROUGH this map, so a second sweep over a stale query result sees
 * the advanced `nextRunAt` exactly as it would in Firestore.
 */
const talonStore = new Map<string, Record<string, unknown>>();

/** Deferral documents, keyed `${siteId}/${runId}` and claimed the same way. */
const deferralStore = new Map<string, Record<string, unknown>>();

const talonRunAdd = jest.fn();
const staleRunUpdate = jest.fn();
const transactionUpdate = jest.fn();
const deferralUpdate = jest.fn();

/** Doc ref carrying its backing map, so the transaction mock can serve talons and deferrals alike. */
interface RefMock {
  id: string;
  key: string;
  store: Map<string, Record<string, unknown>>;
  parent: { parent: { id: string } | null };
  update: (updates: Record<string, unknown>) => Promise<void>;
}

interface StaleRunDocMock {
  id: string;
  data: () => Record<string, unknown>;
  ref: { update: typeof staleRunUpdate };
}

let dueRefs: RefMock[] = [];
let staleRunDocs: StaleRunDocMock[] = [];
let dueDeferralRefs: RefMock[] = [];

const talonQuery = {
  where: jest.fn(() => talonQuery),
  orderBy: jest.fn(() => talonQuery),
  limit: jest.fn(() => talonQuery),
  get: jest.fn(async () => ({
    docs: dueRefs.map((ref) => ({ id: ref.id, ref, data: () => talonStore.get(ref.key) })),
  })),
};

/**
 * `talon_runs` backs both collection-group queries (janitor `running`,
 * deferral pass `pending`), so the fake records filters and answers from the
 * matching fixture.
 */
function talonRunQuery(filters: [string, unknown][] = []) {
  const query = {
    filters,
    where: jest.fn((field: string, _op: string, value: unknown) => {
      talonRunWhere(field, _op, value);
      return talonRunQuery([...filters, [field, value]]);
    }),
    orderBy: jest.fn(() => query),
    limit: jest.fn((max: number) => {
      talonRunLimit(max);
      return query;
    }),
    get: jest.fn(async () => {
      const pending = filters.some(([field, value]) => field === 'status' && value === 'pending');
      if (pending) {
        if (deferralQueryFails) throw new Error('index not ready');
        return {
          docs: dueDeferralRefs.map((ref) => ({
            id: ref.id,
            ref,
            data: () => deferralStore.get(ref.key),
          })),
        };
      }
      if (staleQueryFails) throw new Error('index not ready');
      return { docs: staleRunDocs };
    }),
  };
  return query;
}

/** Filter/limit spies, shared across every `talon_runs` query instance. */
const talonRunWhere = jest.fn();
const talonRunLimit = jest.fn();
let staleQueryFails = false;
let deferralQueryFails = false;

/** Apply an update to an in-memory doc, honouring the delete sentinel. */
function applyUpdate(
  store: Map<string, Record<string, unknown>>,
  key: string,
  updates: Record<string, unknown>,
): void {
  const data = store.get(key);
  if (!data) return;
  for (const [field, value] of Object.entries(updates)) {
    if (value && typeof value === 'object' && (value as { __op?: string }).__op === 'delete') {
      delete data[field];
    } else {
      data[field] = value;
    }
  }
}

const transaction = {
  get: jest.fn(async (ref: RefMock) => ({
    exists: ref.store.has(ref.key),
    data: () => ref.store.get(ref.key),
  })),
  update: jest.fn((ref: RefMock, updates: Record<string, unknown>) => {
    transactionUpdate(ref.key, updates);
    applyUpdate(ref.store, ref.key, updates);
  }),
};

const mockDb = {
  collectionGroup: jest.fn((name: string) => {
    if (name === 'talons') return talonQuery;
    if (name === 'talon_runs') return talonRunQuery();
    throw new Error(`unexpected collection group: ${name}`);
  }),
  collection: jest.fn((name: string) => {
    if (name !== 'sites') throw new Error(`unexpected collection: ${name}`);
    return {
      doc: jest.fn(() => ({
        collection: jest.fn((sub: string) => {
          if (sub !== 'talon_runs') throw new Error(`unexpected subcollection: ${sub}`);
          return { add: talonRunAdd };
        }),
      })),
    };
  }),
  runTransaction: jest.fn(
    async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction),
  ),
};

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { delete: jest.fn(() => ({ __op: 'delete' })) },
  // `@/lib/firestoreTime.server` does `value instanceof Timestamp`, so the
  // binding has to exist even though the fixtures all use Dates.
  Timestamp: class Timestamp {},
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDb,
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('@/lib/auditLog.server', () => ({
  generateCorrelationId: () => 'corr-fixed',
}));

jest.mock('@/lib/talons/engine.server', () => ({
  runTalon: (...args: unknown[]) => runTalonMock(...args),
  STALE_RUN_MS: 10 * 60_000,
}));

jest.mock('@/lib/talons/store.server', () => ({
  getSiteTimezone: (...args: unknown[]) => getSiteTimezoneMock(...args),
  getTalon: (...args: unknown[]) => getTalonMock(...args),
}));

jest.mock('@/lib/hoot/followupSweep.server', () => ({
  fireDueFollowups: (...args: unknown[]) => fireDueFollowupsMock(...args),
}));

jest.mock('@/lib/planPause.server', () => ({
  createPlanMemo: () => ({ sites: new Map(), payers: new Map() }),
  pausedByPlan: (...args: unknown[]) => pausedByPlanMock(...args),
}));

import { GET } from '@/app/api/cron/talons/route';

const MIN = 60_000;

function request(secret?: string) {
  return new NextRequest('http://localhost/api/cron/talons', {
    headers: secret ? { 'x-cron-secret': secret } : {},
  });
}

/** A 30-minute interval talon, the simplest thing the sweep can claim. */
function scheduleTalon(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: 'restart signage',
    enabled: true,
    trigger: { type: 'schedule', intervalMinutes: 30 },
    condition: { type: 'none' },
    outputs: [],
    scope: { machineIds: null },
    cooldownMinutes: 0,
    createdBy: 'user-1',
    createdVia: 'ui',
    consecutiveFailures: 0,
    ...overrides,
  };
}

function refFor(
  store: Map<string, Record<string, unknown>>,
  siteId: string,
  id: string,
): RefMock {
  const key = `${siteId}/${id}`;
  return {
    id,
    key,
    store,
    parent: { parent: { id: siteId } },
    update: async (updates: Record<string, unknown>) => {
      deferralUpdate(key, updates);
      applyUpdate(store, key, updates);
    },
  };
}

/** Seed a talon and return the doc ref the collection-group query hands back. */
function seedTalon(siteId: string, talonId: string, data: Record<string, unknown>): RefMock {
  talonStore.set(`${siteId}/${talonId}`, { ...data });
  return refFor(talonStore, siteId, talonId);
}

/** A deferral written by the matcher, already `pending` and waiting. */
function deferral(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    talonId: 'talon-1',
    talonName: 'check the wall after a restart',
    triggerType: 'event',
    triggerSummary: 'on process_restarted · after 3 min',
    machineId: 'lobby-01',
    status: 'pending',
    createdAt: new Date(Date.now() - 4 * MIN),
    startedAt: new Date(Date.now() - 4 * MIN),
    runAfterAt: new Date(Date.now() - 1 * MIN),
    outputs: [],
    correlationId: 'corr-fixed',
    ...overrides,
  };
}

/** Seed a deferral and return the ref the collection-group query hands back. */
function seedDeferral(
  siteId: string,
  runId: string,
  data: Record<string, unknown> = deferral(),
): RefMock {
  deferralStore.set(`${siteId}/${runId}`, { ...data });
  return refFor(deferralStore, siteId, runId);
}

function staleRunDoc(id: string, startedAt: Date): StaleRunDocMock {
  return { id, data: () => ({ status: 'running', startedAt }), ref: { update: staleRunUpdate } };
}

async function sweep(secret = 'cron-secret') {
  const response = await GET(request(secret));
  return { status: response.status, body: await response.json() };
}

const originalSecret = process.env.CRON_SECRET;

// File-scoped: both sweeps share every fixture and mock, and a leaked
// `runTalonMock` would silently change what the other suite asserts.
beforeEach(() => {
    process.env.CRON_SECRET = 'cron-secret';
    talonStore.clear();
    deferralStore.clear();
    dueRefs = [];
    staleRunDocs = [];
    dueDeferralRefs = [];
    staleQueryFails = false;
    deferralQueryFails = false;
    runTalonMock.mockReset();
    runTalonMock.mockResolvedValue([]);
    pausedByPlanMock.mockReset();
    pausedByPlanMock.mockResolvedValue(false);
    getSiteTimezoneMock.mockReset();
    getSiteTimezoneMock.mockResolvedValue('UTC');
    getTalonMock.mockReset();
    // Deferral tests override this for the "switched off while it waited" paths.
    getTalonMock.mockImplementation(async (_db: unknown, siteId: string, talonId: string) => {
      const data = talonStore.get(`${siteId}/${talonId}`);
      return data ? { id: talonId, ...data } : null;
    });
    talonRunAdd.mockResolvedValue(undefined);
    staleRunUpdate.mockResolvedValue(undefined);
    fireDueFollowupsMock.mockReset();
    fireDueFollowupsMock.mockResolvedValue({
      due: 0,
      fired: 0,
      failed: 0,
      skipped: 0,
      turnActive: 0,
    });
});

afterAll(() => {
  process.env.CRON_SECRET = originalSecret;
});

describe('GET /api/cron/talons', () => {
  it('rejects a request without the cron secret', async () => {
    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(talonQuery.get).not.toHaveBeenCalled();
    expect(mockDb.collectionGroup).not.toHaveBeenCalled();
  });

  it('rejects a request with the wrong cron secret', async () => {
    const { status } = await sweep('not-the-secret');

    expect(status).toBe(401);
    expect(talonQuery.get).not.toHaveBeenCalled();
  });

  it('claims a due talon, advances nextRunAt, and executes it', async () => {
    const dueAt = new Date(Date.now() - 1 * MIN);
    dueRefs = [seedTalon('node-pa', 'talon-1', scheduleTalon({ nextRunAt: dueAt }))];

    const { status, body } = await sweep();

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, due: 1, executed: 1, missed: 0, deferred: 0 });

    // Re-armed one interval ahead of the sweep instant, inside the claim.
    const advanced = talonStore.get('node-pa/talon-1')?.nextRunAt as Date;
    expect(advanced.getTime()).toBeGreaterThan(Date.now() + 29 * MIN);

    expect(runTalonMock).toHaveBeenCalledTimes(1);
    expect(runTalonMock).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ id: 'talon-1', name: 'restart signage' }),
      { siteId: 'node-pa', triggerSummary: 'schedule' },
    );
  });

  it("claims but does not run a scheduled talon whose site's plan lacks talons", async () => {
    dueRefs = [seedTalon('node-pa', 'talon-1', scheduleTalon({ nextRunAt: new Date(Date.now() - 1 * MIN) }))];
    pausedByPlanMock.mockResolvedValue(true);

    const { body } = await sweep();

    expect(body).toMatchObject({ ok: true, due: 1, executed: 0 });
    expect(runTalonMock).not.toHaveBeenCalled();
    expect(pausedByPlanMock).toHaveBeenCalledWith('node-pa', 'owlette.talons', expect.anything());
    // the slot is spent, so a lapsed site doesn't build a backlog that fires on upgrade
    const advanced = talonStore.get('node-pa/talon-1')?.nextRunAt as Date;
    expect(advanced.getTime()).toBeGreaterThan(Date.now());
  });

  it('queries only enabled talons that are already due, oldest first', async () => {
    await sweep();

    expect(mockDb.collectionGroup).toHaveBeenCalledWith('talons');
    expect(talonQuery.where).toHaveBeenCalledWith('enabled', '==', true);
    expect(talonQuery.where).toHaveBeenCalledWith('nextRunAt', '<=', expect.any(Date));
    expect(talonQuery.orderBy).toHaveBeenCalledWith('nextRunAt', 'asc');
    expect(talonQuery.limit).toHaveBeenCalledWith(25);
  });

  it('skips a talon a concurrent sweep already claimed', async () => {
    dueRefs = [seedTalon('node-pa', 'talon-1', scheduleTalon({ nextRunAt: new Date(Date.now() - MIN) }))];

    const first = await sweep();
    // Stale query result: the re-read sees the advanced `nextRunAt`, loser no-ops.
    const second = await sweep();

    expect(first.body).toMatchObject({ due: 1, executed: 1 });
    expect(second.body).toMatchObject({ due: 1, executed: 0, missed: 0, deferred: 0 });
    expect(runTalonMock).toHaveBeenCalledTimes(1);
    expect(transactionUpdate).toHaveBeenCalledTimes(1);
  });

  it('skips a talon disabled between the query and the claim', async () => {
    const ref = seedTalon('node-pa', 'talon-1', scheduleTalon({ nextRunAt: new Date(Date.now() - MIN) }));
    dueRefs = [ref];
    transaction.get.mockImplementationOnce(async () => ({
      exists: true,
      data: () => ({ ...talonStore.get(ref.key), enabled: false }),
    }));

    const { body } = await sweep();

    expect(body).toMatchObject({ due: 1, executed: 0 });
    expect(runTalonMock).not.toHaveBeenCalled();
    expect(transactionUpdate).not.toHaveBeenCalled();
  });

  it('records a missed run without executing when the fire window has passed', async () => {
    // Sweep down 20 minutes: firing now is a burst of stale automations.
    dueRefs = [
      seedTalon(
        'node-pa',
        'talon-1',
        scheduleTalon({ nextRunAt: new Date(Date.now() - 20 * MIN) }),
      ),
    ];

    const { body } = await sweep();

    expect(body).toMatchObject({ due: 1, executed: 0, missed: 1 });
    expect(runTalonMock).not.toHaveBeenCalled();
    expect(talonRunAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        talonId: 'talon-1',
        talonName: 'restart signage',
        triggerType: 'schedule',
        triggerSummary: 'schedule',
        status: 'missed',
        error: 'missed_fire_window',
        outputs: [],
        startedAt: expect.any(Date),
        completedAt: expect.any(Date),
      }),
    );
    // Still re-armed, so it fires normally at its next real slot.
    const advanced = talonStore.get('node-pa/talon-1')?.nextRunAt as Date;
    expect(advanced.getTime()).toBeGreaterThan(Date.now());
  });

  it('fires a talon that is only slightly late', async () => {
    dueRefs = [
      seedTalon('node-pa', 'talon-1', scheduleTalon({ nextRunAt: new Date(Date.now() - 9 * MIN) })),
    ];

    const { body } = await sweep();

    expect(body).toMatchObject({ executed: 1, missed: 0 });
  });

  it('drops nextRunAt when the trigger is no longer a schedule', async () => {
    dueRefs = [
      seedTalon(
        'node-pa',
        'talon-1',
        scheduleTalon({
          trigger: { type: 'threshold', metric: 'cpu_percent', operator: '>', value: 90 },
          nextRunAt: new Date(Date.now() - MIN),
        }),
      ),
    ];

    const { body } = await sweep();

    expect(body).toMatchObject({ due: 1, executed: 0, missed: 0 });
    expect(transactionUpdate).toHaveBeenCalledWith('node-pa/talon-1', {
      nextRunAt: { __op: 'delete' },
    });
    expect(talonStore.get('node-pa/talon-1')?.nextRunAt).toBeUndefined();
    expect(runTalonMock).not.toHaveBeenCalled();
  });

  it('closes out runs stuck running past the stale window', async () => {
    const startedAt = new Date(Date.now() - 30 * MIN);
    staleRunDocs = [staleRunDoc('run-1', startedAt), staleRunDoc('run-2', startedAt)];

    const { body } = await sweep();

    expect(body.staleRecovered).toBe(2);
    expect(mockDb.collectionGroup).toHaveBeenCalledWith('talon_runs');
    expect(talonRunWhere).toHaveBeenCalledWith('status', '==', 'running');
    expect(talonRunWhere).toHaveBeenCalledWith('startedAt', '<=', expect.any(Date));
    expect(staleRunUpdate).toHaveBeenCalledTimes(2);
    expect(staleRunUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        error: 'stale',
        completedAt: expect.any(Date),
        durationMs: expect.any(Number),
      }),
    );
  });

  it('keeps dispatching when the stale-run janitor fails', async () => {
    // Usually a still-building collection-group index; schedules must keep firing.
    staleQueryFails = true;
    dueRefs = [seedTalon('node-pa', 'talon-1', scheduleTalon({ nextRunAt: new Date(Date.now() - MIN) }))];

    const { status, body } = await sweep();

    expect(status).toBe(200);
    expect(body).toMatchObject({ executed: 1, staleRecovered: 0 });
  });

  it('defers the remainder once the sweep budget is spent', async () => {
    dueRefs = [
      seedTalon('node-pa', 'talon-1', scheduleTalon({ nextRunAt: new Date(Date.now() - MIN) })),
      seedTalon('node-pa', 'talon-2', scheduleTalon({ nextRunAt: new Date(Date.now() - MIN) })),
      seedTalon('node-pa', 'talon-3', scheduleTalon({ nextRunAt: new Date(Date.now() - MIN) })),
    ];

    const base = Date.now();
    let offset = 0;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => base + offset);
    // The first talon burns the whole 50s budget.
    runTalonMock.mockImplementation(async () => {
      offset += 60_000;
      return [];
    });

    const { body } = await sweep();

    expect(body).toMatchObject({ due: 3, executed: 1, deferred: 2 });
    expect(runTalonMock).toHaveBeenCalledTimes(1);
    // Deferred talons keep their due instant, so the next sweep claims them.
    expect((talonStore.get('node-pa/talon-3')?.nextRunAt as Date).getTime()).toBeLessThan(base);

    nowSpy.mockRestore();
  });

  it('keeps sweeping after one talon throws', async () => {
    dueRefs = [
      seedTalon('node-pa', 'talon-1', scheduleTalon({ nextRunAt: new Date(Date.now() - MIN) })),
      seedTalon('node-pa', 'talon-2', scheduleTalon({ nextRunAt: new Date(Date.now() - MIN) })),
    ];
    runTalonMock.mockRejectedValueOnce(new Error('output exploded'));

    const { status, body } = await sweep();

    expect(status).toBe(200);
    expect(body).toMatchObject({ due: 2, executed: 1 });
    expect(runTalonMock).toHaveBeenCalledTimes(2);
  });

  it('reads each site timezone once per sweep', async () => {
    dueRefs = [
      seedTalon('node-pa', 'talon-1', scheduleTalon({ nextRunAt: new Date(Date.now() - MIN) })),
      seedTalon('node-pa', 'talon-2', scheduleTalon({ nextRunAt: new Date(Date.now() - MIN) })),
      seedTalon('node-nyc', 'talon-3', scheduleTalon({ nextRunAt: new Date(Date.now() - MIN) })),
    ];

    await sweep();

    expect(getSiteTimezoneMock).toHaveBeenCalledTimes(2);
    expect(getSiteTimezoneMock).toHaveBeenCalledWith(mockDb, 'node-pa');
    expect(getSiteTimezoneMock).toHaveBeenCalledWith(mockDb, 'node-nyc');
  });
});

describe('GET /api/cron/talons — delayed event triggers', () => {
  /** The talon a seeded deferral points at, enabled unless told otherwise. */
  function seedDelayedTalon(overrides: Record<string, unknown> = {}) {
    talonStore.set(
      'node-pa/talon-1',
      scheduleTalon({
        name: 'check the wall after a restart',
        trigger: { type: 'event', eventTypes: ['process_restarted'], delayMinutes: 3 },
        ...overrides,
      }),
    );
  }

  beforeEach(() => {
    seedDelayedTalon();
    // A run is the normal outcome here; the schedule suite's empty-list default
    // means "cooled down" on this path, tested separately below.
    runTalonMock.mockResolvedValue([{ runId: 'run-real', status: 'succeeded', outputs: [] }]);
  });

  it('queries pending deferrals that are due, oldest first, capped', async () => {
    await sweep();

    expect(mockDb.collectionGroup).toHaveBeenCalledWith('talon_runs');
    expect(talonRunWhere).toHaveBeenCalledWith('status', '==', 'pending');
    expect(talonRunWhere).toHaveBeenCalledWith('runAfterAt', '<=', expect.any(Date));
    expect(talonRunLimit).toHaveBeenCalledWith(25);
  });

  it('fires a due deferral through the engine and closes the crumb out', async () => {
    dueDeferralRefs = [seedDeferral('node-pa', 'run-1')];

    const { status, body } = await sweep();

    expect(status).toBe(200);
    expect(body).toMatchObject({ deferredDue: 1, deferredFired: 1, deferredMissed: 0 });

    expect(runTalonMock).toHaveBeenCalledTimes(1);
    expect(runTalonMock).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ id: 'talon-1' }),
      {
        siteId: 'node-pa',
        machineId: 'lobby-01',
        triggerSummary: 'on process_restarted · after 3 min',
      },
    );

    const crumb = deferralStore.get('node-pa/run-1');
    expect(crumb).toMatchObject({
      status: 'fired',
      firedAt: expect.any(Date),
      firedRunIds: ['run-real'],
      completedAt: expect.any(Date),
    });
  });

  it('leaves a deferral alone until its delay has elapsed', async () => {
    // Production's query wouldn't return it, but a claim trusting a stale query
    // result fires early — so the claim re-checks.
    dueDeferralRefs = [
      seedDeferral('node-pa', 'run-1', deferral({ runAfterAt: new Date(Date.now() + 2 * MIN) })),
    ];

    const { body } = await sweep();

    expect(body).toMatchObject({ deferredFired: 0, deferredMissed: 0 });
    expect(runTalonMock).not.toHaveBeenCalled();
    expect(deferralStore.get('node-pa/run-1')?.status).toBe('pending');
  });

  it('lets only one of two overlapping sweeps fire the same deferral', async () => {
    dueDeferralRefs = [seedDeferral('node-pa', 'run-1')];

    const first = await sweep();
    // Stale query result: the loser re-reads a no-longer-pending doc and no-ops.
    const second = await sweep();

    expect(first.body).toMatchObject({ deferredDue: 1, deferredFired: 1 });
    expect(second.body).toMatchObject({ deferredDue: 1, deferredFired: 0, deferredSkipped: 0 });
    expect(runTalonMock).toHaveBeenCalledTimes(1);
  });

  it('writes off a deferral that is past its grace window without running it', async () => {
    // Sweep down 20 minutes: a "wait 3 minutes then look at the wall" must not
    // run 23 minutes late.
    dueDeferralRefs = [
      seedDeferral('node-pa', 'run-1', deferral({ runAfterAt: new Date(Date.now() - 20 * MIN) })),
    ];

    const { body } = await sweep();

    expect(body).toMatchObject({ deferredDue: 1, deferredFired: 0, deferredMissed: 1 });
    expect(runTalonMock).not.toHaveBeenCalled();
    expect(deferralStore.get('node-pa/run-1')).toMatchObject({
      status: 'missed',
      error: 'missed_fire_window',
      completedAt: expect.any(Date),
      durationMs: 0,
    });
  });

  it('fires a deferral that is only slightly late', async () => {
    dueDeferralRefs = [
      seedDeferral('node-pa', 'run-1', deferral({ runAfterAt: new Date(Date.now() - 9 * MIN) })),
    ];

    const { body } = await sweep();

    expect(body).toMatchObject({ deferredFired: 1, deferredMissed: 0 });
  });

  it('skips a talon that was switched off while its deferral waited', async () => {
    seedDelayedTalon({ enabled: false });
    dueDeferralRefs = [seedDeferral('node-pa', 'run-1')];

    const { body } = await sweep();

    expect(body).toMatchObject({ deferredFired: 0, deferredSkipped: 1 });
    expect(runTalonMock).not.toHaveBeenCalled();
    expect(deferralStore.get('node-pa/run-1')).toMatchObject({
      status: 'skipped',
      error: 'talon_disabled',
    });
  });

  it("skips a deferral whose site's plan lacks talons, and says so on the crumb", async () => {
    seedDelayedTalon();
    dueDeferralRefs = [seedDeferral('node-pa', 'run-1')];
    pausedByPlanMock.mockResolvedValue(true);

    const { body } = await sweep();

    expect(body).toMatchObject({ deferredFired: 0, deferredSkipped: 1 });
    expect(runTalonMock).not.toHaveBeenCalled();
    expect(deferralStore.get('node-pa/run-1')).toMatchObject({ status: 'skipped', error: 'plan_paused' });
  });

  it('skips a talon that was deleted while its deferral waited', async () => {
    talonStore.clear();
    dueDeferralRefs = [seedDeferral('node-pa', 'run-1')];

    const { body } = await sweep();

    expect(body).toMatchObject({ deferredFired: 0, deferredSkipped: 1 });
    expect(runTalonMock).not.toHaveBeenCalled();
    expect(deferralStore.get('node-pa/run-1')?.error).toBe('talon_deleted');
  });

  it('records the cooldown skip the engine itself never writes down', async () => {
    // A cooling-down `runTalon` records nothing, so the crumb is the only trace.
    dueDeferralRefs = [seedDeferral('node-pa', 'run-1')];
    runTalonMock.mockResolvedValue([]);

    const { body } = await sweep();

    expect(body).toMatchObject({ deferredFired: 0, deferredSkipped: 1 });
    expect(deferralStore.get('node-pa/run-1')).toMatchObject({
      status: 'skipped',
      error: 'cooldown',
      firedRunIds: [],
    });
  });

  it('keeps the pass going after one deferral throws', async () => {
    dueDeferralRefs = [seedDeferral('node-pa', 'run-1'), seedDeferral('node-pa', 'run-2')];
    runTalonMock.mockRejectedValueOnce(new Error('output exploded'));

    const { status, body } = await sweep();

    expect(status).toBe(200);
    expect(body).toMatchObject({ deferredDue: 2, deferredFired: 1 });
    expect(runTalonMock).toHaveBeenCalledTimes(2);
  });

  it('keeps dispatching schedules when the deferral index is still building', async () => {
    deferralQueryFails = true;
    dueRefs = [seedTalon('node-pa', 'talon-2', scheduleTalon({ nextRunAt: new Date(Date.now() - MIN) }))];

    const { status, body } = await sweep();

    expect(status).toBe(200);
    expect(body).toMatchObject({ executed: 1, deferredDue: 0, deferredFired: 0 });
  });
});

describe('GET /api/cron/talons — hoot follow-ups', () => {
  it('runs the follow-up pass inside the sweep budget and reports its counters', async () => {
    fireDueFollowupsMock.mockResolvedValue({
      due: 3,
      fired: 2,
      failed: 1,
      skipped: 0,
      turnActive: 0,
    });

    const { status, body } = await sweep();

    expect(status).toBe(200);
    expect(fireDueFollowupsMock).toHaveBeenCalledWith(mockDb, expect.any(Date), expect.any(Number));
    expect(body).toMatchObject({
      followupDue: 3,
      followupFired: 2,
      followupFailed: 1,
      followupSkipped: 0,
      followupTurnActive: 0,
    });
  });

  it('keeps dispatching talons when the follow-up pass fails', async () => {
    // Usually a still-building `cortex-followups` index — a different feature's
    // problem must never stop a talon firing.
    fireDueFollowupsMock.mockRejectedValue(new Error('index not ready'));
    dueRefs = [
      seedTalon('node-pa', 'talon-1', scheduleTalon({ nextRunAt: new Date(Date.now() - MIN) })),
    ];

    const { status, body } = await sweep();

    expect(status).toBe(200);
    expect(body).toMatchObject({ executed: 1, followupDue: 0, followupFired: 0 });
  });
});
