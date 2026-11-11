/**
 * POST /api/agent/fleet/call — start one tool call for a granted machine
 * (ADR 0017). body `{ tool, params }`; `params.machine` names the machine a
 * machine tool acts on.
 *
 * 200 for a tool the server answers itself, `{ status: 'completed', content }`
 * or `{ status: 'failed', error }`; else 202 `{ callId, timeoutSeconds }`, read
 * back at `/api/agent/fleet/calls/{callId}`.
 *
 * `Idempotency-Key` is required: the local script retries a call whose answer
 * it lost, and the retry must get the first call back, never a second command.
 *
 * dispatch decides the call, and runs the admission (the command rate limit,
 * then the blocking allow row) just before it; a refusal dispatch makes itself
 * is recorded here.
 */

import { NextResponse } from 'next/server';
import { readAndParseJsonBody } from '@/app/api/_shared';
import { apiError } from '@/lib/apiErrorResponse';
import { startFleetCall } from '@/lib/fleet/dispatch.server';
import { admitFleetCall, denyFleetCall, fleetHandler } from '@/lib/fleet/handler.server';
import { withIdempotency } from '@/lib/idempotency';

export const POST = fleetHandler(async (request, ctx) => {
  try {
    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body: Record<string, unknown> =
      typeof parsed.body === 'object' && parsed.body !== null ? (parsed.body as Record<string, unknown>) : {};

    return await withIdempotency(
      request,
      { userId: `machine:${ctx.siteId}:${ctx.machineId}`, environment: 'unknown' },
      parsed.raw,
      async () => {
        const start = await startFleetCall(ctx, { tool: body.tool, params: body.params }, admitFleetCall(request, ctx));
        if (!start.ok) {
          if (start.deny) denyFleetCall(request, ctx, start.deny);
          return start.response;
        }
        return NextResponse.json(start.body, { status: start.kind === 'started' ? 202 : 200 });
      },
      { requireKey: true },
    );
  } catch (error: unknown) {
    return apiError(error, 'agent/fleet/call');
  }
});
