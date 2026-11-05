/**
 * `membership.server.ts` — THE single writer for site membership.
 *
 * Wave 2 of `dev/active/per-site-roles`. Membership is implied today by two legacy
 * fields — `sites/{siteId}.owner` and `users/{uid}.sites[]` — written from eleven
 * places; this module is the only writer allowed from here on.
 *
 * DUAL-WRITE. Every mutation writes BOTH `sites/{siteId}/members/{uid}` and the
 * legacy pair in ONE batch or transaction — a write landing in one shape but not the
 * other is the divergence this wave exists to end. The new document is a shadow until
 * Wave 5, when it becomes authoritative.
 *
 * Three invariants, each a live escalation path before this module (details at each
 * function): `addMember` uses `create()`, never `set()`, so a site admin cannot
 * overwrite the OWNER's row and take the site; `updateMember` cannot reach `'owner'` —
 * ownership moves only through the transactional `transferOwnership` (task 2.2);
 * `removeMember` refuses the owner.
 *
 * SUPERADMINS ARE DELIBERATELY NOT MEMBERS. They reach every site by global role
 * (`resolveSiteAccess` short-circuits before the membership term); writing member rows
 * would leave a demoted superadmin holding a membership nobody granted. The cost is
 * that a superadmin appears in no member list — the members endpoint's problem.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { listUserStanding } from '@/lib/sitePolicy.server';
import { parseSwoopMode, type SwoopMode } from '@/lib/swoopMode';

/** Stored per-site role. `owner` is written only by ownership transfer. */
export type MemberRole = 'owner' | 'admin' | 'member';

/** Roles a membership mutation may assign. `owner` is deliberately absent. */
export type AssignableRole = 'admin' | 'member';

export const ASSIGNABLE_ROLES: readonly AssignableRole[] = ['admin', 'member'];

export interface MemberDoc {
  /** Duplicated as a FIELD, not just the document id, so the client can run
   *  `collectionGroup('members').where('uid','==',me)` — the Wave 4 read path. */
  uid: string;
  role: MemberRole;
  /** Present from day one so invitations can be added later with no migration. */
  status: 'active';
  addedAt: Date;
  addedBy: string;
  /**
   * the person's own swoop mode, present only when someone set it; absent means
   * the role decides. never stored as null, and never on the owner's row.
   */
  swoop?: SwoopMode;
}

/** a member's access on a site: the site role, and their own swoop mode or null. */
export interface MemberAccess {
  role: MemberRole;
  swoop: SwoopMode | null;
}

/** Typed failures. Callers map these to status codes; this module picks none. */
export type MembershipFailure =
  | { kind: 'already_member' }
  | { kind: 'not_member' }
  | { kind: 'is_owner' }
  | { kind: 'site_not_found' }
  | { kind: 'user_not_found' }
  | { kind: 'user_inactive' }
  | { kind: 'invalid_role' };

export type MembershipResult<T = void> =
  | ({ ok: true } & (T extends void ? Record<string, never> : { value: T }))
  | { ok: false; failure: MembershipFailure };

function memberRef(db: FirebaseFirestore.Firestore, siteId: string, uid: string) {
  return db.collection('sites').doc(siteId).collection('members').doc(uid);
}

/**
 * Add a member to a site. Authorization and email→uid resolution are the CALLER's
 * job; this module trusts the uid and re-checks only the invariants above.
 */
/**
 * every site id where the user's member row grants a site role, read as every
 * gate reads it: an inactive row or a malformed role lists nothing.
 *
 * The read counterpart to this module's writes, and the replacement for
 * `getUserSiteIds` (which reads the legacy `users/{uid}.sites[]` array). Anything
 * still scoping on that array silently scopes to NOTHING once wave 6.1 strips it
 * — an empty 200, not an error — which is why the two hoot/chat callers had to
 * move before the migration could run.
 *
 * the query and its index note are `listUserStanding`'s, in sitePolicy.server.ts.
 */
export async function listUserSiteIds(userId: string): Promise<string[]> {
  return Object.keys(await listUserStanding(userId));
}

export async function addMember(input: {
  siteId: string;
  uid: string;
  role: AssignableRole;
  swoop?: SwoopMode;
  addedBy: string;
  now?: () => Date;
  db?: FirebaseFirestore.Firestore;
}): Promise<MembershipResult> {
  if (!ASSIGNABLE_ROLES.includes(input.role)) {
    return { ok: false, failure: { kind: 'invalid_role' } };
  }

  const db = input.db ?? getAdminDb();
  const now = (input.now ?? (() => new Date()))();
  const userRef = db.collection('users').doc(input.uid);

  const batch = db.batch();
  // create(), never set(): fails closed if a row (owner included) already exists.
  batch.create(memberRef(db, input.siteId, input.uid), {
    uid: input.uid,
    role: input.role,
    status: 'active',
    addedAt: now,
    addedBy: input.addedBy,
    ...(input.swoop !== undefined ? { swoop: input.swoop } : {}),
  } satisfies MemberDoc);
  batch.update(userRef, { sites: FieldValue.arrayUnion(input.siteId) });

  try {
    await batch.commit();
  } catch (err) {
    if (isAlreadyExists(err)) return { ok: false, failure: { kind: 'already_member' } };
    throw err;
  }

  return { ok: true } as MembershipResult;
}

/**
 * Change a member's per-site role, their swoop mode, or both, and return their
 * access before and after the write.
 *
 * `AssignableRole` makes `'owner'` untypeable as a destination and the owner check
 * below makes it unreachable as a source — together they close the
 * admin-promotes-self-to-owner path. the same check keeps a mode off the owner's
 * row, because the owner always controls.
 *
 * `swoop: null` deletes the field, so the role decides again. a role change
 * leaves the mode as it is.
 */
export async function updateMember(input: {
  siteId: string;
  uid: string;
  role?: AssignableRole;
  swoop?: SwoopMode | null;
  db?: FirebaseFirestore.Firestore;
}): Promise<MembershipResult<{ before: MemberAccess; after: MemberAccess }>> {
  if (input.role !== undefined && !ASSIGNABLE_ROLES.includes(input.role)) {
    return { ok: false, failure: { kind: 'invalid_role' } };
  }

  const db = input.db ?? getAdminDb();
  const ref = memberRef(db, input.siteId, input.uid);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, failure: { kind: 'not_member' } };
    const row = snap.data() as MemberDoc;
    // Read INSIDE the transaction: a concurrent transferOwnership that makes this
    // uid the owner must abort this write rather than demote the new owner.
    if (row.role === 'owner') {
      return { ok: false, failure: { kind: 'is_owner' } };
    }

    const before: MemberAccess = { role: row.role, swoop: parseSwoopMode(row.swoop) };
    const update: { role?: AssignableRole; swoop?: SwoopMode | FieldValue } = {};
    if (input.role !== undefined) update.role = input.role;
    if (input.swoop !== undefined) {
      update.swoop = input.swoop === null ? FieldValue.delete() : input.swoop;
    }
    if (Object.keys(update).length > 0) tx.update(ref, update);

    const after: MemberAccess = {
      role: input.role ?? before.role,
      swoop: input.swoop === undefined ? before.swoop : input.swoop,
    };
    return { ok: true, value: { before, after } };
  });
}

/**
 * Remove a member from a site.
 *
 * Refuses the owner — a site must never be left ownerless. The check runs inside the
 * transaction that performs the write: the existing DELETE route evaluates its guard
 * against a snapshot taken before talon reassignment, so a concurrent ownership
 * transfer slips in and the removal strips the NEW owner's `sites[]` entry.
 *
 * Talon reassignment stays the CALLER's business and must still happen first — the
 * route's ordering contract (a refused successor leaves membership intact) is pinned
 * by tests.
 */
export async function removeMember(input: {
  siteId: string;
  uid: string;
  db?: FirebaseFirestore.Firestore;
}): Promise<MembershipResult> {
  const db = input.db ?? getAdminDb();
  const ref = memberRef(db, input.siteId, input.uid);
  const siteRef = db.collection('sites').doc(input.siteId);
  const userRef = db.collection('users').doc(input.uid);

  return db.runTransaction(async (tx) => {
    const [memberSnap, siteSnap] = await Promise.all([tx.get(ref), tx.get(siteRef)]);

    // A MISSING SITE IS NOT A REFUSAL: the guard below protects the OWNER, and a
    // deleted site has none. The membership left behind is the dangling entry that
    // makes a re-registered slug inherit the previous tenant's members, and stripping
    // it is what ManageUserSitesDialog's orphan cleanup depends on. The DELETE route
    // 404s on a missing site itself, before calling this.
    if (!siteSnap.exists) {
      if (memberSnap.exists) tx.delete(ref);
      tx.update(userRef, { sites: FieldValue.arrayRemove(input.siteId) });
      return { ok: true };
    }

    // BOTH shapes are consulted while the legacy field is still authoritative:
    // the member row may not exist yet for a site whose owner predates this
    // module, so the legacy `owner` field is the one that must not be removed.
    const ownerUid = (siteSnap.data() as { owner?: unknown } | undefined)?.owner;
    const isOwnerByLegacyField = typeof ownerUid === 'string' && ownerUid === input.uid;
    const isOwnerByMemberDoc = (memberSnap.data() as MemberDoc | undefined)?.role === 'owner';
    if (isOwnerByLegacyField || isOwnerByMemberDoc) {
      return { ok: false, failure: { kind: 'is_owner' } };
    }

    // Absent member row is NOT an error while the subcollection is a shadow —
    // refusing would make the endpoint unusable for every pre-existing member.
    if (memberSnap.exists) tx.delete(ref);
    tx.update(userRef, { sites: FieldValue.arrayRemove(input.siteId) });
    return { ok: true };
  }) as Promise<MembershipResult>;
}

/**
 * Write the owner's member row into a batch `createSite` ALREADY commits — site
 * document, owner field and member row land in one atomic write. It takes the batch
 * rather than committing because a second commit reopens the partial-write window.
 */
export function addOwnerToBatch(
  batch: FirebaseFirestore.WriteBatch,
  input: { siteId: string; ownerUid: string; now: Date; db?: FirebaseFirestore.Firestore },
): void {
  const db = input.db ?? getAdminDb();
  batch.set(memberRef(db, input.siteId, input.ownerUid), {
    uid: input.ownerUid,
    role: 'owner',
    status: 'active',
    addedAt: input.now,
    addedBy: input.ownerUid,
  } satisfies MemberDoc);
}

/**
 * Firestore signals a failed `create()` on an existing document as gRPC code 6
 * (ALREADY_EXISTS). The emulator and the production client differ in which of
 * `code`/`message` they populate, so both are checked.
 */
function isAlreadyExists(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (code === 6 || code === 'already-exists' || code === 'ALREADY_EXISTS') return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && /already exists/i.test(message);
}
