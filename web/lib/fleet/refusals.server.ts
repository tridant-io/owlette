/** the refusals a queued call and a task for hoot both give, so they read the same. */

import type { NextResponse } from 'next/server';
import { problem, ProblemType } from '@/lib/apiErrors';
import type { FleetRefusal } from '@/lib/fleet/context';

// a record outlives its call's timeout by an hour, so a script still polling
// at the edge finds it; after that the next call anyone starts prunes it.
export const CALL_RECORD_GRACE_MS = 60 * 60 * 1000;

/** a refusal dispatch decided, with what its deny row should say. */
export function denied(
  response: NextResponse,
  reason: string,
  tool: string | null,
  machineId: string | null,
): FleetRefusal {
  return { ok: false, response, deny: { reason, tool, machineId } };
}

export function machineNotGranted(machine: string): NextResponse {
  return problem({
    type: ProblemType.Forbidden,
    title: 'machine not granted',
    status: 403,
    detail: `this machine's grant does not reach ${machine}`,
    code: 'machine_not_granted',
  });
}

export function callNotFound(): FleetRefusal {
  return {
    ok: false,
    response: problem({
      type: ProblemType.NotFound,
      title: 'call not found',
      status: 404,
      detail: 'no such call: it never started, or its result was already collected',
    }),
  };
}

export function isLive(expiresAt: unknown, now: number): boolean {
  return typeof expiresAt === 'number' && expiresAt > now;
}
