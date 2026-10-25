'use client';

/**
 * Outcome of one dispatched machine command, read from the agent's
 * `sites/{siteId}/machines/{machineId}/commands/completed` doc (one field per
 * command id).
 *
 * Scoped to `commandId`: null holds no subscription, a new id swaps it, and the
 * listener closes itself once the entry lands — a completed or failed entry
 * never changes — so a dispatch never leaves a standing per-machine listener
 * behind.
 */

import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';

/** A command the agent finished: its result, or the `Error: …` text it failed with. */
export type CommandOutcome =
  | { status: 'completed'; result: string }
  | { status: 'failed'; error: string };

interface InternalState {
  /** Stamps the outcome with the command it came from, so a swapped id reads as
   * pending instead of showing the previous command's outcome. */
  commandId: string | null;
  outcome: CommandOutcome | null;
}

const INITIAL_STATE: InternalState = { commandId: null, outcome: null };

/**
 * The command's outcome once the agent marks it completed or failed, or null
 * while it is still pending. A completed command that recorded no result reads
 * as 'no result', and a failed one with no error as 'no error'.
 */
export function useCommandOutcome(
  siteId: string,
  machineId: string,
  commandId: string | null,
): CommandOutcome | null {
  const [state, setState] = useState<InternalState>(INITIAL_STATE);

  useEffect(() => {
    if (!db || !siteId || !machineId || !commandId) return;

    const ref = doc(
      db, 'sites', siteId, 'machines', machineId, 'commands', 'completed',
    );
    const unsubscribe = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) return;
        const entry = snap.data()[commandId] as
          | { status?: string; result?: unknown; error?: unknown }
          | undefined;
        if (entry?.status === 'completed') {
          setState({
            commandId,
            outcome: {
              status: 'completed',
              result: typeof entry.result === 'string' ? entry.result : 'no result',
            },
          });
        } else if (entry?.status === 'failed') {
          setState({
            commandId,
            outcome: {
              status: 'failed',
              error: typeof entry.error === 'string' ? entry.error : 'no error',
            },
          });
        } else {
          return;
        }
        unsubscribe();
      },
      (err) => {
        console.error('Error subscribing to command result:', err);
      },
    );
    return () => unsubscribe();
  }, [siteId, machineId, commandId]);

  // Render-time derivation, matching useDisplayModes: a stale stamp reads as
  // pending rather than leaking the previous command's outcome.
  return state.commandId !== null && state.commandId === commandId
    ? state.outcome
    : null;
}

/**
 * The command's `result` string once the agent marks it completed, or null while
 * it is still pending or when it failed. A completed command that recorded no
 * result reads as 'no result' — a completed command is never null.
 */
export function useCommandResult(
  siteId: string,
  machineId: string,
  commandId: string | null,
): string | null {
  const outcome = useCommandOutcome(siteId, machineId, commandId);
  return outcome?.status === 'completed' ? outcome.result : null;
}
