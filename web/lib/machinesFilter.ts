import type { NextResponse } from 'next/server';
import { problemValidation } from '@/lib/apiErrors';

/**
 * The optional `machines` body filter that the deployment retry and cancel
 * routes take. Absent → `undefined`, which means every target.
 */
export function parseMachinesFilter(
  body: unknown,
): { ok: true; machines: string[] | undefined } | { ok: false; response: NextResponse } {
  const machines = ((body ?? {}) as { machines?: unknown }).machines;
  if (machines === undefined) return { ok: true, machines: undefined };
  if (
    !Array.isArray(machines) ||
    machines.length === 0 ||
    machines.some((m) => typeof m !== 'string' || m.length === 0)
  ) {
    return {
      ok: false,
      response: problemValidation('machines must be a non-empty string array when provided', {
        'body.machines': ['must be a non-empty string array when provided'],
      }),
    };
  }
  return { ok: true, machines: machines as string[] };
}
