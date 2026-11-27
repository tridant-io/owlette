/**
 * Display Layout API — PUT (capture / set-auto-restore / reset-breaker) +
 * DELETE (clear).
 *
 * `PUT    /api/sites/{siteId}/machines/{machineId}/display-layout`
 * `DELETE /api/sites/{siteId}/machines/{machineId}/display-layout`
 *
 * security-boundary-migration wave 3.2: capability `MACHINE_CONFIG_WRITE`,
 * api-key scope `machine=<id>:write`, and required `Idempotency-Key`.
 *
 * PUT body is discriminated by `op`:
 *
 *   { "op": "capture", "monitors": [...], "capturedBy": "alice@acme.com" }
 *   { "op": "set_auto_restore", "enabled": true,  "enabledBy": "alice@acme.com" }
 *   { "op": "set_auto_restore", "enabled": false }
 *   { "op": "reset_breaker" }
 *   { "op": "set_remote_apply", "enabled": true }
 *
 * DELETE clears the assigned layout entirely and turns auto-restore off;
 * the other `displays` fields survive.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import {
  problem as apiProblem,
  problemFromError,
  ProblemType,
} from '@/lib/apiErrors';
import { withIdempotency } from '@/lib/idempotency';
import {
  setDisplayLayout,
  type SetDisplayLayoutInput,
} from '@/lib/actions/setDisplayLayout.server';
import { clearDisplayLayout } from '@/lib/actions/clearDisplayLayout.server';
import { ActionInputError, type ActionContext } from '@/lib/actions/createProcess.server';

const putWrapped = authorizedSiteHandler<{ siteId: string; machineId: string }>({
  capability: 'MACHINE_CONFIG_WRITE',
  siteIdParam: 'path',
  targetKind: 'machine',
  targetIdParam: 'machineId',
  apiKeyScope: { resource: 'machine', idParam: 'machineId', permission: 'write' },
})(async (request: NextRequest, ctx, routeContext) => {
  try {
    const { machineId } = await routeContext.params;

    let raw: string;
    let body: unknown;
    try {
      raw = await request.text();
      body = raw.length > 0 ? JSON.parse(raw) : undefined;
    } catch {
      return problem(400, 'invalid_body', 'Request body must be valid JSON.');
    }

    return withIdempotency(
      request,
      {
        userId: ctx.auth.userId,
        environment: ctx.auth.keyContext?.environment ?? 'unknown',
      },
      raw,
      async () => handlePutBody(ctx, machineId, body),
      { requireKey: true },
    );
  } catch (error: unknown) {
    return problemFromError(error, 'sites/[siteId]/machines/[machineId]/display-layout:PUT');
  }
});

type DisplayLayoutRouteContext = Pick<ActionContext, 'siteId' | 'actor'> & {
  auth: {
    userId: string;
    keyContext?: { keyId: string; environment?: string | null } | null;
  };
};

async function handlePutBody(
  ctx: DisplayLayoutRouteContext,
  machineId: string,
  body: unknown,
): Promise<NextResponse> {
  if (!isPlainObject(body)) {
    return problem(400, 'invalid_body', 'Request body must be a JSON object.');
  }

  const auditActor = ctx.auth.keyContext
    ? `apiKey:${ctx.auth.keyContext.keyId}`
    : `user:${ctx.auth.userId}`;

  const op = body.op;
  let input: SetDisplayLayoutInput;

  if (op === 'capture') {
    if (!Array.isArray(body.monitors)) {
      return problem(400, 'invalid_monitors', 'Field `monitors` must be an array.');
    }
    if (body.monitors.length === 0) {
      return problem(400, 'missing_monitors', 'Field `monitors` must be a non-empty array.');
    }
    if (typeof body.capturedBy !== 'string' || body.capturedBy.length === 0) {
      return problem(400, 'missing_captured_by', 'Field `capturedBy` is required.');
    }
    input = {
      machineId,
      op: 'capture',
      monitors: body.monitors as Record<string, unknown>[],
      capturedBy: body.capturedBy,
    };
  } else if (op === 'set_auto_restore') {
    if (typeof body.enabled !== 'boolean') {
      return problem(400, 'invalid_enabled', 'Field `enabled` must be a boolean.');
    }
    if (body.enabled && (typeof body.enabledBy !== 'string' || body.enabledBy.length === 0)) {
      return problem(
        400,
        'missing_enabled_by',
        'Field `enabledBy` is required when enabling auto-restore.',
      );
    }
    input = {
      machineId,
      op: 'set_auto_restore',
      enabled: body.enabled,
      ...(typeof body.enabledBy === 'string' ? { enabledBy: body.enabledBy } : {}),
    };
  } else if (op === 'reset_breaker') {
    input = { machineId, op: 'reset_breaker' };
  } else if (op === 'set_remote_apply') {
    if (typeof body.enabled !== 'boolean') {
      return problem(400, 'invalid_enabled', 'Field `enabled` must be a boolean.');
    }
    input = {
      machineId,
      op: 'set_remote_apply',
      enabled: body.enabled,
    };
  } else {
    return problem(
      400,
      'invalid_op',
      '`op` must be one of: capture, set_auto_restore, reset_breaker, set_remote_apply.',
    );
  }

  try {
    const result = await setDisplayLayout(
      { siteId: ctx.siteId, actor: ctx.actor, auditActor },
      input,
    );
    return NextResponse.json({ ok: true, data: result });
  } catch (e) {
    if (e instanceof ActionInputError) {
      return problem(e.status, e.code, e.message);
    }
    throw e;
  }
}

export const PUT = withRateLimit(putWrapped, {
  strategy: 'api',
  identifier: 'ip',
});

const deleteWrapped = authorizedSiteHandler<{ siteId: string; machineId: string }>({
  capability: 'MACHINE_CONFIG_WRITE',
  siteIdParam: 'path',
  targetKind: 'machine',
  targetIdParam: 'machineId',
  apiKeyScope: { resource: 'machine', idParam: 'machineId', permission: 'write' },
})(async (request: NextRequest, ctx, routeContext) => {
  try {
    const { machineId } = await routeContext.params;

    return withIdempotency(
      request,
      {
        userId: ctx.auth.userId,
        environment: ctx.auth.keyContext?.environment ?? 'unknown',
      },
      '',
      async () => {
        const auditActor = ctx.auth.keyContext
          ? `apiKey:${ctx.auth.keyContext.keyId}`
          : `user:${ctx.auth.userId}`;

        const result = await clearDisplayLayout(
          { siteId: ctx.siteId, actor: ctx.actor, auditActor },
          { machineId },
        );
        return NextResponse.json({ ok: true, data: result });
      },
      { requireKey: true },
    );
  } catch (error: unknown) {
    if (error instanceof ActionInputError) {
      return problem(error.status, error.code, error.message);
    }
    return problemFromError(error, 'sites/[siteId]/machines/[machineId]/display-layout:DELETE');
  }
});

export const DELETE = withRateLimit(deleteWrapped, {
  strategy: 'api',
  identifier: 'ip',
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function problem(status: number, code: string, detail: string): NextResponse {
  const type = status === 404
    ? ProblemType.NotFound
    : status === 409
      ? ProblemType.Conflict
      : ProblemType.ValidationFailed;

  return apiProblem({
    type,
    title: code,
    status,
    code,
    detail,
  });
}
