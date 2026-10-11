/**
 * POST /api/passkeys/authenticate/verify
 * Request:  { credential: AuthenticationResponseJSON, challengeId: string }
 * Response: { success: boolean, customToken: string, userId: string }
 *
 * A passkey login SATISFIES 2FA in one ceremony: `requireUserVerification: true`
 * is pinned below, so a verified response proves possession AND user
 * verification (PIN/biometric). The session is created with
 * `mfaSatisfiedBy: 'passkey-uv'` and born `mfaVerified` even for a TOTP-enrolled
 * user, rather than bouncing to `/verify-2fa`.
 *
 * `createSession` still re-derives `mfaRequired` from Firestore — this route
 * asserts the challenge was satisfied, never that it doesn't apply.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { withRateLimit } from '@/lib/withRateLimit';
import { getAdminAuth } from '@/lib/firebase-admin';
import { createSession } from '@/lib/sessionManager.server';
import { signInCeremonyNetwork } from '@/lib/swoop/networks.server';
import { apiError } from '@/lib/apiErrorResponse';
import { ApiAuthError, assertActiveUser } from '@/lib/apiAuth.server';
import {
  getRpId,
  getExpectedOrigins,
  getAndDeleteChallenge,
  getUserPasskeys,
  updatePasskeyCounter,
} from '@/lib/webauthn.server';

export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const body = await request.json();
    const { credential, challengeId } = body;

    if (!credential || !challengeId) {
      return NextResponse.json(
        { error: 'Missing credential or challengeId' },
        { status: 400 }
      );
    }

    const challengeData = await getAndDeleteChallenge(challengeId);
    if (!challengeData) {
      return NextResponse.json(
        { error: 'Challenge expired or not found. Please try again.' },
        { status: 400 }
      );
    }

    if (challengeData.type !== 'authentication') {
      return NextResponse.json({ error: 'Invalid challenge type' }, { status: 400 });
    }

    const userHandle = credential.response?.userHandle;
    if (!userHandle) {
      return NextResponse.json(
        { error: 'No user handle in credential response. Discoverable credential required.' },
        { status: 400 }
      );
    }

    // userHandle carries the registration uid but arrives BASE64URL-ENCODED:
    // @simplewebauthn/browser base64url-encodes every ArrayBuffer on the way out
    // (`userHandle?: Base64URLString`). Using it verbatim looked up
    // `users/<base64url-of-uid>`, so every passkey sign-in 403'd in
    // `assertActiveUser` as "deleted or inactive". Broken from day one — no test
    // reached this line until `e2e/specs/mfa/passkey-factor.spec.ts`.
    const userId = isoBase64URL.toUTF8String(userHandle);
    await assertActiveUser(userId);

    const userPasskeys = await getUserPasskeys(userId);
    const credentialIdFromResponse = credential.id;

    const matchingPasskey = userPasskeys.find(
      (p) => p.credentialId === credentialIdFromResponse
    );

    if (!matchingPasskey) {
      return NextResponse.json(
        { error: 'Passkey not found for this user' },
        { status: 400 }
      );
    }

    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: challengeData.challenge,
      expectedOrigin: getExpectedOrigins(),
      expectedRPID: getRpId(),
      // Pinned even though upstream defaults it to true: without the `uv` flag
      // this is possession only, and a default flip would silently downgrade
      // every passkey login to single-factor.
      requireUserVerification: true,
      credential: {
        id: matchingPasskey.credentialId,
        publicKey: isoBase64URL.toBuffer(matchingPasskey.credentialPublicKey),
        counter: matchingPasskey.counter,
        transports: matchingPasskey.transports,
      },
    });

    if (!verification.verified) {
      return NextResponse.json(
        { error: 'Authentication verification failed' },
        { status: 400 }
      );
    }

    // Clone detection.
    const { authenticationInfo } = verification;
    await updatePasskeyCounter(
      userId,
      matchingPasskey.credentialId,
      authenticationInfo.newCounter
    );

    // Reaching here means verification passed with `requireUserVerification`, so
    // the authenticator checked the human — the basis for one ceremony counting
    // as two factors. `'passkey-uv'` is hardcoded on purpose: it is server-side
    // only and must never be derived from the request.
    await createSession(userId, 7, 'passkey-uv', undefined, await signInCeremonyNetwork(request, userId));

    const adminAuth = getAdminAuth();
    const customToken = await adminAuth.createCustomToken(userId);

    return NextResponse.json({
      success: true,
      customToken,
      userId,
    });
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'passkeys/authenticate/verify');
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});
