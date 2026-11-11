// @auth-bypass: self-delete is "actor IS target" — `authorizedSiteHandler` needs
// site access (the user may have none) and `authorizedPlatformHandler` needs
// superadmin. Auth + capability + audit are enforced inline below.
/**
 * DELETE /api/users/me — server-side account self-deletion cascade.
 *
 * Authoritative replacement for the client-side `writeBatch` cascade in
 * AuthContext.deleteAccount. Re-authentication and Firebase Auth account
 * deletion stay client-side: credentials must not cross the security boundary.
 *
 * Auth: session cookie or freshly-issued id token only, never an API key — a key
 * holder must not be able to delete the account remotely (that is the superadmin
 * `DELETE /api/users/{uid}`). Capability USER_SELF_DELETE is gated inline because
 * the shared handler wrappers don't support the "actor IS target" shape.
 *
 * Audit: one entry in `global/audit_log/{entryId}` carrying per-path delete
 * counts. `?dryRun=1` scans without deleting. Idempotent — progress lives at
 * `users/{userId}/account_deletion/operation`, so a retry with the same
 * Idempotency-Key (or synthesised operation id) returns the recorded outcome.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';
import {
  problem,
  problemForbidden,
  problemFromError,
  problemUnauthorized,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  ApiAuthError,
  requireSessionOrIdToken,
} from '@/lib/apiAuth.server';
import {
  Capability,
  hasCapability,
  siteStanding,
  type Actor,
  type Role,
  type UserActor,
} from '@/lib/capabilities';
import { securityConfig } from '@/lib/securityConfig.server';
import { generateCorrelationId } from '@/lib/auditLog.server';
import { deleteOwnAccount } from '@/lib/actions/deleteOwnAccount.server';
import logger from '@/lib/logger';

interface ActorRecord {
  actor: UserActor;
  userId: string;
  role: Role;
}

/**
 * Resolve the caller into a UserActor. API-key auth is refused: self-delete is a
 * "you, in person" action.
 */
async function resolveSelfActor(request: NextRequest): Promise<ActorRecord> {
  // requireSessionOrIdToken already ignores `owk_*` bearers; an explicit 401 here
  // helps callers diagnose a misconfigured CLI.
  const apiHeader =
    request.headers.get('x-api-key') ||
    request.nextUrl.searchParams.get('api_key');
  if (apiHeader && apiHeader.startsWith('owk_')) {
    throw new ApiAuthError(401, 'self-delete requires a session or id-token, not an api key');
  }

  const userId = await requireSessionOrIdToken(request);

  // User doc hard-deleted meanwhile → least privilege; the cascade short-circuits.
  const db = getAdminDb();
  const userDoc = await db.collection('users').doc(userId).get();
  const data = userDoc.exists ? userDoc.data() : null;
  const rawRole = data?.role;
  const role: Role =
    rawRole === 'superadmin' || rawRole === 'admin' ? rawRole : 'member';
  // No site is in scope: USER_SELF_DELETE is a platform capability, so no
  // per-site standing is resolved and nothing site-scoped is reachable here.
  const actor: UserActor = { type: 'user', userId, role, ...siteStanding([]) };
  return { actor, userId, role };
}

interface PlatformAuditEntry {
  correlationId: string;
  actor: { type: 'user'; userId: string; role: Role };
  capability: typeof Capability.USER_SELF_DELETE;
  target: { kind: 'user'; id: string };
  outcome: 'allow' | 'deny' | 'error';
  metadata?: Record<string, unknown>;
  denyReason?: string;
  errorCode?: string;
  enforcementBypassed?: boolean;
}

/** Inline platform audit writer, mirroring authorizedPlatformHandler's private one. */
async function writeSelfDeleteAudit(
  entry: PlatformAuditEntry,
  blocking: boolean,
): Promise<void> {
  const db = getAdminDb();
  const docRef = db
    .collection('global')
    .doc('audit_log')
    .collection('entries')
    .doc();

  const payload: Record<string, unknown> = {
    correlationId: entry.correlationId,
    actor: entry.actor,
    capability: entry.capability,
    target: entry.target,
    outcome: entry.outcome,
    timestamp: FieldValue.serverTimestamp(),
  };
  if (entry.metadata !== undefined) payload.metadata = entry.metadata;
  if (entry.denyReason !== undefined) payload.denyReason = entry.denyReason;
  if (entry.errorCode !== undefined) payload.errorCode = entry.errorCode;
  if (entry.enforcementBypassed !== undefined) {
    payload.enforcementBypassed = entry.enforcementBypassed;
  }

  if (blocking) {
    await docRef.set(payload);
  } else {
    void docRef.set(payload).catch((err) => {
      logger.error('self-delete audit write failed (fire-and-forget)', {
        context: 'users/me',
        data: {
          correlationId: entry.correlationId,
          outcome: entry.outcome,
          err: err instanceof Error ? err.message : String(err),
        },
      });
    });
  }
}

/**
 * Stable operation id for the action core's progress doc: derived from
 * `Idempotency-Key` when sent, else a per-user fixed id so concurrent retries
 * during a blip collapse onto one record. A fresh random id per request would
 * defeat the action core's resumability guarantee.
 */
function deriveOperationId(request: NextRequest, userId: string): string {
  const header = request.headers.get('idempotency-key');
  if (header && header.length > 0) {
    return crypto.createHash('sha256').update(`${userId}:${header}`).digest('hex');
  }
  return crypto.createHash('sha256').update(`account-self-delete:${userId}`).digest('hex');
}

export async function DELETE(request: NextRequest) {
  const correlationId = generateCorrelationId();

  // 1. Resolve auth
  let actorRecord: ActorRecord;
  try {
    actorRecord = await resolveSelfActor(request);
  } catch (err) {
    if (err instanceof ApiAuthError) {
      if (err.status === 401) return problemUnauthorized(err.message);
      if (err.status === 403) return problemForbidden(err.message);
      return problem({
        type: ProblemType.Internal,
        title: 'authorization error',
        status: err.status,
        detail: err.message,
      });
    }
    return problemFromError(err, 'users/me:DELETE');
  }
  const { actor, userId, role } = actorRecord;

  // 2. Capability gate (kill-switch aware)
  let config: { capability_enforcement: boolean };
  try {
    config = await securityConfig.read();
  } catch (err) {
    logger.error('[users/me:DELETE] securityConfig read failed', {
      context: 'users/me',
      data: { err: err instanceof Error ? err.message : String(err) },
    });
    return problem({
      type: ProblemType.ServiceUnavailable,
      title: 'service unavailable',
      status: 503,
      detail: 'security config unavailable',
    });
  }

  const enforcementBypassed = !config.capability_enforcement;
  if (config.capability_enforcement) {
    const ok = hasCapability(actor as Actor, Capability.USER_SELF_DELETE);
    if (!ok) {
      void writeSelfDeleteAudit(
        {
          correlationId,
          actor: { type: 'user', userId, role },
          capability: Capability.USER_SELF_DELETE,
          target: { kind: 'user', id: userId },
          outcome: 'deny',
          denyReason: 'capability_missing',
          metadata: { route: request.nextUrl.pathname, method: 'DELETE' },
        },
        false,
      );
      return problemForbidden('capability not granted');
    }
  }

  // 3. Parse query params
  const dryRunParam = request.nextUrl.searchParams.get('dryRun');
  const dryRun =
    dryRunParam === '1' || dryRunParam === 'true' || dryRunParam === 'yes';

  const operationId = deriveOperationId(request, userId);

  // 4. Run the cascade
  let result;
  try {
    result = await deleteOwnAccount({
      userId,
      dryRun,
      operationId,
    });
  } catch (err) {
    void writeSelfDeleteAudit(
      {
        correlationId,
        actor: { type: 'user', userId, role },
        capability: Capability.USER_SELF_DELETE,
        target: { kind: 'user', id: userId },
        outcome: 'error',
        errorCode: err instanceof Error ? err.name : 'cascade_error',
        metadata: {
          route: request.nextUrl.pathname,
          method: 'DELETE',
          dryRun,
          operationId,
        },
        enforcementBypassed,
      },
      false,
    );
    return problemFromError(err, 'users/me:DELETE');
  }

  // 4a. Owner of a site with other members must transfer ownership first.
  //     Audited as a deny so the refusal is logged.
  if (result.kind === 'needs_successor') {
    void writeSelfDeleteAudit(
      {
        correlationId,
        actor: { type: 'user', userId, role },
        capability: Capability.USER_SELF_DELETE,
        target: { kind: 'user', id: userId },
        outcome: 'deny',
        denyReason: 'needs_successor',
        metadata: {
          route: request.nextUrl.pathname,
          method: 'DELETE',
          ownedSharedSites: result.ownedSharedSites,
          operationId,
        },
        enforcementBypassed,
      },
      false,
    );
    return problem({
      type: ProblemType.Conflict,
      title: 'cannot delete: account owns shared sites',
      status: 409,
      detail:
        'you own one or more sites with other members; transfer ownership to another admin before deleting your account',
      instance: request.nextUrl.pathname,
      code: 'needs_successor',
      ownedSharedSites: result.ownedSharedSites,
    });
  }

  // 5. Allow audit, blocking and BEFORE the response: a failed write must surface
  //    as 503 — privileged actions never run untracked. Counts ride in metadata.
  try {
    await writeSelfDeleteAudit(
      {
        correlationId,
        actor: { type: 'user', userId, role },
        capability: Capability.USER_SELF_DELETE,
        target: { kind: 'user', id: userId },
        outcome: 'allow',
        metadata: {
          route: request.nextUrl.pathname,
          method: 'DELETE',
          dryRun: result.dryRun,
          operationId: result.operationId,
          alreadyCompleted: result.alreadyCompleted,
          deletedCounts: result.deletedCounts,
          siteCount: result.sites.length,
          siteClassification: result.siteClassification,
          authRevoked: result.authRevoked,
        },
        enforcementBypassed,
      },
      true,
    );
  } catch (err) {
    logger.error('[users/me:DELETE] allow-audit write failed; refusing response', {
      context: 'users/me',
      data: {
        correlationId,
        userId,
        err: err instanceof Error ? err.message : String(err),
      },
    });
    return problem({
      type: ProblemType.ServiceUnavailable,
      title: 'service unavailable',
      status: 503,
      detail: 'audit log unavailable; refusing privileged action',
    });
  }

  // 6. Response
  return NextResponse.json({
    userId: result.userId,
    operationId: result.operationId,
    correlationId,
    performed: result.performed,
    alreadyCompleted: result.alreadyCompleted,
    dryRun: result.dryRun,
    sites: result.sites,
    siteClassification: result.siteClassification,
    deletedCounts: result.deletedCounts,
    authRevoked: result.authRevoked,
    // Dry-runs return every would-delete path; live runs return only the head
    // (the action core truncates the persisted slice the same way).
    deletedPaths: result.dryRun
      ? result.deletedPaths
      : result.deletedPaths.slice(0, 200),
  });
}
