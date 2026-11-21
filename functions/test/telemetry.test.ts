/** Unit tests for roost telemetry + per-tenant cost attribution. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateCounters,
  buildEmptyRecord,
  buildUsageRecord,
  computeCost,
  monthFractionElapsed,
  R2_CLASS_A_USD_PER_M,
  R2_CLASS_B_USD_PER_M,
  R2_STORAGE_USD_PER_GB_MONTH,
  type OtlpTelemetryRecord,
  type UsageEvent,
} from '../src/lib/telemetryLogic';
import {
  aggregateOneSite,
  getUsageSummary,
  isAuthorizedForSiteUsage,
  recordEvent,
  type AggregateDeps,
  type EventStore,
  type SiteDirectory,
  type SiteUsageAuthDeps,
  type SummaryStore,
} from '../src/telemetry';

const GB = 1024 ** 3;

describe('computeCost', () => {
  it('zero counters → zero cost', () => {
    const c = computeCost({
      counters: { storageBytes: 0, classAOps: 0, classBOps: 0, egressBytes: 0 },
      monthFractionElapsed: 1,
    });
    assert.equal(c.totalUsd, 0);
  });

  it('1 GB for a full month → $0.015', () => {
    const c = computeCost({
      counters: { storageBytes: 1 * GB, classAOps: 0, classBOps: 0, egressBytes: 0 },
      monthFractionElapsed: 1,
    });
    assert.ok(Math.abs(c.storageUsd - R2_STORAGE_USD_PER_GB_MONTH) < 1e-9);
  });

  it('1 GB for half a month → half price', () => {
    const c = computeCost({
      counters: { storageBytes: 1 * GB, classAOps: 0, classBOps: 0, egressBytes: 0 },
      monthFractionElapsed: 0.5,
    });
    assert.ok(Math.abs(c.storageUsd - R2_STORAGE_USD_PER_GB_MONTH * 0.5) < 1e-9);
  });

  it('1 M class-A ops → $4.50', () => {
    const c = computeCost({
      counters: {
        storageBytes: 0,
        classAOps: 1_000_000,
        classBOps: 0,
        egressBytes: 0,
      },
      monthFractionElapsed: 1,
    });
    assert.equal(c.classAUsd, R2_CLASS_A_USD_PER_M);
  });

  it('1 M class-B ops → $0.36', () => {
    const c = computeCost({
      counters: {
        storageBytes: 0,
        classAOps: 0,
        classBOps: 1_000_000,
        egressBytes: 0,
      },
      monthFractionElapsed: 1,
    });
    assert.equal(c.classBUsd, R2_CLASS_B_USD_PER_M);
  });

  it('egress is $0 (R2 headline feature)', () => {
    const c = computeCost({
      counters: {
        storageBytes: 0,
        classAOps: 0,
        classBOps: 0,
        egressBytes: 100 * GB,
      },
      monthFractionElapsed: 1,
    });
    assert.equal(c.egressUsd, 0);
  });

  it('ops are NOT pro-rated by month fraction', () => {
    // Ops cost the same whether the month is 1% or 99% elapsed.
    const c = computeCost({
      counters: {
        storageBytes: 0,
        classAOps: 1_000_000,
        classBOps: 0,
        egressBytes: 0,
      },
      monthFractionElapsed: 0.01,
    });
    assert.equal(c.classAUsd, R2_CLASS_A_USD_PER_M);
  });

  it('clamps negative / infinite / NaN monthFraction to 0', () => {
    const cNeg = computeCost({
      counters: { storageBytes: 1 * GB, classAOps: 0, classBOps: 0, egressBytes: 0 },
      monthFractionElapsed: -1,
    });
    const cBig = computeCost({
      counters: { storageBytes: 1 * GB, classAOps: 0, classBOps: 0, egressBytes: 0 },
      monthFractionElapsed: 99,
    });
    const cNan = computeCost({
      counters: { storageBytes: 1 * GB, classAOps: 0, classBOps: 0, egressBytes: 0 },
      monthFractionElapsed: NaN,
    });
    assert.equal(cNeg.storageUsd, 0);
    // 99 clamps to 1.
    assert.ok(
      Math.abs(cBig.storageUsd - R2_STORAGE_USD_PER_GB_MONTH) < 1e-9,
    );
    assert.equal(cNan.storageUsd, 0);
  });
});

describe('monthFractionElapsed', () => {
  it('≈0 at the first second of a month', () => {
    const f = monthFractionElapsed(new Date('2026-04-01T00:00:00Z'));
    assert.equal(f, 0);
  });

  it('≈1 at end of month', () => {
    // 30-day month (april), last microsecond.
    const f = monthFractionElapsed(new Date('2026-04-30T23:59:59.999Z'));
    assert.ok(f > 0.999);
  });

  it('halfway through → ~0.5', () => {
    const f = monthFractionElapsed(new Date('2026-04-15T12:00:00Z'));
    // 30-day april, day 15 noon = 14.5/30 = 0.4833…
    assert.ok(f > 0.48 && f < 0.49);
  });
});

function evt(kind: UsageEvent['kind'], count?: number, bytes?: number): UsageEvent {
  return { siteId: 's', kind, count, bytes, timestamp: 0 };
}

describe('aggregateCounters', () => {
  it('sums class-A / class-B ops', () => {
    const c = aggregateCounters([
      evt('class_a_op', 3),
      evt('class_a_op', 2),
      evt('class_b_op', 1),
      evt('class_b_op', 4),
    ]);
    assert.equal(c.classAOps, 5);
    assert.equal(c.classBOps, 5);
  });

  it('defaults op count to 1 when omitted', () => {
    const c = aggregateCounters([evt('class_a_op'), evt('class_a_op')]);
    assert.equal(c.classAOps, 2);
  });

  it('sums egress bytes', () => {
    const c = aggregateCounters([
      evt('egress', undefined, 100),
      evt('egress', undefined, 200),
    ]);
    assert.equal(c.egressBytes, 300);
  });

  it('averages storage snapshots (GB-day accounting)', () => {
    // 100 GB + 1 GB across two snapshots = avg 50.5 GB.
    const c = aggregateCounters([
      evt('storage_snapshot', undefined, 100 * GB),
      evt('storage_snapshot', undefined, 1 * GB),
    ]);
    assert.equal(c.storageBytes, (100 * GB + 1 * GB) / 2);
  });

  it('zero storage when no snapshots (not NaN)', () => {
    const c = aggregateCounters([evt('class_a_op')]);
    assert.equal(c.storageBytes, 0);
  });
});

describe('buildUsageRecord', () => {
  const fixedNow = new Date('2026-04-20T12:00:00Z');
  const counters = {
    storageBytes: 10 * GB,
    classAOps: 1000,
    classBOps: 500,
    egressBytes: 0,
  };
  const cost = computeCost({
    counters,
    monthFractionElapsed: 1 / 30,
  });

  it('emits OTLP-shaped record', () => {
    const r = buildUsageRecord('site-a', counters, cost, fixedNow);
    assert.equal(r.name, 'roost.usage.daily');
    assert.equal(r.severity, 'INFO');
    assert.equal(r.siteId, 'site-a');
    assert.equal(r.timestamp, fixedNow.toISOString());
    assert.equal(r.attributes['tenant.id'], 'site-a');
    assert.equal(r.attributes['usage.storage_bytes'], 10 * GB);
    assert.equal(r.attributes['cost.total_usd'], cost.totalUsd);
  });

  it('empty record signals skipped / no-data days', () => {
    const r = buildEmptyRecord('site-a', 'no_events_in_window', fixedNow);
    assert.equal(r.name, 'roost.usage.skipped');
    assert.equal(r.attributes.reason, 'no_events_in_window');
  });
});

function makeEventStore(): EventStore & { appended: UsageEvent[] } {
  const appended: UsageEvent[] = [];
  return {
    appended,
    async append(e) { appended.push(e); },
    async readWindow() { return []; },
    async trimOlderThan() { return 0; },
  };
}

describe('recordEvent', () => {
  it('accepts a valid class-A op', async () => {
    const store = makeEventStore();
    const r = await recordEvent(
      { siteId: 's', kind: 'class_a_op', count: 3 },
      { store, now: () => new Date(0) },
    );
    assert.equal(r.ok, true);
    assert.equal(store.appended.length, 1);
    assert.equal(store.appended[0].count, 3);
  });

  it('rejects missing siteId', async () => {
    const store = makeEventStore();
    const r = await recordEvent({ kind: 'class_a_op' }, { store });
    assert.equal(r.ok, false);
    assert.equal(store.appended.length, 0);
  });

  it('rejects unknown kind', async () => {
    const store = makeEventStore();
    const r = await recordEvent(
      { siteId: 's', kind: 'garbage' as never },
      { store },
    );
    assert.equal(r.ok, false);
  });

  it('floors negative/fractional counts to 0 / integer', async () => {
    const store = makeEventStore();
    await recordEvent(
      { siteId: 's', kind: 'class_a_op', count: -5 },
      { store },
    );
    assert.equal(store.appended[0].count, 0);
    await recordEvent(
      { siteId: 's', kind: 'class_a_op', count: 2.9 },
      { store },
    );
    assert.equal(store.appended[1].count, 2);
  });

  it('stamps timestamp with now() if caller omits', async () => {
    const store = makeEventStore();
    const fixedNow = new Date('2026-04-20T00:00:00Z');
    await recordEvent(
      { siteId: 's', kind: 'class_b_op' },
      { store, now: () => fixedNow },
    );
    assert.equal(store.appended[0].timestamp, fixedNow.getTime());
  });
});

interface AggState {
  events: UsageEvent[];
  trimmed: number;
  rollups: Array<{
    siteId: string;
    dayIso: string;
    counters: unknown;
    cost: unknown;
  }>;
  otlp: OtlpTelemetryRecord[];
}

function aggDeps(state: AggState, now: Date): AggregateDeps {
  const directory: SiteDirectory = {
    async listSiteIds() { return ['s']; },
  };
  const events: EventStore = {
    async append(e) { state.events.push(e); },
    async readWindow(_siteId, startMs, endMs) {
      return state.events.filter(
        (e) => e.timestamp >= startMs && e.timestamp < endMs,
      );
    },
    async trimOlderThan(_siteId, cutoffMs) {
      const before = state.events.length;
      state.events = state.events.filter((e) => e.timestamp >= cutoffMs);
      const removed = before - state.events.length;
      state.trimmed += removed;
      return removed;
    },
  };
  const summaries: SummaryStore = {
    async writeDailyRollup(siteId, dayIso, counters, cost) {
      state.rollups.push({ siteId, dayIso, counters, cost });
    },
    async readMonthToDate() { return null; },
  };
  return {
    directory,
    events,
    summaries,
    exporter: (r) => state.otlp.push(r),
    now: () => now,
  };
}

describe('aggregateOneSite', () => {
  it('rolls up yesterday events + emits usage OTLP record', async () => {
    const now = new Date('2026-04-20T04:30:00Z');
    const yesterdayMs = Date.UTC(2026, 3, 19, 12, 0, 0); // April 19 noon UTC
    const state: AggState = {
      events: [
        { siteId: 's', kind: 'class_a_op', count: 5, timestamp: yesterdayMs },
        { siteId: 's', kind: 'class_b_op', count: 10, timestamp: yesterdayMs },
        {
          siteId: 's',
          kind: 'storage_snapshot',
          bytes: 2 * GB,
          timestamp: yesterdayMs,
        },
      ],
      trimmed: 0,
      rollups: [],
      otlp: [],
    };
    const r = await aggregateOneSite('s', aggDeps(state, now));
    assert.equal(r.eventsAggregated, 3);
    assert.equal(r.counters.classAOps, 5);
    assert.equal(r.counters.storageBytes, 2 * GB);
    assert.equal(r.dayIso, '2026-04-19');
    assert.equal(state.rollups.length, 1);
    assert.equal(state.otlp[0].name, 'roost.usage.daily');
  });

  it('emits skipped OTLP record when no events, no rollup written', async () => {
    const now = new Date('2026-04-20T04:30:00Z');
    const state: AggState = {
      events: [],
      trimmed: 0,
      rollups: [],
      otlp: [],
    };
    const r = await aggregateOneSite('s', aggDeps(state, now));
    assert.equal(r.eventsAggregated, 0);
    assert.equal(state.rollups.length, 0);
    assert.equal(state.otlp[0].name, 'roost.usage.skipped');
  });

  it('trims events older than retention window after aggregation', async () => {
    const now = new Date('2026-04-20T04:30:00Z');
    const veryOldMs = now.getTime() - 30 * 24 * 60 * 60 * 1000;
    const state: AggState = {
      events: [
        { siteId: 's', kind: 'class_a_op', timestamp: veryOldMs },
      ],
      trimmed: 0,
      rollups: [],
      otlp: [],
    };
    await aggregateOneSite('s', aggDeps(state, now));
    assert.equal(state.trimmed, 1);
  });
});

describe('getUsageSummary', () => {
  it('returns null when no data exists', async () => {
    const summaries: SummaryStore = {
      async writeDailyRollup() {},
      async readMonthToDate() { return null; },
    };
    const r = await getUsageSummary('s', {
      summaries,
      now: () => new Date('2026-04-15T12:00:00Z'),
    });
    assert.equal(r, null);
  });

  it('projects full-month cost linearly from MTD', async () => {
    // ~14.5 days into a 30-day month → monthFraction ~ 0.483.
    const summaries: SummaryStore = {
      async writeDailyRollup() {},
      async readMonthToDate() {
        return {
          counters: {
            storageBytes: 1 * GB,
            classAOps: 100,
            classBOps: 100,
            egressBytes: 0,
          },
          cost: {
            storageUsd: 0.01,
            classAUsd: 0.10,
            classBUsd: 0.05,
            egressUsd: 0,
            totalUsd: 0.16,
          },
        };
      },
    };
    const r = await getUsageSummary('s', {
      summaries,
      now: () => new Date('2026-04-15T12:00:00Z'),
    });
    assert.ok(r);
    // Projected must never regress below current MTD.
    assert.ok(r!.projectedMonthCost.totalUsd >= r!.cost.totalUsd);
    // Roughly 2x MTD halfway through the month.
    assert.ok(r!.projectedMonthCost.totalUsd > 0.3);
  });
});

describe('isAuthorizedForSiteUsage', () => {
  /**
   * The only authorization check in front of getUsageSummaryHttp, a DEPLOYED
   * public HTTPS endpoint serving every site's cost figures — and it had no test
   * at all until 2026-09-07.
   *
   * It authorized on `users/{uid}.sites[]` until then. Wave 6.1 deletes that
   * field, which would have locked every non-superadmin out of their own usage
   * data. It now reads the member row that actually grants access.
   */
  function deps(overrides: Partial<SiteUsageAuthDeps> = {}): SiteUsageAuthDeps {
    return {
      verifyIdToken: async () => ({ uid: 'user-1' }),
      getUser: async () => ({ role: 'member' }),
      getMember: async () => ({ status: 'active' }),
      ...overrides,
    };
  }

  it('allows an active whole-site member of the site', async () => {
    assert.equal(await isAuthorizedForSiteUsage('Bearer t', 'site-a', deps()), true);
  });

  it('allows a superadmin with no member row', async () => {
    assert.equal(
      await isAuthorizedForSiteUsage('Bearer t', 'site-a', deps({
        getUser: async () => ({ role: 'superadmin' }),
        getMember: async () => null,
      })),
      true,
    );
  });

  // THE regression this rewrite exists to prevent. A user carrying the legacy
  // array but no member row must be refused: the array is not an access grant.
  it('refuses a user with a legacy sites[] entry but no member row', async () => {
    assert.equal(
      await isAuthorizedForSiteUsage('Bearer t', 'site-a', deps({
        getUser: async () => ({ role: 'member', sites: ['site-a'] }),
        getMember: async () => null,
      })),
      false,
    );
  });

  it('refuses a member row that is not active', async () => {
    assert.equal(
      await isAuthorizedForSiteUsage('Bearer t', 'site-a', deps({
        getMember: async () => ({ status: 'revoked' }),
      })),
      false,
    );
  });

  it('refuses a scoped member: cost data is site-wide', async () => {
    assert.equal(
      await isAuthorizedForSiteUsage('Bearer t', 'site-a', deps({
        getMember: async () => ({ status: 'active', machineIds: ['m1'] }),
      })),
      false,
    );
  });

  it('fails closed on an empty or malformed machine scope', async () => {
    for (const machineIds of [[], null]) {
      assert.equal(
        await isAuthorizedForSiteUsage('Bearer t', 'site-a', deps({
          getMember: async () => ({ status: 'active', machineIds }),
        })),
        false,
        `machineIds: ${JSON.stringify(machineIds)}`,
      );
    }
  });

  it('refuses a soft-deleted account holding a still-valid token', async () => {
    assert.equal(
      await isAuthorizedForSiteUsage('Bearer t', 'site-a', deps({
        getUser: async () => ({ role: 'member', deletedAt: 1 }),
      })),
      false,
    );
  });

  it('refuses a missing or malformed bearer token', async () => {
    assert.equal(await isAuthorizedForSiteUsage(undefined, 'site-a', deps()), false);
    assert.equal(await isAuthorizedForSiteUsage('', 'site-a', deps()), false);
  });

  it('refuses when token verification throws', async () => {
    assert.equal(
      await isAuthorizedForSiteUsage('Bearer bad', 'site-a', deps({
        verifyIdToken: async () => {
          throw new Error('invalid token');
        },
      })),
      false,
    );
  });

  it('fails closed when the member lookup throws', async () => {
    assert.equal(
      await isAuthorizedForSiteUsage('Bearer t', 'site-a', deps({
        getMember: async () => {
          throw new Error('firestore unavailable');
        },
      })),
      false,
    );
  });
});
