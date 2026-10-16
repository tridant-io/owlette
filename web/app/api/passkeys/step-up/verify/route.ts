/**
 * POST /api/passkeys/step-up/verify
 * { credential: AuthenticationResponseJSON, challengeId } -> { success: true }
 *
 * Verifies an assertion from `/api/passkeys/step-up/options` and marks the
 * CALLER'S EXISTING session as having cleared MFA. Nothing else: no session
 * created, no custom token minted, no factor state written. Do NOT reuse
 * `/api/passkeys/authenticate/verify` here — it is a pre-login endpoint and would
 * hand a fresh credential to anyone reaching this route.
 *
 * The ceremony is `verifyPasskeyStepUpAssertion` in `lib/mfaProof.server.ts`, one
 * of three interchangeable proofs of possession. The uid comes from the session
 * ONLY; `credential.response.userHandle` is ignored because it is
 * attacker-controlled (the sign-in route trusts it only for lack of a session).
 *
 * The ceremony binds the assertion to this account three ways: the challenge was
 * minted for this uid, the credential id is one of `users/{uid}/passkeys`, and
 * `requireUserVerification: true`.
 *
 * DEPENDENCY — do not remove silently: passkey REGISTRATION is gated behind an
 * already-satisfied MFA challenge (task 2.3). Reopen registration to an unverified
 * session and this route becomes a full MFA bypass — an attacker with only a
 * `__session` cookie could enroll their own credential and step up with it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { apiError } from '@/lib/apiErrorResponse';
import { ApiAuthError, assertActiveUser, requireSession } from '@/lib/apiAuth.server';
import { markSessionMfaVerified } from '@/lib/sessionManager.server';
import { signInCeremonyNetwork } from '@/lib/swoop/networks.server';
import {
  mfaProofErrorResponse,
  verifyPasskeyStepUpAssertion,
} from '@/lib/mfaProof.server';

export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const userId = await requireSession(request);
    await assertActiveUser(userId);

    const body = await request.json();
    const { credential, challengeId } = body;

    if (!credential || typeof challengeId !== 'string' || !challengeId) {
      return NextResponse.json(
        { error: 'Missing credential or challengeId' },
        { status: 400 }
      );
    }

    const proof = await verifyPasskeyStepUpAssertion({
      userId,
      credential,
      challengeId,
    });
    if (!proof.ok) {
      return mfaProofErrorResponse(proof);
    }

    // The ONLY session state this route writes. Never createSession (it re-mints
    // expiry and re-reads factor state) and never a custom token.
    await markSessionMfaVerified(await signInCeremonyNetwork(request, userId));

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'passkeys/step-up/verify');
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});
