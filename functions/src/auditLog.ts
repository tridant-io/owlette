/**
 * Append-only audit log sink. Events: signed_url_issued,
 * distribution_started, version_pointer_changed, api_key_used, gc_run.
 *
 * Hash-chained (lib/auditLogLogic.ts): each record embeds hash(prev || record)
 * so a verifier can prove nothing was modified or deleted.
 *
 * Append-only is NOT enforced here — it lives in firestore.rules, which is
 * operator-owned and must carry:
 *
 *     match /sites/{siteId}/audit_log/{recordId} {
 *       allow read:   if isSiteAdmin(siteId);
 *       allow create: if isSiteAdmin(siteId) || isServiceAccount();
 *       allow update, delete: if false;
 *     }
 */

import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore } from 'firebase-admin/firestore';
import { requireInternalSecret } from './lib/requireInternalSecret';
import {
  AUDIT_RETENTION_DAYS,
  buildAuditRecord,
  canonicaliseEvent,
  GENESIS_HASH,
  verifyChain,
  type AuditEvent,
  type AuditRecord,
} from './lib/auditLogLogic';

export interface AuditStore {
  /** Latest record hash for the site, or GENESIS_HASH — the next `previousHash`. */
  getLatestHash(siteId: string): Promise<string>;
  /**
   * Implementations MUST assert `previousHash` still matches the head inside a
   * transaction, or concurrent appends fork the chain.
   */
  append(record: AuditRecord): Promise<void>;
  /** Full chain (or a prefix) in recordedAt-ascending order. */
  readChain(siteId: string, limit?: number): Promise<AuditRecord[]>;
}

export interface AuditExporter {
  /** Ship a batch to cold storage (BigQuery in prod); called by the daily job. */
  exportBatch(records: readonly AuditRecord[]): Promise<void>;
}

export interface AppendDeps {
  store: AuditStore;
  now?: () => Date;
}

export interface AppendResult {
  ok: true;
  record: AuditRecord;
}
export interface AppendFailure {
  ok: false;
  reason: string;
}

/**
 * Validate, read head, build a chain-linked record, append. Holds no state —
 * chain continuation comes entirely from the store.
 */
export async function appendAudit(
  raw: Partial<AuditEvent> | undefined,
  deps: AppendDeps,
): Promise<AppendResult | AppendFailure> {
  const validated = canonicaliseEvent(raw);
  if (!validated.ok) return { ok: false, reason: validated.reason };

  const now = deps.now ? deps.now() : new Date();
  const previousHash = await deps.store.getLatestHash(validated.event.siteId);
  const record = buildAuditRecord(
    validated.event,
    previousHash,
    now.getTime(),
  );
  try {
    await deps.store.append(record);
  } catch (err) {
    // A concurrent writer moved the head; surface a 409 so the caller retries
    // against the new head.
    return {
      ok: false,
      reason: `append_failed: ${(err as Error).message}`,
    };
  }
  return { ok: true, record };
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

export const recordAuditEvent = onRequest(
  { timeoutSeconds: 15, memory: '256MiB' },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }
    if (!requireInternalSecret(req, res)) return;
    const result = await appendAudit(
      (req.body ?? {}) as Partial<AuditEvent>,
      { store: getDefaultStore() },
    );
    if (!result.ok) {
      res.status(result.reason.startsWith('append_failed') ? 409 : 400).json({
        error: result.reason,
      });
      return;
    }
    res.status(201).json({ recordedAt: result.record.recordedAt, hash: result.record.hash });
  },
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
  const col = (siteId: string) =>
    db.collection('sites').doc(siteId).collection('audit_log');
  const headDoc = (siteId: string) =>
    db
      .collection('sites')
      .doc(siteId)
      .collection('audit_log_meta')
      .doc('head');

  return {
    async getLatestHash(siteId: string) {
      const snap = await headDoc(siteId).get();
      const data = snap.exists
        ? (snap.data() as { hash?: string })
        : undefined;
      return data?.hash ?? GENESIS_HASH;
    },
    async append(record: AuditRecord) {
      // CAS on the head doc serialises concurrent appends to one site.
      await db.runTransaction(async (tx) => {
        const headSnap = await tx.get(headDoc(record.event.siteId));
        const currentHead = headSnap.exists
          ? ((headSnap.data() as { hash?: string }).hash ?? GENESIS_HASH)
          : GENESIS_HASH;
        if (record.previousHash !== currentHead) {
          throw new Error('head_changed_during_append');
        }
        tx.set(col(record.event.siteId).doc(record.hash), record);
        tx.set(headDoc(record.event.siteId), {
          hash: record.hash,
          recordedAt: record.recordedAt,
        });
      });
    },
    async readChain(siteId: string, limit?: number) {
      let q = col(siteId).orderBy('recordedAt', 'asc');
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
