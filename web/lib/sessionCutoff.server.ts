/**
 * Two cutoffs end a login session minted before them:
 * - `users/{uid}.sessionsValidAfter` (epoch ms), set by a factor change (`applyMfaFactorChange`);
 * - Firebase Auth's `tokensValidAfterTime` for the uid, which a password reset or change moves.
 * An account with neither keeps every session it has.
 */

import { getAdminAuth } from '@/lib/firebase-admin';

/** how long a login session lasts. every caller mints this, so a cookie from before `issuedAt` is dated by its expiry */
export const SESSION_LIFETIME_DAYS = 7;
const SESSION_LIFETIME_MS = SESSION_LIFETIME_DAYS * 24 * 60 * 60 * 1000;

/** how long one Auth lookup answers for a uid, per instance */
const REVOCATION_CACHE_MS = 60_000;

const revocations = new Map<string, { at: number; revokedAt: Promise<number | null> }>();

export function sessionIssuedAt(session: { issuedAt?: number; expiresAt?: number }): number {
  if (typeof session.issuedAt === 'number') return session.issuedAt;
  return typeof session.expiresAt === 'number' ? session.expiresAt - SESSION_LIFETIME_MS : 0;
}

/** Was this session minted before any of the cutoffs? A missing cutoff cuts nothing. */
export function sessionRevoked(
  session: { issuedAt?: number; expiresAt?: number },
  ...cutoffs: unknown[]
): boolean {
  const issuedAt = sessionIssuedAt(session);
  return cutoffs.some((cutoff) => typeof cutoff === 'number' && issuedAt < cutoff);
}

async function lookUpRevocation(uid: string, previous?: Promise<number | null>): Promise<number | null> {
  try {
    const { tokensValidAfterTime } = await getAdminAuth().getUser(uid);
    const revokedAt = tokensValidAfterTime ? Date.parse(tokensValidAfterTime) : NaN;
    return Number.isFinite(revokedAt) ? revokedAt : null;
  } catch (err) {
    // fails open: refusing here would sign every user out for as long as Auth is down. the last
    // value seen still applies, as do the account's own cutoff and the session's expiry.
    console.error('[sessionCutoff] token revocation lookup failed for', uid, err);
    return previous ?? null;
  }
}

/** Firebase's last token revocation for the uid, looked up at most once a minute per instance. */
export function tokensRevokedAt(uid: string): Promise<number | null> {
  const cached = revocations.get(uid);
  if (cached && Date.now() - cached.at < REVOCATION_CACHE_MS) return cached.revokedAt;
  const revokedAt = lookUpRevocation(uid, cached?.revokedAt);
  revocations.set(uid, { at: Date.now(), revokedAt });
  return revokedAt;
}
