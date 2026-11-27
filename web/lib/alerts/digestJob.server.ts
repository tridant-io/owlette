/**
 * The alert digest job behind `GET /api/cron/alert-digest`. Server-only.
 *
 * Per person with a pending queue: decide whether the period is due, claim it
 * in a transaction (a live lease blocks every other run, the load balancer's
 * retry against the standby origin included), check again who may receive each
 * row, render once and store the body on the claim, send under a key that
 * strictly advances, then delete exactly the rows that went out.
 */

import { randomUUID } from 'crypto';
import { FieldValue, Timestamp, type DocumentData, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';
import { sanitizeForLog } from '@/lib/logSanitize';
import { getSiteAlertAudience, getSiteLabel, type SiteAlertAudience } from '@/lib/adminUtils.server';
import { parseAlertDelivery } from '@/lib/alerts/delivery';
import {
  ALERT_DIGESTS,
  DIGEST_CAPS,
  DIGEST_EVENTS,
  alertDigestStatusRef,
  classifySendError,
  decideClaim,
  digestDue,
  digestGroupKey,
  digestIdempotencyKey,
  digestTimezone,
  partitionRows,
  summarizeDigest,
  type DigestCategory,
  type DigestClaim,
  type DigestMachineState,
  type DigestRow,
} from '@/lib/alerts/digest.server';
import { buildAlertDigestEmail, unsubscribeHeaders } from '@/lib/emailTemplates.server';
import { generateUnsubscribeToken } from '@/app/api/unsubscribe/route';
import { timestampToMs } from '@/lib/firestoreTime.server';
import { createPlanMemo } from '@/lib/planPause.server';
import { FROM_EMAIL, getResend, trustedBaseUrl } from '@/lib/resendClient.server';

/** where the digest "sends" under OWLETTE_E2E, for the playwright rig to read */
export const E2E_EMAIL_OUTBOX = 'e2e_email_outbox';

/** a dead run's claim is resumed by the next 15-minute run */
const LEASE_MS = 10 * 60_000;
/** inside cron-job.org's 60s timeout; whoever is left waits for the next run */
const BUDGET_MS = 50_000;
const USER_READ_CHUNK = 100;
const WRITE_CHUNK = 500;
/** the most a rendered body may take on the claim, well inside its document's 1 MiB */
const BODY_LIMIT_BYTES = 700_000;

export interface DigestEmail {
  to: string;
  cc: string[];
  subject: string;
  html: string;
  headers: Record<string, string>;
}

export interface DigestSendError {
  name?: string;
  statusCode?: number | null;
  message?: string;
}

/** null when no transport is configured */
export type DigestTransport = (email: DigestEmail, idempotencyKey: string) => Promise<{ error: DigestSendError | null } | null>;

/**
 * Resend, or the e2e outbox. The outbox takes auto ids, so a second send of the
 * same period shows up as a second doc: deduping is the claim's job, not the fake's.
 */
export const sendDigestEmail: DigestTransport = async (email, idempotencyKey) => {
  if (process.env.OWLETTE_E2E === '1') {
    await getAdminDb().collection(E2E_EMAIL_OUTBOX).add({ ...email, idempotencyKey, sentAt: Date.now() });
    return { error: null };
  }
  const resend = getResend();
  if (!resend) return null;
  try {
    const result = await resend.emails.send(
      {
        from: FROM_EMAIL,
        to: [email.to],
        ...(email.cc.length > 0 ? { cc: email.cc } : {}),
        subject: email.subject,
        html: email.html,
        headers: email.headers,
      },
      { idempotencyKey },
    );
    return { error: result.error };
  } catch (error) {
    return { error: { name: 'application_error', statusCode: null, message: String(error) } };
  }
};

export interface DigestRunReport {
  /** people with a pending queue */
  users: number;
  /** of those, whose period this run claimed */
  due: number;
  sent: number;
  failed: number;
  /** people with rows held because their recipients could not be read */
  held: number;
  /** people left for the next run: the budget ran out, or a send said stop */
  deferred: number;
}

interface RunContext {
  db: Firestore;
  now: () => number;
  send: DigestTransport;
  baseUrl: string;
  audience: (siteId: string, category: DigestCategory) => Promise<SiteAlertAudience>;
  siteLabel: (siteId: string) => Promise<string>;
  report: DigestRunReport;
}

type Outcome = 'idle' | 'wait' | 'busy' | 'sent' | 'empty' | 'failed' | 'stop';

function memo<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let value = cache.get(key);
  if (!value) {
    value = load();
    cache.set(key, value);
  }
  return value;
}

function readClaim(value: unknown): DigestClaim | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  if (typeof c.claimId !== 'string' || typeof c.periodKey !== 'string' || !(c.cutoff instanceof Timestamp)) return null;
  return {
    claimId: c.claimId,
    periodKey: c.periodKey,
    mode: parseAlertDelivery(c.mode),
    dueAt: typeof c.dueAt === 'number' ? c.dueAt : 0,
    cutoff: c.cutoff,
    leaseUntil: typeof c.leaseUntil === 'number' ? c.leaseUntil : 0,
    attempts: typeof c.attempts === 'number' ? c.attempts : 0,
    ...(typeof c.subject === 'string' ? { subject: c.subject } : {}),
    ...(typeof c.html === 'string' ? { html: c.html } : {}),
    ...(Array.isArray(c.held) ? { held: c.held.filter((k): k is string => typeof k === 'string') } : {}),
  };
}

function readRow(id: string, data: DocumentData): DigestRow {
  return {
    id,
    siteId: String(data.siteId ?? ''),
    machineId: typeof data.machineId === 'string' ? data.machineId : null,
    category: data.category as DigestCategory,
    kind: data.kind,
    severity: data.severity === 'critical' || data.severity === 'warning' ? data.severity : 'info',
    title: String(data.title ?? ''),
    detail: String(data.detail ?? ''),
    data: data.data && typeof data.data === 'object' ? data.data : {},
    at: typeof data.at === 'number' ? data.at : 0,
  };
}

async function deleteRefs(db: Firestore, refs: DocumentReference[]): Promise<void> {
  for (let i = 0; i < refs.length; i += WRITE_CHUNK) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + WRITE_CHUNK)) batch.delete(ref);
    await batch.commit();
  }
}

/** the claim as stored, if it is still this run's */
async function ownClaim(stateRef: DocumentReference, claimId: string): Promise<{ claim: DigestClaim; introduced: boolean } | null> {
  const snap = await stateRef.get();
  const claim = readClaim(snap.get('claim'));
  return claim && claim.claimId === claimId ? { claim, introduced: snap.get('introducedAt') != null } : null;
}

/** hand the claim back for the next run without counting this one: the send failed, the run did not die */
async function endLease(db: Firestore, stateRef: DocumentReference, claimId: string): Promise<void> {
  await db.runTransaction(async (tx) => {
    const claim = readClaim((await tx.get(stateRef)).get('claim'));
    if (!claim || claim.claimId !== claimId) return;
    tx.update(stateRef, { 'claim.leaseUntil': 0, 'claim.attempts': Math.max(0, claim.attempts - 1) });
  });
}

/**
 * how a period ended: `sent`; `refused` when Resend may have seen its key (a
 * rejected message, or a claim given up after dead runs); `empty` when nothing
 * was sent because every row was dropped or held.
 */
type PeriodEnd = 'sent' | 'refused' | 'empty';

/**
 * Close the period: delete its rows but the held ones (a row committed after the
 * claim is newer than its cutoff and stays), clear the claim and its stored
 * body, and leave `pending` set while any row remains. A period Resend may have
 * seen moves `lastClosedAt` on, so the next key advances and a 409 on a reused
 * key can only mean this body; an empty one leaves it, so held rows retry on the
 * next run under the same key, which nothing went out under. A queue write also
 * writes this doc, so one landing mid-close makes the transaction retry rather
 * than clear `pending` under it.
 */
async function closePeriod(ctx: RunContext, stateRef: DocumentReference, claim: DigestClaim, end: PeriodEnd): Promise<void> {
  const rowsRef = stateRef.collection(DIGEST_EVENTS);
  const held = new Set(claim.held ?? []);
  const period = await rowsRef.where('queuedAt', '<=', claim.cutoff).get();
  await deleteRefs(
    ctx.db,
    period.docs.filter((d) => !held.has(digestGroupKey({ siteId: d.get('siteId'), category: d.get('category') }))).map((d) => d.ref),
  );
  const closedAt = Math.max(ctx.now(), claim.dueAt);
  await ctx.db.runTransaction(async (tx) => {
    const [state, remaining] = await Promise.all([tx.get(stateRef), tx.get(rowsRef.limit(1))]);
    if (readClaim(state.get('claim'))?.claimId !== claim.claimId) return;
    tx.update(stateRef, {
      pending: !remaining.empty,
      claim: FieldValue.delete(),
      ...(end === 'empty' ? {} : { lastClosedAt: closedAt }),
      ...(end === 'sent'
        ? {
            lastSentPeriodKey: claim.periodKey,
            lastSentAt: closedAt,
            ...(state.get('introducedAt') == null ? { introducedAt: closedAt } : {}),
          }
        : {}),
    });
  });
}

type Rendered = { subject: string; html: string; held: string[] } | { empty: true; held: string[] };

async function render(ctx: RunContext, uid: string, stateRef: DocumentReference, claim: DigestClaim, timezone: string, introduced: boolean, unsubscribeUrl: string): Promise<Rendered> {
  const rowsRef = stateRef.collection(DIGEST_EVENTS);
  const snap = await rowsRef.where('queuedAt', '<=', claim.cutoff).get();
  const rows = snap.docs.map((d) => readRow(d.id, d.data()));

  const audiences = new Map<string, SiteAlertAudience>();
  for (const row of rows) {
    const key = digestGroupKey(row);
    if (!audiences.has(key)) audiences.set(key, await ctx.audience(row.siteId, row.category));
  }
  const { keep, drop, held } = partitionRows(rows, uid, audiences);
  await deleteRefs(ctx.db, drop.map((id) => rowsRef.doc(id)));
  if (held.length > 0) ctx.report.held++;
  if (keep.length === 0) return { empty: true, held };

  const machines = [
    ...new Map(keep.filter((r) => r.machineId).map((r) => [`${r.siteId}/${r.machineId}`, { siteId: r.siteId, machineId: r.machineId! }])),
  ];
  const states = new Map<string, DigestMachineState | null>();
  for (let i = 0; i < machines.length; i += USER_READ_CHUNK) {
    const chunk = machines.slice(i, i + USER_READ_CHUNK);
    const docs = await ctx.db.getAll(
      ...chunk.map(([, m]) => ctx.db.collection('sites').doc(m.siteId).collection('machines').doc(m.machineId)),
    );
    docs.forEach((doc) => {
      const m = doc.data();
      states.set(
        `${doc.ref.parent.parent?.id}/${doc.id}`,
        m
          ? {
              online: m.online === true,
              asleep: m.asleep === true,
              lastHeartbeatMs: timestampToMs(m.lastHeartbeat) ?? 0,
              asleepSinceMs: timestampToMs(m.asleepSince) ?? 0,
            }
          : null,
      );
    });
  }
  const siteIds = [...new Set(keep.map((r) => r.siteId))];
  const siteLabels = new Map(await Promise.all(siteIds.map(async (id) => [id, await ctx.siteLabel(id)] as const)));

  // tighter caps until the body fits on the claim; the last caps always do
  let email: { subject: string; html: string } | null = null;
  for (const caps of DIGEST_CAPS) {
    email = buildAlertDigestEmail({
      mode: claim.mode,
      timezone,
      summary: summarizeDigest({ rows: keep, states, siteLabels, timezone, now: ctx.now(), caps }),
      introduce: !introduced,
      baseUrl: ctx.baseUrl,
      unsubscribeUrl,
    });
    if (Buffer.byteLength(email.subject) + Buffer.byteLength(email.html) <= BODY_LIMIT_BYTES) break;
  }
  return { ...email!, held };
}

/** store the rendered body on the claim, so a retry sends exactly what the first attempt did */
async function storeBody(db: Firestore, stateRef: DocumentReference, claimId: string, body: { subject: string; html: string; held: string[] }): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const claim = readClaim((await tx.get(stateRef)).get('claim'));
    if (!claim || claim.claimId !== claimId) return false;
    tx.update(stateRef, { 'claim.subject': body.subject, 'claim.html': body.html, 'claim.held': body.held });
    return true;
  });
}

async function processUser(ctx: RunContext, uid: string, user: DocumentData): Promise<Outcome> {
  const stateRef = ctx.db.collection(ALERT_DIGESTS).doc(uid);
  const rowsRef = stateRef.collection(DIGEST_EVENTS);
  const mode = parseAlertDelivery(user.preferences?.alertDelivery);
  const timezone = digestTimezone(user.preferences?.timezone);
  const now = ctx.now();
  const claimId = randomUUID();

  const decision = await ctx.db.runTransaction(async (tx) => {
    const [state, oldest] = await Promise.all([tx.get(stateRef), tx.get(rowsRef.orderBy('queuedAt').limit(1))]);
    const claim = readClaim(state.get('claim'));
    const first = oldest.docs[0];
    if (!claim && !first) {
      // the TTL took the rows
      tx.set(stateRef, { pending: false }, { merge: true });
      return 'idle' as const;
    }
    const due = first
      ? digestDue(mode, timezone, timestampToMs(first.get('queuedAt')) ?? now, timestampToMs(state.get('lastClosedAt')) ?? 0)
      : null;
    const decided = decideClaim(claim, due?.dueAt ?? null, now);
    if (claim && (decided === 'resume' || decided === 'give_up')) {
      // a run that died holding it: that death is what `attempts` counts
      tx.update(stateRef, {
        claim: { ...claim, claimId, leaseUntil: now + LEASE_MS, attempts: claim.attempts + (decided === 'resume' ? 1 : 0) },
      });
    } else if (decided === 'claim' && due) {
      // update, not a merge: the claim is replaced whole, so nothing of an older one survives in it
      tx.update(stateRef, {
        claim: {
          claimId,
          periodKey: due.periodKey,
          mode,
          dueAt: due.dueAt,
          cutoff: FieldValue.serverTimestamp(),
          leaseUntil: now + LEASE_MS,
          attempts: 1,
        },
      });
    }
    return decided;
  });
  if (decision === 'idle' || decision === 'wait' || decision === 'busy') return decision;
  ctx.report.due++;

  const owned = await ownClaim(stateRef, claimId);
  if (!owned) return 'busy';
  const { claim } = owned;
  if (decision === 'give_up') {
    logger.error('alert digest given up after repeated dead runs', {
      context: 'alert-digest',
      data: { userId: sanitizeForLog(uid), periodKey: claim.periodKey },
    });
    await closePeriod(ctx, stateRef, claim, 'refused');
    return 'failed';
  }

  const unsubscribeUrl = `${ctx.baseUrl}/api/unsubscribe?token=${generateUnsubscribeToken(uid)}`;
  let body = claim.html && claim.subject ? { subject: claim.subject, html: claim.html, held: claim.held ?? [] } : null;
  if (!body) {
    const rendered = await render(ctx, uid, stateRef, claim, timezone, owned.introduced, unsubscribeUrl);
    if ('empty' in rendered) {
      // nothing to report: no email, but the period still closes so the key advances
      await closePeriod(ctx, stateRef, { ...claim, held: rendered.held }, 'empty');
      return 'empty';
    }
    body = rendered;
    if (!(await storeBody(ctx.db, stateRef, claimId, body))) return 'busy';
  }
  const closing = { ...claim, held: body.held };

  const cc: string[] = Array.isArray(user.preferences?.alertCcEmails) ? user.preferences.alertCcEmails : [];
  const result = await ctx.send(
    {
      to: String(user.email),
      cc,
      subject: body.subject,
      html: body.html,
      headers: unsubscribeHeaders(unsubscribeUrl, cc).headers ?? {},
    },
    digestIdempotencyKey(uid, claim.periodKey),
  );
  if (result === null) {
    logger.warn('alert digest: no email transport configured, every queue is held', { context: 'alert-digest' });
    await endLease(ctx.db, stateRef, claimId);
    return 'stop';
  }

  const verdict = classifySendError(result.error);
  const log = { userId: sanitizeForLog(uid), periodKey: claim.periodKey, error: result.error };
  switch (verdict) {
    case 'sent':
      await closePeriod(ctx, stateRef, closing, 'sent');
      return 'sent';
    case 'concurrent':
      // another request is sending this key right now; its run closes the period
      return 'busy';
    case 'stop':
      logger.warn('alert digest send refused for the whole account, run stopped with every row kept', { context: 'alert-digest', data: log });
      await endLease(ctx.db, stateRef, claimId);
      return 'stop';
    case 'transient':
      logger.warn('alert digest send failed, kept for the next run', { context: 'alert-digest', data: log });
      await endLease(ctx.db, stateRef, claimId);
      return 'failed';
    case 'rejected':
      logger.error('alert digest rejected by resend, period given up', { context: 'alert-digest', data: log });
      await closePeriod(ctx, stateRef, closing, 'refused');
      return 'failed';
  }
}

async function readUsers(db: Firestore, uids: string[]): Promise<Map<string, DocumentData | undefined>> {
  const users = new Map<string, DocumentData | undefined>();
  for (let i = 0; i < uids.length; i += USER_READ_CHUNK) {
    const docs = await db.getAll(...uids.slice(i, i + USER_READ_CHUNK).map((uid) => db.collection('users').doc(uid)));
    for (const doc of docs) users.set(doc.id, doc.data());
  }
  return users;
}

export async function runAlertDigest(options: { now?: () => number; send?: DigestTransport } = {}): Promise<DigestRunReport> {
  const db = getAdminDb();
  const now = options.now ?? Date.now;
  const started = now();
  const planMemo = createPlanMemo();
  const audiences = new Map<string, Promise<SiteAlertAudience>>();
  const labels = new Map<string, Promise<string>>();
  const ctx: RunContext = {
    db,
    now,
    send: options.send ?? sendDigestEmail,
    baseUrl: trustedBaseUrl(),
    audience: (siteId, category) => memo(audiences, `${siteId}|${category}`, () => getSiteAlertAudience(siteId, category, planMemo)),
    siteLabel: (siteId) => memo(labels, siteId, () => getSiteLabel(siteId)),
    report: { users: 0, due: 0, sent: 0, failed: 0, held: 0, deferred: 0 },
  };
  const { report } = ctx;

  const pending = await db.collection(ALERT_DIGESTS).where('pending', '==', true).get();
  const uids = pending.docs.map((d) => d.id);
  report.users = uids.length;
  const users = await readUsers(db, uids);

  let stopped = false;
  for (const uid of uids) {
    if (stopped || now() - started > BUDGET_MS) {
      report.deferred++;
      continue;
    }
    try {
      const user = users.get(uid);
      if (!user || typeof user.deletedAt === 'number' || !user.email) {
        // nobody to send to: drop the queue and any stored body with it
        await db.recursiveDelete(db.collection(ALERT_DIGESTS).doc(uid));
        continue;
      }
      const outcome = await processUser(ctx, uid, user);
      if (outcome === 'sent') report.sent++;
      else if (outcome === 'failed') report.failed++;
      else if (outcome === 'stop') {
        report.deferred++;
        stopped = true;
      }
    } catch (error) {
      report.failed++;
      logger.error('alert digest failed for one person', {
        context: 'alert-digest',
        data: { userId: sanitizeForLog(uid), error: String(error) },
      });
    }
  }

  await alertDigestStatusRef(db).set({ lastRunAt: now(), lastRun: report }, { merge: true });
  return report;
}
