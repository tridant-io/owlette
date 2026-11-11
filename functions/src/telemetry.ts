/**
 * Telemetry pipeline + per-tenant cost attribution.
 *
 *   recordUsageEvent   — HTTPS. Callers POST a UsageEvent for a billable R2
 *                        operation; written to the per-site events subcollection.
 *   aggregateTelemetry — scheduled 04:30 UTC. Folds each site's window into
 *                        UsageCounters, computes cost, writes a daily rollup doc
 *                        and emits an OTLP log record.
 *   getUsageSummary    — HTTPS. Current-month counters + projected cost.
 *
 * OTLP records go out as structured JSON on stderr (`console.error` in GCP maps to
 * Cloud Logging with severity + jsonPayload); a collector sidecar (wave 0.6)
 * forwards them to the eventual OTLP backend.
 */

import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { requireInternalSecret } from './lib/requireInternalSecret';
import {
  aggregateCounters,
  buildEmptyRecord,
  buildUsageRecord,
  computeCost,
  monthFractionElapsed,
  type CostBreakdown,
  type OtlpTelemetryRecord,
  type UsageCounters,
  type UsageEvent,
  type UsageEventKind,
} from './lib/telemetryLogic';

const FIRESTORE_BATCH_LIMIT = 400;

export interface EventStore {
  /** Persist a raw usage event. Called by `recordUsageEvent`. */
  append(event: UsageEvent): Promise<void>;
  /** All events for `siteId` in `[startMs, endMs)`; aggregator iterates daily windows. */
  readWindow(
    siteId: string,
    startMs: number,
    endMs: number,
  ): Promise<UsageEvent[]>;
  /** Delete events older than `cutoffMs` so the collection doesn't grow forever. */
  trimOlderThan(siteId: string, cutoffMs: number): Promise<number>;
}

export interface SummaryStore {
  /** Write a daily rollup + update the month-to-date running total. */
  writeDailyRollup(
    siteId: string,
    dayIso: string, // '2026-04-19'
    counters: UsageCounters,
    cost: CostBreakdown,
  ): Promise<void>;
  /** Fetch the current month-to-date summary for the dashboard. */
  readMonthToDate(
    siteId: string,
    yyyyMm: string, // '2026-04'
  ): Promise<{ counters: UsageCounters; cost: CostBreakdown } | null>;
}

export interface SiteDirectory {
  listSiteIds(): Promise<string[]>;
}

export type OtlpExporter = (record: OtlpTelemetryRecord) => void;

export interface RecordEventDeps {
  store: EventStore;
  now?: () => Date;
}

/**
 * Validate + persist a usage event. Returns 400 on malformed input so
 * a broken caller doesn't silently corrupt the billing data.
 */
export async function recordEvent(
  raw: Partial<UsageEvent>,
  deps: RecordEventDeps,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const now = deps.now ? deps.now() : new Date();

  if (!raw.siteId || typeof raw.siteId !== 'string') {
    return { ok: false, reason: 'siteId_required' };
  }
  if (!isUsageEventKind(raw.kind)) {
    return { ok: false, reason: 'invalid_kind' };
  }

  const count =
    raw.kind === 'class_a_op' || raw.kind === 'class_b_op'
      ? Math.max(0, Math.floor(raw.count ?? 1))
      : undefined;

  const bytes =
    raw.kind === 'egress' || raw.kind === 'storage_snapshot'
      ? Math.max(0, Math.floor(raw.bytes ?? 0))
      : undefined;

  const event: UsageEvent = {
    siteId: raw.siteId,
    kind: raw.kind,
    count,
    bytes,
    timestamp:
      typeof raw.timestamp === 'number' && isFinite(raw.timestamp)
        ? raw.timestamp
        : now.getTime(),
  };

  await deps.store.append(event);
  return { ok: true };
}

function isUsageEventKind(x: unknown): x is UsageEventKind {
  return (
    x === 'class_a_op' ||
    x === 'class_b_op' ||
    x === 'egress' ||
    x === 'storage_snapshot'
  );
}

export interface AggregateDeps {
  directory: SiteDirectory;
  events: EventStore;
  summaries: SummaryStore;
  exporter: OtlpExporter;
  now?: () => Date;
  /** How many days of events to retain after aggregation. */
  retentionDays?: number;
}

export interface AggregateResult {
  siteId: string;
  dayIso: string;
  counters: UsageCounters;
  cost: CostBreakdown;
  eventsAggregated: number;
  eventsTrimmed: number;
}

/** Aggregate yesterday's events into a rollup doc + OTLP record. */
export async function aggregateOneSite(
  siteId: string,
  deps: AggregateDeps,
): Promise<AggregateResult> {
  const now = deps.now ? deps.now() : new Date();
  const retentionDays = deps.retentionDays ?? 7;

  // "yesterday" in UTC — the window we're closing out on this run.
  const endOfYesterday = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const startOfYesterday = endOfYesterday - 24 * 60 * 60 * 1000;
  const dayIso = new Date(startOfYesterday).toISOString().slice(0, 10);

  const events = await deps.events.readWindow(
    siteId,
    startOfYesterday,
    endOfYesterday,
  );
  const counters = aggregateCounters(events);

  // cost.storage is pro-rated to a single day (1 / days-in-month), so this is the
  // storage fee allocated to yesterday.
  const storageDaysInMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const perDayFraction = 1 / storageDaysInMonth;
  const cost = computeCost({
    counters,
    monthFractionElapsed: perDayFraction,
  });

  const record = events.length === 0
    ? buildEmptyRecord(siteId, 'no_events_in_window', now)
    : buildUsageRecord(siteId, counters, cost, now);
  deps.exporter(record);

  if (events.length > 0) {
    await deps.summaries.writeDailyRollup(siteId, dayIso, counters, cost);
  }

  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const eventsTrimmed = await deps.events.trimOlderThan(siteId, cutoff);

  return {
    siteId,
    dayIso,
    counters,
    cost,
    eventsAggregated: events.length,
    eventsTrimmed,
  };
}

export async function aggregateAllSites(
  deps: AggregateDeps,
): Promise<AggregateResult[]> {
  const siteIds = await deps.directory.listSiteIds();
  const results: AggregateResult[] = [];
  for (const siteId of siteIds) {
    try {
      results.push(await aggregateOneSite(siteId, deps));
    } catch (err) {
      console.error(
        `[telemetry] aggregate failed for ${siteId}: ${
          (err as Error).message
        }`,
      );
    }
  }
  return results;
}

export interface GetSummaryDeps {
  summaries: SummaryStore;
  now?: () => Date;
}

export interface UsageSummaryResponse {
  siteId: string;
  yyyyMm: string;
  counters: UsageCounters;
  cost: CostBreakdown;
  /** Projected full-month total if current run-rate continues. */
  projectedMonthCost: CostBreakdown;
}

/**
 * Month-to-date usage + costs, plus a naive linear projection for the full month.
 */
export async function getUsageSummary(
  siteId: string,
  deps: GetSummaryDeps,
): Promise<UsageSummaryResponse | null> {
  const now = deps.now ? deps.now() : new Date();
  const yyyyMm = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}`;
  const mtd = await deps.summaries.readMonthToDate(siteId, yyyyMm);
  if (!mtd) return null;

  const f = monthFractionElapsed(now);
  // project: MTD / elapsed-fraction, with a floor of MTD itself so a
  // start-of-month fetch doesn't report an absurd projection.
  const projectedMonthCost: CostBreakdown =
    f <= 0
      ? mtd.cost
      : {
          storageUsd: Math.max(mtd.cost.storageUsd, mtd.cost.storageUsd / f),
          classAUsd: Math.max(mtd.cost.classAUsd, mtd.cost.classAUsd / f),
          classBUsd: Math.max(mtd.cost.classBUsd, mtd.cost.classBUsd / f),
          egressUsd: Math.max(mtd.cost.egressUsd, mtd.cost.egressUsd / f),
          totalUsd: Math.max(mtd.cost.totalUsd, mtd.cost.totalUsd / f),
        };

  return {
    siteId,
    yyyyMm,
    counters: mtd.counters,
    cost: mtd.cost,
    projectedMonthCost,
  };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export const aggregateTelemetry = onSchedule(
  { schedule: '30 4 * * *', timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    const results = await aggregateAllSites({
      directory: getDefaultDirectory(),
      events: getDefaultEventStore(),
      summaries: getDefaultSummaryStore(),
      exporter: otlpExporterToStderr,
    });
    const totalCost = results.reduce((s, r) => s + r.cost.totalUsd, 0);
    console.log(
      `[telemetry] aggregate complete: sites=${results.length} total_cost_usd=${totalCost.toFixed(4)}`,
    );
  },
);

export const recordUsageEvent = onRequest(
  { timeoutSeconds: 10, memory: '256MiB' },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }
    if (!requireInternalSecret(req, res)) return;
    const result = await recordEvent(
      (req.body ?? {}) as Partial<UsageEvent>,
      { store: getDefaultEventStore() },
    );
    if (!result.ok) {
      res.status(400).json({ error: result.reason });
      return;
    }
    res.status(204).send();
  },
);

/**
 * Per-tenant cost data — verify the caller can access `siteId` first, or any HTTPS
 * caller could enumerate cost figures for sites they don't belong to. Allowed: a
 * superadmin, or a user holding an ACTIVE, whole-site `sites/{siteId}/members/{uid}`
 * row. A single 401 covers both "no token" and "no access" so the endpoint can't be
 * used to probe which siteIds an attacker has access to.
 *
 * cost data is site-wide, so a scoped member gets that same 401: any `machineIds`
 * on the row, even `[]` or a malformed value, means not whole site, as the rules'
 * memberIsWholeSite() reads it.
 *
 * Reads the member row, not `users/{uid}.sites[]`. That array is legacy and wave
 * 6.1 deletes it; this endpoint is deployed and public, and it was the only
 * authorization check standing in front of every site's cost figures. It would
 * have failed closed rather than open, but it would still have locked every
 * non-superadmin out of their own usage data the moment the migration ran.
 *
 * A direct document get, deliberately — no collection-group query, so no index
 * dependency in a Cloud Function that has no way to report a missing one.
 */
export interface SiteUsageAuthDeps {
  verifyIdToken: (token: string) => Promise<{ uid: string }>;
  getUser: (uid: string) => Promise<Record<string, unknown> | null>;
  getMember: (siteId: string, uid: string) => Promise<Record<string, unknown> | null>;
}

/** Real Firebase implementations. Injected in tests, which is why they are a parameter. */
function defaultSiteUsageAuthDeps(): SiteUsageAuthDeps {
  return {
    verifyIdToken: (token) => getAuth().verifyIdToken(token),
    getUser: async (uid) => {
      const snap = await getFirestore().collection('users').doc(uid).get();
      return snap.exists ? (snap.data() ?? {}) : null;
    },
    getMember: async (siteId, uid) => {
      const snap = await getFirestore()
        .collection('sites')
        .doc(siteId)
        .collection('members')
        .doc(uid)
        .get();
      return snap.exists ? (snap.data() ?? {}) : null;
    },
  };
}

export async function isAuthorizedForSiteUsage(
  authorizationHeader: string | undefined,
  siteId: string,
  deps: SiteUsageAuthDeps = defaultSiteUsageAuthDeps(),
): Promise<boolean> {
  const token = (authorizationHeader ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  let uid: string;
  try {
    ({ uid } = await deps.verifyIdToken(token));
  } catch {
    return false;
  }
  try {
    const user = await deps.getUser(uid);
    if (!user) return false;
    // A soft-deleted account keeps a valid token until it expires.
    if (user.deletedAt) return false;
    if (user.role === 'superadmin') return true;

    const member = await deps.getMember(siteId, uid);
    return (
      member !== null &&
      member.status === 'active' &&
      !Object.prototype.hasOwnProperty.call(member, 'machineIds')
    );
  } catch {
    return false;
  }
}

export const getUsageSummaryHttp = onRequest(
  { timeoutSeconds: 15, memory: '256MiB' },
  async (req, res) => {
    const siteId = String(req.query.siteId ?? '');
    if (!siteId) {
      res.status(400).json({ error: 'siteId_required' });
      return;
    }
    const authorized = await isAuthorizedForSiteUsage(
      req.headers.authorization,
      siteId,
    );
    if (!authorized) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const summary = await getUsageSummary(siteId, {
      summaries: getDefaultSummaryStore(),
    });
    if (!summary) {
      res.status(404).json({ error: 'no_data_yet' });
      return;
    }
    res.status(200).json(summary);
  },
);

function getDefaultDirectory(): SiteDirectory {
  const db = getFirestore();
  return {
    async listSiteIds() {
      const snap = await db.collection('sites').listDocuments();
      return snap.map((d) => d.id);
    },
  };
}

function getDefaultEventStore(): EventStore {
  const db = getFirestore();
  const col = (siteId: string) =>
    db.collection('sites').doc(siteId).collection('usage_events');

  return {
    async append(event: UsageEvent) {
      await col(event.siteId).add({
        ...event,
        timestamp: Timestamp.fromMillis(event.timestamp),
      });
    },
    async readWindow(siteId, startMs, endMs) {
      const snap = await col(siteId)
        .where('timestamp', '>=', Timestamp.fromMillis(startMs))
        .where('timestamp', '<', Timestamp.fromMillis(endMs))
        .get();
      return snap.docs.map((d) => {
        const data = d.data() as UsageEvent;
        // Events persisted via `append()` always carry a Timestamp; fall back to
        // Number() for a legacy numeric value.
        const raw: unknown = (data as unknown as Record<string, unknown>).timestamp;
        const ts =
          raw && typeof (raw as { toMillis?: unknown }).toMillis === 'function'
            ? (raw as Timestamp).toMillis()
            : Number(raw);
        return { ...data, timestamp: ts };
      });
    },
    async trimOlderThan(siteId, cutoffMs) {
      const snap = await col(siteId)
        .where('timestamp', '<', Timestamp.fromMillis(cutoffMs))
        .get();
      if (snap.empty) return 0;
      let batch = db.batch();
      let opsInBatch = 0;
      for (const d of snap.docs) {
        batch.delete(d.ref);
        opsInBatch += 1;
        if (opsInBatch >= FIRESTORE_BATCH_LIMIT) {
          await batch.commit();
          batch = db.batch();
          opsInBatch = 0;
        }
      }
      if (opsInBatch > 0) {
        await batch.commit();
      }
      return snap.size;
    },
  };
}

function getDefaultSummaryStore(): SummaryStore {
  const db = getFirestore();
  const monthDoc = (siteId: string, yyyyMm: string) =>
    db
      .collection('sites')
      .doc(siteId)
      .collection('usage_summaries')
      .doc(yyyyMm);

  return {
    async writeDailyRollup(siteId, dayIso, counters, cost) {
      const yyyyMm = dayIso.slice(0, 7);
      const ref = monthDoc(siteId, yyyyMm);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const prior = snap.exists
          ? (snap.data() as { counters: UsageCounters; cost: CostBreakdown })
          : null;
        const nextCounters: UsageCounters = {
          storageBytes: counters.storageBytes, // latest day's avg — dashboard shows "current"
          classAOps: (prior?.counters.classAOps ?? 0) + counters.classAOps,
          classBOps: (prior?.counters.classBOps ?? 0) + counters.classBOps,
          egressBytes: (prior?.counters.egressBytes ?? 0) + counters.egressBytes,
        };
        const nextCost: CostBreakdown = {
          storageUsd: (prior?.cost.storageUsd ?? 0) + cost.storageUsd,
          classAUsd: (prior?.cost.classAUsd ?? 0) + cost.classAUsd,
          classBUsd: (prior?.cost.classBUsd ?? 0) + cost.classBUsd,
          egressUsd: (prior?.cost.egressUsd ?? 0) + cost.egressUsd,
          totalUsd: (prior?.cost.totalUsd ?? 0) + cost.totalUsd,
        };
        tx.set(
          ref,
          {
            counters: nextCounters,
            cost: nextCost,
            lastDayRolledUp: dayIso,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      });
    },
    async readMonthToDate(siteId, yyyyMm) {
      const snap = await monthDoc(siteId, yyyyMm).get();
      if (!snap.exists) return null;
      const data = snap.data() as {
        counters: UsageCounters;
        cost: CostBreakdown;
      };
      return { counters: data.counters, cost: data.cost };
    },
  };
}

/**
 * OTLP exporter: one JSON line on stderr. Cloud Logging ingests it with severity
 * + jsonPayload; an OTEL collector sidecar (wave 0.6) forwards OTLP-native on.
 */
export function otlpExporterToStderr(record: OtlpTelemetryRecord): void {
  // Cloud Logging parses the JSON automatically when it is the whole line.
  const line = JSON.stringify(record);
  if (record.severity === 'ERROR') console.error(line);
  else if (record.severity === 'WARN') console.warn(line);
  else console.log(line);
}
