/**
 * Enrollment gate shared by every factor-enrollment route (TOTP and WebAuthn),
 * and the same rule for renaming or removing a passkey.
 *
 * The enrollment routes answer a session still owing its second factor
 * (`requirePreMfaSessionUser`), so without this a stolen `__session` cookie could
 * enroll its own factor and clear the gate — a full MFA bypass plus a permanent
 * attacker-owned factor.
 *
 * The rule: zero factors -> OPEN (mandatory-setup path; gating would deadlock a
 * user who can never hold `mfaVerified`). One or more factors -> the session must
 * have cleared a challenge, else 403 `mfa_challenge_required`.
 *
 * The inventory is returned so callers can make per-factor decisions without a
 * second read of the user document.
 */

import { NextResponse } from 'next/server';
import {
  deriveMfaEnrolled,
  readMfaFactors,
  type MfaFactorInventory,
} from '@/lib/mfaFactors.server';
import { getSessionData, type SessionData } from '@/lib/sessionManager.server';

/** Machine-readable code the client keys off to send the user to /verify-2fa. */
export const MFA_CHALLENGE_REQUIRED = 'mfa_challenge_required';

/** The same for an account that has to enrol a factor first, at /setup-2fa. */
export const MFA_SETUP_REQUIRED = 'mfa_setup_required';

export interface MfaEnrollmentGateResult {
  /** The account's current factor inventory, already read by the gate. */
  factors: MfaFactorInventory;
  /**
   * Response to return immediately, or `null` to proceed. Callers must
   * `if (gate.denied) return gate.denied;` before any side effect.
   */
  denied: NextResponse | null;
}

/**
 * has this session cleared a challenge? `mfaVerified` alone doesn't say: a sign-in
 * on an account with no factor is born with it, and keeps it until the next session
 * create even if the account gains one. `mfaRequired` marks a real challenge, and
 * `mfaCompletedAt` the proof `/api/mfa/disable` took, which clears `mfaRequired`.
 */
export function sessionClearedMfaChallenge(session: SessionData | null): boolean {
  return (
    session?.mfaVerified === true &&
    (session.mfaRequired === true || typeof session.mfaCompletedAt === 'number')
  );
}

async function evaluateGate(
  factors: MfaFactorInventory,
  deniedMessage: string,
): Promise<MfaEnrollmentGateResult> {
  // No factor yet — mandatory setup. Must stay open.
  if (!deriveMfaEnrolled(factors)) {
    return { factors, denied: null };
  }

  if (sessionClearedMfaChallenge(await getSessionData())) {
    return { factors, denied: null };
  }

  return {
    factors,
    denied: NextResponse.json(
      { error: deniedMessage, code: MFA_CHALLENGE_REQUIRED },
      { status: 403 },
    ),
  };
}

/**
 * Evaluate the enrollment gate for `userId`. Reads via `readMfaFactors`, not the
 * raw `mfaEnrolled` boolean: its healing path stops a legacy passkey-holding
 * account from reading zero-factor (the gate failing OPEN) pre-backfill.
 */
export async function checkMfaEnrollmentGate(
  userId: string,
  precomputedFactors?: MfaFactorInventory,
): Promise<MfaEnrollmentGateResult> {
  // WebAuthn register routes already read both docs to build
  // `excludeCredentials`, so they pass the inventory in and pay no extra read.
  return evaluateGate(
    precomputedFactors ?? (await readMfaFactors(userId)),
    'this account already has a second factor. verify it first, then add another.',
  );
}

/** the same rule for renaming or removing a passkey, with its own message. */
export async function checkMfaFactorChangeGate(
  userId: string,
): Promise<MfaEnrollmentGateResult> {
  return evaluateGate(
    await readMfaFactors(userId),
    'this account has a second factor. verify it first, then change it.',
  );
}
