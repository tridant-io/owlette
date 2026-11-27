/**
 * The alert digest's queue and its pure rules. Server-only.
 *
 * Each alert sender resolves its recipients as before and hands every one to
 * {@link alertEmailDelivery}: a person on `immediate` gets today's email, anyone
 * else, while the digest job runs, gets the alert written to
 * `alert_digests/{uid}/digest_events`, which
 * `GET /api/cron/alert-digest` (lib/alerts/digestJob.server.ts) turns into one
 * email per period. Who may receive each queued alert is decided again at send
 * time, so a queued row is a candidate, never a promise.
 */

import { createHash } from 'crypto';
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';
import { sanitizeForLog } from '@/lib/logSanitize';
import { isValidTimezone } from '@/lib/timeUtils';
import { computeNextRunAt } from '@/lib/talons/schedule.server';
import { DAY_KEYS, type DayKey } from '@/lib/talons/types';
import { METRIC_LABELS, describeDisplayEvent, type PendingDisplayAlert } from '@/lib/emailTemplates.server';
import { timestampToMs } from '@/lib/firestoreTime.server';
import { recipientWantsMachine, type SiteAlertAudience, type SiteAlertPreference, type SiteRecipient } from '@/lib/adminUtils.server';
import type { AlertDelivery } from '@/lib/alerts/delivery';

export const ALERT_DIGESTS = 'alert_digests';
/** not `events`: a TTL applies to every collection group of its name (firestore.indexes.json) */
export const DIGEST_EVENTS = 'digest_events';
/** the TTL backstop: a row is deleted when its digest sends, or after this */
const DIGEST_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * the job stamps `global/alert_digest.lastRunAt` on every 15-minute run. older
 * than this is three missed runs: senders stop queueing and email at once, and
 * the `alert_delivery` status component degrades while a queue waits.
 */
export const ALERT_DIGEST_STALE_MS = 45 * 60 * 1000;

export function alertDigestStatusRef(db: Firestore) {
  return db.collection('global').doc('alert_digest');
}

const HOUR_MS = 60 * 60 * 1000;
const TITLE_MAX = 200;
const DETAIL_MAX = 500;
const DATA_TEXT_MAX = 200;
const ALREADY_EXISTS = 6;
/** health-check's offline threshold, for what the digest calls offline now */
const OFFLINE_AFTER_MS = 5 * 60 * 1000;

/** the categories a digest carries: every site alert but talon emails, which stay immediate */
export type DigestCategory = Exclude<SiteAlertPreference, 'talonAlerts'>;

export type DigestKind =
  | 'offline'
  | 'asleep'
  | 'awake'
  | 'agent_error'
  | 'reboot_pending'
  | 'process_crash'
  | 'process_start_failed'
  | 'threshold'
  | 'hoot_escalation'
  | `display_${string}`;

export type DigestSeverity = 'info' | 'warning' | 'critical';

type DigestData = Record<string, string | number | boolean | null>;

/** one alert, as a sender hands it over */
export interface DigestEvent {
  /** repeats of one source (an outage re-alerting hourly, an overlapping cron run) collapse into one row; null for an alert posted once */
  sourceKey: string | null;
  siteId: string;
  machineId: string | null;
  category: DigestCategory;
  kind: DigestKind;
  severity: DigestSeverity;
  /** the line's subject: "touchdesigner", "monitor removed", a rule's name */
  title: string;
  detail?: string;
  data?: DigestData;
  /** when it happened, for display only: periods are cut on the server's `queuedAt` */
  at: number;
}

/** a queued row, as the job reads it back */
export interface DigestRow {
  id: string;
  siteId: string;
  machineId: string | null;
  category: DigestCategory;
  kind: DigestKind;
  severity: DigestSeverity;
  title: string;
  detail: string;
  data: DigestData;
  at: number;
}

/** a display alert's digest row: from the 3-minute drain keyed on its queue doc, inline (critical path) with none */
export function displayDigestEvent(alert: PendingDisplayAlert, sourceKey: string | null): DigestEvent {
  const { label, severity, detail } = describeDisplayEvent(alert.eventType, alert.data);
  return {
    sourceKey,
    siteId: alert.siteId,
    machineId: alert.machineId,
    category: 'displayAlerts',
    kind: alert.eventType as DigestKind,
    severity,
    title: label,
    detail,
    at: timestampToMs(alert.timestamp) ?? Date.now(),
  };
}

export function digestEventId(sourceKey: string): string {
  return createHash('sha1').update(sourceKey).digest('hex');
}

/**
 * Queue alerts for one person. One batch per alert, so a repeat of a
 * deterministic id fails alone (ALREADY_EXISTS is the collapse) and every write
 * also touches the state doc, which is what makes the job's finish transaction
 * notice a row that lands mid-finish.
 */
export async function queueDigestEvents(uid: string, events: DigestEvent[]): Promise<void> {
  const db = getAdminDb();
  const stateRef = db.collection(ALERT_DIGESTS).doc(uid);
  const rows = stateRef.collection(DIGEST_EVENTS);
  await Promise.all(
    events.map(async (event) => {
      const batch = db.batch();
      batch.create(event.sourceKey ? rows.doc(digestEventId(event.sourceKey)) : rows.doc(), {
        siteId: event.siteId,
        machineId: event.machineId,
        category: event.category,
        kind: event.kind,
        severity: event.severity,
        title: event.title.slice(0, TITLE_MAX),
        detail: (event.detail ?? '').slice(0, DETAIL_MAX),
        data: Object.fromEntries(
          Object.entries(event.data ?? {}).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, DATA_TEXT_MAX) : v]),
        ),
        at: event.at,
        queuedAt: FieldValue.serverTimestamp(),
        deleteAt: Timestamp.fromMillis(Date.now() + DIGEST_RETENTION_MS),
      });
      batch.set(stateRef, { pending: true, lastQueuedAt: FieldValue.serverTimestamp() }, { merge: true });
      try {
        await batch.commit();
      } catch (err) {
        const code = (err as { code?: unknown } | null)?.code;
        if (code !== ALREADY_EXISTS && code !== 'already-exists') throw err;
      }
    }),
  );
}

export type DeliveryOutcome = 'sent' | 'queued' | 'failed';

/** whether the digest job ran lately; a failed read reads as no, so mail goes out now */
async function digestJobAlive(now: number): Promise<boolean> {
  try {
    const lastRunAt = (await alertDigestStatusRef(getAdminDb()).get()).data()?.lastRunAt;
    return typeof lastRunAt === 'number' && now - lastRunAt <= ALERT_DIGEST_STALE_MS;
  } catch (error) {
    logger.warn('alert digest: could not read whether the job is running, sending at once', {
      context: 'alert-digest',
      data: { error: String(error) },
    });
    return false;
  }
}

/**
 * One per request or cron run, for the branch every alert sender takes per
 * recipient: queue for their digest, or send now. It queues only while the
 * digest job is running, so a job never registered, or one that stopped, means
 * today's immediate email rather than mail nobody sends. Whether it is running
 * is read once, on the first recipient who would queue. Each alert takes exactly
 * one path. A failed queue write is logged and reported, never thrown, so an
 * agent's POST still answers 2xx and is not re-posted as a duplicate.
 */
export function alertEmailDelivery(now: () => number = Date.now) {
  let alive: Promise<boolean> | null = null;
  return {
    async deliver(recipient: SiteRecipient, events: DigestEvent[], sendNow: () => Promise<boolean>): Promise<DeliveryOutcome> {
      if (recipient.delivery !== 'immediate') {
        alive ??= digestJobAlive(now());
        if (await alive) {
          try {
            await queueDigestEvents(recipient.userId, events);
            return 'queued';
          } catch (error) {
            logger.error('alert digest queue write failed', {
              context: 'alert-digest',
              data: { userId: sanitizeForLog(recipient.userId), error: String(error) },
            });
            return 'failed';
          }
        }
      }
      return (await sendNow()) ? 'sent' : 'failed';
    },
  };
}

// due times

const DIGEST_TIME = '08:00';
const DIGEST_DAYS: Record<'daily' | 'weekly', DayKey[]> = { daily: [...DAY_KEYS], weekly: ['mon'] };

/** the person's zone when it is a real one, else UTC */
export function digestTimezone(value: unknown): string {
  return typeof value === 'string' && value !== '' && isValidTimezone(value) ? value : 'UTC';
}

/** the first boundary strictly after `after`: 08:00 local daily, monday 08:00 local weekly, the next whole UTC hour hourly */
export function nextDigestAt(mode: Exclude<AlertDelivery, 'immediate'>, timezone: string, after: number): number {
  if (mode === 'hourly') return Math.floor(after / HOUR_MS) * HOUR_MS + HOUR_MS;
  const next = computeNextRunAt(
    { type: 'schedule', entries: [{ id: 'digest', days: DIGEST_DAYS[mode], time: DIGEST_TIME }] },
    timezone,
    new Date(after),
  );
  // a daily or weekly entry always lands inside the scan, so null is unreachable
  return next!.getTime();
}

export interface DigestDue {
  periodKey: string;
  dueAt: number;
}

/**
 * When a person's queue is due, and the key its email goes out under. The anchor
 * is the later of the oldest row and the last closed period, so a held row never
 * pins a period already sent and the key strictly advances: that is what makes
 * a Resend 409 on a reused key safe to read as sent. `immediate` is due at once,
 * which flushes the queue of someone who just switched.
 */
export function digestDue(mode: AlertDelivery, timezone: string, oldestQueuedAt: number, lastClosedAt: number): DigestDue {
  const anchor = Math.max(oldestQueuedAt, lastClosedAt);
  if (mode === 'immediate') return { periodKey: `flush:${anchor}`, dueAt: anchor };
  const dueAt = nextDigestAt(mode, timezone, anchor);
  return { periodKey: `${mode}:${new Date(dueAt).toISOString()}`, dueAt };
}

export function digestIdempotencyKey(uid: string, periodKey: string): string {
  return `alert-digest/${uid}/${periodKey}`;
}

// claims

/** after this many runs died holding the claim, the period is given up: a lost email beats a loop */
export const MAX_CLAIM_ATTEMPTS = 3;

export interface DigestClaim {
  claimId: string;
  periodKey: string;
  mode: AlertDelivery;
  dueAt: number;
  /** a server timestamp: every row committed after the claim is newer, so a resume reads the same rows */
  cutoff: Timestamp;
  leaseUntil: number;
  /** runs that took the claim and did not hand it back */
  attempts: number;
  subject?: string;
  html?: string;
  /** `siteId|category` groups whose recipients could not be read, left for the next period */
  held?: string[];
}

export type ClaimDecision = 'busy' | 'resume' | 'give_up' | 'claim' | 'wait';

/**
 * Any live lease blocks, whatever its key. A dead claim is finished before any
 * new period starts, with its own key, cutoff and body, so a retry sends what
 * the first attempt may already have sent.
 */
export function decideClaim(claim: DigestClaim | null, dueAt: number | null, now: number): ClaimDecision {
  if (claim) {
    if (claim.leaseUntil > now) return 'busy';
    return claim.attempts >= MAX_CLAIM_ATTEMPTS ? 'give_up' : 'resume';
  }
  return dueAt !== null && dueAt <= now ? 'claim' : 'wait';
}

// send results

export type SendVerdict = 'sent' | 'concurrent' | 'stop' | 'transient' | 'rejected';

/**
 * errors that are not about one message: the account, the sending domain, a
 * quota, or our own key format. every digest would fail the same way.
 */
const STOP_ERRORS = new Set([
  'missing_api_key',
  'invalid_api_key',
  'restricted_api_key',
  'invalid_from_address',
  'invalid_access',
  'invalid_region',
  'security_error',
  'invalid_idempotency_key',
  'rate_limit_exceeded',
  'daily_quota_exceeded',
  'monthly_quota_exceeded',
]);
/** this one message will never pass, however often it is retried */
const REJECTED_ERRORS = new Set(['validation_error', 'invalid_parameter', 'missing_required_field']);

/**
 * What a Resend answer means for the claim. `stop` ends the run with every row
 * kept (a quota, a rate limit, a broken key or domain); `transient` ends this
 * person's lease without counting it; only `rejected` gives the period up.
 * Status decides before the name: Resend answers an unverified domain, and a
 * test sender writing to anyone but its own address, as `validation_error`
 * with 403, and giving up on those would delete every due digest in one run.
 */
export function classifySendError(error: { name?: string; statusCode?: number | null } | null): SendVerdict {
  if (!error) return 'sent';
  // an earlier body already went out under this key
  if (error.name === 'invalid_idempotent_request') return 'sent';
  if (error.name === 'concurrent_idempotent_requests') return 'concurrent';
  if (error.statusCode === 401 || error.statusCode === 403 || error.statusCode === 429) return 'stop';
  if (error.name && STOP_ERRORS.has(error.name)) return 'stop';
  if (error.name && REJECTED_ERRORS.has(error.name)) return 'rejected';
  return 'transient';
}

// the send-time check

/** the recipient lookup a row is checked against: one per site and category */
export function digestGroupKey(row: { siteId: string; category: string }): string {
  return `${row.siteId}|${row.category}`;
}

export interface PartitionedRows {
  keep: DigestRow[];
  /** ids of rows this person may no longer receive */
  drop: string[];
  /** groups whose recipients could not be read: neither sent nor deleted */
  held: string[];
}

/**
 * Who may receive each queued row is decided again here, not at queue time. A
 * row goes only while its person is still on the site's list for that category
 * and the machine is in their scope and not muted; otherwise it is dropped,
 * which covers an opt-out, a mute, a removal or narrowing, and a paused or
 * deleted site. A list that came from a failed read holds its rows, and the
 * ADMIN_EMAIL fallback in it is never mailed from a digest.
 */
export function partitionRows(rows: DigestRow[], uid: string, audiences: Map<string, SiteAlertAudience>): PartitionedRows {
  const out: PartitionedRows = { keep: [], drop: [], held: [] };
  const held = new Set<string>();
  for (const row of rows) {
    const key = digestGroupKey(row);
    const audience = audiences.get(key);
    if (!audience || !audience.complete) {
      held.add(key);
      continue;
    }
    const me = audience.recipients.find((r) => r.userId === uid);
    if (me && (row.machineId === null || recipientWantsMachine(me, row.machineId))) out.keep.push(row);
    else out.drop.push(row.id);
  }
  out.held = [...held];
  return out;
}

// content

export interface DigestMachineState {
  online: boolean;
  asleep: boolean;
  lastHeartbeatMs: number;
  asleepSinceMs: number;
}

export interface DigestLine {
  text: string;
  severity: DigestSeverity;
}

export interface DigestMachine {
  machineId: string | null;
  /** "online now", "offline since …", "asleep since …", "removed" */
  stateNow: string;
  lines: DigestLine[];
  /** lines past the cap */
  moreLines: number;
}

export interface DigestSite {
  siteLabel: string;
  machines: DigestMachine[];
  /** machines past the per-site cap */
  moreMachines: number;
}

export interface DigestSummary {
  eventCount: number;
  siteCount: number;
  offlineNow: { siteLabel: string; machineId: string; state: 'offline' | 'asleep'; since: string }[];
  /** offline or asleep machines past the cap */
  moreOffline: number;
  sites: DigestSite[];
  /** sites past the cap */
  moreSites: number;
  /** the earliest alert and the end of the period, formatted in the person's zone */
  from: string;
  to: string;
}

export interface DigestCaps {
  sites: number;
  machinesPerSite: number;
  linesPerMachine: number;
  offline: number;
}

/**
 * caps on what one digest lists, loosest first. the rendered body is stored on
 * the claim, a document of at most 1 MiB, until it is sent: the job renders with
 * the next caps while the body is over its limit, so a large fleet is summarized
 * harder rather than failing the write and losing the digest.
 */
export const DIGEST_CAPS: readonly DigestCaps[] = [
  { sites: 25, machinesPerSite: 25, linesPerMachine: 20, offline: 25 },
  { sites: 10, machinesPerSite: 10, linesPerMachine: 10, offline: 10 },
  { sites: 5, machinesPerSite: 5, linesPerMachine: 5, offline: 5 },
];
const ESCALATION_SUMMARY_MAX = 300;
const ERROR_MAX = 160;

const SEVERITY_RANK: Record<DigestSeverity, number> = { critical: 0, warning: 1, info: 2 };

function formatDigestTime(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
    .format(new Date(ms))
    .toLowerCase();
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const cut = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** which rows read as one line */
function lineKey(row: DigestRow): string {
  switch (row.kind) {
    case 'asleep':
    case 'awake':
      return 'sleep';
    case 'process_crash':
    case 'process_start_failed':
      return `${row.kind}|${row.title}`;
    case 'threshold':
      return `threshold|${row.title}|${str(row.data.metric)}|${str(row.data.operator)}|${num(row.data.threshold)}`;
    default:
      return row.kind;
  }
}

function worst(rows: DigestRow[]): DigestSeverity {
  return rows.reduce<DigestSeverity>((w, r) => (SEVERITY_RANK[r.severity] < SEVERITY_RANK[w] ? r.severity : w), 'info');
}

function latest(rows: DigestRow[]): DigestRow {
  return rows.reduce((a, b) => (b.at > a.at ? b : a));
}

/** one line for a group of repeats: the hourly re-alerts of one outage are one episode, a flapping rule one row */
function lineText(rows: DigestRow[], tz: string): string {
  const last = latest(rows);
  const when = (ms: number) => formatDigestTime(ms, tz);
  switch (last.kind) {
    case 'offline':
      // one row per outage already: the row id is keyed on staleSince, so its hourly re-alerts collapse
      return rows.length === 1 ? `offline since ${when(last.at)}` : `offline ${rows.length}× · last ${when(last.at)}`;
    case 'asleep':
    case 'awake': {
      const episodes = new Set(rows.map((r) => num(r.data.asleepSince)));
      const slept = rows.filter((r) => r.kind === 'awake').reduce((total, r) => total + num(r.data.sleptMs), 0);
      if (slept === 0) return `asleep since ${when(Math.max(...episodes) || last.at)}`;
      return `slept ${episodes.size}× · ${duration(slept)} in total`;
    }
    case 'process_crash':
    case 'process_start_failed': {
      const did = last.kind === 'process_crash' ? 'crashed' : 'failed to start';
      const error = last.detail ? ` · last error: ${cut(last.detail, ERROR_MAX)}` : '';
      return `${last.title} ${did} ${rows.length}× · last ${when(last.at)}${error}`;
    }
    case 'threshold': {
      const operator = str(last.data.operator);
      const values = rows.map((r) => num(r.data.value));
      const peak = operator.startsWith('<') ? Math.min(...values) : Math.max(...values);
      const metric = METRIC_LABELS[str(last.data.metric)] || str(last.data.metric);
      return `${last.title}: ${metric} ${operator} ${num(last.data.threshold)} · ${rows.length}× · peak ${peak} · latest ${num(last.data.value)}`;
    }
    case 'agent_error':
      return `agent error ${rows.length}× · last: ${cut(last.detail, ERROR_MAX)}`;
    case 'reboot_pending':
      return 'reboot pending';
    case 'hoot_escalation':
      return `hoot escalation ${rows.length}× · ${cut(last.detail, ESCALATION_SUMMARY_MAX)}`;
    default:
      return `${last.title} ${rows.length}× · last ${when(last.at)}`;
  }
}

function stateNow(state: DigestMachineState | null | undefined, now: number, tz: string): { text: string; down: 'offline' | 'asleep' | null; sinceMs: number } {
  if (!state) return { text: 'removed', down: null, sinceMs: 0 };
  if (state.asleep) return { text: `asleep since ${formatDigestTime(state.asleepSinceMs || now, tz)}`, down: 'asleep', sinceMs: state.asleepSinceMs };
  if (!state.online || now - state.lastHeartbeatMs > OFFLINE_AFTER_MS) {
    return {
      text: state.lastHeartbeatMs > 0 ? `offline since ${formatDigestTime(state.lastHeartbeatMs, tz)}` : 'offline',
      down: 'offline',
      sinceMs: state.lastHeartbeatMs,
    };
  }
  return { text: 'online now', down: null, sinceMs: 0 };
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

/** most severe first, then the busiest */
const byWeight = (a: { severity: DigestSeverity; count: number }, b: { severity: DigestSeverity; count: number }) =>
  SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.count - a.count;

/**
 * Collapse a period's rows into what the email shows: per site, per machine,
 * one line per kind of alert. `states` is each machine's state at send time,
 * keyed `siteId/machineId`; a missing key reads as removed.
 */
export function summarizeDigest(input: {
  rows: DigestRow[];
  states: Map<string, DigestMachineState | null>;
  siteLabels: Map<string, string>;
  timezone: string;
  now: number;
  caps?: DigestCaps;
}): DigestSummary {
  const { rows, states, siteLabels, timezone: tz, now, caps = DIGEST_CAPS[0] } = input;
  const offlineNow: DigestSummary['offlineNow'] = [];

  const sites = [...groupBy(rows, (r) => r.siteId)].map(([siteId, siteRows]) => {
    const siteLabel = siteLabels.get(siteId) ?? siteId;
    const machines = [...groupBy(siteRows, (r) => r.machineId ?? '')].map(([machineId, machineRows]) => {
      const lines = [...groupBy(machineRows, lineKey).values()]
        .map((group) => ({ text: lineText(group, tz), severity: worst(group), count: group.length }))
        .sort(byWeight);
      const current = machineId ? stateNow(states.get(`${siteId}/${machineId}`), now, tz) : null;
      if (machineId && current?.down) {
        offlineNow.push({ siteLabel, machineId, state: current.down, since: current.sinceMs > 0 ? formatDigestTime(current.sinceMs, tz) : '' });
      }
      return {
        machine: {
          machineId: machineId || null,
          stateNow: current?.text ?? '',
          lines: lines.slice(0, caps.linesPerMachine).map(({ text, severity }) => ({ text, severity })),
          moreLines: Math.max(0, lines.length - caps.linesPerMachine),
        },
        severity: worst(machineRows),
        count: machineRows.length,
      };
    });
    machines.sort(byWeight);
    return {
      site: {
        siteLabel,
        machines: machines.slice(0, caps.machinesPerSite).map((m) => m.machine),
        moreMachines: Math.max(0, machines.length - caps.machinesPerSite),
      },
      severity: worst(siteRows),
      count: siteRows.length,
    };
  });
  sites.sort(byWeight);
  // an outage before a sleep
  offlineNow.sort((a, b) => Number(a.state === 'asleep') - Number(b.state === 'asleep'));

  return {
    eventCount: rows.length,
    siteCount: sites.length,
    offlineNow: offlineNow.slice(0, caps.offline),
    moreOffline: Math.max(0, offlineNow.length - caps.offline),
    sites: sites.slice(0, caps.sites).map((s) => s.site),
    moreSites: Math.max(0, sites.length - caps.sites),
    from: formatDigestTime(Math.min(...rows.map((r) => r.at)), tz),
    to: formatDigestTime(now, tz),
  };
}
