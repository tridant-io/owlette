/**
 * `transferSiteOwnership.server.ts` — the ONE atomic ownership transfer.
 *
 * Wave 2 task 2.2 of `dev/active/per-site-roles`.
 *
 * Replaces the transfer that was buried in `performUserDeleteCascade`, which
 * validated the successor with plain reads outside any transaction and rewrote each
 * owned site in a separate warn-and-continue `update`. The three live bugs that
 * produced, which this function exists to end:
 *
 *   - A transfer racing a demote hands ownership to a user whose global role just
 *     became `member`; ownership short-circuits the capability matrix, so they
 *     silently gain SITE_DELETE.
 *   - `?successorUid=<the uid being deleted>` passed every guard, leaving a site
 *     owned by a soft-deleted account — unreachable by its own owner, since both
 *     `resolveSiteAccess` and `firestore.rules` reject a deleted principal — while
 *     the operation reported success.
 *   - A failed transfer was permanent: the idempotency short-circuit replays the
 *     recorded response on retry instead of finishing the work.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import type { MemberDoc } from '@/lib/membership.server';
import { planLimit, resolvePlan } from '@/lib/plan.server';

export type TransferFailure =
  | { kind: 'site_not_found' }
  | { kind: 'not_owner' }
  | { kind: 'successor_not_found' }
  | { kind: 'successor_inactive' }
  | { kind: 'successor_already_owner' }
  | { kind: 'site_has_no_owner' }
  | { kind: 'plan_limit'; entitlement: 'owlette.sites' | 'owlette.machines' };

export type TransferResult =
  | { ok: true; previousOwnerUid: string; newOwnerUid: string }
  | { ok: false; failure: TransferFailure };

export interface TransferInput {
  siteId: string;
  successorUid: string;
  actorUid: string;
  /** True when the actor holds the global superadmin role. */
  actorIsSuperadmin: boolean;
  /**
   * account deletion hands every site over even past the successor's plan: a
   * departing owner can't be held hostage to someone else's limits, and the
   * successor's gates still refuse anything new.
   */
  skipPlanCheck?: boolean;
  now?: () => Date;
  db?: FirebaseFirestore.Firestore;
}

/**
 * Move ownership of a site to `successorUid`.
 *
 * The actor must BE the current owner, or a superadmin — a site admin is not
 * enough, the same line `SITE_DELETE` draws.
 *
 * The successor need not already be a member; this transaction makes them one.
 * Requiring prior membership would force a two-step add-then-transfer whose window
 * is exactly the partial state this closes.
 *
 * The outgoing owner is demoted to `admin` and KEEPS their `sites[]` entry; callers
 * wanting them gone must remove them afterwards, through `membership.server.ts`.
 */
export async function transferSiteOwnership(input: TransferInput): Promise<TransferResult> {
  const db = input.db ?? getAdminDb();
  const now = (input.now ?? (() => new Date()))();

  const siteRef = db.collection('sites').doc(input.siteId);
  const successorUserRef = db.collection('users').doc(input.successorUid);
  const membersCol = siteRef.collection('members');

  // before the transaction: the tridant lookup can run to its timeout, and the
  // transaction's reads would hold their locks for all of it.
  const planRefusal = input.skipPlanCheck
    ? null
    : await successorPlanRefusal(db, input.successorUid, input.siteId);

  return db.runTransaction(async (tx) => {
    // All reads first: Firestore forbids a read after a write in one transaction,
    // and these are the documents whose concurrent modification must abort this.
    const [siteSnap, successorSnap] = await Promise.all([
      tx.get(siteRef),
      tx.get(successorUserRef),
    ]);

    if (!siteSnap.exists) return { ok: false, failure: { kind: 'site_not_found' } };

    const siteData = (siteSnap.data() ?? {}) as { owner?: unknown };
    const currentOwnerUid = typeof siteData.owner === 'string' ? siteData.owner : null;
    if (!currentOwnerUid) {
      // An ownerless site is a repair job — never invent an owner from the caller.
      return { ok: false, failure: { kind: 'site_has_no_owner' } };
    }

    // THE authorization decision, from a document read inside this transaction.
    if (!input.actorIsSuperadmin && input.actorUid !== currentOwnerUid) {
      return { ok: false, failure: { kind: 'not_owner' } };
    }

    // Refused, not treated as a no-op success: silent success hides the caller's bug.
    if (input.successorUid === currentOwnerUid) {
      return { ok: false, failure: { kind: 'successor_already_owner' } };
    }

    if (!successorSnap.exists) return { ok: false, failure: { kind: 'successor_not_found' } };
    const successorData = (successorSnap.data() ?? {}) as { deletedAt?: unknown };
    if (typeof successorData.deletedAt === 'number') {
      // Read in-transaction so a soft-delete racing this transfer aborts it.
      return { ok: false, failure: { kind: 'successor_inactive' } };
    }

    // last, so a caller refused for any other reason learns nothing of the successor's plan.
    if (planRefusal) return { ok: false, failure: planRefusal };

    const previousOwnerMemberRef = membersCol.doc(currentOwnerUid);
    const successorMemberRef = membersCol.doc(input.successorUid);
    const previousOwnerMemberSnap = await tx.get(previousOwnerMemberRef);

    tx.update(siteRef, { owner: input.successorUid });

    // `set`, not `update`: the outgoing owner may predate the members subcollection
    // and have no row at all, and update() on a missing document fails the whole tx.
    if (previousOwnerMemberSnap.exists) {
      tx.update(previousOwnerMemberRef, { role: 'admin' });
    } else {
      tx.set(previousOwnerMemberRef, {
        uid: currentOwnerUid,
        role: 'admin',
        status: 'active',
        addedAt: now,
        addedBy: input.actorUid,
      } satisfies MemberDoc);
    }

    tx.set(successorMemberRef, {
      uid: input.successorUid,
      role: 'owner',
      status: 'active',
      addedAt: now,
      addedBy: input.actorUid,
    } satisfies MemberDoc);

    // Legacy `users.sites[]` mirror, dual-written alongside the members subcollection.
    tx.update(successorUserRef, { sites: FieldValue.arrayUnion(input.siteId) });

    return { ok: true, previousOwnerUid: currentOwnerUid, newOwnerUid: input.successorUid };
  }) as Promise<TransferResult>;
}

/**
 * the plan limit the successor would break by taking the site, or null. the
 * owner is the payer (plan decision 1), so the site counts against the
 * successor's sites and its machines join theirs.
 */
async function successorPlanRefusal(
  db: FirebaseFirestore.Firestore,
  successorUid: string,
  siteId: string,
): Promise<TransferFailure | null> {
  const plan = await resolvePlan(successorUid);
  const siteLimit = planLimit(plan, 'owlette.sites');
  const machineLimit = planLimit(plan, 'owlette.machines');
  if (siteLimit === Infinity && machineLimit === Infinity) return null;

  const owned = await db.collection('sites').where('owner', '==', successorUid).select().get();
  if (owned.docs.length >= siteLimit) return { kind: 'plan_limit', entitlement: 'owlette.sites' };
  if (machineLimit === Infinity) return null;

  const machinesOf = async (id: string) =>
    (await db.collection('sites').doc(id).collection('machines').select().get()).docs.map((doc) => doc.id);
  const [incoming, ...ownedMachines] = await Promise.all(
    [siteId, ...owned.docs.map((site) => site.id)].map(machinesOf),
  );
  const theirs = new Set(ownedMachines.flat());
  const combined = new Set([...theirs, ...incoming]);
  // a site whose machines are all already theirs adds nothing, as a re-pair is exempt at mint.
  return combined.size > theirs.size && combined.size > machineLimit
    ? { kind: 'plan_limit', entitlement: 'owlette.machines' }
    : null;
}
