/**
 * DELETE /api/sites/{siteId}/machines/{machineId}/reboot-pending — dismiss the
 * "restart pending" banner.
 *
 * Clears `sites/{siteId}/machines/{machineId}.rebootPending` (the live status
 * doc — service-account only in the rules, which is why this is a route and not
 * a client write) and relays `dismiss_reboot_pending` to the agent best-effort.
 * Succeeds on an offline machine: the flag is cloud state, and an unreachable
 * machine is the case that most needs clearing.
 *
 * `MACHINE_EXEC_COMMAND` — the same bar the command path enforced, so the set of
 * people who can dismiss is unchanged. Api-key scope `machine=<id>:write`.
 */
import { NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { resolveAuth } from '@/lib/apiAuth.server';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import { dismissRebootPending } from '@/lib/actions/dismissRebootPending.server';
import { ActionInputError } from '@/lib/actions/createProcess.server';

const deleteWrapped = authorizedSiteHandler<{ siteId: string; machineId: string }>({
  capability: 'MACHINE_EXEC_COMMAND',
  siteIdParam: 'path',
  targetKind: 'machine',
  targetIdParam: 'machineId',
  apiKeyScope: { resource: 'machine', idParam: 'machineId', permission: 'write' },
})(async (request, ctx, routeContext) => {
  try {
    const { machineId } = await routeContext.params;

    const auth = await resolveAuth(request);
    const auditActor = auth.keyContext
      ? `apiKey:${auth.keyContext.keyId}`
      : `user:${auth.userId}`;

    try {
      const result = await dismissRebootPending(
        { siteId: ctx.siteId, actor: ctx.actor, auditActor, correlationId: ctx.correlationId },
        { machineId },
      );
      return NextResponse.json({ ok: true, data: result });
    } catch (e) {
      if (e instanceof ActionInputError) {
        return problem(e.status, e.code, e.message);
      }
      throw e;
    }
  } catch (error: unknown) {
    console.error('sites/machines/reboot-pending DELETE:', error);
    return problem(
      500,
      'internal_error',
      error instanceof Error ? error.message : 'Internal server error',
    );
  }
});

export const DELETE = withRateLimit(deleteWrapped, {
  strategy: 'api',
  identifier: 'ip',
});

function problem(status: number, code: string, detail: string): NextResponse {
  return NextResponse.json(
    { type: 'about:blank', title: code, status, code, detail },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}
