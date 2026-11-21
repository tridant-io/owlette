/**
 * @jest-environment node
 */

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

let mockEnforced = true;
jest.mock('@/lib/plan.server', () => ({
  plansEnforced: () => mockEnforced,
}));

const mockStamp = jest.fn();
const mockCount = jest.fn();
jest.mock('@/lib/planUsage.server', () => ({
  stampSiteMachines: (...args: unknown[]) => mockStamp(...args),
  activeMachinesBetween: (...args: unknown[]) => mockCount(...args),
  inBatches: <T, R>(items: T[], run: (item: T) => Promise<R>) => Promise.all(items.map(run)),
}));

const mockReportUsage = jest.fn();
jest.mock('@/lib/tridantBilling.server', () => ({
  reportUsage: (...args: unknown[]) => mockReportUsage(...args),
}));

type Doc = Record<string, unknown>;

/** `billing_usage/{siteId}`, by site id. */
let mockDocs = new Map<string, Doc>();
/** site ids whose updates fail. */
let mockFailUpdates = new Set<string>();
/** the filters of the last query, `[field, op, value]`. */
let mockFilters: unknown[][] = [];
let mockQueries = 0;

function mockField(data: Doc, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => (value as Doc | undefined)?.[key], data);
}

// as firestore's update applies a dotted path: only the named leaf changes.
function mockUpdate(siteId: string, fields: Doc) {
  if (mockFailUpdates.has(siteId)) throw new Error('write refused');
  const data = structuredClone(mockDocs.get(siteId)) as Doc;
  for (const [path, value] of Object.entries(fields)) {
    const keys = path.split('.');
    const parent = keys.slice(0, -1).reduce<Doc>((map, key) => (map[key] ??= {}) as Doc, data);
    parent[keys[keys.length - 1]] = value;
  }
  mockDocs.set(siteId, data);
}

function mockMatches(value: unknown, op: unknown, bound: unknown): boolean {
  // a range filter skips a document without a number there, as firestore's does.
  if (typeof value !== 'number') return false;
  if (op === '>') return value > (bound as number);
  if (op === '<=') return value <= (bound as number);
  throw new Error(`unexpected operator ${String(op)}`);
}

function mockQuery(filters: unknown[][]): Record<string, unknown> {
  return {
    where: (...filter: unknown[]) => mockQuery([...filters, filter]),
    get: async () => {
      mockQueries += 1;
      mockFilters = filters;
      const docs = [...mockDocs]
        .filter(([, data]) => filters.every(([field, op, bound]) => mockMatches(mockField(data, field as string), op, bound)))
        .map(([id, data]) => ({ id, data: () => data, ref: { update: async (fields: Doc) => mockUpdate(id, fields) } }));
      return { size: docs.length, docs };
    },
  };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => {
      if (name !== 'billing_usage') throw new Error(`unexpected collection ${name}`);
      return mockQuery([]);
    },
  }),
}));

import logger from '@/lib/logger';
import { runPlanSettle } from '@/lib/planSettle.server';
import type { UsageEntry, UsageOutcome } from '@/lib/tridantBilling.server';

const HOUR_MS = 60 * 60 * 1000;
// the scheduled slot: the morning after a period ends.
const NOW = new Date('2026-11-01T06:00:00.000Z');
const PERIOD_START = Date.UTC(2026, 9, 1);
const PERIOD_END = Date.UTC(2026, 10, 1);
const LAST_MS = PERIOD_END - 1;
const SETTLES_AT = PERIOD_END + 24 * HOUR_MS;

/** what the daily job saved for a billed site. */
function report(overrides: Doc = {}): Doc {
  return {
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    countedFrom: PERIOD_START,
    floor: 0,
    machines: 2,
    asOf: PERIOD_END - 30 * 60 * 1000,
    status: 'recorded',
    recorded: true,
    settled: false,
    at: '__SERVER_TS__',
    ...overrides,
  };
}

function outcome(siteId: string, overrides: Partial<UsageOutcome> = {}): UsageOutcome {
  return {
    siteId,
    status: 'recorded',
    recorded: true,
    settling: true,
    settlesAt: SETTLES_AT,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    ...overrides,
  };
}

/** tridant's answer per site; a site not named is recorded into the settling period. */
function answers(bySite: Record<string, Partial<UsageOutcome>> = {}) {
  mockReportUsage.mockImplementation(async (entries: UsageEntry[]) => ({
    ok: true,
    results: entries.map(({ siteId }) => outcome(siteId, bySite[siteId])),
  }));
}

function sentEntries(): UsageEntry[] {
  return mockReportUsage.mock.calls[0][0];
}

function savedReport(siteId: string): Doc {
  return mockDocs.get(siteId)?.report as Doc;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEnforced = true;
  mockDocs = new Map();
  mockFailUpdates = new Set();
  mockFilters = [];
  mockQueries = 0;
  mockStamp.mockReset();
  mockStamp.mockResolvedValue(1);
  mockCount.mockReset();
  mockCount.mockResolvedValue(2);
  mockReportUsage.mockReset();
  answers();
});

describe('runPlanSettle', () => {
  it('does nothing while plans are not enforced', async () => {
    mockEnforced = false;
    mockDocs.set('s1', { report: report() });

    expect(await runPlanSettle(NOW)).toEqual({ ok: true, candidates: 0, sent: 0, settled: 0, errors: 0 });
    expect(mockQueries).toBe(0);
    expect(mockStamp).not.toHaveBeenCalled();
    expect(mockReportUsage).not.toHaveBeenCalled();
    expect(mockDocs.get('s1')).toEqual({ report: report() });
  });

  it('reads the reports whose period ended in the last 24 hours, up to now', async () => {
    const nowMs = NOW.getTime();
    mockDocs.set('ended-a-day-ago', { report: report({ periodEnd: nowMs - 24 * HOUR_MS }) });
    mockDocs.set('ended-at-midnight', { report: report() });
    mockDocs.set('ends-now', { report: report({ periodEnd: nowMs }) });
    mockDocs.set('ends-later', { report: report({ periodEnd: nowMs + 1 }) });
    mockDocs.set('no-period-end', { report: report({ periodEnd: null }) });
    mockDocs.set('no-report', {});

    const summary = await runPlanSettle(NOW);

    expect(mockFilters).toEqual([
      ['report.periodEnd', '>', nowMs - 24 * HOUR_MS],
      ['report.periodEnd', '<=', nowMs],
    ]);
    expect(summary).toMatchObject({ candidates: 2, sent: 2, settled: 2, errors: 0 });
    expect(sentEntries().map(({ siteId }) => siteId)).toEqual(['ended-at-midnight', 'ends-now']);
  });

  it('skips a report already settled', async () => {
    mockDocs.set('settled', { report: report({ settled: true }) });
    mockDocs.set('open', { report: report() });

    const summary = await runPlanSettle(NOW);

    expect(summary).toMatchObject({ candidates: 1, sent: 1, settled: 1 });
    expect(mockStamp).toHaveBeenCalledTimes(1);
    expect(mockStamp).toHaveBeenCalledWith('open', NOW.getTime());
    expect(sentEntries().map(({ siteId }) => siteId)).toEqual(['open']);
    expect(savedReport('settled')).toEqual(report({ settled: true }));
  });

  it('leaves out a report counted from its period end or later: the trial covered the whole period', async () => {
    mockDocs.set('trial-covered', { report: report({ countedFrom: PERIOD_END, machines: 0 }) });
    mockDocs.set('open', { report: report() });

    const summary = await runPlanSettle(NOW);

    expect(summary).toMatchObject({ candidates: 1, sent: 1, settled: 1 });
    expect(sentEntries().map(({ siteId }) => siteId)).toEqual(['open']);
    expect(savedReport('trial-covered')).toEqual(report({ countedFrom: PERIOD_END, machines: 0 }));
  });

  it('calls nothing of tridant id when no report waits', async () => {
    mockDocs.set('settled', { report: report({ settled: true }) });

    expect(await runPlanSettle(NOW)).toEqual({ ok: true, candidates: 0, sent: 0, settled: 0, errors: 0 });
    expect(mockReportUsage).not.toHaveBeenCalled();
  });

  it('stamps, then recounts from the saved start to the period’s last millisecond with the saved floor', async () => {
    const trialEnd = Date.UTC(2026, 9, 15);
    mockDocs.set('pro-small', { report: report({ floor: 3 }) });
    mockDocs.set('pro-big', { report: report({ floor: 3 }) });
    mockDocs.set('core', { report: report({ countedFrom: trialEnd }) });
    mockCount.mockImplementation(async (siteId: string) => ({ 'pro-small': 1, 'pro-big': 5, core: 2 })[siteId]);

    await runPlanSettle(NOW);

    for (const siteId of ['pro-small', 'pro-big', 'core']) {
      expect(mockStamp).toHaveBeenCalledWith(siteId, NOW.getTime());
      const stampOrder = mockStamp.mock.invocationCallOrder[mockStamp.mock.calls.findIndex(([id]) => id === siteId)];
      const countOrder = mockCount.mock.invocationCallOrder[mockCount.mock.calls.findIndex(([id]) => id === siteId)];
      expect(stampOrder).toBeLessThan(countOrder);
    }
    expect(mockCount).toHaveBeenCalledWith('pro-small', PERIOD_START, LAST_MS);
    expect(mockCount).toHaveBeenCalledWith('core', trialEnd, LAST_MS);
    expect(mockReportUsage).toHaveBeenCalledTimes(1);
    expect(sentEntries()).toEqual([
      { siteId: 'pro-small', machines: 3, asOfMs: LAST_MS },
      { siteId: 'pro-big', machines: 5, asOfMs: LAST_MS },
      { siteId: 'core', machines: 2, asOfMs: LAST_MS },
    ]);
  });

  it('sends each entry as of its own period’s last millisecond', async () => {
    const otherEnd = NOW.getTime() - 2 * HOUR_MS;
    mockDocs.set('a', { report: report() });
    mockDocs.set('b', { report: report({ periodEnd: otherEnd }) });

    await runPlanSettle(NOW);

    expect(mockReportUsage).toHaveBeenCalledWith(
      [
        { siteId: 'a', machines: 2, asOfMs: LAST_MS },
        { siteId: 'b', machines: 2, asOfMs: otherEnd - 1 },
      ],
      NOW.getTime(),
    );
  });

  it('saves each outcome onto the report and leaves the rest of it', async () => {
    mockDocs.set('recorded', { report: report({ status: 'unreachable', recorded: false }), other: 'kept' });
    mockDocs.set('stale', { report: report() });
    mockDocs.set('unanswered', { report: report() });
    mockCount.mockResolvedValue(4);
    answers({
      stale: { status: 'stale', recorded: false, settling: false, settlesAt: null, periodStart: null, periodEnd: null },
      unanswered: { status: 'unreachable', recorded: false, settling: false, settlesAt: null, periodStart: null, periodEnd: null },
    });

    const summary = await runPlanSettle(NOW);

    expect(summary).toEqual({ ok: true, candidates: 3, sent: 3, settled: 2, errors: 0 });
    // status, recorded, machines and asOf now describe the resend; the period and count basis stay.
    expect(mockDocs.get('recorded')).toEqual({
      report: report({ status: 'recorded', recorded: true, settled: true, machines: 4, asOf: LAST_MS, settlesAt: SETTLES_AT }),
      other: 'kept',
    });
    expect(savedReport('stale')).toEqual(
      report({ status: 'stale', recorded: false, settled: true, machines: 4, asOf: LAST_MS, settlesAt: null }),
    );
    expect(savedReport('unanswered')).toEqual(
      report({ status: 'unreachable', recorded: false, settled: false, machines: 4, asOf: LAST_MS, settlesAt: null }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      '[plan-settle] usage not settled',
      expect.objectContaining({ data: { siteId: 'unanswered', status: 'unreachable' } }),
    );
  });

  it('settles a site whose billing ended with the period: the daily run already billed it', async () => {
    mockDocs.set('stopped', { report: report() });
    answers({ stopped: { status: 'site_not_billed', recorded: false, settling: false, settlesAt: null, periodStart: null, periodEnd: null } });

    const summary = await runPlanSettle(NOW);

    expect(summary).toMatchObject({ sent: 1, settled: 1, errors: 0 });
    expect(savedReport('stopped')).toMatchObject({ settled: true, status: 'site_not_billed' });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs a period tridant id already closed at error and leaves it unsettled', async () => {
    mockDocs.set('late', { report: report() });
    answers({ late: { status: 'period_closed', recorded: false, settling: false, settlesAt: null, periodStart: null, periodEnd: null } });

    const summary = await runPlanSettle(NOW);

    expect(summary).toMatchObject({ sent: 1, settled: 0, errors: 0 });
    expect(savedReport('late')).toMatchObject({ settled: false, status: 'period_closed' });
    expect(logger.error).toHaveBeenCalledWith(
      '[plan-settle] period closed before the resend',
      expect.objectContaining({ data: { siteId: 'late', status: 'period_closed' } }),
    );
  });

  it('counts a call that failed outright as one error and settles nothing', async () => {
    mockDocs.set('a', { report: report() });
    mockDocs.set('b', { report: report() });
    mockReportUsage.mockResolvedValue({ ok: false, reason: 'not_configured' });

    const summary = await runPlanSettle(NOW);

    expect(summary).toEqual({ ok: true, candidates: 2, sent: 2, settled: 0, errors: 1 });
    expect(savedReport('a')).toEqual(report());
    expect(logger.error).toHaveBeenCalledWith(
      '[plan-settle] usage report failed',
      expect.objectContaining({ data: { reason: 'not_configured', sites: 2 } }),
    );
  });

  it('does not send a site whose stamp or count failed, and sends the others', async () => {
    mockDocs.set('stamp-fails', { report: report() });
    mockDocs.set('count-fails', { report: report() });
    mockDocs.set('ok', { report: report() });
    mockStamp.mockImplementation(async (siteId: string) => {
      if (siteId === 'stamp-fails') throw new Error('machines read failed');
      return 1;
    });
    mockCount.mockImplementation(async (siteId: string) => {
      if (siteId === 'count-fails') throw new Error('days read failed');
      return 2;
    });

    const summary = await runPlanSettle(NOW);

    expect(summary).toEqual({ ok: true, candidates: 3, sent: 1, settled: 1, errors: 2 });
    expect(sentEntries().map(({ siteId }) => siteId)).toEqual(['ok']);
    expect(savedReport('stamp-fails')).toEqual(report());
    expect(logger.error).toHaveBeenCalledWith(
      '[plan-settle] recount failed',
      expect.objectContaining({ data: { siteId: 'stamp-fails', error: 'machines read failed' } }),
    );
  });

  it('does not send a report missing what the recount needs', async () => {
    mockDocs.set('malformed', { report: report({ countedFrom: null }) });
    mockDocs.set('ok', { report: report() });

    const summary = await runPlanSettle(NOW);

    expect(summary).toMatchObject({ candidates: 2, sent: 1, errors: 1 });
    expect(mockStamp).not.toHaveBeenCalledWith('malformed', expect.anything());
  });

  it('counts an outcome it could not save as one error and saves the others', async () => {
    mockDocs.set('a', { report: report() });
    mockDocs.set('b', { report: report() });
    mockFailUpdates.add('a');

    const summary = await runPlanSettle(NOW);

    expect(summary).toEqual({ ok: true, candidates: 2, sent: 2, settled: 2, errors: 1 });
    expect(savedReport('b')).toMatchObject({ settled: true });
  });

  it('logs its summary', async () => {
    mockDocs.set('a', { report: report() });

    const summary = await runPlanSettle(NOW);

    expect(logger.info).toHaveBeenCalledWith('[plan-settle] done', { context: 'planSettle', data: summary });
  });
});
