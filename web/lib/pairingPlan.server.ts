/**
 * the machine limit where agent credentials are minted (plan.md decision 6):
 * device-code authorize, the deferred `/ADD=` mint at poll, and registration-code
 * exchange. the agent writes its own machine doc, so minting is the only place
 * the limit can hold.
 *
 * a refusal is 402 `{ error }`, never 401/403: every fielded agent shows only
 * `error`, and a 401/403 on an agent auth route reads as a dead credential.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';
import { machineSlotAvailable, payerForSite, plansEnforced } from '@/lib/plan.server';

export const MACHINE_LIMIT_ERROR =
  'owlette free covers one machine. upgrade to add more, or remove a machine first.';

/** the refusal message when the site's payer has no slot for `machineId`, else null. */
export async function machineLimitRefusal(
  siteId: string,
  machineId: string,
  siteData?: Record<string, unknown> | null,
): Promise<string | null> {
  if (!plansEnforced()) return null;
  const payer = await payerForSite(siteId, siteData);
  return (await machineSlotAvailable(payer, machineId)) ? null : MACHINE_LIMIT_ERROR;
}

/**
 * stamps `pairedAt` on the machine doc unless it already has one, so a re-pair
 * keeps the original date the lapse ui orders machines by. best effort: the
 * credentials are already minted, and failing the pairing over this would strand them.
 */
export async function stampPairedAt(siteId: string, machineId: string): Promise<void> {
  try {
    // generate and exchange take the machine id unvalidated, and a slash would address a nested doc.
    if (machineId.includes('/')) return;
    const db = getAdminDb();
    const ref = db.collection('sites').doc(siteId).collection('machines').doc(machineId);
    await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      if (snap.data()?.pairedAt == null) {
        transaction.set(ref, { pairedAt: FieldValue.serverTimestamp() }, { merge: true });
      }
    });
  } catch (error: unknown) {
    logger.warn(`pairedAt not stamped: site=${siteId}, machine=${machineId}`, {
      context: 'pairing',
      data: { error: error instanceof Error ? error.message : String(error) },
    });
  }
}
