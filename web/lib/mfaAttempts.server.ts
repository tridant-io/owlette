/**
 * Shared by every route that checks a totp or backup code against an account: one attempt
 * budget per account, and a totp time step that is spent once.
 */

import { getAdminDb } from '@/lib/firebase-admin';
import { checkRateLimit, mfaAttemptRateLimit } from '@/lib/rateLimit';
import { totpStep } from '@/lib/totp';

/** The code of the 429 every route answers once the account's budget is spent. */
export const MFA_ATTEMPTS_EXCEEDED = 'mfa_attempts_exceeded';

/** Spend one attempt from the account's budget. Call before checking the code. */
export function spendMfaAttempt(userId: string) {
  return checkRateLimit(mfaAttemptRateLimit, `mfa:${userId}`);
}

/**
 * True when `code` is valid for `secret` and its time step is later than the last one the
 * account spent; records that step in the same transaction.
 */
export async function consumeTotpCode(userId: string, code: string, secret: string): Promise<boolean> {
  const step = totpStep(code, secret);
  if (step === null) return false;

  const db = getAdminDb();
  const userRef = db.collection('users').doc(userId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) return false;
    const last = snap.data()?.totpLastStep;
    if (typeof last === 'number' && step <= last) return false;
    tx.update(userRef, { totpLastStep: step });
    return true;
  });
}
