/**
 * POST /api/sites/{siteId}/machines/{machineId}/swoop/step-up — run the step-up
 * ceremony on its own and open the caller's 12-hour window on this machine.
 * GET  — is that window open for the login session asking?
 *
 * owlette swoop's webview reaches only the platform authenticator, so its
 * dialog sends the operator to the browser (`/swoop/<site>/<machine>/verify`),
 * which posts the proof here, and polls the GET until the window reads open.
 * The window is (user, machine) state, so the app's next session create finds
 * it — but only from a login session that itself passed a ceremony, exactly as
 * the create would decide (`hasOpenStepUpWindow`), which is why the GET answers
 * for the session asking and says whether that session can ever read one.
 *
 * Nothing here is new authority: the proof, the window and the session gate are
 * `swoop/sessions`' own (`lib/swoop/stepUp.server.ts`), so a stolen cookie
 * opens a window here only by passing a second factor, as it would there.
 */

import { NextRequest, NextResponse } from 'next/server';
import { problem, problemFromError, ProblemType } from '@/lib/apiErrors';
import {
  applyAuthDeprecations,
  readAndParseJsonBody,
  requireSiteAuthAndScope,
} from '@/app/api/_shared';
import { ApiAuthError } from '@/lib/apiAuth.server';
import { authorizedSiteHandler, type SiteRouteHandler } from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import { evaluateSwoopAccess, hasOpenStepUpWindow } from '@/lib/swoop/policy.server';
import { openStepUpFromProof, requestPassedMfaCeremony } from '@/lib/swoop/stepUp.server';
import { recordSwoopDenied } from '@/lib/swoop/audit.server';
import {
  apiKeyRefusal,
  decisionProblem,
  swoopGate,
  type SwoopRouteParams,
} from '../_shared';

const postHandler: SiteRouteHandler<SwoopRouteParams> = async (request, ctx, { params }) => {
  try {
    const { machineId } = await params;
    const siteId = ctx.siteId;
    const userId = ctx.actor.userId;
    const auditBase = { siteId, machineId, actor: ctx.actor, correlationId: ctx.correlationId };
    const refused = (denyReason: string) =>
      recordSwoopDenied({ ...auditBase, event: 'step_up_failed', denyReason, ctl: true });

    const keyRefusal = apiKeyRefusal(ctx);
    if (keyRefusal) {
      refused('api_key_not_permitted');
      return keyRefusal;
    }

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as { mfaProof?: unknown };

    // the proof is spent only where a session create would spend it: when the
    // missing window is the one thing standing between this caller and control.
    const gate = await swoopGate({ ctx, machineId, intent: 'control' });
    const decision = evaluateSwoopAccess({ ...gate, stepUpOpen: false });
    if (!decision.ok && decision.code !== 'step_up_required') {
      refused(decision.code);
      return decisionProblem(decision);
    }

    const opened = await openStepUpFromProof({ userId, siteId, machineId, proof: body.mfaProof });
    if (!opened.ok) {
      refused(opened.reason);
      return opened.response;
    }
    return applyAuthDeprecations(new NextResponse(null, { status: 204 }), ctx.scopeCheck);
  } catch (err) {
    // `assertActiveUser` throws this on a soft-deleted account during the
    // ceremony; its own status and code are the answer.
    if (err instanceof ApiAuthError) {
      return problem({
        type: ProblemType.Forbidden,
        title: 'forbidden',
        status: err.status,
        detail: err.message,
        ...(err.code ? { code: err.code } : {}),
      });
    }
    return problemFromError(err, 'sites/[siteId]/machines/[machineId]/swoop/step-up:POST');
  }
};

export const POST = authorizedSiteHandler<SwoopRouteParams>({
  capability: Capability.MACHINE_REMOTE_CONTROL,
  siteIdParam: 'path',
  targetKind: 'machine',
  targetIdParam: 'machineId',
  apiKeyScope: { resource: 'machine', idParam: 'machineId', permission: 'write' },
})(postHandler);

/**
 * Polled every 3 s while owlette swoop waits on the browser, so it takes the
 * site-access gate and not the wrapper: the wrapper's per-capability rate limit
 * would share the bucket the session create needs right after, and its blocking
 * allow row would write one audit entry per poll. It reads only the caller's own
 * window, and opens, extends or writes nothing.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ siteId: string; machineId: string }> },
): Promise<NextResponse> {
  try {
    const { siteId, machineId } = await params;
    const auth = await requireSiteAuthAndScope(request, siteId, 'read');
    if (!auth.ok) return auth.response;
    const keyRefusal = apiKeyRefusal(auth);
    if (keyRefusal) return keyRefusal;

    const sessionPassedCeremony = await requestPassedMfaCeremony(request, auth.userId);
    const open = await hasOpenStepUpWindow({
      userId: auth.userId,
      siteId,
      machineId,
      sessionPassedCeremony,
    });
    return applyAuthDeprecations(
      NextResponse.json({ ok: true, data: { open, sessionPassedCeremony } }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/machines/[machineId]/swoop/step-up:GET');
  }
}
