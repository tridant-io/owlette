/**
 * POST /api/passkeys/register/options — WebAuthn registration options for a
 * logged-in user. Request `{ userId }`, response
 * PublicKeyCredentialCreationOptionsJSON; the challenge is stored server-side
 * with a 10-minute expiry.
 *
 * Enrollment gate: `/api/*` is deliberately not MFA-gated, so without it an
 * unverified session could enroll a UV passkey and step straight up — a full
 * MFA bypass from a stolen `__session` cookie. The FIRST factor stays open
 * (mandatory setup); every one after requires `mfaVerified`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import { isoUint8Array } from '@simplewebauthn/server/helpers';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, assertActiveUser, requirePreMfaSessionUser } from '@/lib/apiAuth.server';
import { apiError } from '@/lib/apiErrorResponse';
import { normalizeMfaFactors } from '@/lib/mfaFactors.server';
import { checkMfaEnrollmentGate } from '@/lib/mfaEnrollmentGate.server';
import {
  getRpId,
  getRpName,
  getUserPasskeys,
  storeChallenge,
} from '@/lib/webauthn.server';

export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const body = await request.json();
    const { userId } = body;

    if (!userId || typeof userId !== 'string') {
      return NextResponse.json({ error: 'Invalid user ID' }, { status: 400 });
    }

    await requirePreMfaSessionUser(request, userId);

    // Labels come from the user document, never the attacker-controlled body —
    // they are what the authenticator shows at every future login.
    // `assertActiveUser` also rejects soft-deleted accounts.
    const userData = await assertActiveUser(userId);
    const email = typeof userData.email === 'string' ? userData.email.trim() : '';
    const displayName =
      typeof userData.displayName === 'string' ? userData.displayName.trim() : '';

    // `userName` is what 1Password and the OS picker print, so it must be
    // human-readable (it used to show raw uid hex). The uid stays as `userID`,
    // the handle the authenticator returns on login.
    const userName = email || userId;
    const userDisplayName = displayName || email || userId;

    // Excluded so an existing credential can't re-register.
    const existingPasskeys = await getUserPasskeys(userId);
    const excludeCredentials = existingPasskeys.map((p) => ({
      id: p.credentialId,
      transports: p.transports,
    }));

    // Enrollment gate, shared by every factor-enrollment route — see
    // `lib/mfaEnrollmentGate.server.ts` for the bypass it closes. The inventory
    // comes from the two reads above so the gate costs no extra round-trip, and
    // it runs BEFORE minting a challenge; register/verify re-checks it anyway.
    const gate = await checkMfaEnrollmentGate(
      userId,
      normalizeMfaFactors(userData, existingPasskeys.length),
    );
    if (gate.denied) return gate.denied;

    const options = await generateRegistrationOptions({
      rpName: getRpName(),
      rpID: getRpId(),
      userName,
      userDisplayName,
      userID: isoUint8Array.fromUTF8String(userId),
      attestationType: 'none',
      excludeCredentials,
      authenticatorSelection: {
        residentKey: 'preferred',
        // PIN/biometric required — single-touch FIDO keys aren't enough here.
        userVerification: 'required',
      },
    });

    await storeChallenge(userId, options.challenge, userId, 'registration');

    return NextResponse.json(options);
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'passkeys/register/options');
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});
