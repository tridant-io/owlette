/**
 * GET    /api/sites/{siteId}/machines/{machineId}/swoop/sessions/{sessionId}
 * DELETE /api/sites/{siteId}/machines/{machineId}/swoop/sessions/{sessionId}
 *
 * Read the state of a live session, or end it. The session document holds no
 * key material by construction (`lib/swoop/sessionStore.server.ts`), so the GET
 * body is safe to hand a site member as it stands.
 *
 * DELETE ends the record and then stops the streamer over the two independent
 * paths: the worker broadcast (<= 2 s, authoritative) and the polled command
 * (last resort). Neither failing withholds the 200 — the record is already
 * ended, and a streamer that survives both is stopped by its own lease.
 */

import { NextResponse } from 'next/server';
import {
  problemFromError,
  problemNotFound,
  problemValidation,
} from '@/lib/apiErrors';
import { applyAuthDeprecations, readAndParseJsonBody } from '@/app/api/_shared';
import { authorizedSiteHandler, type SiteRouteHandler } from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import logger from '@/lib/logger';
import { evaluateSwoopAccess } from '@/lib/swoop/policy.server';
import {
  endSwoopSession,
  getSwoopSession,
  type SwoopSessionEndReason,
} from '@/lib/swoop/sessionStore.server';
import { killSession } from '@/lib/swoop/signal.server';
import { requestSwoopSession } from '@/lib/actions/requestSwoopSession.server';
import {
  apiKeyRefusal,
  decisionProblem,
  isValidSid,
  swoopGate,
  type SwoopRouteParams,
} from '../../_shared';

/**
 * Reasons an operator may name. The machine-side reasons (`idle`,
 * `lease_expired`, `session_cap`) are recorded by the host, never claimed by a
 * caller, so accepting them here would let a viewer forge the audit trail.
 */
const CALLER_END_REASONS: ReadonlySet<string> = new Set<SwoopSessionEndReason>([
  'closed',
  'killed',
  'revoked',
]);

const readHandler: SiteRouteHandler<SwoopRouteParams> = async (request, ctx, { params }) => {
  try {
    const keyRefusal = apiKeyRefusal(ctx);
    if (keyRefusal) return keyRefusal;

    const { machineId, sessionId } = await params;
    if (!isValidSid(sessionId)) return problemValidation('invalid session id');

    const gate = await swoopGate({ request, ctx, machineId, intent: 'view' });
    const decision = evaluateSwoopAccess({ ...gate.input, stepUpOpen: false });
    if (!decision.ok) return decisionProblem(decision);

    const session = await getSwoopSession(ctx.siteId, machineId, sessionId);
    if (!session) return problemNotFound('session not found');

    return applyAuthDeprecations(
      NextResponse.json({
        ok: true,
        data: {
          sid: session.sid,
          state: session.state,
          createdBy: session.createdBy,
          startedAt: session.startedAt,
          absoluteExpiresAt: session.absoluteExpiresAt,
          viewers: session.viewers,
          ...(session.endReason ? { endReason: session.endReason } : {}),
          ...(session.endedAt ? { endedAt: session.endedAt } : {}),
        },
      }),
      ctx.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/machines/[machineId]/swoop/sessions/[sessionId]:GET');
  }
};

const deleteHandler: SiteRouteHandler<SwoopRouteParams> = async (request, ctx, { params }) => {
  try {
    const keyRefusal = apiKeyRefusal(ctx);
    if (keyRefusal) return keyRefusal;

    const { machineId, sessionId } = await params;
    const siteId = ctx.siteId;
    if (!isValidSid(sessionId)) return problemValidation('invalid session id');

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const raw = (parsed.body ?? {}) as { endReason?: unknown };
    if (raw.endReason !== undefined && !CALLER_END_REASONS.has(String(raw.endReason))) {
      return problemValidation('field `endReason` is not one a caller may set', {
        endReason: [[...CALLER_END_REASONS].sort().join(', ')],
      });
    }
    const endReason = (raw.endReason ?? 'closed') as SwoopSessionEndReason;

    const gate = await swoopGate({ request, ctx, machineId, intent: 'view' });
    const decision = evaluateSwoopAccess({ ...gate.input, stepUpOpen: false });
    if (!decision.ok) return decisionProblem(decision);

    const session = await getSwoopSession(siteId, machineId, sessionId);
    if (!session) return problemNotFound('session not found');

    await endSwoopSession({ siteId, machineId, sid: sessionId, endReason });

    const [killed, queued] = await Promise.allSettled([
      killSession({ siteId, machineId, sid: sessionId }),
      requestSwoopSession({
        type: 'swoop_kill',
        sid: sessionId,
        siteId,
        machineId,
        actor: ctx.actor,
        auditActor: `user:${ctx.actor.userId}`,
        correlationId: ctx.correlationId,
      }),
    ]);
    if (killed.status === 'fulfilled' && !killed.value.ok) {
      logger.warn('[swoop/sessions] kill broadcast failed; falling back to the polled command', {
        context: 'swoop/sessions',
        data: { siteId, machineId, reason: killed.value.reason },
      });
    }
    if (queued.status === 'rejected') {
      logger.warn('[swoop/sessions] kill command could not be queued', {
        context: 'swoop/sessions',
        data: {
          siteId,
          machineId,
          err: queued.reason instanceof Error ? queued.reason.message : String(queued.reason),
        },
      });
    }

    return applyAuthDeprecations(
      NextResponse.json({ ok: true, data: { sid: sessionId, state: 'ended', endReason } }),
      ctx.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/machines/[machineId]/swoop/sessions/[sessionId]:DELETE');
  }
};

const sharedHandlerOptions = {
  siteIdParam: 'path' as const,
  targetKind: 'machine' as const,
  targetIdParam: 'machineId',
};

export const GET = authorizedSiteHandler<SwoopRouteParams>({
  capability: Capability.MACHINE_REMOTE_VIEW,
  ...sharedHandlerOptions,
  apiKeyScope: {
    resource: 'machine' as const,
    idParam: 'machineId',
    permission: 'read' as const,
  },
})(readHandler);

// Ending a session sits on the watch bar on purpose: anyone who may be in the
// room may leave it, and stopping a stream is never the dangerous direction.
export const DELETE = authorizedSiteHandler<SwoopRouteParams>({
  capability: Capability.MACHINE_REMOTE_VIEW,
  ...sharedHandlerOptions,
  apiKeyScope: {
    resource: 'machine' as const,
    idParam: 'machineId',
    permission: 'write' as const,
  },
})(deleteHandler);
