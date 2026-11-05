/**
 * POST /api/sites/{siteId}/machines/{machineId}/swoop/sessions/{sessionId}/kick
 *
 * take one person out of a live session. body `{ viewerId }`, a seat they hold:
 * every seat of theirs goes with it.
 *
 * one streamer serves everyone on the machine and the protocol cannot drop one
 * viewer (PROTOCOL.md §10), so this is the revocation's cut: the record ends
 * naming them, the streamer is killed, and every page reads the record off the
 * bye. they stop; everyone else is back within ~2 s.
 *
 * unlike a revocation, their access is intact, so they may rejoin: a kick is
 * not a ban, and keeping someone out is their swoop mode, in the site's members
 * section. their continuity grants are spent, as their own leave spends them,
 * so a rejoin asks for the step-up again. the step-up windows stay open: only
 * the kill route closes them, for the whole machine, and a kick puts nobody
 * through a ceremony the admin did not ask for. a revocation leaves them too.
 *
 * who: a site owner or admin, or a superadmin, whatever their own swoop mode,
 * as for a kill. anyone but yourself, with no order among them: an admin may
 * kick the owner, who rejoins and can remove the admin. a rejoin undoes a kick,
 * so a rank between them would guard nothing; rank decides in the members
 * section.
 */

import { NextResponse } from 'next/server';
import { problem, problemFromError, problemValidation, ProblemType } from '@/lib/apiErrors';
import { applyAuthDeprecations, readAndParseJsonBody } from '@/app/api/_shared';
import { authorizedSiteHandler, type SiteRouteHandler } from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import { recordSwoopDenied } from '@/lib/swoop/audit.server';
import { endSwoopSessionForUser } from '@/lib/swoop/revokeViewerSessions.server';
import { getSwoopSession, markSwoopContinuityUsed } from '@/lib/swoop/sessionStore.server';
import { apiKeyRefusal, isValidSid, type SwoopRouteParams } from '../../../_shared';

const kickHandler: SiteRouteHandler<SwoopRouteParams> = async (request, ctx, { params }) => {
  try {
    const { machineId, sessionId } = await params;
    const siteId = ctx.siteId;

    const keyRefusal = apiKeyRefusal(ctx);
    if (keyRefusal) {
      recordSwoopDenied({
        siteId,
        machineId,
        ...(isValidSid(sessionId) ? { sid: sessionId } : {}),
        actor: ctx.actor,
        correlationId: ctx.correlationId,
        event: 'session_denied',
        denyReason: 'api_key_not_permitted',
        ctl: false,
      });
      return keyRefusal;
    }

    if (!isValidSid(sessionId)) return problemValidation('invalid session id');

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const { viewerId } = (parsed.body ?? {}) as { viewerId?: unknown };
    if (!isValidSid(viewerId)) {
      return problemValidation('field `viewerId` is not a viewer id', {
        viewerId: ['the viewer id of a seat in the session'],
      });
    }

    const session = await getSwoopSession(siteId, machineId, sessionId);
    if (!session) {
      return problem({
        type: ProblemType.NotFound,
        title: 'not found',
        status: 404,
        detail: 'session not found',
        code: 'session_not_found',
      });
    }
    if (session.state === 'ended') {
      return problem({
        type: ProblemType.Conflict,
        title: 'conflict',
        status: 409,
        detail: 'this session has already ended',
        code: 'session_ended',
      });
    }
    const seat = session.viewers.find((viewer) => viewer.viewerId === viewerId);
    if (!seat) {
      return problem({
        type: ProblemType.NotFound,
        title: 'not found',
        status: 404,
        detail: 'that person is no longer in this session',
        code: 'viewer_not_found',
      });
    }
    if (seat.uid === ctx.actor.userId) return problemValidation('field `viewerId` names your own seat');

    const { uid } = seat;
    const now = Date.now();
    // a grant outlives its seat, so a tab of theirs that already dropped out is
    // spent too: none of them comes back past the step-up.
    for (const [grantViewerId, grant] of Object.entries(session.continuity ?? {})) {
      if (grant.uid === uid && grant.usedAt === undefined) {
        await markSwoopContinuityUsed(siteId, machineId, sessionId, grantViewerId, now);
      }
    }

    await endSwoopSessionForUser({
      session,
      uid,
      endReason: 'kicked',
      auditReason: 'kicked',
      actor: ctx.actor,
      auditActor: `user:${ctx.actor.userId}`,
      correlationId: ctx.correlationId,
    });

    return applyAuthDeprecations(
      NextResponse.json({ ok: true, data: { sid: sessionId, state: 'ended', endReason: 'kicked', endedFor: uid } }),
      ctx.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/machines/[machineId]/swoop/sessions/[sessionId]/kick:POST');
  }
};

// the kill route's gate: stopping someone must work on a lapsed plan too.
export const POST = authorizedSiteHandler<SwoopRouteParams>({
  capability: Capability.SWOOP_SETTINGS_MANAGE,
  siteIdParam: 'path',
  targetKind: 'machine',
  targetIdParam: 'machineId',
  apiKeyScope: { resource: 'machine', idParam: 'machineId', permission: 'write' },
  planExempt: true,
})(kickHandler);
