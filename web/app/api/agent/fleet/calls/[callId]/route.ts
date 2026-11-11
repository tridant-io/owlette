/**
 * GET /api/agent/fleet/calls/{callId} — read back a call this machine started
 * (ADR 0017): `{ status, content?, error? }`. the read that hands over a
 * `completed` or `failed` status is the last one, and a repeat is 404. a call
 * another machine started, or a command a person queued, is the same 404.
 * a read: it writes no audit row.
 */

import { NextResponse } from 'next/server';
import { apiError } from '@/lib/apiErrorResponse';
import { readFleetCall } from '@/lib/fleet/dispatch.server';
import { fleetHandler } from '@/lib/fleet/handler.server';

/** `callId` arrives percent-encoded, colons included; one that will not decode reads as unknown. */
function decodeCallId(callId: string): string {
  try {
    return decodeURIComponent(callId);
  } catch {
    return callId;
  }
}

export const GET = fleetHandler<{ callId: string }>(async (_request, ctx, { params }) => {
  try {
    const read = await readFleetCall(ctx, decodeCallId((await params).callId));
    return read.ok ? NextResponse.json(read.body) : read.response;
  } catch (error: unknown) {
    return apiError(error, 'agent/fleet/calls');
  }
});
