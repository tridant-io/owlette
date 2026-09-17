'use client';

/**
 * Result of one dispatched machine command, read from the agent's
 * `sites/{siteId}/machines/{machineId}/commands/completed` doc (one field per
 * command id).
 *
 * Scoped to `commandId`: null holds no subscription, a new id swaps it, and the
 * listener closes itself once the entry lands — a completed entry never changes
 * — so a dispatch never leaves a standing per-machine listener behind.
 */

import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';

interface InternalState {
  /** Stamps the result with the command it came from, so a swapped id reads as
   * pending instead of showing the previous command's result. */
  commandId: string | null;
  result: string | null;
}

const INITIAL_STATE: InternalState = { commandId: null, result: null };

/**
 * The command's `result` string once the agent marks it completed, or null while
 * it is still pending. A completed command that recorded no result reads as
 * 'no result' — a resolved command is never null.
 */
export function useCommandResult(
  siteId: string,
  machineId: string,
  commandId: string | null,
): string | null {
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
          | { status?: string; result?: unknown }
          | undefined;
        if (!entry || entry.status !== 'completed') return;
        setState({
          commandId,
          result: typeof entry.result === 'string' ? entry.result : 'no result',
        });
        unsubscribe();
      },
      (err) => {
        console.error('Error subscribing to command result:', err);
      },
    );
    return () => unsubscribe();
  }, [siteId, machineId, commandId]);

  // Render-time derivation, matching useDisplayModes: a stale stamp reads as
  // pending rather than leaking the previous command's result.
  return state.commandId !== null && state.commandId === commandId
    ? state.result
    : null;
}
