/**
 * POST /api/sites/{siteId}/machines/{machineId}/swoop/sessions/{sessionId}/lease
 *
 * Renew one viewer's 5-minute lease and hand back a fresh viewer JWT. The point
 * of the lease is that authorisation is re-checked while the session runs: a
 * removed member, a site that turns swoop off, an excluded machine or a revoked
 * capability all take effect within one lease (PROTOCOL.md §10).
 *
 * The capability bar is re-read from the viewer's stored `ctl` rather than from
 * the request, so a watch-only viewer cannot renew itself into control. Step-up
 * is deliberately NOT re-run — the window covers it, and a ceremony every five
 * minutes is how operators end up turning the feature off.
 *
 * The 12-hour cap is absolute and is not moved by a renewal.
 */

import { NextResponse } from 'next/server';
import { problemFromError, problemNotFound, problemValidation } from '@/lib/apiErrors';
import { applyAuthDeprecations, readAndParseJsonBody } from '@/app/api/_shared';
import { authorizedSiteHandler, type SiteRouteHandler } from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import { evaluateLeaseRenewal, SWOOP_LEASE_SECONDS } from '@/lib/swoop/policy.server';
import { getSwoopSession, renewSwoopViewerLease } from '@/lib/swoop/sessionStore.server';
import { canonicalizeFingerprint, mintViewerToken } from '@/lib/swoop/tokens.server';
import { recordSwoopDenied } from '@/lib/swoop/audit.server';
import {
  apiKeyRefusal,
  decisionProblem,
  isValidSid,
  swoopGate,
  type SwoopRouteParams,
} from '../../../_shared';

interface LeaseBody {
  viewerId?: unknown;
  fp?: unknown;
}

const leaseHandler: SiteRouteHandler<SwoopRouteParams> = async (request, ctx, { params }) => {
  try {
    const { machineId, sessionId } = await params;
    const siteId = ctx.siteId;
    const userId = ctx.actor.userId;
    // Only refusals are audited here: a renewal grants nothing the session was
    // not started with, and a row every few minutes would bury the grants.
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
        event: 'lease_denied',
        denyReason: 'api_key_not_permitted',
        ctl: false,
      });
      return keyRefusal;
    }

    if (!isValidSid(sessionId)) return problemValidation('invalid session id');

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as LeaseBody;

    if (!isValidSid(body.viewerId)) {
      return problemValidation('field `viewerId` is required', {
        viewerId: ['the viewer id the session was created with'],
      });
    }
    // Mandatory on every mint, renewals included: the host compares it against
    // the fingerprint of the already established dtls session, so a browser
    // that lies here only refuses itself (PROTOCOL.md §10, §11).
    const fp = canonicalizeFingerprint(body.fp);
    if (!fp) {
      return problemValidation('field `fp` is required', {
        fp: ['the browser dtls fingerprint, as `<hash-func> <HEX:WITH:COLONS>`'],
      });
    }

    const session = await getSwoopSession(siteId, machineId, sessionId);
    if (!session || session.state === 'ended') return problemNotFound('session not found');

    // A viewer row that is not the caller's answers exactly as a missing one:
    // whose viewers a live session holds is not the caller's business.
    const viewer = session.viewers.find((v) => v.viewerId === body.viewerId);
    if (!viewer || viewer.uid !== userId) return problemNotFound('session not found');

    const gate = await swoopGate({
      request,
      ctx,
      machineId,
      intent: viewer.ctl ? 'control' : 'view',
    });
    const decision = evaluateLeaseRenewal({ ...gate.input, startedAt: session.startedAt });
    if (!decision.ok) {
      recordSwoopDenied({
        ...auditBase,
        event: 'lease_denied',
        denyReason: decision.code,
        ctl: viewer.ctl,
      });
      return decisionProblem(decision);
    }

    const leaseExpiresAt = Date.now() + SWOOP_LEASE_SECONDS * 1000;
    const renewed = await renewSwoopViewerLease({
      siteId,
      machineId,
      sid: sessionId,
      viewerId: viewer.viewerId,
      leaseExpiresAt,
    });
    if (!renewed) return problemNotFound('session not found');

    const viewerToken = mintViewerToken({
      uid: userId,
      site: siteId,
      machine: machineId,
      sid: sessionId,
      viewer: viewer.viewerId,
      ctl: decision.ctl,
      fp,
    });

    return applyAuthDeprecations(
      NextResponse.json({
        ok: true,
        data: { sid: sessionId, viewerJwt: viewerToken.token, expiresAt: leaseExpiresAt },
      }),
      ctx.scopeCheck,
    );
  } catch (err) {
    return problemFromError(
      err,
      'sites/[siteId]/machines/[machineId]/swoop/sessions/[sessionId]/lease:POST',
    );
  }
};

// The watch bar, deliberately: a renewal grants nothing the session was not
// already started with, and the control bar is re-applied in-handler from the
// viewer's own `ctl`.
export const POST = authorizedSiteHandler<SwoopRouteParams>({
  capability: Capability.MACHINE_REMOTE_VIEW,
  siteIdParam: 'path',
  targetKind: 'machine',
  targetIdParam: 'machineId',
  apiKeyScope: {
    resource: 'machine',
    idParam: 'machineId',
    permission: 'write',
  },
})(leaseHandler);
