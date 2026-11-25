/**
 * Live proof of possession of a second factor, for routes that cannot settle
 * for "the session cleared a challenge sometime in the last seven days" —
 * minting fresh recovery codes off a warm session alone would hand a session
 * thief a permanent offline factor that also unlocks disable.
 *
 * Three equivalent proofs: `totp`, `backup_code` (consumed on use), and
 * `passkey` (UV-verified assertion; the same ceremony
 * `/api/passkeys/step-up/verify` runs, factored out so there is one impl).
 *
 * Deliberately does NOT: touch the session (promoting to `mfaVerified` is the
 * step-up route's job), write factor state (`lib/mfaFactors.server.ts` owns
 * that), or audit (callers emit the user-visible verb).
 *
 * TODO: `/api/mfa/disable` still carries its own TOTP + backup-code copies;
 * adopt `verifyMfaProof` there once this has soaked (gets passkey for free).
 * Left alone for now — its failure mode is a hard account lockout.
 */

import { NextResponse } from 'next/server';
import {
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { verifyBackupCode } from '@/lib/totp';
import { decrypt, isEncryptionConfigured } from '@/lib/encryption.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { MFA_ATTEMPTS_EXCEEDED, consumeTotpCode, spendMfaAttempt } from '@/lib/mfaAttempts.server';
import {
  getRpId,
  getExpectedOrigins,
  getAndDeleteChallenge,
  getUserPasskeys,
  updatePasskeyCounter,
} from '@/lib/webauthn.server';

/** Which factor a caller actually presented — recorded in audit rows. */
export type MfaProofFactor = 'totp' | 'backup_code' | 'passkey';

/** The proof a request carried, after validation of its shape. */
export type MfaProof =
  | { kind: 'totp'; code: string }
  | { kind: 'backup_code'; code: string }
  | {
      kind: 'passkey';
      credential: AuthenticationResponseJSON;
      challengeId: string;
    };

/** `error` is surfaced verbatim; `code` is the slug clients branch on. */
export interface MfaProofRejection {
  ok: false;
  status: number;
  error: string;
  code: string;
}

export type MfaProofOutcome = { ok: true; factorUsed: MfaProofFactor } | MfaProofRejection;

export type MfaProofParse = { ok: true; proof: MfaProof } | MfaProofRejection;

function reject(status: number, error: string, code: string): MfaProofRejection {
  return { ok: false, status, error, code };
}

/** Turn a rejection into the response a route returns verbatim. */
export function mfaProofErrorResponse(rejection: MfaProofRejection): NextResponse {
  return NextResponse.json(
    { error: rejection.error, code: rejection.code },
    { status: rejection.status },
  );
}

/**
 * Read a proof out of a request body. Accepts the two shapes already in the
 * wild — `{ code, isBackupCode }` and `{ credential, challengeId }`. A body
 * with neither is refused here; "no proof" must never reach a success path.
 */
export function parseMfaProof(body: unknown): MfaProofParse {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  if (b.credential) {
    // Its own error, not "no proof supplied" — that would send the caller
    // looking for a code they were never asked for.
    if (typeof b.challengeId !== 'string' || !b.challengeId) {
      return reject(
        400,
        'a passkey proof must include the challengeId it was issued against.',
        'invalid_passkey_proof',
      );
    }
    return {
      ok: true,
      proof: {
        kind: 'passkey',
        credential: b.credential as AuthenticationResponseJSON,
        challengeId: b.challengeId,
      },
    };
  }

  if (typeof b.code === 'string' && b.code) {
    if (b.isBackupCode === true) {
      return { ok: true, proof: { kind: 'backup_code', code: b.code } };
    }
    if (b.code.length !== 6) {
      return reject(400, 'TOTP code must be 6 digits', 'invalid_totp_code');
    }
    return { ok: true, proof: { kind: 'totp', code: b.code } };
  }

  return reject(
    400,
    'a current 2FA code, a backup code, or a passkey is required for this action.',
    'mfa_proof_required',
  );
}

/** Verify a TOTP code against the account's stored (encrypted) secret, spending its step. */
async function verifyStoredTotp(
  userId: string,
  code: string,
  userData: FirebaseFirestore.DocumentData,
): Promise<MfaProofOutcome> {
  const encryptedSecret = userData.mfaSecret;
  if (!encryptedSecret || typeof encryptedSecret !== 'string') {
    return reject(400, 'this account has no authenticator enrolled.', 'totp_not_enrolled');
  }

  let secret: string;
  if (encryptedSecret.includes(':')) {
    if (!isEncryptionConfigured()) {
      console.error('[mfaProof] MFA_ENCRYPTION_KEY not configured');
      return reject(500, 'MFA encryption not configured', 'encryption_not_configured');
    }
    secret = decrypt(encryptedSecret);
  } else {
    // Legacy unencrypted format — same handling as verify-login and disable.
    secret = encryptedSecret;
  }

  if (!(await consumeTotpCode(userId, code, secret))) {
    return reject(400, 'invalid verification code', 'invalid_mfa_proof');
  }
  return { ok: true, factorUsed: 'totp' };
}

/**
 * Verify and consume a backup code in ONE transaction: a crash between match
 * and whatever the caller does next must not leave the code replayable.
 */
async function consumeBackupCode(
  userId: string,
  code: string,
): Promise<MfaProofOutcome> {
  const db = getAdminDb();
  const userRef = db.collection('users').doc(userId);
  const normalizedCode = code.toUpperCase().trim();

  const consumed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) {
      return { ok: false, reason: 'no_user' as const };
    }
    const data = snap.data() ?? {};
    const codes: string[] = Array.isArray(data.backupCodes) ? data.backupCodes : [];
    const idx = codes.findIndex((hash) => verifyBackupCode(normalizedCode, hash));
    if (idx === -1) {
      return { ok: false, reason: 'no_match' as const };
    }
    tx.update(userRef, { backupCodes: codes.filter((_, i) => i !== idx) });
    return { ok: true } as const;
  });

  if (!consumed.ok) {
    if (consumed.reason === 'no_user') {
      return reject(404, 'user not found', 'user_not_found');
    }
    return reject(400, 'invalid verification code', 'invalid_mfa_proof');
  }
  return { ok: true, factorUsed: 'backup_code' };
}

/**
 * Verify a WebAuthn step-up assertion against the SESSION'S OWN account.
 * Three checks bind the ceremony to the account; dropping any one turns
 * step-up into a bypass:
 *   1. the challenge was minted for this uid (a `null` uid means the pre-login
 *      discoverable-credential flow and must not be redeemable here),
 *   2. the credential is one of this uid's — we never look outside
 *      `users/{uid}/passkeys`,
 *   3. `requireUserVerification: true` — possession alone is not enough.
 *
 * `credential.response.userHandle` is IGNORED (attacker-controlled); the uid
 * always comes from the session.
 */
export async function verifyPasskeyStepUpAssertion(args: {
  userId: string;
  credential: AuthenticationResponseJSON;
  challengeId: string;
}): Promise<MfaProofOutcome> {
  const { userId, credential, challengeId } = args;

  // Single-use: getAndDeleteChallenge removes the record before returning, so
  // a replayed assertion cannot re-clear the gate.
  const challengeData = await getAndDeleteChallenge(challengeId);
  if (!challengeData) {
    return reject(
      400,
      'Challenge expired or not found. Please try again.',
      'challenge_not_found',
    );
  }

  if (challengeData.type !== 'authentication') {
    return reject(400, 'Invalid challenge type', 'invalid_challenge_type');
  }

  if (challengeData.userId !== userId) {
    return reject(403, 'Challenge does not belong to this user', 'challenge_user_mismatch');
  }

  const userPasskeys = await getUserPasskeys(userId);
  const matchingPasskey = userPasskeys.find((p) => p.credentialId === credential.id);

  if (!matchingPasskey) {
    return reject(400, 'Passkey not found for this user', 'passkey_not_found');
  }

  const verification = await verifyAuthenticationResponse({
    response: credential,
    expectedChallenge: challengeData.challenge,
    expectedOrigin: getExpectedOrigins(),
    expectedRPID: getRpId(),
    // Pinned though the library already defaults true: without the `uv` flag
    // this is possession only, and an upstream default flip would silently
    // turn step-up into a one-touch bypass.
    requireUserVerification: true,
    credential: {
      id: matchingPasskey.credentialId,
      publicKey: isoBase64URL.toBuffer(matchingPasskey.credentialPublicKey),
      counter: matchingPasskey.counter,
      transports: matchingPasskey.transports,
    },
  });

  if (!verification.verified) {
    return reject(400, 'Authentication verification failed', 'assertion_failed');
  }

  // Update counter (clone detection).
  await updatePasskeyCounter(
    userId,
    matchingPasskey.credentialId,
    verification.authenticationInfo.newCounter,
  );

  return { ok: true, factorUsed: 'passkey' };
}

/**
 * Verify whichever proof the caller presented. `userData` is the doc the caller
 * already read via `assertActiveUser`, so the TOTP branch costs no extra read.
 */
export async function verifyMfaProof(
  userId: string,
  proof: MfaProof,
  userData: FirebaseFirestore.DocumentData,
): Promise<MfaProofOutcome> {
  if (proof.kind !== 'passkey' && !(await spendMfaAttempt(userId)).success) {
    return reject(429, 'too many attempts. try again in a few minutes.', MFA_ATTEMPTS_EXCEEDED);
  }
  switch (proof.kind) {
    case 'totp':
      return verifyStoredTotp(userId, proof.code, userData);
    case 'backup_code':
      return consumeBackupCode(userId, proof.code);
    case 'passkey':
      return verifyPasskeyStepUpAssertion({
        userId,
        credential: proof.credential,
        challengeId: proof.challengeId,
      });
  }
}
