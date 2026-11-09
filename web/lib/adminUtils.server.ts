/** Server-only admin utilities. Never import from a client component. */

import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';
import { parseMachineIds, scopeCovers } from '@/lib/machineAccess';
import { pausedByPlan, type PlanMemo } from '@/lib/planPause.server';
import { deriveMembership } from '@/lib/sitePolicy.server';

export interface SiteRecipient {
  userId: string;
  email: string;
  ccEmails: string[];
  mutedMachines: string[];
  /** the member row's machine scope; null is the whole site */
  machineIds: readonly string[] | null;
}

/** false when the recipient muted the machine or their machine scope does not reach it */
export function recipientWantsMachine(recipient: SiteRecipient, machineId: string): boolean {
  // a recipient built without the field reaches no machine; scopeCovers would throw on it
  if (recipient.machineIds === undefined) return false;
  return !recipient.mutedMachines.includes(machineId) && scopeCovers(recipient.machineIds, machineId);
}

/** One user, resolved as the recipient of an alert that has no site to scope it to. */
export interface UserRecipient {
  userId: string;
  email: string;
  ccEmails: string[];
}

const isProduction =
  process.env.NODE_ENV === 'production' &&
  !process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN?.includes('dev');

const ADMIN_EMAIL = isProduction
  ? process.env.ADMIN_EMAIL_PROD
  : process.env.ADMIN_EMAIL_DEV;

/**
 * Email-friendly site label: `"name (siteId)"`, or the bare id when unnamed or
 * the lookup fails.
 */
export async function getSiteLabel(siteId: string): Promise<string> {
  try {
    const siteDoc = await getAdminDb().collection('sites').doc(siteId).get();
    const name = (siteDoc.data()?.name as string | undefined)?.trim();
    return name && name !== siteId ? `${name} (${siteId})` : siteId;
  } catch {
    return siteId;
  }
}

/** users per `getAll`, so a large site is never one unbounded read */
const USER_READ_CHUNK = 100;

/**
 * Site recipients carrying userId + email, for per-user email personalization
 * (unsubscribe links). Optionally filtered by one alert preference. None when
 * the site's payer has no `owlette.control`; pass a batch's `planMemo` to
 * resolve each payer once.
 *
 * Recipients are the site's active member rows, plus the legacy `users.sites[]`
 * array during the transition, plus the owner. Each carries its member row's
 * machine scope (null for the whole site, the owner and the ADMIN_EMAIL
 * fallback), so a sender filters per machine with {@link recipientWantsMachine}.
 */
export async function getSiteAlertRecipients(
  siteId: string,
  filterPreference?: 'healthAlerts' | 'processAlerts' | 'thresholdAlerts' | 'cortexAlerts' | 'displayAlerts' | 'talonAlerts',
  planMemo?: PlanMemo
): Promise<SiteRecipient[]> {
  const db = getAdminDb();
  const recipients: SiteRecipient[] = [];
  const seenIds = new Set<string>();
  // A throw is NOT "genuinely no recipients" — fail open (deliver, no mutes) or
  // a transient Firestore error plus an admin mute silently drops a real alert.
  let enumerationFailed = false;
  // At least one alertable user exists (member or owner, has email, not deleted)
  // even if they opted out of THIS alert. Then an empty set means "everyone
  // opted out" — respect it; only a genuinely orphan site gets the fallback.
  let siteHasUsers = false;

  const addUser = (
    userId: string,
    data: FirebaseFirestore.DocumentData | undefined,
    machineIds: readonly string[] | null,
  ) => {
    if (typeof data?.deletedAt === 'number') return;
    const email = data?.email as string | undefined;
    if (!email) return;
    siteHasUsers = true;
    if (filterPreference && data?.preferences?.[filterPreference] === false) return;
    recipients.push({ userId, email, ccEmails: data?.preferences?.alertCcEmails || [], mutedMachines: data?.preferences?.mutedMachines || [], machineIds });
  };

  try {
    const siteDoc = await db.collection('sites').doc(siteId).get();
    const siteData = siteDoc.data();

    // returns before the ADMIN_EMAIL fallback below, which would otherwise page
    // the admin with every paused customer's alerts.
    if (await pausedByPlan(siteId, 'owlette.control', planMemo, siteData ?? null)) {
      logger.warn("alerts paused: the site's plan has no remote control", {
        context: 'adminUtils',
        data: { siteId, filterPreference },
      });
      return [];
    }

    const ownerId = siteData?.owner as string | undefined;

    // read before anyone is added: if it throws, the catch below leaves only the
    // fallback. going on without it would mail a scoped member about every machine.
    const memberRows = await db.collection('sites').doc(siteId).collection('members').get();
    const rowByUid = new Map<string, { active: boolean; machineIds: readonly string[] | null }>();
    for (const doc of memberRows.docs) {
      const data = doc.data();
      rowByUid.set(doc.id, { active: deriveMembership(data) !== null, machineIds: parseMachineIds(data) });
    }

    const usersQuery = await db
      .collection('users')
      .where('sites', 'array-contains', siteId)
      .get();

    for (const doc of usersQuery.docs) {
      seenIds.add(doc.id);
      addUser(doc.id, doc.data(), rowByUid.get(doc.id)?.machineIds ?? null);
    }

    if (ownerId && !seenIds.has(ownerId)) {
      try {
        const ownerDoc = await db.collection('users').doc(ownerId).get();
        addUser(ownerId, ownerDoc.data(), null);
      } catch {
        // Untrustworthy empty set — fall open below rather than apply mutes.
        enumerationFailed = true;
      }
    }

    // a member row the legacy array does not list: a scoped member, or anyone
    // once scripts/migrations/strip-legacy-membership.mjs has run.
    const rowOnly = [...rowByUid]
      .filter(([uid, row]) => row.active && !seenIds.has(uid) && uid !== ownerId)
      .map(([uid]) => uid);
    const reads: Array<Promise<FirebaseFirestore.DocumentSnapshot[]>> = [];
    for (let i = 0; i < rowOnly.length; i += USER_READ_CHUNK) {
      reads.push(db.getAll(...rowOnly.slice(i, i + USER_READ_CHUNK).map((uid) => db.collection('users').doc(uid))));
    }
    for (const doc of (await Promise.all(reads)).flat()) {
      addUser(doc.id, doc.data(), rowByUid.get(doc.id)?.machineIds ?? null);
    }
  } catch (error) {
    enumerationFailed = true;
    console.error('[adminUtils] Error fetching site alert recipients:', error);
  }

  // ADMIN_EMAIL fallback ONLY for a genuinely orphan site or a failed
  // enumeration. If siteHasUsers, the empty set is a deliberate opt-out and
  // firing the fallback would override it and spam the admin.
  //
  // The synthetic recipient carries the admin's own mutes, or the per-recipient
  // mute guard in every sender is silently defeated.
  if (recipients.length === 0 && ADMIN_EMAIL && (enumerationFailed || !siteHasUsers)) {
    let mutedMachines: string[] = [];
    // Only honor mutes on a GENUINELY empty set; a failed enumeration falls open.
    if (!enumerationFailed) {
      try {
        const adminUser = await getAdminAuth().getUserByEmail(ADMIN_EMAIL);
        const adminDoc = await db.collection('users').doc(adminUser.uid).get();
        const adminData = adminDoc.data();
        if (adminData && typeof adminData.deletedAt !== 'number') {
          mutedMachines = adminData.preferences?.mutedMachines || [];
        }
      } catch {
        // No Auth user (distribution list) or Auth down — deliver with no mutes.
      }
    }
    recipients.push({ userId: 'fallback', email: ADMIN_EMAIL, ccEmails: [], mutedMachines, machineIds: null });
  }

  return recipients;
}

/**
 * The single recipient for a user-scoped alert — one an api key raises, where
 * there is no site to enumerate members of. Returns null when the user is
 * deleted, has no email, or opted out; the caller sends nothing.
 *
 * Deliberately unlike {@link getSiteAlertRecipients} in two ways. There is no
 * ADMIN_EMAIL fallback: that exists so an ORPHAN SITE still pages someone, and
 * applied here it would mail the admin about a stranger's api key. And there is
 * no `mutedMachines` — a key belongs to no machine, so no mute can apply.
 *
 * `userId` comes off the returned snapshot, not the argument, so a caller can
 * assert the recipient it got back is the owner it asked about.
 */
export async function getUserAlertRecipient(
  userId: string,
  // Only user-scoped alert preference today; widen the union when another lands.
  filterPreference: 'apiKeyAlerts'
): Promise<UserRecipient | null> {
  try {
    const userDoc = await getAdminDb().collection('users').doc(userId).get();
    const data = userDoc.data();
    if (!data) return null;
    if (typeof data.deletedAt === 'number') return null;
    const email = data.email as string | undefined;
    if (!email) return null;
    // Opt-out model: absent means enabled.
    if (data.preferences?.[filterPreference] === false) return null;
    return { userId: userDoc.id, email, ccEmails: data.preferences?.alertCcEmails || [] };
  } catch (error) {
    console.error('[adminUtils] Error fetching user alert recipient:', error);
    return null;
  }
}

/**
 * A machine's IANA timezone for alert emails. Only `machine_timezone_iana` works —
 * the sibling `machine_timezone` holds the Windows registry name and makes `Intl`
 * throw RangeError. Agents < 2.6.1 lack the field; callers fall back to UTC.
 */
export async function getMachineTimezone(siteId: string, machineId: string): Promise<string | undefined> {
  try {
    const db = getAdminDb();
    const machineDoc = await db.collection('sites').doc(siteId).collection('machines').doc(machineId).get();
    return machineDoc.data()?.machine_timezone_iana as string | undefined;
  } catch {
    return undefined;
  }
}
