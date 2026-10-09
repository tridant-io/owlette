/**
 * POST /api/sites/{siteId}/deployments/{deploymentId}/cancel
 *
 * Cancels every target still in a pre-flight state, purges queued
 * install_software commands, and fans out cancel_installation commands.
 *
 * security-boundary-migration wave 3.3: mutation logic lives in
 * `web/lib/actions/cancelDeployment.server.ts`.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problem, problemFromError, ProblemType } from '@/lib/apiErrors';
import {
  applyAuthDeprecations,
  auditActorIdentifier,
  readAndParseJsonBody,
} from '../../../../../_shared';
import { withIdempotency } from '@/lib/idempotency';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import {
  cancelDeployment,
  type CancelDeploymentResult,
} from '@/lib/actions/cancelDeployment.server';

type RouteParams = { siteId: string; deploymentId: string };

export const POST = authorizedSiteHandler<RouteParams>({
  capability: 'DEPLOYMENT_MANAGE',
  siteIdParam: 'path',
  // a deployment already running can always be stopped, whatever the plan
  planExempt: true,
  // Opted in: enforced through the inner _shared gate until now, so without
  // this, removing that gate would drop the 400 on an unsupported
  // Roost-Version.
  roostVersioned: true,
  targetKind: 'deployment',
})(async (request: NextRequest, ctx, routeContext) => {
  try {
    const { siteId, deploymentId } = await routeContext.params;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;


    return withIdempotency(
      request,
      {
        userId: ctx.actor.userId,
        environment: ctx.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        const result = await cancelDeployment({
          siteId,
          deploymentId,
          actorIdentifier: auditActorIdentifier(ctx.auth),
          correlationId: ctx.correlationId,
        });

        if (!result.ok) {
          return cancelDeploymentErrorToResponse(result, siteId, deploymentId);
        }

        return applyAuthDeprecations(
          NextResponse.json({
            deploymentId: result.deploymentId,
            siteId: result.siteId,
            status: result.status,
            cancelled: result.cancelled,
            machine_ids: result.machine_ids,
          }),
          ctx.scopeCheck,
        );
      },
      { requireKey: true },
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/deployments/[deploymentId]/cancel:POST');
  }
});


function cancelDeploymentErrorToResponse(
  result: Extract<CancelDeploymentResult, { ok: false }>,
  siteId: string,
  deploymentId: string,
): NextResponse {
  if (result.code === 'not_found') {
    return problem({
      type: ProblemType.NotFound,
      title: 'not found',
      status: 404,
      detail: result.message,
      instance: `/api/sites/${siteId}/deployments/${deploymentId}/cancel`,
    });
  }

  return problem({
    type: ProblemType.Conflict,
    title: 'no cancellable targets',
    status: 409,
    detail: result.message,
    instance: `/api/sites/${siteId}/deployments/${deploymentId}/cancel`,
    code: 'no_cancellable_targets',
  });
}
