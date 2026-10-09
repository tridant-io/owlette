/**
 * User soft-delete cascade for `DELETE /api/users/{uid}`:
 *
 *   1. Refuse if the user owns sites without a `successorUid` — owned sites would be orphaned.
 *      The successor must exist and be at least admin-role.
 *   2. Revoke every api key: `revokedAt` on `users/{uid}/api_keys/*` AND the top-level
 *      `api_keys/{keyHash}` lookup doc, so cached lookups stop succeeding.
 *   3. Cancel pending commands the user issued — background sweep, so a slow command scan doesn't
 *      gate the response. Bounded to the user's assigned + owned sites.
 *   4. Set `users/{uid}.deletedAt`. Doc is preserved for audit, excluded from default list reads.
 *   5. Revoke Firebase Auth refresh tokens and disable the Auth record. No `deleteUser()` —
 *      keeping the record preserves the email→uid mapping for forensics; hard delete belongs to
 *      the self-delete path.
 */

import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { MIN_SUPERADMINS } from '@/lib/actions/setUserRole.server';
import { transferSiteOwnership } from '@/lib/actions/transferSiteOwnership.server';

function asRole(raw: unknown): string | null {
  return typeof raw === 'string' ? raw : null;
}

/**
 * Active superadmins, counted the same way `setUserRole` counts them: role is
 * exactly 'superadmin' and `deletedAt` is absent. Kept as a plain scan rather
 * than a query so it matches that implementation exactly — the two must never
 * disagree about who holds the floor.
 */
async function countActiveSuperadmins(db: FirebaseFirestore.Firestore): Promise<number> {
  const all = await db.collection('users').get();
  return all.docs.reduce((n, doc) => {
    const d = doc.data() ?? {};
    if (d.role !== 'superadmin') return n;
    if (typeof d.deletedAt === 'number') return n;
    return n + 1;
  }, 0);
}

export type UserDeleteOutcome =
  | { kind: 'already_deleted'; deletedAt: number }
  | { kind: 'not_found' }
  | {
      kind: 'orphan_sites';
      ownedSites: string[];
    }
  | {
      kind: 'successor_invalid';
      reason: 'not_found' | 'not_admin' | 'soft_deleted';
    }
  | {
      /**
       * Deleting this user would leave fewer than MIN_SUPERADMINS active
       * superadmins. `setUserRole` has always refused the equivalent DEMOTE;
       * delete did not, so the floor was reachable around it — and unlike a
       * demote the result is unrecoverable, because USER_ROLE_MANAGE exists
       * only in SUPERADMIN_CAPABILITIES, so nobody is left who can appoint a
       * replacement.
       */
      kind: 'last_superadmin';
      activeSuperadmins: number;
    }
  | {
      /**
       * An ownership transfer did not land, so the delete was ABORTED before
       * anything destructive ran — no key revoked, no `deletedAt` stamped.
       *
       * `transferredSites` lists the sites that DID move before the failure.
       * They are not rolled back and do not need to be: each moved atomically,
       * and a re-issued delete re-runs `findOwnedSites`, which queries
       * `sites where owner == uid` — so the sites already handed over simply do
       * not appear the second time. The retry attempts only what is left.
       *
       * A retry does need a NEW Idempotency-Key: reusing the failed request's
       * key replays this refusal rather than re-running the work.
       */
      kind: 'transfer_failed';
      siteId: string;
      reason: string;
      transferredSites: string[];
    }
  | {
      kind: 'deleted';
      deletedAt: number;
      revokedKeyIds: string[];
      transferredSites: string[];
      /**
       * Auth user revoked + disabled. Best-effort: a transient Auth failure does NOT roll back
       * the Firestore soft-delete (rules already gate on `deletedAt`), but is surfaced for audit.
       */
      authDisabled: boolean;
    };

/** Sites this user owns — the route handler surfaces the orphan guard before any mutation. */
export async function findOwnedSites(uid: string): Promise<string[]> {
  const db = getAdminDb();
  const ownedSnap = await db
    .collection('sites')
    .where('owner', '==', uid)
    .get();
  return ownedSnap.docs.map((d) => d.id);
}

interface CascadeOptions {
  /** Required when the user owns at least one site; rejected otherwise. */
  successorUid?: string | null;
}

export async function performUserDeleteCascade(
  uid: string,
  options: CascadeOptions = {},
): Promise<UserDeleteOutcome> {
  const db = getAdminDb();

  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    return { kind: 'not_found' };
  }
  const userData = userSnap.data() ?? {};

  // True-idempotent: a re-issued DELETE on an already-deleted user is a no-op.
  if (typeof userData.deletedAt === 'number') {
    return { kind: 'already_deleted', deletedAt: userData.deletedAt };
  }

  // Superadmin floor. Enforced BEFORE any other refusal so the most consequential
  // answer wins, and before every mutation so a refusal costs nothing.
  //
  // `setUserRole` counts the same population inside its transaction to refuse the
  // last DEMOTE; deleting the account achieved the same end state and was not
  // counted at all. Soft-deleted users are excluded from the count exactly as
  // there — a deleted superadmin cannot authenticate, so it cannot hold the floor.
  if (asRole(userData.role) === 'superadmin') {
    const activeSuperadmins = await countActiveSuperadmins(db);
    if (activeSuperadmins <= MIN_SUPERADMINS) {
      return { kind: 'last_superadmin', activeSuperadmins };
    }
  }

  // Owned-site check: refuse without a successor.
  const ownedSites = await findOwnedSites(uid);
  const successorUid =
    typeof options.successorUid === 'string' && options.successorUid.length > 0
      ? options.successorUid
      : null;

  if (ownedSites.length > 0 && !successorUid) {
    return { kind: 'orphan_sites', ownedSites };
  }

  // Successor must be live and >= admin: a member-tier owner inherits the site but lacks the
  // admin dashboard surface, which breaks it.
  if (successorUid) {
    const successorRef = db.collection('users').doc(successorUid);
    const successorSnap = await successorRef.get();
    if (!successorSnap.exists) {
      return { kind: 'successor_invalid', reason: 'not_found' };
    }
    const successorData = successorSnap.data() ?? {};
    if (typeof successorData.deletedAt === 'number') {
      return { kind: 'successor_invalid', reason: 'soft_deleted' };
    }
    const successorRole = successorData.role;
    if (successorRole !== 'admin' && successorRole !== 'superadmin') {
      return { kind: 'successor_invalid', reason: 'not_admin' };
    }
  }

  // Transfer owned sites through the one transactional transfer (Wave 2 task
  // 2.2), and FAIL CLOSED if any of them does not land.
  //
  // This loop used to be two un-batched `update` calls per site inside a
  // `try/catch` that logged a warning and carried on. Three things went wrong
  // with that, and all three end the same way — a site owned by an account that
  // is about to be soft-deleted, therefore reachable by nobody, since both
  // `resolveSiteAccess` and `firestore.rules` reject a deleted principal:
  //
  //   - a failure between the two updates left `sites/{id}.owner` and the
  //     successor's `sites[]` disagreeing;
  //   - the warning was the only trace, and the soft-delete below ran anyway;
  //   - `transferredSites` under-reported, so the audit row said a transfer had
  //     not happened when half of it had.
  //
  // Retrying was not possible either: the idempotency short-circuit at the top
  // of this function replays the recorded response, so a partial failure was
  // permanent. Aborting before any destructive step is the only safe answer —
  // the caller can then fix the successor and re-issue the delete.
  const transferredSites: string[] = [];
  if (successorUid && ownedSites.length > 0) {
    for (const siteId of ownedSites) {
      const outcome = await transferSiteOwnership({
        siteId,
        successorUid,
        actorUid: uid,
        // The cascade acts with platform authority: it has already established
        // the caller holds USER_DELETE, and the departing user is by definition
        // the current owner of every site in `ownedSites`.
        actorIsSuperadmin: true,
        skipPlanCheck: true,
      });

      if (!outcome.ok) {
        // Nothing destructive has run yet — no key revoked, no `deletedAt`
        // stamped — so returning here leaves the account exactly as it was.
        return {
          kind: 'transfer_failed',
          siteId,
          reason: outcome.failure.kind,
          transferredSites,
        };
      }
      transferredSites.push(siteId);
    }
  }

  // Revoke api keys: subcollection entries + top-level lookup docs.
  const revokedKeyIds: string[] = [];
  try {
    const keysSnap = await userRef.collection('api_keys').get();
    const now = Date.now();
    for (const keyDoc of keysSnap.docs) {
      const keyData = keyDoc.data() ?? {};
      // Don't bump revokedAt on already-revoked keys.
      if (typeof keyData.revokedAt === 'number') continue;

      try {
        await keyDoc.ref.update({ revokedAt: now });
        revokedKeyIds.push(keyDoc.id);

        // Mirror onto api_keys/{keyHash} so the auth path sees the revocation immediately.
        const keyHash =
          typeof keyData.keyHash === 'string' ? keyData.keyHash : null;
        if (keyHash) {
          await db.collection('api_keys').doc(keyHash).update({
            revokedAt: now,
          }).catch(() => {
            // The lookup doc may not exist for very old keys; not fatal.
          });
        }
      } catch (err) {
        console.warn(
          `[userDeleteCascade] failed to revoke key ${keyDoc.id}: ${
            (err as Error).message
          }`,
        );
      }
    }
  } catch (err) {
    console.warn(
      `[userDeleteCascade] failed to enumerate api keys: ${
        (err as Error).message
      }`,
    );
  }

  // Revoke passkeys. The final update zeroes `mfaFactors` even if some deletes fail, so the
  // account cannot be left claiming factors it no longer has.
  try {
    const passkeysSnap = await userRef.collection('passkeys').get();
    for (const passkeyDoc of passkeysSnap.docs) {
      try {
        await passkeyDoc.ref.delete();
      } catch (err) {
        console.warn(
          `[userDeleteCascade] failed to delete passkey ${passkeyDoc.id}: ${
            (err as Error).message
          }`,
        );
      }
    }
  } catch (err) {
    console.warn(
      `[userDeleteCascade] failed to enumerate passkeys: ${
        (err as Error).message
      }`,
    );
  }

  // Revoke device-trust records so a stale trust cookie can no longer skip the MFA challenge.
  // Best-effort — a failure here must not abort the cascade.
  try {
    const trustedDevicesSnap = await userRef.collection('trustedDevices').get();
    for (const trustedDeviceDoc of trustedDevicesSnap.docs) {
      try {
        await trustedDeviceDoc.ref.delete();
      } catch (err) {
        console.warn(
          `[userDeleteCascade] failed to delete trusted device ${trustedDeviceDoc.id}: ${
            (err as Error).message
          }`,
        );
      }
    }
  } catch (err) {
    console.warn(
      `[userDeleteCascade] failed to enumerate trusted devices: ${
        (err as Error).message
      }`,
    );
  }

  // Drop any pending MFA setup challenge; stored MFA state is cleared with the stamp below.
  try {
    await db.collection('mfa_pending').doc(uid).delete();
  } catch (err) {
    console.warn(
      `[userDeleteCascade] failed to delete pending MFA setup for ${uid}: ${
        (err as Error).message
      }`,
    );
  }

  // Cancel pending commands, fire-and-forget via setImmediate so DELETE returns promptly even for
  // a user with many sites. Scoped to owned + assigned sites; cross-site commands aren't swept —
  // the issuer record survives on the command doc for audit.
  const userSites = Array.isArray(userData.sites)
    ? (userData.sites as string[]).filter((s) => typeof s === 'string')
    : [];
  const sitesToScan = Array.from(new Set([...ownedSites, ...userSites]));
  if (sitesToScan.length > 0) {
    setImmediate(() => {
      void cancelUserCommands(uid, sitesToScan);
    });
  }

  // Last write: earlier best-effort failures must not block the deleted flag (orphaned api keys
  // can be swept separately).
  const deletedAt = Date.now();
  await userRef.update({
    sites: [],
    mfaEnrolled: false,
    // Zero the inventory too: `normalizeMfaFactors` TRUSTS a well-formed stored value, so leaving
    // `{ totp: true, passkeys: 2 }` would resurrect `mfaEnrolled: true` on the next recompute.
    // Shape mirrors `EMPTY_MFA_FACTORS` in lib/mfaFactors.server.ts.
    mfaFactors: { totp: false, passkeys: 0 },
    mfaSecret: FieldValue.delete(),
    backupCodes: [],
    mfaEnrolledAt: FieldValue.delete(),
    // DELIBERATE EXCEPTION to the single-writer rule in lib/mfaFactors.server.ts: routing through
    // `applyMfaFactorChange` would derive `requiresMfaSetup: true`, re-arming mandatory 2FA on a
    // just-deleted account. Don't "fix" this by routing it through the module.
    requiresMfaSetup: false,
    deletedAt,
    deletedBy: 'superadmin', // route handler doesn't pass actor here; auditLog has it
  });

  // Rules (`isNotDeletedUser`) gate on `deletedAt`, but outstanding ID tokens stay valid for ~1h
  // unless revoked; `disabled: true` also blocks new sign-ins and custom-token mints. Best-effort:
  // no rollback of the soft-delete on Auth failure — Firestore is authoritative for authz.
  let authDisabled = false;
  try {
    const adminAuth = getAdminAuth();
    try {
      await adminAuth.revokeRefreshTokens(uid);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code !== 'auth/user-not-found') {
        console.warn(
          `[userDeleteCascade] revokeRefreshTokens failed for ${uid}: ${
            (err as Error).message
          }`,
        );
      }
    }
    try {
      await adminAuth.updateUser(uid, { disabled: true });
      authDisabled = true;
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === 'auth/user-not-found') {
        // No Auth record (hard-deleted via self-delete earlier) — nothing to disable.
        authDisabled = true;
      } else {
        console.warn(
          `[userDeleteCascade] updateUser(disabled=true) failed for ${uid}: ${
            (err as Error).message
          }`,
        );
      }
    }
  } catch (err) {
    // getAdminAuth() throws when env vars are missing (test mode without mocks). Soft failure —
    // the Firestore soft-delete already gates access via rules.
    console.warn(
      `[userDeleteCascade] admin auth unavailable for ${uid}: ${
        (err as Error).message
      }`,
    );
  }

  return {
    kind: 'deleted',
    deletedAt,
    revokedKeyIds,
    transferredSites,
    authDisabled,
  };
}

/** Best-effort `cancelled: true` on every pending command with `issuedBy === uid` in `siteIds`. */
async function cancelUserCommands(uid: string, siteIds: string[]): Promise<void> {
  const db = getAdminDb();
  const now = Date.now();

  for (const siteId of siteIds) {
    try {
      const machinesSnap = await db
        .collection('sites')
        .doc(siteId)
        .collection('machines')
        .get();

      for (const machineDoc of machinesSnap.docs) {
        try {
          const cmdSnap = await machineDoc.ref
            .collection('commands')
            .doc('pending')
            .collection('items')
            .where('issuedBy', '==', uid)
            .get();
          for (const cmd of cmdSnap.docs) {
            await cmd.ref
              .update({ cancelled: true, cancelledAt: now })
              .catch(() => {});
          }
        } catch {
          // Some machines lack the nested commands shape.
        }
      }
    } catch (err) {
      console.warn(
        `[userDeleteCascade] command cancel sweep failed for site ${siteId}: ${
          (err as Error).message
        }`,
      );
    }
  }
}

/**
 * Void a user's queued commands when `POST /api/users/{uid}/remove-sites` un-assigns them.
 * Returns the count cancelled; partial failures are logged and counted as not-cancelled.
 */
export async function cancelUserCommandsOnSites(
  uid: string,
  siteIds: string[],
): Promise<number> {
  if (siteIds.length === 0) return 0;
  const db = getAdminDb();
  const now = Date.now();
  let cancelled = 0;

  for (const siteId of siteIds) {
    try {
      const machinesSnap = await db
        .collection('sites')
        .doc(siteId)
        .collection('machines')
        .get();

      for (const machineDoc of machinesSnap.docs) {
        try {
          const cmdSnap = await machineDoc.ref
            .collection('commands')
            .doc('pending')
            .collection('items')
            .where('issuedBy', '==', uid)
            .get();
          for (const cmd of cmdSnap.docs) {
            try {
              await cmd.ref.update({ cancelled: true, cancelledAt: now });
              cancelled += 1;
            } catch (err) {
              console.warn(
                `[cancelUserCommandsOnSites] failed for cmd ${cmd.id}: ${
                  (err as Error).message
                }`,
              );
            }
          }
        } catch {
          // Some machines lack the nested commands shape.
        }
      }
    } catch (err) {
      console.warn(
        `[cancelUserCommandsOnSites] sweep failed for site ${siteId}: ${
          (err as Error).message
        }`,
      );
    }
  }

  return cancelled;
}
