/**
 * GET /api/sites/{siteId}/audit-log/{recordHash}
 *     → Full audit record + hash-chain verification result. The chain is
 *       tamper-evident: we recompute the record's own hash and compare to
 *       the stored hash (internal integrity), and fetch the predecessor
 *       (by the stored `previousHash`) to verify linkage into the chain.
 *       Site admins and owners only (`requireAuditLogCapability`).
 *
 * roost public api wave 3.8.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { timestampToMs } from '@/lib/firestoreTime.server';
import {
  problem,
  problemFromError,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  GENESIS_HASH,
  verifyRecord,
  type AuditRecord,
} from '@/lib/auditLogVerify';
import {
  applyAuthDeprecations,
  requireAuditLogCapability,
  requireSiteAuthAndScope,
} from '../../../../_shared';

interface RouteParams {
  params: Promise<{ siteId: string; recordHash: string }>;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId, recordHash } = await params;
    if (!SHA256_HEX_RE.test(recordHash)) {
      return problemValidation('recordHash must be a 64-char lowercase sha-256 hex', {
        recordHash: ['must match ^[0-9a-f]{64}$'],
      });
    }

    const auth = await requireSiteAuthAndScope(request, siteId, 'read');
    if (!auth.ok) return auth.response;

    const capabilityError = await requireAuditLogCapability(auth.auth, siteId);
    if (capabilityError) return capabilityError;

    const db = getAdminDb();
    const col = db.collection('sites').doc(siteId).collection('audit_log');
    const recordSnap = await col.doc(recordHash).get();
    if (!recordSnap.exists) {
      return problem({
        type: ProblemType.NotFound,
        title: 'audit record not found',
        status: 404,
        detail: `record ${recordHash} not found on site ${siteId}`,
        instance: `/api/sites/${siteId}/audit-log/${recordHash}`,
      });
    }

    const raw = recordSnap.data() ?? {};
    const record = normalise(raw, recordHash);
    if (!record) {
      return problem({
        type: ProblemType.Conflict,
        title: 'audit record malformed',
        status: 409,
        detail: `record ${recordHash} is missing required fields; chain cannot be verified`,
        instance: `/api/sites/${siteId}/audit-log/${recordHash}`,
      });
    }

    // Predecessor lookup: by stored previousHash. Skip when this is the
    // genesis record (no predecessor exists by definition).
    let predecessorRecord: AuditRecord | null = null;
    let predecessorPresent = false;
    if (record.previousHash !== GENESIS_HASH) {
      const prevSnap = await col.doc(record.previousHash).get();
      predecessorPresent = prevSnap.exists;
      if (prevSnap.exists) {
        predecessorRecord = normalise(prevSnap.data() ?? {}, record.previousHash);
      }
    }

    const baseVerification = verifyRecord(record, predecessorRecord);
    const verification =
      baseVerification.hashValid &&
      !baseVerification.isGenesis &&
      predecessorRecord === null
        ? {
            ...baseVerification,
            ok: false,
            linkageValid: false,
            reason: predecessorPresent ? 'predecessor_malformed' : 'predecessor_missing',
          }
        : baseVerification;

    return applyAuthDeprecations(
      NextResponse.json({
        siteId,
        hash: record.hash,
        previousHash: record.previousHash,
        recordedAt: record.recordedAt,
        event: record.event,
        verification: {
          ok: verification.ok,
          hashValid: verification.hashValid,
          linkageValid: verification.linkageValid ?? null,
          isGenesis: verification.isGenesis,
          predecessorPresent,
          reason: verification.reason ?? null,
        },
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/sites/[siteId]/audit-log/[recordHash]:GET');
  }
}

function normalise(raw: Record<string, unknown>, fallbackHash: string): AuditRecord | null {
  const event = raw.event as Record<string, unknown> | undefined;
  if (
    !event ||
    typeof event.kind !== 'string' ||
    typeof event.siteId !== 'string' ||
    typeof event.actor !== 'string' ||
    typeof event.occurredAt !== 'number'
  ) {
    return null;
  }
  const recordedAt = timestampToMs(raw.recordedAt);
  if (recordedAt === null) return null;
  const attributes =
    event.attributes && typeof event.attributes === 'object' && !Array.isArray(event.attributes)
      ? (event.attributes as Record<string, unknown>)
      : {};
  const target = typeof event.target === 'string' ? event.target : undefined;
  return {
    event: {
      kind: event.kind,
      siteId: event.siteId,
      actor: event.actor,
      ...(target !== undefined ? { target } : {}),
      occurredAt: event.occurredAt,
      attributes,
    },
    recordedAt,
    previousHash: typeof raw.previousHash === 'string' ? raw.previousHash : GENESIS_HASH,
    hash: typeof raw.hash === 'string' ? raw.hash : fallbackHash,
  };
}
