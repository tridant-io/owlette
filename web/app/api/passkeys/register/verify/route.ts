/**
 * Passkey registration verification — verifies the WebAuthn response and stores the
 * credential.
 *
 * POST /api/passkeys/register/verify
 * Request: { userId: string, credential: RegistrationResponseJSON, friendlyName?: string }
 * Response: { success: boolean, credentialId: string }
 *
 * SECURITY — the enrollment gate: `/api/*` is not MFA-gated by proxy.ts, so without a
 * gate here a stolen `__session` cookie could enroll its own UV passkey and step straight
 * into a verified session (full MFA bypass + a permanent attacker credential). The FIRST
 * factor stays open (mandatory-setup path); every later enrollment requires
 * `mfaVerified`. Re-checked here, not trusted from register/options, because a caller can
 * POST a credential straight at this route.
 *
 * The inventory (`users/{uid}.mfaFactors`, `mfaEnrolled`, `requiresMfaSetup`) is written
 * exclusively through `applyMfaFactorChange` (lib/mfaFactors.server.ts) — never here.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, assertActiveUser, requireSessionUser } from '@/lib/apiAuth.server';
import { apiError } from '@/lib/apiErrorResponse';
import { emitMutation } from '@/lib/auditLogClient';
import {
  applyMfaFactorChange,
  deriveMfaEnrolled,
} from '@/lib/mfaFactors.server';
import { checkMfaEnrollmentGate } from '@/lib/mfaEnrollmentGate.server';
import { markSessionMfaVerified } from '@/lib/sessionManager.server';
import { signInCeremonyNetwork } from '@/lib/swoop/networks.server';
import {
  getRpId,
  getExpectedOrigins,
  getAndDeleteChallenge,
  storePasskey,
} from '@/lib/webauthn.server';

export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const body = await request.json();
    const { userId, credential, friendlyName } = body;

    if (!userId || typeof userId !== 'string') {
      return NextResponse.json({ error: 'Invalid user ID' }, { status: 400 });
    }

    if (!credential) {
      return NextResponse.json({ error: 'Missing credential' }, { status: 400 });
    }

    await requireSessionUser(request, userId);
    await assertActiveUser(userId);

    // THE ENROLLMENT GATE — shared with the TOTP routes (lib/mfaEnrollmentGate.server.ts).
    // The gate returns the inventory it read; `factorsBefore` is then compared against the
    // post-write result to tell whether this passkey is the account's FIRST factor.
    const gate = await checkMfaEnrollmentGate(userId);
    if (gate.denied) return gate.denied;
    const factorsBefore = gate.factors;

    const challengeData = await getAndDeleteChallenge(userId);
    if (!challengeData) {
      return NextResponse.json(
        { error: 'Challenge expired or not found. Please try again.' },
        { status: 400 }
      );
    }

    if (challengeData.type !== 'registration' || challengeData.userId !== userId) {
      return NextResponse.json({ error: 'Invalid challenge' }, { status: 400 });
    }

    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: challengeData.challenge,
      expectedOrigin: getExpectedOrigins(),
      expectedRPID: getRpId(),
      // UV pinned rather than defaulted, matching login verify: a passkey only counts as a
      // second factor because the authenticator verified the user. A credential enrolled
      // without UV would satisfy `mfaEnrolled` while failing every UV-required login.
      requireUserVerification: true,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return NextResponse.json(
        { error: 'Registration verification failed' },
        { status: 400 }
      );
    }

    const { registrationInfo } = verification;
    const credentialId = registrationInfo.credential.id; // Already Base64URLString
    const credentialPublicKey = isoBase64URL.fromBuffer(
      registrationInfo.credential.publicKey // Uint8Array -> Base64URLString
    );

    await storePasskey(
      userId,
      {
        credentialId,
        credentialPublicKey,
        counter: registrationInfo.credential.counter,
        transports: registrationInfo.credential.transports,
        deviceType: registrationInfo.credentialDeviceType,
        backedUp: registrationInfo.credentialBackedUp,
      },
      friendlyName || 'Passkey'
    );

    // Refresh the denormalized inventory. `recountPasskeys` — never an explicit count — is
    // the only value that can't drift: read from the subcollection inside the same
    // transaction that writes the tally.
    const factorsAfter = await applyMfaFactorChange(userId, {
      recountPasskeys: true,
    });

    // FIRST factor: promote the session to MFA-verified, as /api/mfa/verify-setup does after
    // TOTP enrollment. The write above flipped `mfaEnrolled`, so without this the next
    // session-create bounces the user to /verify-2fa with nothing to present — a lockout for
    // exactly the passkey-only signup this feature serves.
    const wasFirstFactor =
      !deriveMfaEnrolled(factorsBefore) && factorsAfter.mfaEnrolled;
    if (wasFirstFactor) {
      await markSessionMfaVerified(await signInCeremonyNetwork(request, userId));
    }

    // Audit: registering a credential is the cheapest persistent-access move an attacker with
    // a live session has. Platform-tenant mutation (siteId = ''), like other security events.
    emitMutation({
      kind: 'user_mutated',
      siteId: '',
      actor: `user:${userId}`,
      targetId: userId,
      attributes: {
        endpoint: '/api/passkeys/register/verify',
        method: 'POST',
        verb: 'passkey_added',
        credentialId,
        deviceType: registrationInfo.credentialDeviceType,
        backedUp: registrationInfo.credentialBackedUp,
        passkeyCount: factorsAfter.factors.passkeys,
        firstFactor: wasFirstFactor,
      },
    });

    return NextResponse.json({ success: true, credentialId });
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'passkeys/register/verify');
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});
