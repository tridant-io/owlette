/**
 * small readers behind hoot mcp's read tools. each reads the documents the
 * dashboard or the public route reads, the same way, and never writes.
 */

import { FieldPath, type Firestore } from 'firebase-admin/firestore';
import { timestampToMs } from '@/lib/firestoreTime.server';
import { downsampleTimeUniform } from '@/lib/metricsDownsample';
import { formatDayBucketId, formatHourBucketId, DAY_BUCKET_ID_RE, HOUR_BUCKET_ID_RE } from '@/lib/metricsHistoryBuckets';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function machineCollection(db: Firestore, siteId: string, machineId: string, name: string) {
  return db.collection('sites').doc(siteId).collection('machines').doc(machineId).collection(name);
}

// --- metrics history ---

/** the stored sample keys the dashboard's charts read, under the names alert rules use. */
export const HISTORY_METRIC_KEYS = {
  cpu_percent: 'c',
  memory_percent: 'm',
  disk_percent: 'd',
  gpu_percent: 'g',
  cpu_temp: 'ct',
  gpu_temp: 'gt',
} as const;

export type HistoryMetric = keyof typeof HISTORY_METRIC_KEYS;

export const HISTORY_MAX_HOURS = 168;
export const HISTORY_MAX_POINTS = 500;

// firestore's `in` limit
const IN_LIMIT = 30;

export interface MetricsHistory {
  from: string;
  to: string;
  /** samples in the range, before any downsampling. */
  sampleCount: number;
  downsampled: boolean;
  points: Array<Record<string, string | number>>;
}

/** hourly (`YYYY-MM-DD-HH`) and legacy daily (`YYYY-MM-DD`) buckets, as useHistoricalMetrics reads them. */
export async function readMetricsHistory(
  db: Firestore,
  siteId: string,
  machineId: string,
  opts: { hours: number; metrics: readonly HistoryMetric[]; maxPoints: number; now?: number },
): Promise<MetricsHistory> {
  const end = opts.now ?? Date.now();
  const start = end - opts.hours * 60 * 60 * 1000;
  const startSeconds = Math.floor(start / 1000);
  const endSeconds = Math.floor(end / 1000);
  const history = machineCollection(db, siteId, machineId, 'metrics_history');

  const dayIds: string[] = [];
  const day = new Date(start);
  day.setUTCHours(0, 0, 0, 0);
  while (day.getTime() <= end) {
    dayIds.push(formatDayBucketId(day));
    day.setUTCDate(day.getUTCDate() + 1);
  }

  const buckets = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < dayIds.length; i += IN_LIMIT) {
    const snap = await history.where(FieldPath.documentId(), 'in', dayIds.slice(i, i + IN_LIMIT)).get();
    for (const doc of snap.docs) if (DAY_BUCKET_ID_RE.test(doc.id)) buckets.set(doc.id, doc.data());
  }
  const hourSnap = await history
    .where(FieldPath.documentId(), '>=', formatHourBucketId(new Date(start)))
    .where(FieldPath.documentId(), '<=', formatHourBucketId(new Date(end)))
    .orderBy(FieldPath.documentId(), 'asc')
    .get();
  for (const doc of hourSnap.docs) if (HOUR_BUCKET_ID_RE.test(doc.id)) buckets.set(doc.id, doc.data());

  const all: Array<{ time: number; values: Record<string, number> }> = [];
  for (const bucket of buckets.values()) {
    if (!Array.isArray(bucket.samples)) continue;
    for (const sample of bucket.samples) {
      if (!isRecord(sample) || typeof sample.t !== 'number' || sample.t < startSeconds || sample.t > endSeconds) continue;
      const values: Record<string, number> = {};
      for (const metric of opts.metrics) {
        const value = sample[HISTORY_METRIC_KEYS[metric]];
        if (typeof value === 'number' && Number.isFinite(value)) values[metric] = value;
      }
      all.push({ time: sample.t * 1000, values });
    }
  }
  all.sort((a, b) => a.time - b.time);

  // the dashboard's own time-uniform reduction; it returns at most target + 1 points
  const kept = downsampleTimeUniform(all, Math.max(1, opts.maxPoints - 1), start, end);
  return {
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    sampleCount: all.length,
    downsampled: kept.length < all.length,
    points: kept.map((sample) => ({ time: new Date(sample.time).toISOString(), ...sample.values })),
  };
}

// --- installed software ---

// the most entries one read takes, so a machine with an odd inventory cannot make it unbounded
const SOFTWARE_READ_MAX = 2000;

export interface InstalledSoftware {
  entries: Array<{ name: string; version: string | null; publisher: string | null }>;
  /** entries that matched, before the cap. */
  matched: number;
  /** the inventory was longer than one read takes, so matches may be missing. */
  incomplete: boolean;
}

/** `installed_software` as useUninstall reads it, sorted by name. */
export async function readInstalledSoftware(
  db: Firestore,
  siteId: string,
  machineId: string,
  opts: { limit: number; name?: string },
): Promise<InstalledSoftware> {
  const snap = await machineCollection(db, siteId, machineId, 'installed_software').limit(SOFTWARE_READ_MAX).get();
  const needle = opts.name?.toLowerCase();
  const matches = snap.docs
    .map((doc) => doc.data())
    .filter((data) => typeof data.name === 'string' && (!needle || data.name.toLowerCase().includes(needle)))
    .map((data) => ({
      name: data.name as string,
      version: typeof data.version === 'string' ? data.version : null,
      publisher: typeof data.publisher === 'string' ? data.publisher : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    entries: matches.slice(0, opts.limit),
    matched: matches.length,
    incomplete: snap.size >= SOFTWARE_READ_MAX,
  };
}

// --- alert rules ---

export interface AlertRuleView {
  id: string;
  name: string;
  metric: string;
  operator: string;
  value: number;
  severity: string;
  channels: string[];
  enabled: boolean;
  cooldownMinutes: number;
}

/** `sites/{siteId}/settings/alerts`, `rules`, as the alerts page reads it. */
export async function readAlertRules(db: Firestore, siteId: string): Promise<AlertRuleView[]> {
  const snap = await db.collection('sites').doc(siteId).collection('settings').doc('alerts').get();
  const rules = snap.exists ? snap.data()?.rules : null;
  if (!Array.isArray(rules)) return [];

  const views: AlertRuleView[] = [];
  for (const rule of rules) {
    if (!isRecord(rule) || typeof rule.id !== 'string' || typeof rule.name !== 'string') continue;
    views.push({
      id: rule.id,
      name: rule.name,
      metric: String(rule.metric ?? ''),
      operator: String(rule.operator ?? ''),
      value: typeof rule.value === 'number' ? rule.value : 0,
      severity: String(rule.severity ?? ''),
      channels: Array.isArray(rule.channels) ? rule.channels.filter((c): c is string => typeof c === 'string') : [],
      enabled: rule.enabled === true,
      cooldownMinutes: typeof rule.cooldownMinutes === 'number' ? rule.cooldownMinutes : 0,
    });
  }
  return views;
}

// --- audit log ---

export const AUDIT_DEFAULT_LIMIT = 50;
export const AUDIT_MAX_LIMIT = 200;

export interface AuditRecord {
  hash: string;
  kind: string;
  actor: string;
  target: string | null;
  occurredAt: number | null;
  recordedAt: number | null;
  attributes: Record<string, unknown>;
}

/** `sites/{siteId}/audit_log`, newest `recordedAt` first, as the public route reads it. */
export async function readAuditLog(
  db: Firestore,
  siteId: string,
  opts: { limit: number; sinceMs?: number },
): Promise<AuditRecord[]> {
  const col = db.collection('sites').doc(siteId).collection('audit_log');
  let query = col.orderBy('recordedAt', 'desc').limit(opts.limit);
  if (typeof opts.sinceMs === 'number') {
    query = col.where('recordedAt', '>=', opts.sinceMs).orderBy('recordedAt', 'desc').limit(opts.limit);
  }
  const snap = await query.get();
  return snap.docs.map((doc): AuditRecord => {
    const data = doc.data();
    const event = isRecord(data.event) ? data.event : {};
    return {
      hash: doc.id,
      kind: typeof event.kind === 'string' ? event.kind : 'unknown',
      actor: typeof event.actor === 'string' ? event.actor : '',
      target: typeof event.target === 'string' ? event.target : null,
      occurredAt: typeof event.occurredAt === 'number' ? event.occurredAt : null,
      recordedAt: timestampToMs(data.recordedAt),
      attributes: isRecord(event.attributes) ? event.attributes : {},
    };
  });
}
