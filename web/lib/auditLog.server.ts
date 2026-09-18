/**
 * audit log writer (security-boundary-migration wave 1.3).
 *
 * Writes authorization decisions to `sites/{siteId}/audit_log/{entryId}` — exactly one
 * entry per (correlationId, outcome), for user, api-key and system actors alike. The
 * `correlationId` is also stamped onto the state docs an action produces (commands,
 * deployments) so an investigator can pivot between state and authorization context.
 *
 * `writeAuditEntry` is fire-and-forget and never throws — default for deny/error.
 * `writeAuditEntryBlocking` must be awaited so a failed audit fails the request closed
 * (503) instead of letting a privileged action through unrecorded (wave 2.1 allows).
 *
 * `enforcementBypassed: true` means a kill switch was active at decision time; also
 * logged at warn level so ops see kill-switch usage without querying firestore.
 */

import crypto from 'crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import type { Capability } from '@/lib/capabilities';
import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';
import { emitSecurityBoundaryMetric } from '@/lib/securityBoundaryMetrics.server';

export type { Capability };

export type Role = 'member' | 'admin' | 'superadmin';

export type SystemActorName =
  | 'cortex_autonomous'
  | 'cortex_provisioning'
  | 'scheduled_cleanup'
  // the swoop streamer reporting its own lifecycle and refusals through
  // `POST /api/agent/swoop/events`. An audit SUBJECT only — it invokes nothing,
  // so it is deliberately absent from `capabilities.ts`'s system matrix.
  | 'swoop_host'
  | 'talon_runner';

export type UserActor = {
  type: 'user';
  userId: string;
  apiKeyId?: string;
  role: Role;
};

export type SystemActor = {
  type: 'system';
  name: SystemActorName;
};

export type AuditActor = UserActor | SystemActor;

export type AuditTargetKind =
  | 'site'
  | 'machine'
  | 'deployment'
  | 'distribution'
  | 'user'
  | 'process'
  | 'preset'
  | 'installer'
  | 'talon';

export interface AuditTarget {
  kind: AuditTargetKind;
  id: string;
  /** Optional — set when the target is scoped to a specific machine. */
  machineId?: string;
}

export type AuditOutcome = 'allow' | 'deny' | 'error';

export interface AuditEntry {
  /** Stable join key tying this decision to any related state writes. */
  correlationId: string;
  actor: AuditActor;
  capability: Capability;
  target: AuditTarget;
  outcome: AuditOutcome;
  metadata?: Record<string, unknown>;
  /** Required when `outcome === 'deny'` so triage tools can group denies. */
  denyReason?: string;
  /** Required when `outcome === 'error'` for the same reason. */
  errorCode?: string;
  /** True when a kill switch was active at decision time. */
  enforcementBypassed?: boolean;
  /** Stamped server-side at write time; callers should not pre-fill. */
  timestamp: Timestamp;
}

/** Caller-facing entry shape — `timestamp` is filled by the writer. */
export type AuditEntryInput = Omit<AuditEntry, 'timestamp'>;

const AUDIT_LOG_COLLECTION = 'audit_log';

/**
 * Fresh correlation id: URL-safe, 22 hex chars (88 bits — collision-resistant well past
 * audit retention). Embed it in state docs to pivot from a state row to its audit row.
 */
export function generateCorrelationId(): string {
  return crypto.randomBytes(11).toString('hex');
}

/**
 * Fire-and-forget audit write. Never throws, never blocks — for deny/error outcomes where
 * the response is already decided and an audit failure shouldn't change it.
 */
export function writeAuditEntry(siteId: string, entry: AuditEntryInput): void {
  void writeAuditEntryInternal(siteId, entry).catch((err) => {
    emitAuditWriteFailure(siteId, entry, err);
    logger.error('audit log write failed (fire-and-forget)', {
      context: 'auditLog',
      data: {
        siteId,
        correlationId: entry.correlationId,
        capability: entry.capability,
        outcome: entry.outcome,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  });
}

/**
 * Awaitable audit write; rejects on failure so `allow` outcomes fail the request closed
 * (503) rather than letting a privileged action through with no record.
 */
export async function writeAuditEntryBlocking(
  siteId: string,
  entry: AuditEntryInput,
): Promise<void> {
  try {
    await writeAuditEntryInternal(siteId, entry);
  } catch (err) {
    emitAuditWriteFailure(siteId, entry, err);
    throw err;
  }
}

/**
 * Awaitable write to the PLATFORM sink at `global/audit_log/entries`, for records
 * that must outlive the site they describe.
 *
 * Site audit rows live at `sites/{siteId}/audit_log/` — a subcollection of the site
 * document — so a site deletion destroys its own evidence, including the record of
 * the deletion. Anything auditing the destruction of a site (or of any other
 * audited container) writes here instead, BEFORE the cascade begins, and rejects on
 * failure so the caller can refuse to proceed unrecorded.
 */
export async function writeGlobalAuditEntryBlocking(
  entry: AuditEntryInput,
  /** Injected by callers that already hold an instance (and by tests); production omits. */
  db?: FirebaseFirestore.Firestore,
): Promise<void> {
  const database = db ?? getAdminDb();
  const docRef = database.collection('global').doc('audit_log').collection('entries').doc();

  const payload: Record<string, unknown> = {
    correlationId: entry.correlationId,
    actor: entry.actor,
    capability: entry.capability,
    target: stripUndefined({ ...entry.target } as Record<string, unknown>),
    outcome: entry.outcome,
    timestamp: FieldValue.serverTimestamp(),
  };
  if (entry.metadata !== undefined) payload.metadata = entry.metadata;
  if (entry.denyReason !== undefined) payload.denyReason = entry.denyReason;
  if (entry.errorCode !== undefined) payload.errorCode = entry.errorCode;
  if (entry.enforcementBypassed !== undefined) {
    payload.enforcementBypassed = entry.enforcementBypassed;
  }

  try {
    await docRef.set(payload);
  } catch (err) {
    emitAuditWriteFailure('__platform__', entry, err);
    throw err;
  }

  emitSecurityBoundaryMetric('capability_decision_total', 1, {
    labels: {
      outcome: entry.outcome,
      capability: entry.capability,
      role: actorRoleLabel(entry.actor),
      site: '__platform__',
    },
    fields: { correlationId: entry.correlationId, target: entry.target },
  });
}

async function writeAuditEntryInternal(
  siteId: string,
  entry: AuditEntryInput,
): Promise<void> {
  if (!siteId) {
    throw new Error('writeAuditEntry: siteId is required');
  }

  // Warn level too, so ops see enforcement being switched off without tailing firestore.
  if (entry.enforcementBypassed) {
    logger.warn('authorization enforcement bypassed', {
      context: 'auditLog',
      data: {
        siteId,
        correlationId: entry.correlationId,
        actor: redactActorForLog(entry.actor),
        capability: entry.capability,
        outcome: entry.outcome,
        target: entry.target,
        metadata: entry.metadata,
      },
    });
    emitSecurityBoundaryMetric('authorization_enforcement_bypass_total', 1, {
      severity: 'warning',
      labels: {
        site: siteId,
        capability: entry.capability,
        outcome: entry.outcome,
        role: actorRoleLabel(entry.actor),
        bypass: String(entry.metadata?.enforcement_bypassed ?? 'unknown'),
      },
      fields: {
        correlationId: entry.correlationId,
        target: entry.target,
      },
    });
  }

  const db = getAdminDb();
  const docRef = db
    .collection('sites')
    .doc(siteId)
    .collection(AUDIT_LOG_COLLECTION)
    .doc();

  // serverTimestamp() at write time so the persisted value is authoritative server time,
  // not the handler's idea of "now". The in-memory type says `Timestamp` — what reads see.
  const payload: Record<string, unknown> = {
    correlationId: entry.correlationId,
    actor: entry.actor,
    capability: entry.capability,
    target: stripUndefined({ ...entry.target } as Record<string, unknown>),
    outcome: entry.outcome,
    timestamp: FieldValue.serverTimestamp(),
  };
  if (entry.metadata !== undefined) payload.metadata = entry.metadata;
  if (entry.denyReason !== undefined) payload.denyReason = entry.denyReason;
  if (entry.errorCode !== undefined) payload.errorCode = entry.errorCode;
  if (entry.enforcementBypassed !== undefined) {
    payload.enforcementBypassed = entry.enforcementBypassed;
  }

  await docRef.set(payload);
  emitSecurityBoundaryMetric('capability_decision_total', 1, {
    labels: {
      outcome: entry.outcome,
      capability: entry.capability,
      role: actorRoleLabel(entry.actor),
      site: siteId,
    },
    fields: {
      correlationId: entry.correlationId,
      target: entry.target,
      denyReason: entry.denyReason,
      errorCode: entry.errorCode,
      enforcementBypassed: entry.enforcementBypassed,
    },
  });
}

/** Drop `undefined`-valued keys — firestore admin sdk rejects them. */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(obj) as Array<keyof T>) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

/**
 * Redact actor identity for log lines (the audit row keeps the full record): keeps type +
 * role/name but trims user ids to a prefix, so logs don't leak uids on kill-switch flips.
 */
function redactActorForLog(actor: AuditActor): Record<string, unknown> {
  if (actor.type === 'user') {
    return {
      type: 'user',
      role: actor.role,
      userIdPrefix: actor.userId.slice(0, 6),
      ...(actor.apiKeyId ? { apiKeyIdPrefix: actor.apiKeyId.slice(0, 8) } : {}),
    };
  }
  return { type: 'system', name: actor.name };
}

function actorRoleLabel(actor: AuditActor): string {
  if (actor.type === 'system') return `system:${actor.name}`;
  return actor.apiKeyId ? `api-key:${actor.role}` : actor.role;
}

function emitAuditWriteFailure(siteId: string, entry: AuditEntryInput, err: unknown): void {
  emitSecurityBoundaryMetric('audit_write_failures_total', 1, {
    severity: 'error',
    labels: {
      site: siteId,
      capability: entry.capability,
      outcome: entry.outcome,
      role: actorRoleLabel(entry.actor),
    },
    fields: {
      correlationId: entry.correlationId,
      error: err instanceof Error ? err.message : String(err),
    },
  });
}

/**
 * 90-day ttl cleanup for audit entries — stubbed until the scheduled-cleanup system actor
 * is wired up (wave 5.3+). Deliberately a logging no-op so accidental wiring is loud.
 */
export async function cleanupExpiredAuditEntries(): Promise<void> {
  logger.info('TODO: implement TTL cleanup in wave 5.3 or later', {
    context: 'auditLog',
  });
}
