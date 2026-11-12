/**
 * POST /api/users/{uid}/mfa-reset
 *
 * Superadmin recovery for a user locked out of their own account: strip every
 * second factor off ANOTHER user and re-arm mandatory 2FA setup. `/api/mfa/disable`
 * cannot serve this — it acts on the caller's own account and demands live proof
 * of possession, which is exactly what the locked-out user has lost.
 *
 * Steps: (1) delete `users/{uid}/passkeys`, (2) rewrite the factor inventory via
 * `applyMfaFactorChange` + `recountPasskeys` (clears TOTP, secret and backup codes
 * in the same write), (3) revoke trusted devices, (4) emit a mutation audit row,
 * (5) email the target.
 *
 * ORDER IS LOAD-BEARING: credentials before inventory. A crash between them leaves
 * the account locked out — the state it was already in, and a retry finishes the
 * job. Reversed, the account would report zero factors and be signable-into while
 * live WebAuthn credentials survived, so resetting a STOLEN device would look
 * revoked when it was not. `recountPasskeys` (not an explicit zero) for the same
 * reason: the tally is read inside the transaction that writes it, so a failed
 * delete shows up instead of being papered over.
 *
 * Steps 3-5 are best-effort tails — trust records are inert once no factors remain
 * — so a failure there must not fail a reset that already landed.
 *
 * The inventory (`users/{uid}.mfaFactors` + its derived flags) is written ONLY
 * through `lib/mfaFactors.server.ts`; never write those fields here.
 *
 * 200 -> { uid, clearedTotp, deletedPasskeys, trustedDevicesRevoked, enrolled,
 * setupRequired }. 400 malformed uid or soft-deleted target, 403 non-superadmin or
 * self-reset, 404 unknown user, plus the wrapper's auth/scope/rate-limit problems.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import {
  problemForbidden,
  problemFromError,
  problemNotFound,
  problemValidation,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  authorizedPlatformHandler,
  type PlatformHandlerContext,
} from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import { applyAuthDeprecations } from '../../../_shared';
import { applyMfaFactorChange, readMfaFactors } from '@/lib/mfaFactors.server';
import { revokeAllTrustedDevices } from '@/lib/deviceTrust.server';
import { emitMutation } from '@/lib/auditLogClient';
import { sendMfaFactorNotice } from '@/lib/mfaNotice.server';

const UID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

/** Firestore caps batches at 500; 100 matches the repo-wide cascade convention. */
const DELETE_BATCH_SIZE = 100;

type RouteParams = { uid: string };

function auditActor(ctx: PlatformHandlerContext): string {
  return ctx.auth.keyContext
    ? `apiKey:${ctx.auth.keyContext.keyId}`
    : `user:${ctx.actor.userId}`;
}

/**
 * Delete every WebAuthn credential under `passkeys`, batched; returns the count.
 * Errors PROPAGATE — a half-revoked credential set must abort before the inventory
 * is rewritten (see the header's ordering note).
 */
async function deleteAllPasskeys(
  db: FirebaseFirestore.Firestore,
  uid: string,
): Promise<number> {
  const snap = await db
    .collection('users')
    .doc(uid)
    .collection('passkeys')
    .get();
  if (snap.empty) return 0;

  const refs = snap.docs.map((doc) => doc.ref);
  for (let i = 0; i < refs.length; i += DELETE_BATCH_SIZE) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + DELETE_BATCH_SIZE)) {
      batch.delete(ref);
    }
    await batch.commit();
  }
  return refs.length;
}

export const POST = authorizedPlatformHandler<RouteParams>({
  // Superadmin-only, as the sibling role routes. NOT `USER_DELETE`:
  // `GET /api/users/deletions` queries on it, so every reset would surface in the
  // account-deletions feed as a removal.
  capability: Capability.USER_ROLE_MANAGE,
  targetKind: 'user',
  // Audit target = the reset uid, not the platform sentinel.
  targetIdParam: 'uid',
  // `admin`: stripping anyone's second factor is materially more dangerous than
  // an ordinary role change. (This previously contrasted with "the siblings'
  // `write`". /promote has since been raised to `admin` as well — it can mint a
  // superadmin, which is not an ordinary role change.)
  apiKeyScope: { resource: 'user', permission: 'admin' },
})(async (_request: NextRequest, ctx: PlatformHandlerContext, routeContext) => {
  try {
    const { uid } = await routeContext!.params;
    if (!UID_REGEX.test(uid)) {
      return problemValidation('uid must be 1-128 chars', {
        'path.uid': ['letters, digits, underscore, hyphen only'],
      });
    }

    // No self-reset: a genuinely locked-out superadmin cannot reach this route at
    // all, so the only self-caller holds a live session — for whom a hijacked
    // session would become a way to shed 2FA without proving possession.
    // Recovery is by another superadmin; `MIN_SUPERADMINS` guarantees one exists.
    if (uid === ctx.actor.userId) {
      return problemForbidden(
        'cannot reset your own second factors here; use account settings, or ask another superadmin',
      );
    }

    const db = getAdminDb();
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return problemNotFound(`user ${uid} not found`);
    }
    const userData = userSnap.data() ?? {};

    // The delete cascade deliberately leaves mandatory-setup off for deleted users
    // (see lib/userDeleteCascade.server.ts); this would re-arm it.
    if (typeof userData.deletedAt === 'number') {
      return problemValidation(
        'cannot reset factors on a soft-deleted user; restore the account first',
        { 'path.uid': ['user is soft-deleted'] },
      );
    }

    // Read before mutating so the audit row and response can say what was taken.
    const before = await readMfaFactors(uid, { db });

    // (1) Credentials first — see the header's ordering note.
    const deletedPasskeys = await deleteAllPasskeys(db, uid);

    // (2) Whole inventory in one write. `recountPasskeys` reads the subcollection
    // inside the writing transaction, so the tally can't disagree with reality; the
    // module re-arms mandatory setup at zero factors, which is the desired outcome.
    const after = await applyMfaFactorChange(
      uid,
      { totp: false, recountPasskeys: true },
      {
        db,
        extraUpdate: {
          mfaSecret: FieldValue.delete(),
          backupCodes: [],
          mfaEnrolledAt: FieldValue.delete(),
          // Legacy flag `deletePasskey` also maintains; stale it would still read
          // as "holds a credential".
          passkeyEnrolled: false,
          mfaResetAt: FieldValue.serverTimestamp(),
          mfaResetBy: ctx.actor.userId,
        },
      },
    );

    // (3) Best-effort tail: records are inert at zero factors, so a failure here
    // must not fail a reset that already landed.
    let trustedDevicesRevoked = 0;
    try {
      trustedDevicesRevoked = await revokeAllTrustedDevices(uid);
    } catch (revokeError) {
      console.error('[MFA Reset] failed to revoke trusted devices', revokeError);
    }

    // (4) The wrapper already wrote a capability row; this one names both parties
    // so the mutation feed reads standalone. Platform tenant, so siteId = ''.
    emitMutation({
      kind: 'user_mutated',
      siteId: '',
      actor: auditActor(ctx),
      targetId: uid,
      attributes: {
        endpoint: '/api/users/[uid]/mfa-reset',
        method: 'POST',
        verb: 'mfa_force_reset',
        actorUid: ctx.actor.userId,
        targetUid: uid,
        targetEmail: typeof userData.email === 'string' ? userData.email : null,
        clearedTotp: before.totp,
        deletedPasskeys,
        trustedDevicesRevoked,
        stillEnrolled: after.mfaEnrolled,
        setupReArmed: after.requiresMfaSetup,
      },
    });

    // (5) a reset of a factor-less account changed nothing worth telling them.
    if (before.totp || deletedPasskeys > 0) {
      await sendMfaFactorNotice(userData.email, { change: 'reset', factor: 'second factors' });
    }

    return applyAuthDeprecations(
      NextResponse.json({
        uid,
        clearedTotp: before.totp,
        deletedPasskeys,
        trustedDevicesRevoked,
        enrolled: after.mfaEnrolled,
        setupRequired: after.requiresMfaSetup,
      }),
      ctx.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'users/[uid]/mfa-reset:POST');
  }
});
