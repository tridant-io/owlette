'use client';

import { useCallback, useState } from 'react';
import { MACHINE_LIMIT_ERROR } from '@/lib/planResponse';

/** the move route's `data`: 202 a new move, 200 the same move again or a cancel. */
export interface MachineMoveResult {
  moveId: string;
  status: 'pending' | 'switching' | 'cancelled';
  targetSiteId: string;
  /** epoch ms; absent on a cancel. */
  expiresAt?: number;
}

export interface UseMachineMoveResult {
  /** rejects with the route's user-facing refusal as the message. */
  requestMove: (machineId: string, targetSiteId: string) => Promise<MachineMoveResult>;
  /** rejects with the route's user-facing refusal as the message. */
  cancelMove: (machineId: string) => Promise<MachineMoveResult>;
  busy: boolean;
}

const NETWORK_ERROR = 'could not reach owlette. check your connection and try again.';

/** moves a machine of `siteId` to another site, or cancels that move, through `/api/sites/{siteId}/machines/{machineId}/move`. */
export function useMachineMove(siteId: string): UseMachineMoveResult {
  const [busy, setBusy] = useState(false);

  const send = useCallback(
    async (
      machineId: string,
      method: 'POST' | 'DELETE',
      body: { targetSiteId: string } | null,
      fallback: string,
    ): Promise<MachineMoveResult> => {
      setBusy(true);
      try {
        let response: Response;
        try {
          response = await fetch(
            `/api/sites/${encodeURIComponent(siteId)}/machines/${encodeURIComponent(machineId)}/move`,
            {
              method,
              headers: {
                'content-type': 'application/json',
                'Idempotency-Key': makeIdempotencyKey(`machine-move-${method.toLowerCase()}-${machineId}`),
              },
              body: body ? JSON.stringify(body) : undefined,
            },
          );
        } catch {
          throw new Error(NETWORK_ERROR);
        }
        if (!response.ok) throw new Error(await problemMessage(response, fallback));
        const answer = (await response.json()) as { data: MachineMoveResult };
        return answer.data;
      } finally {
        setBusy(false);
      }
    },
    [siteId],
  );

  const requestMove = useCallback(
    (machineId: string, targetSiteId: string) =>
      send(machineId, 'POST', { targetSiteId }, 'could not move the machine'),
    [send],
  );

  const cancelMove = useCallback(
    (machineId: string) => send(machineId, 'DELETE', null, 'could not cancel the move'),
    [send],
  );

  return { requestMove, cancelMove, busy };
}

/** a refusal's problem+json `detail`, already user-facing; a 402 is owlette free's machine limit. */
async function problemMessage(response: Response, fallback: string): Promise<string> {
  if (response.status === 402) return MACHINE_LIMIT_ERROR;
  const problem = (await response.json().catch(() => ({}))) as { detail?: string; title?: string };
  return problem.detail || problem.title || `${fallback} (${response.status})`;
}

// duplicated per hook rather than shared, matching the other mutation hooks
function makeIdempotencyKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
