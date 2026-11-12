/**
 * owlette free's machine limit where agent credentials are minted (adr 0018):
 * device-code authorize and the deferred `/ADD=` mint at poll. the agent writes
 * its own machine doc, so minting is the only place the limit can hold.
 *
 * a refusal is 402 `{ error }`, never 401/403: every fielded agent shows only
 * `error`, and a 401/403 on an agent auth route reads as a dead credential.
 *
 * both mints create the agent's auth user first, see ensureAgentAuthUser.
 */

import type { Auth } from 'firebase-admin/auth';
import { FieldValue, type Transaction } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { pruneMachineFromFleet } from '@/lib/fleet/cleanup.server';
import { FLEET_SETTINGS_DOC, parseFleetSettings } from '@/lib/fleet/policy.server';
import logger from '@/lib/logger';
import { pruneMachineFromMembers } from '@/lib/membership.server';
import { machineSlotAvailable } from '@/lib/plan.server';

export const MACHINE_LIMIT_ERROR =
  'owlette free covers one machine. upgrade to add more, or remove a machine first.';

/** the refusal message when a free site's owner has no room for `machineId` on owlette free, else null. */
export async function machineLimitRefusal(
  siteId: string,
  machineId: string,
  siteData?: Record<string, unknown> | null,
): Promise<string | null> {
  return (await machineSlotAvailable(siteId, machineId, siteData)) ? null : MACHINE_LIMIT_ERROR;
}

/** a machine id as the agent sends it, trimmed; null when absent, not ok when unusable as a doc id. */
export function sanitizeMachineId(value: unknown): { ok: true; machineId: string | null } | { ok: false } {
  if (value === undefined || value === null) {
    return { ok: true, machineId: null };
  }

  if (typeof value !== 'string') {
    return { ok: false };
  }

  const machineId = value.trim();
  if (
    machineId.length < 1 ||
    machineId.length > 128 ||
    machineId.includes('/') ||
    /[\x00-\x1F]/.test(machineId)
  ) {
    return { ok: false };
  }

  return { ok: true, machineId };
}

/**
 * the machine's doc on the site, or null for an id with a slash. ids are validated
 * where they arrive; this keeps one from addressing a nested doc whatever the caller.
 */
function siteMachineRef(siteId: string, machineId: string) {
  if (machineId.includes('/')) return null;
  return getAdminDb().collection('sites').doc(siteId).collection('machines').doc(machineId);
}

/**
 * whether the site already has `machineId`, read in `transaction`. both mints
 * pair a machine already on the site only when the approval names it, or a
 * generated code allows any.
 */
export async function machineOnSite(
  transaction: Transaction,
  siteId: string,
  machineId: string,
): Promise<boolean> {
  const ref = siteMachineRef(siteId, machineId);
  return ref ? (await transaction.get(ref)).exists : false;
}

/**
 * whether `machineId` is a sender in the site's fleet grant, on or off, read in
 * `transaction`. a code allowed to reinstall any machine still pairs a sender
 * only when it names it, since the grant stays with the machine id.
 */
export async function fleetSenderOnSite(
  transaction: Transaction,
  siteId: string,
  machineId: string,
): Promise<boolean> {
  const ref = getAdminDb().collection('sites').doc(siteId).collection('settings').doc(FLEET_SETTINGS_DOC);
  const snap = await transaction.get(ref);
  const { senders } = parseFleetSettings(snap.exists ? snap.data() : null);
  return Object.prototype.hasOwnProperty.call(senders, machineId);
}

/**
 * creates the agent's auth user unless it exists, before the mint signs in as it.
 * a custom-token sign-in for a uid with no user creates one, which counts as a
 * sign-up and is refused once firebase auth's sign-up setting is off; an admin
 * sdk create is not.
 */
export async function ensureAgentAuthUser(adminAuth: Auth, uid: string): Promise<void> {
  try {
    await adminAuth.createUser({ uid });
  } catch (error: unknown) {
    if ((error as { code?: string } | null)?.code !== 'auth/uid-already-exists') throw error;
  }
}

/**
 * what a pairing records once the credentials are minted. best effort: failing
 * the pairing over either step would strand those credentials.
 *
 * - stamps `pairedAt` on the machine doc unless it already has one, so a re-pair
 *   keeps the original date the lapse ui orders machines by.
 * - when the machine doc did not exist, takes the id out of every machine scope
 *   on the site. missing means an id new to the site, or one whose doc a leave
 *   deleted: dashboard removal, or the desktop app's leave-site, which deletes it
 *   through the agent's rest client and never reaches `removeMachine`. machine
 *   ids start as hostnames and get reused, so a machine that pairs anew starts
 *   with no member's grant. a re-pair of a machine still on the site, a legacy
 *   doc with no `pairedAt` included, keeps its grants, and so does a failed read,
 *   which proves nothing.
 * - in the same case, takes the id out of the site's fleet grant, with any fleet
 *   session and call record left under it (ADR 0017), for the same reason.
 */
export async function recordPairing(siteId: string, machineId: string): Promise<void> {
  let existed = true;
  try {
    const ref = siteMachineRef(siteId, machineId);
    if (!ref) return;
    existed = await getAdminDb().runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      if (snap.data()?.pairedAt == null) {
        transaction.set(ref, { pairedAt: FieldValue.serverTimestamp() }, { merge: true });
      }
      return snap.exists;
    });
  } catch (error: unknown) {
    logger.warn(`pairedAt not stamped: site=${siteId}, machine=${machineId}`, {
      context: 'pairing',
      data: { error: error instanceof Error ? error.message : String(error) },
    });
  }
  if (existed) return;

  try {
    await pruneMachineFromMembers({ siteId, machineId });
  } catch (error: unknown) {
    logger.warn(`machine scopes not pruned: site=${siteId}, machine=${machineId}`, {
      context: 'pairing',
      data: { error: error instanceof Error ? error.message : String(error) },
    });
  }

  try {
    await pruneMachineFromFleet({ siteId, machineId });
  } catch (error: unknown) {
    logger.warn(`fleet grant not pruned: site=${siteId}, machine=${machineId}`, {
      context: 'pairing',
      data: { error: error instanceof Error ? error.message : String(error) },
    });
  }
}
