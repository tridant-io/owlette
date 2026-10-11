/**
 * POST /api/mfa/verify-setup — verify the TOTP code, then encrypt + store the
 * secret. Body `{ userId, code, backupCodes? }`; `backupCodes` is deprecated
 * (server mints the sheet when omitted) and survives only for the browser-side
 * generation in `app/setup-2fa/page.tsx`. Response returns the plaintext sheet
 * once; only hashes are stored.
 *
 * Security: adding a factor to an account that already holds one requires an
 * MFA-verified session (`lib/mfaEnrollmentGate.server.ts`), and an existing TOTP
 * secret is never overwritten — that path is disable-then-enroll.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyTOTP, hashBackupCode } from '@/lib/totp';
import { issueBackupCodes, type IssuedBackupCodes } from '@/lib/backupCodes.server';
import { encrypt, isEncryptionConfigured } from '@/lib/encryption.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, assertActiveUser, requireSessionUser } from '@/lib/apiAuth.server';
import { apiError } from '@/lib/apiErrorResponse';
import { markSessionMfaVerified } from '@/lib/sessionManager.server';
import { signInCeremonyNetwork } from '@/lib/swoop/networks.server';
import { applyMfaFactorChange } from '@/lib/mfaFactors.server';
import { emitMutation } from '@/lib/auditLogClient';
import { checkMfaEnrollmentGate } from '@/lib/mfaEnrollmentGate.server';

export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const body = await request.json();
    const { userId, code, backupCodes } = body;

    if (!userId || typeof userId !== 'string') {
      return NextResponse.json(
        { error: 'Invalid user ID' },
        { status: 400 }
      );
    }

    if (!code || typeof code !== 'string' || code.length !== 6) {
      return NextResponse.json(
        { error: 'Invalid verification code' },
        { status: 400 }
      );
    }

    // Optional: minted here when omitted. A client-supplied set is honoured
    // because setup-2fa generates codes in the browser and is already showing
    // them — storing a different set would leave the user holding dead strings.
    // A malformed/empty array is a client bug, so still a 400.
    if (
      backupCodes !== undefined &&
      (!Array.isArray(backupCodes) ||
        backupCodes.length === 0 ||
        !backupCodes.every((c) => typeof c === 'string' && c.length > 0))
    ) {
      return NextResponse.json(
        { error: 'Backup codes are required' },
        { status: 400 }
      );
    }

    await requireSessionUser(request, userId);
    await assertActiveUser(userId);

    if (!isEncryptionConfigured()) {
      console.error('[MFA Verify Setup] MFA_ENCRYPTION_KEY not configured');
      return NextResponse.json(
        { error: 'MFA encryption not configured' },
        { status: 500 }
      );
    }

    const db = getAdminDb();

    // Enrollment gate: an account that already holds a factor must present an
    // MFA-verified session to add another. `/api/*` is not proxy-MFA-gated, so
    // without this a captured pre-MFA session could overwrite the victim's
    // factors. Do not narrow this without keeping the per-factor check below —
    // together they replaced the old blanket `mfaEnrolled` refusal, which
    // universal 2FA can't use (passkey-only accounts must still add TOTP).
    const gate = await checkMfaEnrollmentGate(userId);
    if (gate.denied) {
      return gate.denied;
    }

    // Never overwrite a live TOTP secret: even a verified session must go
    // through /api/mfa/disable (proof of possession of the current factor)
    // first, so a hijacked session can't silently swap the secret.
    if (gate.factors.totp) {
      return NextResponse.json(
        {
          error:
            'TOTP is already enrolled. Disable it via /api/mfa/disable (which requires proof of your current factor) before re-enrolling.',
          code: 'mfa_already_enrolled',
        },
        { status: 409 },
      );
    }

    const pendingDoc = await db.collection('mfa_pending').doc(userId).get();
    if (!pendingDoc.exists) {
      return NextResponse.json(
        { error: 'No pending MFA setup found. Please start setup again.' },
        { status: 400 }
      );
    }

    const pendingData = pendingDoc.data();
    if (!pendingData) {
      return NextResponse.json(
        { error: 'Invalid pending setup data' },
        { status: 400 }
      );
    }

    const expiresAt = pendingData.expiresAt?.toDate?.() || new Date(pendingData.expiresAt);
    if (expiresAt < new Date()) {
      await db.collection('mfa_pending').doc(userId).delete();
      return NextResponse.json(
        { error: 'Setup expired. Please start again.' },
        { status: 400 }
      );
    }

    const secret = pendingData.secret;
    const isValid = verifyTOTP(code, secret);

    if (!isValid) {
      return NextResponse.json(
        { error: 'Invalid verification code. Please try again.' },
        { status: 400 }
      );
    }

    const encryptedSecret = encrypt(secret);

    // The ONE place recovery codes are issued without separate proof of
    // possession — safe only because a TOTP code was just verified above and the
    // enrollment gate already refused unverified sessions holding a factor.
    // Every other issuance goes through POST /api/mfa/backup-codes. Do not
    // generalise this branch. Client-supplied codes are the transitional path
    // for setup-2fa's browser-side generation.
    const issued: IssuedBackupCodes = Array.isArray(backupCodes)
      ? { plaintext: backupCodes, hashed: backupCodes.map(hashBackupCode) }
      : issueBackupCodes();
    const hashedBackupCodes = issued.hashed;

    // The factor-inventory module is the ONLY writer of `mfaEnrolled` /
    // `requiresMfaSetup`; it folds both into the same merge write as the secret,
    // so the account can never hold a secret without the flags or vice versa.
    const factorResult = await applyMfaFactorChange(
      userId,
      { totp: true },
      {
        extraUpdate: {
          mfaSecret: encryptedSecret, // Now encrypted!
          backupCodes: hashedBackupCodes,
          // One field for sheet age, advanced by every route that regenerates.
          backupCodesGeneratedAt: FieldValue.serverTimestamp(),
          mfaEnrolledAt: FieldValue.serverTimestamp(),
        },
      },
    );

    await db.collection('mfa_pending').doc(userId).delete();

    // Possession of the new factor was just proved — promote the session to
    // MFA-verified so the next protected navigation isn't bounced to /verify-2fa.
    // Subsequent session-creates still require a fresh challenge.
    await markSessionMfaVerified(await signInCeremonyNetwork(request, userId));

    // Platform-tenant mutation (siteId = '') so the cloud function records it on
    // the platform partition; mirrors the `mfa_disabled` row from /api/mfa/disable.
    emitMutation({
      kind: 'user_mutated',
      siteId: '',
      actor: `user:${userId}`,
      targetId: userId,
      attributes: {
        endpoint: '/api/mfa/verify-setup',
        method: 'POST',
        verb: 'mfa_enrolled',
        factor: 'totp',
        backupCodesIssued: hashedBackupCodes.length,
        passkeysEnrolled: factorResult.factors.passkeys,
      },
    });

    // The plaintext sheet, returned exactly once — only hashes were stored.
    return NextResponse.json({
      success: true,
      backupCodes: issued.plaintext,
    });
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'mfa/verify-setup');
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});
