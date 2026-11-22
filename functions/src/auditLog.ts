/**
 * Append-only audit log sink. Events: signed_url_issued,
 * distribution_started, version_pointer_changed, api_key_used, gc_run.
 *
 * Hash-chained (lib/auditLogLogic.ts): each record embeds hash(prev || record)
 * so a verifier can prove nothing was modified or deleted.
 *
 * writers never touch the chain: they add the event to the site's `audit_queue`
 * (the web through the admin sdk, older web builds through recordAuditEvent).
 * drainBatch is the chain's only writer. one transaction takes the oldest queued
 * events, links them onto the head and deletes them, so a burst waits in the
 * queue instead of racing for the head. onAuditQueued drains on every enqueue,
 * and sweepAuditQueue drains whatever a trigger missed.
 *
 * Append-only is NOT enforced here — it lives in firestore.rules, which is
 * operator-owned: clients may read a site's audit_log (site admins) and never
 * write it, and the queue, set-aside and meta docs fall to its default deny.
 */

import { onRequest } from 'firebase-functions/v2/https';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import {
  FieldPath,
  FieldValue,
  getFirestore,
  type DocumentData,
  type DocumentSnapshot,
  type DocumentReference,
  type Firestore,
  type Transaction,
} from 'firebase-admin/firestore';
import { requireInternalSecret } from './lib/requireInternalSecret';
import {
  AUDIT_RETENTION_DAYS,
  canonicaliseEvent,
  chainQueued,
  GENESIS_HASH,
  PLATFORM_AUDIT_SITE_ID,
  verifyChain,
  type AuditEvent,
  type AuditHead,
  type AuditRecord,
} from './lib/auditLogLogic';

/** each event is two writes (its record or set-aside copy, and the queue delete), plus the head and one finding: 202, under the 500-write cap. */
const DRAIN_BATCH = 100;
const DRAIN_LOCK_MS = 60_000;
const DRAIN_BUDGET_MS = 50_000;
// NOT_FOUND, ALREADY_EXISTS, FAILED_PRECONDITION: the lock changed after it was read
const LOCK_TAKEN = new Set([5, 6, 9]);
// the grpc codes firestore's own transaction runner retries; web/lib/auditLogClient.ts keeps the same list
const TRANSIENT_CODES = new Set([1, 2, 4, 8, 10, 13, 14, 16]);
const SET_ASIDE_EVENT_CHARS = 10_000;

export interface AuditStore {
  /** Full chain (or a prefix) in recordedAt-ascending order. */
  readChain(siteId: string, limit?: number): Promise<AuditRecord[]>;
}

export interface AuditExporter {
  /** Ship a batch to cold storage (BigQuery in prod); called by the daily job. */
  exportBatch(records: readonly AuditRecord[]): Promise<void>;
}

const siteDoc = (db: Firestore, siteId: string) => db.collection('sites').doc(siteId);
const oldestQueued = (db: Firestore, siteId: string, n: number) =>
  siteDoc(db, siteId).collection('audit_queue').orderBy('enqueuedAt').limit(n);

const HOUR_MS = 60 * 60 * 1000;
const FINDING_REASONS = 3;
const FINDING_REASON_CHARS = 200;

/** the site's set-aside finding for the hour `now` falls in */
const setAsideFindingRef = (db: Firestore, siteId: string, now: number) =>
  db
    .collection('global')
    .doc('activity_watch')
    .collection('findings')
    .doc(`audit_rejected:${siteId}:${Math.floor(now / HOUR_MS)}`);

interface SetAside {
  queued: DocumentReference;
  copy: DocumentData;
  reason: string;
}

/**
 * in the caller's transaction, after its reads: set queued events aside with their reasons, take
 * them off the queue, and count them into the site's one set-aside finding for this hour, read in
 * the same transaction, so a burst of them mails once. the finding has the shape the web stores
 * and mails (web/lib/activity/types.ts `Finding`, web/lib/activity/findings.server.ts); one already
 * mailed keeps its emailedAt and only shows the higher count.
 */
function setAsideIn(
  tx: Transaction,
  db: Firestore,
  siteId: string,
  events: SetAside[],
  finding: DocumentSnapshot,
  now: number,
): void {
  const rejected = siteDoc(db, siteId).collection('audit_queue_rejected');
  for (const { queued, copy, reason } of events) {
    tx.set(rejected.doc(queued.id), { ...copy, reason, rejectedAt: FieldValue.serverTimestamp() });
    tx.delete(queued);
  }
  const prior = finding.data() as
    | { count?: number; reasons?: string[]; detectedAt?: number; emailedAt?: number | null; digestedAt?: number | null }
    | undefined;
  const count = (prior?.count ?? 0) + events.length;
  // the newest distinct reasons first
  const reasons = [
    ...new Set([...events.map((e) => e.reason.slice(0, FINDING_REASON_CHARS)).reverse(), ...(prior?.reasons ?? [])]),
  ].slice(0, FINDING_REASONS);
  const site = siteId === PLATFORM_AUDIT_SITE_ID ? null : siteId;
  const named = site ?? 'the platform';
  tx.set(finding.ref, {
    id: finding.id,
    rule: 'audit_rejected',
    severity: 'high',
    title: 'audit events not recorded',
    summary:
      `${count === 1 ? '1 audit event' : `${count} audit events`} for ${named} ` +
      `${count === 1 ? 'was' : 'were'} set aside so far this hour instead of joining its audit log.`,
    subject: { siteId: site },
    at: now,
    facts: [
      { label: 'site', value: named },
      { label: 'set aside', value: String(count) },
      { label: 'latest reasons', value: reasons.join(' · ') },
    ],
    rowIds: [],
    count,
    reasons,
    // a number, as the cron's mail query compares it
    detectedAt: prior?.detectedAt ?? now,
    emailedAt: prior?.emailedAt ?? null,
    digestedAt: prior?.digestedAt ?? null,
  });
}

/**
 * chain the oldest queued events onto the site's chain in one transaction.
 * returns how many queue docs it consumed: 0 means the queue is empty.
 */
export async function drainBatch(db: Firestore, siteId: string, size = DRAIN_BATCH): Promise<number> {
  const site = siteDoc(db, siteId);
  const headRef = site.collection('audit_log_meta').doc('head');
  const batch = await db.runTransaction(async (tx) => {
    // read and stamped inside each attempt, so a retried or concurrent drain
    // chains from the head as it is now
    const headSnap = await tx.get(headRef);
    const queued = await tx.get(oldestQueued(db, siteId, size));
    const head = headSnap.data() as Partial<AuditHead> | undefined;
    const now = Date.now();
    const chained = chainQueued(
      siteId,
      { hash: head?.hash ?? GENESIS_HASH, recordedAt: head?.recordedAt ?? 0 },
      queued.docs.map((d) => ({ id: d.id, event: d.get('event') })),
      now,
    );
    // the last read, before any write
    const finding = chained.rejected.length > 0 ? await tx.get(setAsideFindingRef(db, siteId, now)) : null;
    const rejected = new Map(chained.rejected.map((r) => [r.id, r.reason]));
    const setAsides: SetAside[] = [];
    for (const record of chained.records) {
      tx.set(site.collection('audit_log').doc(record.hash), record);
    }
    for (const doc of queued.docs.slice(0, chained.taken)) {
      const reason = rejected.get(doc.id);
      if (reason) setAsides.push({ queued: doc.ref, copy: doc.data(), reason });
      else tx.delete(doc.ref);
    }
    if (finding) setAsideIn(tx, db, siteId, setAsides, finding, now);
    if (chained.records.length > 0) tx.set(headRef, chained.head);
    return chained;
  });
  for (const { id, reason } of batch.rejected) {
    console.warn(`[auditLog] queued event ${siteId}/${id} set aside: ${reason}`);
  }
  return batch.taken;
}

// firestore refused the commit itself: it carries a grpc code its own transaction runner does not
// retry. a failure with no code is our own bug, and its events must wait in the queue, not be set aside
const isRefused = (err: unknown) => {
  const { code, message } = (err ?? {}) as { code?: unknown; message?: unknown };
  // the runner retries this INVALID_ARGUMENT too: it says nothing about the event
  if (code === 3 && /transaction has expired/.test(String(message))) return false;
  return typeof code === 'number' && !TRANSIENT_CODES.has(code);
};

/**
 * move one queued event to audit_queue_rejected with the error it failed on, in
 * the transaction that takes it off the queue and counts it into its finding. when
 * firestore will not store the event itself, a truncated copy of it goes instead.
 */
async function setAside(db: Firestore, siteId: string, queued: DocumentReference, err: Error): Promise<void> {
  const reason = `write_failed: ${err.message}`;
  const move = (copy: (data: DocumentData) => DocumentData) =>
    db.runTransaction(async (tx) => {
      const snap = await tx.get(queued);
      // another drainer took it off the queue first
      if (!snap.exists) return;
      const now = Date.now();
      const finding = await tx.get(setAsideFindingRef(db, siteId, now));
      setAsideIn(tx, db, siteId, [{ queued, copy: copy(snap.data() ?? {}), reason }], finding, now);
    });
  try {
    await move((data) => data);
  } catch (fullCopyErr) {
    if (!isRefused(fullCopyErr)) throw fullCopyErr;
    await move(({ event, enqueuedAt }) => ({
      enqueuedAt,
      event: { kind: event?.kind ?? null, truncated: (JSON.stringify(event) ?? '').slice(0, SET_ASIDE_EVENT_CHARS) },
    }));
  }
  console.warn(`[auditLog] queued event ${queued.path} set aside: ${err.message}`);
}

/**
 * one event at a time, once a batch could not commit: its events still land in
 * order, and an event that cannot commit even alone is set aside so the queue
 * behind it keeps draining.
 */
async function drainOne(db: Firestore, siteId: string): Promise<number> {
  const [oldest] = (await oldestQueued(db, siteId, 1).get()).docs;
  if (!oldest) return 0;
  try {
    return await drainBatch(db, siteId, 1);
  } catch (err) {
    if (!isRefused(err)) throw err;
    // if another drainer took `oldest` meanwhile, this is a no-op and the next attempt meets the failing event itself
    await setAside(db, siteId, oldest.ref, err as Error);
    return 1;
  }
}

/**
 * plain read, then a precondition write: a transaction here would have a burst
 * of triggers contending for one doc, the very thing the queue avoids.
 */
async function takeDrainLock(ref: DocumentReference): Promise<boolean> {
  const snap = await ref.get();
  if ((snap.get('expiresAt') ?? 0) > Date.now()) return false;
  const lock = { expiresAt: Date.now() + DRAIN_LOCK_MS };
  try {
    if (snap.exists) await ref.update(lock, { lastUpdateTime: snap.updateTime });
    else await ref.create(lock);
    return true;
  } catch (err) {
    if (LOCK_TAKEN.has((err as { code?: number }).code ?? 0)) return false;
    throw err;
  }
}

/**
 * drain a site's queue until it is empty or `deadline` passes. the drain lock only
 * lets one drainer work through a burst while the other triggers return; two
 * drainers at once stay correct because every batch is its own transaction.
 */
export async function drainSite(
  db: Firestore,
  siteId: string,
  deadline = Date.now() + DRAIN_BUDGET_MS,
): Promise<void> {
  const lock = siteDoc(db, siteId).collection('audit_log_meta').doc('drain_lock');
  while (Date.now() < deadline) {
    // the holder drains, and the sweeper takes over once a dead holder's lock lapses
    if (!(await takeDrainLock(lock))) return;
    try {
      let oneAtATime = false;
      while (Date.now() < deadline) {
        let taken: number;
        try {
          taken = oneAtATime ? await drainOne(db, siteId) : await drainBatch(db, siteId);
        } catch (err) {
          if (oneAtATime || !isRefused(err)) throw err;
          // a batch that will not commit is worked through one event at a time, for the rest of this run
          oneAtATime = true;
          continue;
        }
        if (taken === 0) break;
        await lock.set({ expiresAt: Date.now() + DRAIN_LOCK_MS });
      }
    } finally {
      // a lock that fails to release lapses on its own
      await lock.delete().catch(() => undefined);
    }
    // a trigger that fired after the last batch but before the release saw the
    // lock held and returned, so its event is still queued
    if ((await oldestQueued(db, siteId, 1).get()).empty) return;
  }
}

/**
 * drain every site with queued events, so no event depends on its own trigger.
 * one read per such site: the scan resumes past the end of each site's queue.
 */
export async function drainQueuedSites(
  db: Firestore,
  deadline = Date.now() + DRAIN_BUDGET_MS,
): Promise<void> {
  let after = '';
  while (Date.now() < deadline) {
    // document-name order only, so this collection-group read needs no composite index
    let scan = db.collectionGroup('audit_queue').orderBy(FieldPath.documentId()).limit(1);
    if (after) scan = scan.startAfter(after);
    const [doc] = (await scan.get()).docs;
    if (!doc) return;
    const site = doc.ref.parent.parent;
    if (site) {
      try {
        await drainSite(db, site.id, deadline);
      } catch (err) {
        // one site that cannot drain this minute must not hold back the sites after it
        console.error(`[auditLog] sweep could not drain ${site.id}: ${(err as Error).message}`);
      }
    }
    after = site ? `${site.path}/audit_queue/\uf8ff` : doc.ref.path;
  }
}

export interface VerifyResult {
  ok: boolean;
  records: number;
  brokenAt?: number;
  reason?: string;
}

export async function verifySiteChain(
  siteId: string,
  store: AuditStore,
): Promise<VerifyResult> {
  const chain = await store.readChain(siteId);
  const result = verifyChain(chain, { assertGenesis: true });
  if (result.ok) return { ok: true, records: chain.length };
  return {
    ok: false,
    records: chain.length,
    brokenAt: result.brokenAt,
    reason: result.reason,
  };
}

export interface ExportDeps {
  store: AuditStore;
  exporter: AuditExporter;
  directory: { listSiteIds(): Promise<string[]> };
  batchSize?: number;
}

export async function exportAllSites(
  deps: ExportDeps,
): Promise<{ siteId: string; exported: number }[]> {
  const batchSize = deps.batchSize ?? 500;
  const siteIds = await deps.directory.listSiteIds();
  const out: { siteId: string; exported: number }[] = [];

  for (const siteId of siteIds) {
    try {
      const chain = await deps.store.readChain(siteId);
      // Batched so a giant chain never sits in memory at once.
      let exported = 0;
      for (let i = 0; i < chain.length; i += batchSize) {
        const batch = chain.slice(i, i + batchSize);
        await deps.exporter.exportBatch(batch);
        exported += batch.length;
      }
      out.push({ siteId, exported });
    } catch (err) {
      console.error(
        `[auditLog] export failed for ${siteId}: ${(err as Error).message}`,
      );
    }
  }
  return out;
}

/**
 * web builds from before the queue post here. it enqueues like the web does,
 * so the drainer stays the chain's only writer.
 */
export const recordAuditEvent = onRequest(
  { timeoutSeconds: 15, memory: '256MiB' },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }
    if (!requireInternalSecret(req, res)) return;
    const validated = canonicaliseEvent((req.body ?? {}) as Partial<AuditEvent>);
    if (!validated.ok) {
      res.status(400).json({ error: validated.reason });
      return;
    }
    const queued = await siteDoc(getFirestore(), validated.event.siteId)
      .collection('audit_queue')
      .add({ event: validated.event, enqueuedAt: FieldValue.serverTimestamp() });
    res.status(202).json({ queued: queued.id });
  },
);

export const onAuditQueued = onDocumentCreated(
  { document: 'sites/{siteId}/audit_queue/{eventId}', timeoutSeconds: 120 },
  (event) => drainSite(getFirestore(), event.params.siteId),
);

export const sweepAuditQueue = onSchedule(
  { schedule: 'every 1 minutes', timeoutSeconds: 120 },
  () => drainQueuedSites(getFirestore()),
);

export const verifyAuditChain = onRequest(
  { timeoutSeconds: 30, memory: '512MiB' },
  async (req, res) => {
    if (!requireInternalSecret(req, res)) return;
    const siteId = String(req.query.siteId ?? '');
    if (!siteId) {
      res.status(400).json({ error: 'siteId_required' });
      return;
    }
    const result = await verifySiteChain(siteId, getDefaultStore());
    res.status(result.ok ? 200 : 422).json(result);
  },
);

/** Daily at 05:15 UTC — after 04:30 telemetry, last of the night. */
export const exportAuditDaily = onSchedule(
  { schedule: '15 5 * * *', timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    const exporter = getDefaultExporter();
    if (!exporter) {
      // the export reads every site's whole chain, so it must not run with nowhere to send it
      console.log('[auditLog] daily export skipped: no audit sink is wired');
      return;
    }
    const results = await exportAllSites({
      store: getDefaultStore(),
      exporter,
      directory: getDefaultDirectory(),
    });
    const totalExported = results.reduce((n, r) => n + r.exported, 0);
    console.log(
      `[auditLog] daily export complete: sites=${results.length} records=${totalExported} retention_days=${AUDIT_RETENTION_DAYS}`,
    );
  },
);

function getDefaultStore(): AuditStore {
  const db = getFirestore();
  return {
    async readChain(siteId: string, limit?: number) {
      let q = siteDoc(db, siteId).collection('audit_log').orderBy('recordedAt', 'asc');
      if (typeof limit === 'number') q = q.limit(limit);
      const snap = await q.get();
      return snap.docs.map((d) => d.data() as AuditRecord);
    },
  };
}

function getDefaultDirectory() {
  const db = getFirestore();
  return {
    async listSiteIds() {
      const snap = await db.collection('sites').listDocuments();
      return snap.map((d) => d.id);
    },
  };
}

function getDefaultExporter(): AuditExporter | null {
  // TODO(wave 0.6): wire BigQuery. Until then the firestore chain is
  // authoritative and 7-year retention holds because no delete job runs
  // (firestore has no auto-TTL on this path).
  return null;
}
