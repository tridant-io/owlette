/**
 * GET    /api/sites/{siteId}/machines/{machineId}/swoop/sessions/{sessionId}
 * DELETE /api/sites/{siteId}/machines/{machineId}/swoop/sessions/{sessionId}
 *
 * Read the state of a live session, or leave it. The session document holds no
 * key material by construction (`lib/swoop/sessionStore.server.ts`), so the GET
 * body is safe to hand a site member as it stands.
 *
 * Several viewers share a session (PROTOCOL.md §6, §11), so DELETE takes the
 * caller's own seat out, and the session goes on for anyone still in it. The
 * last one out ends the record and stops the streamer: the worker broadcast
 * (<= 2 s, authoritative), and the polled command only when that did not land.
 * Neither failing withholds the 200 — the record is already ended, and a
 * streamer that survives both is stopped by its own lease. Ending it for the
 * others is the kill route's, behind the control capability.
 *
 * DELETE deliberately does NOT close the caller's step-up window: it sits on
 * the WATCH bar, so any member could otherwise put every admin on the machine
 * through a fresh ceremony. Closing windows is the kill route's job, and that
 * one takes the control capability.
 */

import { NextResponse } from 'next/server';
import {
  problem,
  problemFromError,
  problemNotFound,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { applyAuthDeprecations, readAndParseJsonBody } from '@/app/api/_shared';
import { authorizedSiteHandler, type SiteRouteHandler } from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import logger from '@/lib/logger';
import { evaluateSwoopAccess } from '@/lib/swoop/policy.server';
import { SWOOP_END_REASONS, isSwoopEndReason } from '@/lib/swoop/backoff';
import {
  getSwoopSession,
  removeSwoopViewers,
  type SwoopSessionEndReason,
} from '@/lib/swoop/sessionStore.server';
import { killSession, type SwoopSignalResult } from '@/lib/swoop/signal.server';
import { requestSwoopSession } from '@/lib/actions/requestSwoopSession.server';
import { recordSwoopDenied, recordSwoopSessionEnded } from '@/lib/swoop/audit.server';
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

const readHandler: SiteRouteHandler<SwoopRouteParams> = async (_request, ctx, { params }) => {
  try {
    const keyRefusal = apiKeyRefusal(ctx);
    if (keyRefusal) return keyRefusal;

    const { machineId, sessionId } = await params;
    if (!isValidSid(sessionId)) return problemValidation('invalid session id');

    const gate = await swoopGate({ ctx, machineId, intent: 'view' });
    const decision = evaluateSwoopAccess({ ...gate, stepUpOpen: false });
    if (!decision.ok) return decisionProblem(decision);

    const session = await getSwoopSession(ctx.siteId, machineId, sessionId);
    // its own code, apart from the site wrapper's `not_found` for a member no
    // longer in the site, which the page reads as its access gone with a kill.
    if (!session) {
      return problem({
        type: ProblemType.NotFound,
        title: 'not found',
        status: 404,
        detail: 'session not found',
        code: 'session_not_found',
      });
    }

    return applyAuthDeprecations(
      NextResponse.json({
        ok: true,
        data: {
          sid: session.sid,
          state: session.state,
          createdBy: session.createdBy,
          startedAt: session.startedAt,
          viewers: session.viewers,
          ...(session.endReason ? { endReason: session.endReason } : {}),
          ...(session.endedAt ? { endedAt: session.endedAt } : {}),
          // whom a revocation ended it for: everyone else in it comes back on their own.
          ...(session.endedFor ? { endedFor: session.endedFor } : {}),
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
    const { machineId, sessionId } = await params;
    const siteId = ctx.siteId;
    const auditBase = {
      siteId,
      machineId,
      ...(isValidSid(sessionId) ? { sid: sessionId } : {}),
      actor: ctx.actor,
      correlationId: ctx.correlationId,
    };

    const keyRefusal = apiKeyRefusal(ctx);
    if (keyRefusal) {
      recordSwoopDenied({
        ...auditBase,
        event: 'session_denied',
        denyReason: 'api_key_not_permitted',
        ctl: false,
      });
      return keyRefusal;
    }

    if (!isValidSid(sessionId)) return problemValidation('invalid session id');

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const raw = (parsed.body ?? {}) as { endReason?: unknown; viewerReason?: unknown; viewerId?: unknown };
    if (raw.viewerId !== undefined && !isValidSid(raw.viewerId)) {
      return problemValidation('field `viewerId` is not a viewer id', {
        viewerId: ['the viewer id the session was started or joined with'],
      });
    }
    if (raw.endReason !== undefined && !CALLER_END_REASONS.has(String(raw.endReason))) {
      return problemValidation('field `endReason` is not one a caller may set', {
        endReason: [[...CALLER_END_REASONS].sort().join(', ')],
      });
    }
    const endReason = (raw.endReason ?? 'closed') as SwoopSessionEndReason;
    // the page's own reason, kept beside the caller's `closed` so the audit
    // trail says whether the operator left or the path failed under them.
    if (raw.viewerReason !== undefined && !isSwoopEndReason(raw.viewerReason)) {
      return problemValidation('field `viewerReason` is not one the page reports', {
        viewerReason: [[...SWOOP_END_REASONS].sort().join(', ')],
      });
    }
    const viewerReason = raw.viewerReason;

    const gate = await swoopGate({ ctx, machineId, intent: 'view' });
    const decision = evaluateSwoopAccess({ ...gate, stepUpOpen: false });
    if (!decision.ok) {
      recordSwoopDenied({
        ...auditBase,
        event: 'session_denied',
        denyReason: decision.code,
        ctl: false,
      });
      return decisionProblem(decision);
    }

    const session = await getSwoopSession(siteId, machineId, sessionId);
    if (!session) return problemNotFound('session not found');

    // The page names its own seat; a caller that names none leaves every seat
    // of its own. A seat that is not the caller's answers as a missing one.
    const seats = session.viewers.filter(
      (viewer) =>
        viewer.uid === ctx.actor.userId && (raw.viewerId === undefined || viewer.viewerId === raw.viewerId),
    );
    const now = Date.now();
    const stillIn = await removeSwoopViewers({
      siteId,
      machineId,
      sid: sessionId,
      viewerIds: seats.map((viewer) => viewer.viewerId),
      // a deliberate end: the next session from that tab asks for the step-up again.
      spendContinuity: true,
      endWhenEmpty: { endReason, ...(viewerReason !== undefined ? { viewerReason } : {}) },
      nowMs: now,
    });
    if (stillIn === null) return problemNotFound('session not found');
    if (stillIn.length > 0) {
      if (seats.length === 0) return problemNotFound('session not found');
      for (const seat of seats) {
        await recordSwoopSessionEnded({
          ...auditBase,
          sid: sessionId,
          endReason,
          viewerReason,
          viewerId: seat.viewerId,
          left: true,
          durationMs: now - seat.joinedAt,
        });
      }
      return applyAuthDeprecations(
        NextResponse.json({ ok: true, data: { sid: sessionId, state: session.state, left: true } }),
        ctx.scopeCheck,
      );
    }

    // The last one out: the record ended with the seat, and the streamer stops.
    const broadcast = await killSession({ siteId, machineId, sid: sessionId }).catch(
      (): SwoopSignalResult => ({ ok: false, reason: 'unreachable' }),
    );
    // the agent's swoop_kill (4.0.1 and every earlier one) stops whatever streamer is
    // running, whatever sid it names, so a polled kill queued every time lands on the
    // next session.
    if (!broadcast.ok) {
      logger.warn('[swoop/sessions] kill broadcast failed; falling back to the polled command', {
        context: 'swoop/sessions',
        data: { siteId, machineId, reason: broadcast.reason },
      });
      try {
        await requestSwoopSession({
          type: 'swoop_kill',
          sid: sessionId,
          siteId,
          machineId,
          actor: ctx.actor,
          auditActor: `user:${ctx.actor.userId}`,
          correlationId: ctx.correlationId,
        });
      } catch (err) {
        logger.warn('[swoop/sessions] kill command could not be queued', {
          context: 'swoop/sessions',
          data: { siteId, machineId, err: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    // After the streamer has been stopped, not before: an audit write that
    // throws must not leave a live session behind an error response.
    await recordSwoopSessionEnded({
      ...auditBase,
      sid: sessionId,
      endReason,
      viewerReason,
      durationMs: Date.now() - session.startedAt,
    });

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

// Leaving sits on the watch bar on purpose: anyone who may be in the room may
// leave it, and the last one out stopping the stream is never the dangerous
// direction. It takes nobody else's seat.
export const DELETE = authorizedSiteHandler<SwoopRouteParams>({
  capability: Capability.MACHINE_REMOTE_VIEW,
  ...sharedHandlerOptions,
  apiKeyScope: {
    resource: 'machine' as const,
    idParam: 'machineId',
    permission: 'write' as const,
  },
})(deleteHandler);
