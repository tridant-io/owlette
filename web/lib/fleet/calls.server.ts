/**
 * `fleet_calls/{commandId}`: the server-only record that binds a started call
 * to the machine that started it (ADR 0017). dispatch writes and reads it; this
 * module names it, and clears it when a machine or a site goes.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { deleteRefsInBatches } from '@/lib/fleet/session.server';

export const FLEET_CALLS_COLLECTION = 'fleet_calls';

/** times are epoch milliseconds. */
export interface FleetCallRecord {
  siteId: string;
  /** the machine that started the call, the only one that may read it. */
  callerMachineId: string;
  /** the machine the call acts on. */
  machineId: string;
  tool: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * delete a site's call records, or with `machineId` only those that machine
 * started or was acted on by.
 */
export async function deleteFleetCalls(
  db: Firestore,
  { siteId, machineId }: { siteId: string; machineId?: string },
): Promise<number> {
  const ofSite = db.collection(FLEET_CALLS_COLLECTION).where('siteId', '==', siteId);
  // `!== undefined`, as in revokeFleetSessions: an empty machine id matches nothing
  const snaps =
    machineId === undefined
      ? [await ofSite.get()]
      : await Promise.all([
          ofSite.where('callerMachineId', '==', machineId).get(),
          ofSite.where('machineId', '==', machineId).get(),
        ]);
  // a call a machine made on itself is in both
  const refs = new Map(snaps.flatMap((snap) => snap.docs.map((doc) => [doc.ref.path, doc.ref] as const)));
  return deleteRefsInBatches(db, [...refs.values()]);
}
