/**
 * GET /api/mfa/factors — read-only second-factor inventory for the security panel.
 * No parameters; response:
 *   { totp: { enrolled, enrolledAt }, passkeys: PasskeyInfo[], totalFactors, mfaVerified }
 *
 * Exists because the TOTP leg lives on the user document and firestore.rules
 * doesn't expose those fields to the browser, so the client could only see
 * passkeys (`/api/passkeys/list`).
 *
 * `mfaVerified` is what `checkMfaEnrollmentGate` will decide for this session.
 * Reported up front because "add authenticator app" is a NAVIGATION to
 * /setup-2fa — discovering the gate via a 403 there happens on a page the user
 * already left the dialog for. It is the caller's own session state.
 *
 * 401 no session · 403 soft-deleted/inactive user · 429 rate limited (`auth`).
 *
 * Session-scoped by design: no `userId` parameter, so there is nothing to point
 * at another account. No secrets cross the wire — `mfaSecret`, hashed
 * `backupCodes` and credential public keys are all absent, and any field added
 * later must pass the same test: could it help someone holding the response but
 * not the account?
 */

import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, assertActiveUser, requirePreMfaSession } from '@/lib/apiAuth.server';
import { apiError } from '@/lib/apiErrorResponse';
import { normalizeMfaFactors } from '@/lib/mfaFactors.server';
import { sessionClearedMfaChallenge } from '@/lib/mfaEnrollmentGate.server';
import { getSessionData } from '@/lib/sessionManager.server';
import { getPasskeyListInfo } from '@/lib/webauthn.server';

/**
 * `mfaEnrolledAt` arrives as a Firestore Timestamp, a Date or epoch millis (or is
 * absent on legacy docs). Normalize to an ISO string so JSON.stringify doesn't
 * emit a `{_seconds,_nanoseconds}` blob the client must re-parse.
 */
function toIsoOrNull(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  const maybeTimestamp = value as { toDate?: unknown };
  if (typeof maybeTimestamp.toDate === 'function') {
    return (maybeTimestamp as { toDate: () => Date }).toDate().toISOString();
  }
  return null;
}

export const GET = withRateLimit(async (request: NextRequest) => {
  try {
    const userId = await requirePreMfaSession(request);
    const userData = await assertActiveUser(userId);

    const passkeys = await getPasskeyListInfo(userId);

    // Passkey count comes from the LIST, not the denormalized `mfaFactors.passkeys`
    // counter: this is the surface the user manages credentials on, so the rows and
    // the count must be the same fact. normalizeMfaFactors still resolves TOTP for
    // its legacy fallback (`mfaEnrolled === true` on pre-`mfaFactors` documents).
    const factors = normalizeMfaFactors(userData, passkeys.length);

    // the gate's own predicate, so the panel and the gate can't disagree.
    const session = await getSessionData();

    return NextResponse.json({
      totp: {
        enrolled: factors.totp,
        enrolledAt: toIsoOrNull(userData.mfaEnrolledAt),
      },
      passkeys,
      totalFactors: (factors.totp ? 1 : 0) + passkeys.length,
      mfaVerified: sessionClearedMfaChallenge(session),
    });
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'mfa/factors');
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});
