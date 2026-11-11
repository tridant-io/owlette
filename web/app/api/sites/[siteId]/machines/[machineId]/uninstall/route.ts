/**
 * POST   — queue `uninstall_software` for one package on one machine. An optional
 *          `deployment_id` ties it to that deployment's finished target for this
 *          machine (untied when the deployment does not target it);
 *          deployments/{id}/uninstall queues it on every target at once.
 * DELETE — queue `cancel_uninstall` against an in-flight uninstall.
 *
 * Capability: `UNINSTALL_TRIGGER` (site admin grants).
 */
import { NextResponse } from 'next/server';
import {
  problem,
  problemFromError,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import { readAndParseJsonBody } from '../../../../../_shared';
import { emitMutation } from '@/lib/auditLogClient';
import { withIdempotency } from '@/lib/idempotency';
import {
  triggerUninstall,
  parseTriggerUninstallInput,
  TriggerUninstallError,
} from '@/lib/actions/triggerUninstall.server';
import {
  cancelUninstall,
  parseCancelUninstallInput,
  CancelUninstallError,
} from '@/lib/actions/cancelUninstall.server';

type RouteParams = { siteId: string; machineId: string };

function actorString(actor: { type: 'user'; userId: string }): string {
  // The wrapper only yields a UserActor, so api-key callers also render as
  // `user:<uid>` — `SiteHandlerContext` doesn't carry the keyContext.
  return `user:${actor.userId}`;
}

export const POST = authorizedSiteHandler<RouteParams>({
  capability: 'UNINSTALL_TRIGGER',
  siteIdParam: 'path',
  targetKind: 'machine',
})(async (request, ctx, routeContext) => {
  try {
    const { machineId } = await routeContext.params;
    if (!machineId) {
      return problem({
        type: ProblemType.ValidationFailed,
        title: 'validation failed',
        status: 400,
        detail: 'machineId missing from path',
      });
    }

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
        let input;
        try {
          input = parseTriggerUninstallInput(parsed.body ?? {});
        } catch (err) {
          if (err instanceof TriggerUninstallError && err.code === 'validation_failed') {
            return problemValidation(err.message, err.fieldErrors);
          }
          throw err;
        }

        let result;
        try {
          result = await triggerUninstall(ctx.siteId, machineId, input, {
            auditCorrelationId: ctx.correlationId,
          });
        } catch (err) {
          if (err instanceof TriggerUninstallError) {
            return triggerUninstallErrorToResponse(err, ctx.siteId, machineId);
          }
          throw err;
        }

        emitMutation({
          kind: 'machine_command_dispatched',
          siteId: ctx.siteId,
          actor: actorString(ctx.actor),
          targetId: result.commandId,
          attributes: {
            commandType: 'uninstall_software',
            endpoint: `/api/sites/${ctx.siteId}/machines/${machineId}/uninstall`,
            method: 'POST',
            machineId,
            software_name: result.software_name,
            ...(result.deployment_id ? { deployment_id: result.deployment_id } : {}),
          },
        });

        return NextResponse.json(
          {
            ok: true,
            data: {
              siteId: result.siteId,
              machineId: result.machineId,
              software_name: result.software_name,
              commandId: result.commandId,
              status: result.status,
            },
          },
          { status: 202 },
        );
      },
      { requireKey: true },
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/machines/[machineId]/uninstall:POST');
  }
});

export const DELETE = authorizedSiteHandler<RouteParams>({
  capability: 'UNINSTALL_TRIGGER',
  siteIdParam: 'path',
  targetKind: 'machine',
})(async (request, ctx, routeContext) => {
  try {
    const { machineId } = await routeContext.params;
    if (!machineId) {
      return problem({
        type: ProblemType.ValidationFailed,
        title: 'validation failed',
        status: 400,
        detail: 'machineId missing from path',
      });
    }

    // Query wins over body: some intermediaries strip a DELETE body.
    const queryName = request.nextUrl.searchParams.get('software_name');
    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const bodyObj =
      parsed.body !== null && typeof parsed.body === 'object' && !Array.isArray(parsed.body)
        ? (parsed.body as Record<string, unknown>)
        : {};
    const rawInput =
      queryName && queryName.length > 0
        ? { software_name: queryName }
        : bodyObj;

    return withIdempotency(
      request,
      {
        userId: ctx.actor.userId,
        environment: ctx.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        let input;
        try {
          input = parseCancelUninstallInput(rawInput);
        } catch (err) {
          if (err instanceof CancelUninstallError && err.code === 'validation_failed') {
            return problemValidation(err.message, err.fieldErrors);
          }
          throw err;
        }

        let result;
        try {
          result = await cancelUninstall(ctx.siteId, machineId, input, {
            auditCorrelationId: ctx.correlationId,
          });
        } catch (err) {
          if (err instanceof CancelUninstallError) {
            return cancelUninstallErrorToResponse(err, ctx.siteId, machineId);
          }
          throw err;
        }

        emitMutation({
          kind: 'machine_command_dispatched',
          siteId: ctx.siteId,
          actor: actorString(ctx.actor),
          targetId: result.commandId,
          attributes: {
            commandType: 'cancel_uninstall',
            endpoint: `/api/sites/${ctx.siteId}/machines/${machineId}/uninstall`,
            method: 'DELETE',
            machineId,
            software_name: result.software_name,
          },
        });

        return NextResponse.json(
          {
            ok: true,
            data: {
              siteId: result.siteId,
              machineId: result.machineId,
              software_name: result.software_name,
              commandId: result.commandId,
              status: result.status,
            },
          },
          { status: 202 },
        );
      },
      { requireKey: true },
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/machines/[machineId]/uninstall:DELETE');
  }
});

function triggerUninstallErrorToResponse(
  err: TriggerUninstallError,
  siteId: string,
  machineId: string,
): NextResponse {
  const instance = `/api/sites/${siteId}/machines/${machineId}/uninstall`;
  switch (err.code) {
    case 'validation_failed':
      return problemValidation(err.message, err.fieldErrors);
    case 'machine_not_found':
    case 'software_not_found':
      return problem({
        type: ProblemType.NotFound,
        title: err.code === 'machine_not_found' ? 'machine not found' : 'software not found',
        status: 404,
        detail: err.message,
        instance,
        code: err.code,
      });
    case 'machine_offline':
      return problem({
        type: ProblemType.Conflict,
        title: 'machine offline',
        status: 409,
        detail: err.message,
        instance,
        code: 'machine_offline',
      });
    case 'software_record_invalid':
      return problem({
        type: ProblemType.Conflict,
        title: 'software record invalid',
        status: 409,
        detail: err.message,
        instance,
        code: 'software_record_invalid',
      });
    default: {
      // Exhaustiveness guard: a new error code without a handler fails to compile.
      const _exhaustive: never = err.code;
      void _exhaustive;
      return problemFromError(err, 'triggerUninstall:unknownErrorCode');
    }
  }
}

function cancelUninstallErrorToResponse(
  err: CancelUninstallError,
  siteId: string,
  machineId: string,
): NextResponse {
  const instance = `/api/sites/${siteId}/machines/${machineId}/uninstall`;
  switch (err.code) {
    case 'validation_failed':
      return problemValidation(err.message, err.fieldErrors);
    case 'machine_not_found':
      return problem({
        type: ProblemType.NotFound,
        title: 'machine not found',
        status: 404,
        detail: err.message,
        instance,
        code: 'machine_not_found',
      });
    default: {
      const _exhaustive: never = err.code;
      void _exhaustive;
      return problemFromError(err, 'cancelUninstall:unknownErrorCode');
    }
  }
}
