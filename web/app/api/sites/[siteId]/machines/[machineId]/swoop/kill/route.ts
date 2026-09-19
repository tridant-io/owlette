/**
 * POST /api/sites/{siteId}/machines/{machineId}/swoop/kill — stop whatever is
 * streaming on this machine. Body `{ sid? }`; without a sid it means "kill
 * whatever is running", which is what a revocation wants when it does not know
 * the live session.
 *
 * Two independent paths, in this order:
 *   1. `killSession` — the worker broadcasts `kill` on the streamer's own
 *      signalling socket and it exits (<= 2 s, authoritative).
 *   2. a polled `swoop_kill` command — queued whenever the first path did not
 *      confirm, for ANY reason. The fast path being down is a reason to kill,
 *      not a reason to give up on killing, and `requestSwoopSession` queues this
 *      one type even for an offline machine (plan.md D11).
 *
 * Deliberately NOT gated on the site's swoop settings: stopping a stream has to
 * work after the feature has been switched off, which is exactly when an
 * operator wants it most. The capability check is the whole gate.
 *
 * It also closes every open step-up window on the machine, before either path
 * runs. A kill the operator it cut off can undo by reconnecting a second later
 * on a window they already held is not a kill.
 */

import { NextResponse } from 'next/server';
import { problem, problemFromError, problemValidation, ProblemType } from '@/lib/apiErrors';
import { applyAuthDeprecations, readAndParseJsonBody } from '@/app/api/_shared';
import { authorizedSiteHandler, type SiteRouteHandler } from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import logger from '@/lib/logger';
import { revokeStepUpWindows } from '@/lib/swoop/policy.server';
import { killSession } from '@/lib/swoop/signal.server';
import {
  requestSwoopSession,
  RequestSwoopSessionError,
} from '@/lib/actions/requestSwoopSession.server';
import { apiKeyRefusal, isValidSid, type SwoopRouteParams } from '../_shared';

const killHandler: SiteRouteHandler<SwoopRouteParams> = async (request, ctx, { params }) => {
  try {
    const keyRefusal = apiKeyRefusal(ctx);
    if (keyRefusal) return keyRefusal;

    const { machineId } = await params;
    const siteId = ctx.siteId;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as { sid?: unknown };
    if (body.sid !== undefined && !isValidSid(body.sid)) {
      return problemValidation('field `sid` is not a session id');
    }
    const sid = body.sid as string | undefined;

    // First, so there is no window left open for the seconds the stop takes.
    // A failure here is logged and the kill goes on: a stream that keeps
    // running is worse than a window that outlives its 10 minutes.
    try {
      await revokeStepUpWindows({ siteId, machineId });
    } catch (err) {
      logger.warn('[swoop/kill] step-up windows could not be closed; killing anyway', {
        context: 'swoop/kill',
        data: {
          siteId,
          machineId,
          err: err instanceof Error ? err.message : String(err),
        },
      });
    }

    const broadcast = await killSession({ siteId, machineId, ...(sid ? { sid } : {}) });
    if (broadcast.ok) {
      return applyAuthDeprecations(
        NextResponse.json({ ok: true, data: { machineId, ...(sid ? { sid } : {}), via: 'signal' } }),
        ctx.scopeCheck,
      );
    }

    logger.warn('[swoop/kill] kill broadcast did not land; queueing the polled command', {
      context: 'swoop/kill',
      data: { siteId, machineId, reason: broadcast.reason },
    });

    const queued = await requestSwoopSession({
      type: 'swoop_kill',
      ...(sid ? { sid } : {}),
      siteId,
      machineId,
      actor: ctx.actor,
      auditActor: `user:${ctx.actor.userId}`,
      correlationId: ctx.correlationId,
    });

    return applyAuthDeprecations(
      NextResponse.json({
        ok: true,
        data: { machineId, ...(sid ? { sid } : {}), via: 'command', commandId: queued.commandId },
      }),
      ctx.scopeCheck,
    );
  } catch (err) {
    // Both paths failed, so say so rather than reporting a kill that never
    // reached anything — the caller has to know to try again.
    if (err instanceof RequestSwoopSessionError) {
      return problem({
        type: err.status === 404 ? ProblemType.NotFound : ProblemType.Conflict,
        title: 'kill not delivered',
        status: err.status,
        detail: err.detail,
        code: err.code,
      });
    }
    return problemFromError(err, 'sites/[siteId]/machines/[machineId]/swoop/kill:POST');
  }
};

/**
 * Site admin/owner. Ending your OWN session sits on the watch bar
 * (`sessions/{sid}` DELETE), but this one ends whatever anyone is running on
 * the machine, so it takes the control capability.
 */
export const POST = authorizedSiteHandler<SwoopRouteParams>({
  capability: Capability.MACHINE_REMOTE_CONTROL,
  siteIdParam: 'path',
  targetKind: 'machine',
  targetIdParam: 'machineId',
  apiKeyScope: { resource: 'machine', idParam: 'machineId', permission: 'write' },
})(killHandler);
