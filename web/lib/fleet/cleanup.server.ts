/**
 * what a machine leaving its site takes with it (ADR 0017).
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { deleteFleetCalls } from '@/lib/fleet/calls.server';
import { parseFleetSettings, storedFleetGrant, type StoredFleetGrant } from '@/lib/fleet/grant';
import { FLEET_SETTINGS_DOC } from '@/lib/fleet/policy.server';
import { revokeFleetSessions } from '@/lib/fleet/session.server';

/**
 * a sender whose only machine this was keeps its entry with no machines, which
 * reaches nothing. it is never widened to the whole site.
 */
async function pruneMachineFromGrant(db: Firestore, siteId: string, machineId: string): Promise<void> {
  const settingsRef = db.collection('sites').doc(siteId).collection('settings').doc(FLEET_SETTINGS_DOC);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(settingsRef);
    if (!snap.exists) return;
    const { senders } = parseFleetSettings(snap.data());
    const held = Object.entries(senders).some(
      ([id, grant]) => id === machineId || (grant.machineIds ?? []).includes(machineId),
    );
    if (!held) return;
    const kept = Object.entries(senders)
      .filter(([id]) => id !== machineId)
      .map(([id, grant]): [string, StoredFleetGrant] => [
        id,
        storedFleetGrant({ ...grant, machineIds: grant.machineIds?.filter((m) => m !== machineId) ?? null }),
      ]);
    // the whole map, as the settings writer stores it: a named field is replaced whole
    tx.set(
      settingsRef,
      { senders: Object.fromEntries(kept), updatedAt: FieldValue.serverTimestamp() },
      { mergeFields: ['senders', 'updatedAt'] },
    );
  });
}

/**
 * take a machine out of everything fleet on its site: its place in the grant,
 * as a sender and in every sender's list, its fleet sessions, and the call
 * records it started or was acted on by. machine ids start as hostnames and get
 * reused, so a box that pairs under an old id must find no grant and no session
 * waiting. removal and pairing call this, beside `pruneMachineFromMembers`.
 *
 * each of the three on its own: a grant that cannot be written must not leave
 * the machine's sessions alive. the first failure is thrown after the rest.
 */
export async function pruneMachineFromFleet(input: {
  siteId: string;
  machineId: string;
  db?: Firestore;
}): Promise<void> {
  const { siteId, machineId } = input;
  const db = input.db ?? getAdminDb();
  const results = await Promise.allSettled([
    pruneMachineFromGrant(db, siteId, machineId),
    revokeFleetSessions(db, { siteId, machineId }),
    deleteFleetCalls(db, { siteId, machineId }),
  ]);
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw failed.reason;
}
