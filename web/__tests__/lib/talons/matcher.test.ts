/** @jest-environment node */

/**
 * Talon trigger matcher + its internal http ingress.
 *
 * The run engine is mocked at its module boundary (engine.test.ts covers runs).
 * Under test is SELECTION: which talons a signal picks out, what each is handed,
 * and that neither a bad talon nor a dead Firestore escapes a tap into the
 * route that fired it.
 *
 * Firestore is an in-memory fake, not chained `jest.fn()`s, because the query
 * the matcher issues (`enabled == true`, capped) is part of the asserted
 * behavior — a naive mock would silently satisfy the cap.
 */

const mockRunTalon = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock('firebase-admin/firestore', () => ({
  __esModule: true,
  FieldValue: { delete: jest.fn(), serverTimestamp: jest.fn() },
}));
jest.mock('@sentry/nextjs', () => ({
  __esModule: true,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock('@/lib/talons/engine.server', () => ({
  __esModule: true,
  runTalon: (...args: unknown[]) => mockRunTalon(...args),
}));
jest.mock('@/lib/auditLog.server', () => ({
  __esModule: true,
  generateCorrelationId: () => 'corr-fixed',
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

const mockGetAdminDb = jest.fn();
jest.mock('@/lib/firebase-admin', () => ({
  __esModule: true,
  getAdminDb: () => mockGetAdminDb(),
  getAdminAuth: jest.fn(),
}));

const mockGetEntitlements = jest.fn();
jest.mock('@/lib/tridantEntitlements.server', () => ({
  getEntitlements: (uid: string) => mockGetEntitlements(uid),
}));

import type { Firestore } from 'firebase-admin/firestore';
import { NextRequest } from 'next/server';

import { POST as matchPOST } from '@/app/api/talons/internal/match/route';
import { createPlanMemo } from '@/lib/planPause.server';
import {
  matchAndRunTalons,
  tapTalonMatcher,
  type TalonMatchEvent,
} from '@/lib/talons/matcher.server';
import type { TalonDoc } from '@/lib/talons/types';
import { MAX_TALONS_PER_SITE } from '@/lib/talons/validation';

type DocData = Record<string, unknown>;

class FakeFirestore {
  readonly docs = new Map<string, DocData>();
  /** Set to make every `.get()` reject — the "Firestore is down" case. */
  failReads = false;
  /** Set to make every `.add()` reject — a write that loses to a rules change. */
  failWrites = false;
  /** Paths of every single-document read, in order — the plan lookup's reads. */
  readonly docReads: string[] = [];

  collection(name: string): FakeCollection {
    return new FakeCollection(this, name);
  }

  childPaths(collectionPath: string): string[] {
    const prefix = `${collectionPath}/`;
    return [...this.docs.keys()].filter(
      (path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'),
    );
  }
}

class FakeCollection {
  constructor(
    private readonly db: FakeFirestore,
    readonly path: string,
  ) {}

  doc(id: string): FakeDocRef {
    return new FakeDocRef(this.db, `${this.path}/${id}`);
  }

  where(field: string, _op: string, value: unknown): FakeQuery {
    return new FakeQuery(this.db, this.path, [{ field, value }], null);
  }

  /** Auto-id insert, as the matcher's deferral write uses. */
  async add(data: DocData): Promise<FakeDocRef> {
    if (this.db.failWrites) throw new Error('firestore unavailable');
    const id = `doc-${this.db.docs.size + 1}`;
    this.db.docs.set(`${this.path}/${id}`, { ...data });
    return new FakeDocRef(this.db, `${this.path}/${id}`);
  }
}

class FakeQuery {
  constructor(
    private readonly db: FakeFirestore,
    private readonly collectionPath: string,
    private readonly filters: { field: string; value: unknown }[],
    private readonly max: number | null,
  ) {}

  where(field: string, _op: string, value: unknown): FakeQuery {
    return new FakeQuery(this.db, this.collectionPath, [...this.filters, { field, value }], this.max);
  }

  limit(max: number): FakeQuery {
    return new FakeQuery(this.db, this.collectionPath, this.filters, max);
  }

  async get() {
    if (this.db.failReads) throw new Error('firestore unavailable');
    let paths = this.db.childPaths(this.collectionPath).filter((path) => {
      const data = this.db.docs.get(path) ?? {};
      return this.filters.every((filter) => data[filter.field] === filter.value);
    });
    if (this.max !== null) paths = paths.slice(0, this.max);
    const docs = paths.map((path) => ({
      id: path.slice(path.lastIndexOf('/') + 1),
      data: () => ({ ...this.db.docs.get(path) }),
    }));
    return { docs, empty: docs.length === 0, size: docs.length };
  }
}

class FakeDocRef {
  constructor(
    private readonly db: FakeFirestore,
    readonly path: string,
  ) {}

  collection(name: string): FakeCollection {
    return new FakeCollection(this.db, `${this.path}/${name}`);
  }

  async get() {
    if (this.db.failReads) throw new Error('firestore unavailable');
    this.db.docReads.push(this.path);
    const data = this.db.docs.get(this.path);
    return { exists: data !== undefined, data: () => (data ? { ...data } : undefined) };
  }
}

const SITE = 'site-a';
const TALONS_PATH = `sites/${SITE}/talons`;
const RUNS_PATH = `sites/${SITE}/talon_runs`;
const NOW = new Date('2026-08-14T12:00:00Z');

let fake: FakeFirestore;
let db: Firestore;

function seedTalon(id: string, overrides: Partial<TalonDoc> = {}): void {
  const doc: TalonDoc = {
    schemaVersion: 1,
    name: `talon ${id}`,
    enabled: true,
    trigger: { type: 'threshold', metric: 'cpu_percent', operator: '>', value: 90 },
    condition: { type: 'none' },
    outputs: [{ type: 'email' }],
    scope: { machineIds: null },
    cooldownMinutes: 0,
    createdBy: 'admin-uid',
    createdVia: 'ui',
    createdAt: NOW,
    updatedAt: NOW,
    consecutiveFailures: 0,
    ...overrides,
  };
  fake.docs.set(`${TALONS_PATH}/${id}`, doc as unknown as DocData);
}

/** Every document written into this site's `talon_runs`, in insertion order. */
function writtenRuns(): DocData[] {
  return fake.childPaths(RUNS_PATH).map((path) => fake.docs.get(path) as DocData);
}

/** Seed a deferral the coalescing check will find. */
function seedDeferral(id: string, overrides: DocData = {}): void {
  fake.docs.set(`${RUNS_PATH}/${id}`, {
    talonId: 'delayed',
    talonName: 'talon delayed',
    triggerType: 'event',
    triggerSummary: 'on process_restarted · after 3 min',
    status: 'pending',
    createdAt: NOW,
    startedAt: NOW,
    runAfterAt: new Date(NOW.getTime() + 3 * 60_000),
    outputs: [],
    correlationId: 'corr-existing',
    ...overrides,
  });
}

/** Ids of the talons `runTalon` was called with, in call order. */
function ranTalonIds(): string[] {
  return mockRunTalon.mock.calls.map((call) => (call[1] as { id: string }).id);
}

function runContext(callIndex = 0): Record<string, unknown> {
  return mockRunTalon.mock.calls[callIndex][2] as Record<string, unknown>;
}

const breach = (overrides: Partial<Extract<TalonMatchEvent, { kind: 'threshold' }>> = {}) =>
  ({
    kind: 'threshold' as const,
    metric: 'cpu_percent',
    operator: '>',
    value: 96,
    machineId: 'm1',
    ...overrides,
  });

beforeEach(() => {
  jest.clearAllMocks();
  fake = new FakeFirestore();
  db = fake as unknown as Firestore;
  mockRunTalon.mockResolvedValue([{ runId: 'run-1', status: 'succeeded', outputs: [] }]);
  mockGetAdminDb.mockReturnValue(db);
});

describe('threshold signals', () => {
  it('runs the talon whose metric, operator and bound the breach satisfies', async () => {
    seedTalon('t1');

    const result = await matchAndRunTalons(db, SITE, breach());

    expect(result.matched).toBe(1);
    expect(result.runs).toEqual([{ runId: 'run-1', status: 'succeeded', outputs: [] }]);
    expect(mockRunTalon).toHaveBeenCalledTimes(1);
    expect(runContext()).toEqual({
      siteId: SITE,
      machineId: 'm1',
      triggerSummary: 'cpu_percent 96 crossed > 90',
    });
  });

  it('ignores a talon watching a different metric', async () => {
    seedTalon('t1', {
      trigger: { type: 'threshold', metric: 'gpu_percent', operator: '>', value: 90 },
    });

    expect((await matchAndRunTalons(db, SITE, breach())).matched).toBe(0);
    expect(mockRunTalon).not.toHaveBeenCalled();
  });

  it('ignores a talon watching the same metric through a different operator', async () => {
    // `<90` and `>90` are opposite questions; 96 answers only one.
    seedTalon('t1', {
      trigger: { type: 'threshold', metric: 'cpu_percent', operator: '<', value: 90 },
    });

    expect((await matchAndRunTalons(db, SITE, breach())).matched).toBe(0);
  });

  it('ignores a talon whose own bound the breach value does not cross', async () => {
    // The alert fired at 80; a talon set at 95 isn't breached by 84.
    seedTalon('t1', {
      trigger: { type: 'threshold', metric: 'cpu_percent', operator: '>', value: 95 },
    });

    expect((await matchAndRunTalons(db, SITE, breach({ value: 84 }))).matched).toBe(0);
  });

  it('honors the inclusive operators at their exact boundary', async () => {
    seedTalon('gte', {
      trigger: { type: 'threshold', metric: 'cpu_temp', operator: '>=', value: 85 },
    });
    seedTalon('lte', {
      trigger: { type: 'threshold', metric: 'cpu_temp', operator: '<=', value: 85 },
    });

    const above = await matchAndRunTalons(
      db,
      SITE,
      breach({ metric: 'cpu_temp', operator: '>=', value: 85 }),
    );
    expect(above.matched).toBe(1);
    expect(ranTalonIds()).toEqual(['gte']);

    mockRunTalon.mockClear();
    const below = await matchAndRunTalons(
      db,
      SITE,
      breach({ metric: 'cpu_temp', operator: '<=', value: 85 }),
    );
    expect(below.matched).toBe(1);
    expect(ranTalonIds()).toEqual(['lte']);
  });

  it('never matches a threshold breach against an event or schedule talon', async () => {
    seedTalon('event', { trigger: { type: 'event', eventTypes: ['process_crash'] } });
    seedTalon('schedule', { trigger: { type: 'schedule', intervalMinutes: 60 } });

    expect((await matchAndRunTalons(db, SITE, breach())).matched).toBe(0);
  });

  it('drops a breach whose value is not a finite number', async () => {
    seedTalon('t1');

    const result = await matchAndRunTalons(
      db,
      SITE,
      breach({ value: Number.NaN }),
    );

    expect(result).toEqual({ matched: 0, runs: [] });
    expect(mockRunTalon).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalled();
  });
});

describe('event signals', () => {
  it('runs every talon subscribed to the event type', async () => {
    seedTalon('t1', { trigger: { type: 'event', eventTypes: ['process_crash'] } });
    seedTalon('t2', {
      trigger: { type: 'event', eventTypes: ['machine_offline', 'process_crash'] },
    });
    seedTalon('t3', { trigger: { type: 'event', eventTypes: ['display_drift'] } });

    const result = await matchAndRunTalons(db, SITE, {
      kind: 'event',
      eventType: 'process_crash',
      machineId: 'm1',
    });

    expect(result.matched).toBe(2);
    expect(ranTalonIds().sort()).toEqual(['t1', 't2']);
    expect(runContext()).toEqual({
      siteId: SITE,
      machineId: 'm1',
      triggerSummary: 'on process_crash',
    });
  });

  it.each(['exe_missing', 'process_restarted'] as const)(
    'matches the catalog member added in this task: %s',
    async (eventType) => {
      seedTalon('t1', { trigger: { type: 'event', eventTypes: [eventType] } });

      const result = await matchAndRunTalons(db, SITE, {
        kind: 'event',
        eventType,
        machineId: 'm1',
      });

      expect(result.matched).toBe(1);
      expect(runContext().triggerSummary).toBe(`on ${eventType}`);
    },
  );

  it('short-circuits an event outside the catalog without reading firestore', async () => {
    // `/api/agent/alert` taps on `connection_failure` too, which no talon can
    // subscribe to — it must not cost a query. The poisoned reads below would
    // reject if one were issued.
    seedTalon('t1', { trigger: { type: 'event', eventTypes: ['process_crash'] } });
    fake.failReads = true;

    const result = await matchAndRunTalons(db, SITE, {
      kind: 'event',
      eventType: 'connection_failure',
      machineId: 'm1',
    });

    expect(result).toEqual({ matched: 0, runs: [] });
    expect(mockRunTalon).not.toHaveBeenCalled();
  });

  it('ignores a catalog event nobody subscribes to', async () => {
    seedTalon('t1', { trigger: { type: 'event', eventTypes: ['process_crash'] } });

    const result = await matchAndRunTalons(db, SITE, {
      kind: 'event',
      eventType: 'display_mosaic_disabled',
      machineId: 'm1',
    });

    expect(result.matched).toBe(0);
  });

  it('skips a disabled talon at the query, not in memory', async () => {
    seedTalon('on', { trigger: { type: 'event', eventTypes: ['process_crash'] } });
    seedTalon('off', {
      enabled: false,
      trigger: { type: 'event', eventTypes: ['process_crash'] },
    });

    const result = await matchAndRunTalons(db, SITE, {
      kind: 'event',
      eventType: 'process_crash',
      machineId: 'm1',
    });

    expect(result.matched).toBe(1);
    expect(ranTalonIds()).toEqual(['on']);
  });
});

describe('delayed event triggers', () => {
  const restarted = { kind: 'event' as const, eventType: 'process_restarted', machineId: 'm1' };

  function seedDelayed(delayMinutes: number | undefined, overrides: Partial<TalonDoc> = {}): void {
    seedTalon('delayed', {
      trigger: { type: 'event', eventTypes: ['process_restarted'], delayMinutes },
      ...overrides,
    });
  }

  it('writes a deferral instead of running the talon', async () => {
    seedDelayed(3);

    const result = await matchAndRunTalons(db, SITE, restarted);

    // Still a match — it just has not run yet.
    expect(result).toEqual({ matched: 1, runs: [] });
    expect(mockRunTalon).not.toHaveBeenCalled();

    const runs = writtenRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      talonId: 'delayed',
      talonName: 'talon delayed',
      triggerType: 'event',
      triggerSummary: 'on process_restarted · after 3 min',
      machineId: 'm1',
      status: 'pending',
      outputs: [],
      correlationId: 'corr-fixed',
    });
  });

  it('schedules the deferral exactly delayMinutes out, and stamps startedAt', async () => {
    seedDelayed(3);
    const before = Date.now();

    await matchAndRunTalons(db, SITE, restarted);

    const [deferral] = writtenRuns();
    const runAfterMs = (deferral.runAfterAt as Date).getTime();
    const createdMs = (deferral.createdAt as Date).getTime();

    expect(runAfterMs - createdMs).toBe(3 * 60_000);
    expect(createdMs).toBeGreaterThanOrEqual(before);
    // The run history orders on `startedAt`; a crumb missing it is invisible.
    expect((deferral.startedAt as Date).getTime()).toBe(createdMs);
  });

  it('coalesces a burst into one deferral', async () => {
    seedDelayed(3);

    // Eight crash-loops inside the wait are still one thing to react to.
    for (let index = 0; index < 8; index += 1) {
      await matchAndRunTalons(db, SITE, restarted);
    }

    expect(writtenRuns()).toHaveLength(1);
    expect(mockRunTalon).not.toHaveBeenCalled();
  });

  it('coalesces per machine, not per talon', async () => {
    seedDelayed(3);

    await matchAndRunTalons(db, SITE, restarted);
    await matchAndRunTalons(db, SITE, { ...restarted, machineId: 'm2' });
    await matchAndRunTalons(db, SITE, { ...restarted, machineId: 'm2' });

    expect(writtenRuns().map((run) => run.machineId)).toEqual(['m1', 'm2']);
  });

  it('coalesces a site-level deferral, which carries no machineId at all', async () => {
    seedDelayed(3);

    await matchAndRunTalons(db, SITE, { kind: 'event', eventType: 'process_restarted' });
    await matchAndRunTalons(db, SITE, { kind: 'event', eventType: 'process_restarted' });

    const runs = writtenRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).not.toHaveProperty('machineId');
    expect(runs[0].triggerSummary).toBe('on process_restarted · after 3 min');
  });

  it('does not coalesce against a deferral that has already fired', async () => {
    seedDelayed(3);
    seedDeferral('spent', { status: 'fired', machineId: 'm1' });

    await matchAndRunTalons(db, SITE, restarted);

    expect(writtenRuns().filter((run) => run.status === 'pending')).toHaveLength(1);
  });

  it('does not coalesce against another talon waiting on the same machine', async () => {
    seedDelayed(3);
    seedDeferral('other-talon', { talonId: 'somebody-else', machineId: 'm1' });

    await matchAndRunTalons(db, SITE, restarted);

    expect(writtenRuns().filter((run) => run.talonId === 'delayed')).toHaveLength(1);
  });

  it.each([[undefined], [0], [-5], [Number.NaN], ['3' as unknown as number]])(
    'runs immediately when the delay is %p',
    async (delayMinutes) => {
      seedDelayed(delayMinutes);

      const result = await matchAndRunTalons(db, SITE, restarted);

      expect(result.runs).toHaveLength(1);
      expect(mockRunTalon).toHaveBeenCalledTimes(1);
      expect(runContext().triggerSummary).toBe('on process_restarted');
      expect(writtenRuns()).toHaveLength(0);
    },
  );

  it('never defers a threshold breach, whatever the trigger carries', async () => {
    // The validator rejects `delayMinutes` on a threshold trigger; a hand-edited
    // doc must still not take the deferral path.
    seedTalon('threshold-delay', {
      trigger: {
        type: 'threshold',
        metric: 'cpu_percent',
        operator: '>',
        value: 90,
        delayMinutes: 30,
      } as unknown as TalonDoc['trigger'],
    });

    await matchAndRunTalons(db, SITE, breach());

    expect(mockRunTalon).toHaveBeenCalledTimes(1);
    expect(writtenRuns()).toHaveLength(0);
  });

  it('isolates a deferral write failure from the other talons', async () => {
    seedDelayed(3);
    seedTalon('immediate', { trigger: { type: 'event', eventTypes: ['process_restarted'] } });
    fake.failWrites = true;

    const result = await matchAndRunTalons(db, SITE, restarted);

    expect(result.matched).toBe(2);
    expect(ranTalonIds()).toEqual(['immediate']);
    expect(mockLoggerError).toHaveBeenCalled();
  });
});

describe('scope filtering', () => {
  it('matches a machine-scoped talon only on a machine in its list', async () => {
    seedTalon('scoped', {
      trigger: { type: 'event', eventTypes: ['process_crash'] },
      scope: { machineIds: ['m1', 'm2'] },
    });

    const hit = await matchAndRunTalons(db, SITE, {
      kind: 'event',
      eventType: 'process_crash',
      machineId: 'm2',
    });
    expect(hit.matched).toBe(1);

    mockRunTalon.mockClear();
    const miss = await matchAndRunTalons(db, SITE, {
      kind: 'event',
      eventType: 'process_crash',
      machineId: 'm9',
    });
    expect(miss.matched).toBe(0);
    expect(mockRunTalon).not.toHaveBeenCalled();
  });

  it('matches an unscoped talon on any machine', async () => {
    seedTalon('all', {
      trigger: { type: 'event', eventTypes: ['process_crash'] },
      scope: { machineIds: null },
    });

    const result = await matchAndRunTalons(db, SITE, {
      kind: 'event',
      eventType: 'process_crash',
      machineId: 'whatever',
    });

    expect(result.matched).toBe(1);
  });

  it('matches ONLY unscoped talons when the event names no machine', async () => {
    // A machine-scoped action can't answer an event with no machine.
    seedTalon('all', {
      trigger: { type: 'event', eventTypes: ['display_sync_lost'] },
      scope: { machineIds: null },
    });
    seedTalon('scoped', {
      trigger: { type: 'event', eventTypes: ['display_sync_lost'] },
      scope: { machineIds: ['m1'] },
    });

    const result = await matchAndRunTalons(db, SITE, {
      kind: 'event',
      eventType: 'display_sync_lost',
    });

    expect(result.matched).toBe(1);
    expect(ranTalonIds()).toEqual(['all']);
    // No machine to attribute the run to, so none is passed through.
    expect(runContext()).toEqual({ siteId: SITE, triggerSummary: 'on display_sync_lost' });
  });

  it('applies the same scope rule to threshold breaches', async () => {
    seedTalon('scoped', { scope: { machineIds: ['other'] } });

    expect((await matchAndRunTalons(db, SITE, breach())).matched).toBe(0);
  });

  it('matches nothing for a talon scoped to an empty machine list', async () => {
    seedTalon('empty', {
      trigger: { type: 'event', eventTypes: ['process_crash'] },
      scope: { machineIds: [] },
    });

    const result = await matchAndRunTalons(db, SITE, {
      kind: 'event',
      eventType: 'process_crash',
      machineId: 'm1',
    });

    expect(result.matched).toBe(0);
  });
});

describe('fan-out', () => {
  it('reads no more than the per-site talon cap', async () => {
    // The create path counts before writing rather than transacting, so a race
    // can leave a site over the cap — a signal must not discover that by
    // fanning out unbounded runs.
    for (let index = 0; index < MAX_TALONS_PER_SITE + 5; index += 1) {
      seedTalon(`t${String(index).padStart(2, '0')}`, {
        trigger: { type: 'event', eventTypes: ['process_crash'] },
      });
    }

    const result = await matchAndRunTalons(db, SITE, {
      kind: 'event',
      eventType: 'process_crash',
      machineId: 'm1',
    });

    expect(result.matched).toBe(MAX_TALONS_PER_SITE);
    expect(mockRunTalon).toHaveBeenCalledTimes(MAX_TALONS_PER_SITE);
  });

  it('keeps running the remaining talons after one throws', async () => {
    seedTalon('t1', { trigger: { type: 'event', eventTypes: ['process_crash'] } });
    seedTalon('t2', { trigger: { type: 'event', eventTypes: ['process_crash'] } });
    mockRunTalon
      .mockRejectedValueOnce(new Error('engine exploded'))
      .mockResolvedValueOnce([{ runId: 'run-2', status: 'succeeded', outputs: [] }]);

    const result = await matchAndRunTalons(db, SITE, {
      kind: 'event',
      eventType: 'process_crash',
      machineId: 'm1',
    });

    expect(mockRunTalon).toHaveBeenCalledTimes(2);
    // Both talons matched; only the one that survived contributed a run.
    expect(result.matched).toBe(2);
    expect(result.runs).toEqual([{ runId: 'run-2', status: 'succeeded', outputs: [] }]);
    expect(mockLoggerError).toHaveBeenCalled();
  });
});

describe('tapTalonMatcher', () => {
  /** Let the tap's detached promise chain settle. */
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it('returns synchronously and runs the match in the background', async () => {
    seedTalon('t1');

    expect(tapTalonMatcher(db, SITE, breach())).toBeUndefined();
    expect(mockRunTalon).not.toHaveBeenCalled();

    await settle();
    expect(mockRunTalon).toHaveBeenCalledTimes(1);
  });

  it('swallows an engine rejection instead of propagating it to the host route', async () => {
    seedTalon('t1');
    mockRunTalon.mockRejectedValue(new Error('engine exploded'));

    expect(() => tapTalonMatcher(db, SITE, breach())).not.toThrow();

    await settle();
    expect(mockLoggerError).toHaveBeenCalled();
  });

  it('swallows a firestore failure that never reaches the run loop', async () => {
    fake.failReads = true;

    expect(() => tapTalonMatcher(db, SITE, breach())).not.toThrow();

    await settle();
    expect(mockLoggerError).toHaveBeenCalledWith(
      'Talon matcher tap failed',
      expect.objectContaining({ context: 'talons/matcher' }),
    );
  });
});

describe('POST /api/talons/internal/match', () => {
  const SECRET = 'internal-secret-value';
  const originalSecret = process.env.CORTEX_INTERNAL_SECRET;

  function request(body: unknown, secret?: string) {
    return new NextRequest('http://localhost/api/talons/internal/match', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(secret === undefined ? {} : { 'x-internal-secret': secret }),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  beforeEach(() => {
    process.env.CORTEX_INTERNAL_SECRET = SECRET;
  });

  afterAll(() => {
    if (originalSecret === undefined) delete process.env.CORTEX_INTERNAL_SECRET;
    else process.env.CORTEX_INTERNAL_SECRET = originalSecret;
  });

  it('rejects a missing secret with a 401 problem', async () => {
    const res = await matchPOST(request({ siteId: SITE, eventType: 'display_drift' }));

    expect(res.status).toBe(401);
    expect(res.headers.get('Content-Type')).toContain('application/problem+json');
    expect(await res.json()).toMatchObject({ status: 401, code: 'unauthorized' });
    expect(mockRunTalon).not.toHaveBeenCalled();
  });

  it.each([
    ['a wrong secret of the same length', 'internal-secret-VALUE'],
    ['a wrong secret of a different length', 'nope'],
    ['an empty secret', ''],
  ])('rejects %s', async (_label, supplied) => {
    const res = await matchPOST(
      request({ siteId: SITE, eventType: 'display_drift' }, supplied),
    );

    expect(res.status).toBe(401);
    expect(mockRunTalon).not.toHaveBeenCalled();
  });

  it('reports 503 when the deployment has no internal secret configured', async () => {
    delete process.env.CORTEX_INTERNAL_SECRET;

    const res = await matchPOST(request({ siteId: SITE, eventType: 'display_drift' }, SECRET));

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'not_configured' });
  });

  it('runs the matching talons and reports how many matched', async () => {
    seedTalon('t1', {
      trigger: { type: 'event', eventTypes: ['display_drift'] },
      scope: { machineIds: ['m1'] },
    });
    seedTalon('t2', { trigger: { type: 'event', eventTypes: ['display_drift'] } });

    const res = await matchPOST(
      request({ siteId: SITE, eventType: 'display_drift', machineId: 'm1' }, SECRET),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, matched: 2 });
    expect(ranTalonIds().sort()).toEqual(['t1', 't2']);
    expect(runContext()).toMatchObject({ siteId: SITE, machineId: 'm1' });
  });

  it('accepts an event with no machineId', async () => {
    seedTalon('t1', { trigger: { type: 'event', eventTypes: ['process_restarted'] } });

    const res = await matchPOST(
      request({ siteId: SITE, eventType: 'process_restarted' }, SECRET),
    );

    expect(await res.json()).toEqual({ ok: true, matched: 1 });
    expect(runContext()).not.toHaveProperty('machineId');
  });

  it('rejects an event outside the closed catalog', async () => {
    const res = await matchPOST(
      request({ siteId: SITE, eventType: 'display_apply_acked' }, SECRET),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(Object.keys(body.errors)).toEqual(['body.eventType']);
    expect(mockRunTalon).not.toHaveBeenCalled();
  });

  it('rejects a missing siteId', async () => {
    const res = await matchPOST(request({ eventType: 'display_drift' }, SECRET));

    expect(res.status).toBe(400);
    expect(Object.keys((await res.json()).errors)).toEqual(['body.siteId']);
  });

  it('rejects a body that is not json', async () => {
    const res = await matchPOST(request('{not json', SECRET));

    expect(res.status).toBe(400);
    expect(mockRunTalon).not.toHaveBeenCalled();
  });
});

/**
 * Plans (plan.md decision 8): matching pauses when the site's payer has no
 * `owlette.talons`. Runs the real resolver against the fake; only tridant's
 * answer is mocked.
 */
describe('plan pause', () => {
  const ent = (talons: '0' | '1') => ({
    ok: true,
    resolved: talons === '1',
    standing: talons === '1' ? 'active' : 'expired',
    inGoodStanding: talons === '1',
    ent: { 'owlette.talons': talons },
    epoch: 0,
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    process.env.PLAN_ENFORCEMENT = 'on';
    process.env.OWLETTE_E2E = '1';
    fake.docs.set(`sites/${SITE}`, { owner: 'payer' });
    fake.docs.set('users/payer', {});
    mockGetEntitlements.mockResolvedValue(ent('0'));
  });

  afterEach(() => {
    delete process.env.PLAN_ENFORCEMENT;
    delete process.env.OWLETTE_E2E;
  });

  it('runs nothing when the payer has no talons, and says so', async () => {
    seedTalon('t1');

    expect(await matchAndRunTalons(db, SITE, breach())).toEqual({ matched: 0, runs: [] });
    expect(mockGetEntitlements).toHaveBeenCalledWith('payer');
    expect(mockRunTalon).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Talon matching paused: the site's plan has no talons",
      expect.objectContaining({ data: { siteId: SITE, kind: 'threshold', talons: 1 } }),
    );
  });

  it('writes no deferral either', async () => {
    seedTalon('delayed', {
      trigger: { type: 'event', eventTypes: ['process_restarted'], delayMinutes: 3 },
    });

    await matchAndRunTalons(db, SITE, { kind: 'event', eventType: 'process_restarted', machineId: 'm1' });

    expect(writtenRuns()).toHaveLength(0);
  });

  it('runs as before when the payer has talons', async () => {
    mockGetEntitlements.mockResolvedValue(ent('1'));
    seedTalon('t1');

    expect((await matchAndRunTalons(db, SITE, breach())).matched).toBe(1);
    expect(mockRunTalon).toHaveBeenCalledTimes(1);
  });

  it('skips the lookup when no talon matches', async () => {
    seedTalon('t1', { trigger: { type: 'event', eventTypes: ['display_drift'] } });

    await matchAndRunTalons(db, SITE, breach());

    expect(fake.docReads).toEqual([]);
    expect(mockGetEntitlements).not.toHaveBeenCalled();
  });

  it('makes no plan read when enforcement is off', async () => {
    delete process.env.PLAN_ENFORCEMENT;
    seedTalon('t1');

    expect((await matchAndRunTalons(db, SITE, breach())).matched).toBe(1);
    expect(fake.docReads).toEqual([]);
    expect(mockGetEntitlements).not.toHaveBeenCalled();
  });

  it('proceeds when the lookup fails', async () => {
    seedTalon('t1');
    fake.docs.delete('users/payer');
    mockGetEntitlements.mockRejectedValue(new Error('tridant exploded'));

    expect((await matchAndRunTalons(db, SITE, breach())).matched).toBe(1);
    expect(mockRunTalon).toHaveBeenCalledTimes(1);
  });

  it('resolves the payer once across taps sharing a memo', async () => {
    seedTalon('t1', { trigger: { type: 'event', eventTypes: ['machine_offline'] } });
    const memo = createPlanMemo();

    for (const machineId of ['m1', 'm2', 'm3']) {
      tapTalonMatcher(db, SITE, { kind: 'event', eventType: 'machine_offline', machineId }, memo);
    }
    await settle();

    expect(fake.docReads).toEqual([`sites/${SITE}`, 'users/payer']);
    expect(mockGetEntitlements).toHaveBeenCalledTimes(1);
    expect(mockRunTalon).not.toHaveBeenCalled();
  });

  it('pauses the internal match route too', async () => {
    const originalSecret = process.env.CORTEX_INTERNAL_SECRET;
    process.env.CORTEX_INTERNAL_SECRET = 'internal-secret-value';
    seedTalon('t1', { trigger: { type: 'event', eventTypes: ['display_drift'] } });

    try {
      const res = await matchPOST(
        new NextRequest('http://localhost/api/talons/internal/match', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-internal-secret': 'internal-secret-value' },
          body: JSON.stringify({ siteId: SITE, eventType: 'display_drift', machineId: 'm1' }),
        }),
      );

      expect(await res.json()).toEqual({ ok: true, matched: 0 });
      expect(mockRunTalon).not.toHaveBeenCalled();
    } finally {
      if (originalSecret === undefined) delete process.env.CORTEX_INTERNAL_SECRET;
      else process.env.CORTEX_INTERNAL_SECRET = originalSecret;
    }
  });
});
