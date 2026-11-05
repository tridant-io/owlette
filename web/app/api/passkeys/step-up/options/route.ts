/**
 * POST /api/passkeys/step-up/options — WebAuthn authentication options for a
 * caller who is ALREADY signed in and sitting on the `/verify-2fa` challenge.
 *
 * Deliberately separate from `/api/passkeys/authenticate/options`: that one is
 * pre-login, takes no session, uses discoverable credentials, and its verify
 * sibling mints a session plus a Firebase custom token. Step-up does none of
 * that. Here a session is REQUIRED, the ceremony is scoped to that session's own
 * uid (never a uid from the body), and `allowCredentials` is pinned to that
 * user's registered credentials.
 *
 * DEPENDENCY — do not remove silently: task 2.3 gates passkey REGISTRATION behind
 * an already-satisfied MFA challenge (zero factors → open; one or more → session
 * `mfaVerified` required, else 403 `mfa_challenge_required`). That gate is what
 * stops an attacker holding only a `__session` cookie from registering a fresh
 * attacker-controlled credential and immediately stepping up with it. Step-up is
 * only ever as strong as that registration gate.
 *
 * Request: {} · Response: { options: PublicKeyCredentialRequestOptionsJSON, challengeId }
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, assertActiveUser, requireSession } from '@/lib/apiAuth.server';
import { apiError } from '@/lib/apiErrorResponse';
import { getRpId, getUserPasskeys, storeChallenge } from '@/lib/webauthn.server';

export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const userId = await requireSession(request);
    await assertActiveUser(userId);

    const passkeys = await getUserPasskeys(userId);
    if (passkeys.length === 0) {
      // Machine-readable code so the challenge page can tell "this account owns
      // no passkeys" from a real failure and keep pointing at TOTP / backup codes.
      return NextResponse.json(
        { error: 'No passkeys registered for this user', code: 'no_passkeys' },
        { status: 400 }
      );
    }

    const options = await generateAuthenticationOptions({
      rpID: getRpId(),
      // This account's own credentials only — the discoverable-credential prompt
      // used at sign-in may return any passkey on the device. No transports:
      // chrome on android routes by them, and a passkey saved through a desktop
      // password manager's extension came back without "this device", so the
      // phone offered usb, nfc or another device and never asked that manager.
      allowCredentials: passkeys.map((p) => ({ id: p.credentialId })),
      // A passkey counts as a second factor only when the authenticator actually
      // verified the human; the verify sibling pins requireUserVerification too.
      userVerification: 'required',
    });

    // The verify sibling refuses any challenge whose stored userId isn't the
    // session's uid, so one account's challenge can't be redeemed by another.
    const challengeId = randomBytes(32).toString('hex');
    await storeChallenge(challengeId, options.challenge, userId, 'authentication');

    return NextResponse.json({ options, challengeId });
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'passkeys/step-up/options');
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});
