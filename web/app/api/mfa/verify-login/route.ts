/**
 * POST /api/mfa/verify-login — verifies a TOTP or backup code at login.
 * Request:  { userId, code, isBackupCode?, trustDevice? }
 * Response: { success, backupCodeUsed, deviceTrusted }
 *
 * The TOTP secret is decrypted server-side only and never leaves this process;
 * a used backup code is deleted.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyTOTP, verifyBackupCode } from '@/lib/totp';
import { decrypt, isEncryptionConfigured } from '@/lib/encryption.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, assertActiveUser, requireSessionUser } from '@/lib/apiAuth.server';
import { apiError } from '@/lib/apiErrorResponse';
import { markSessionMfaVerified } from '@/lib/sessionManager.server';
import { signInCeremonyNetwork } from '@/lib/swoop/networks.server';
import {
  createTrustedDevice,
  mintDeviceTrustToken,
  DEVICE_TRUST_COOKIE,
  deviceTrustCookieOptions,
} from '@/lib/deviceTrust.server';

export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const body = await request.json();
    const { userId, code, isBackupCode = false, trustDevice = false } = body;

    if (!userId || typeof userId !== 'string') {
      return NextResponse.json(
        { error: 'Invalid user ID' },
        { status: 400 }
      );
    }

    if (!code || typeof code !== 'string') {
      return NextResponse.json(
        { error: 'Invalid verification code' },
        { status: 400 }
      );
    }

    if (!isBackupCode && code.length !== 6) {
      return NextResponse.json(
        { error: 'TOTP code must be 6 digits' },
        { status: 400 }
      );
    }

    await requireSessionUser(request, userId);
    const userData = await assertActiveUser(userId);

    const db = getAdminDb();
    const userRef = db.collection('users').doc(userId);

    if (!userData.mfaEnrolled) {
      return NextResponse.json(
        { error: 'MFA not enrolled for this user' },
        { status: 400 }
      );
    }

    let isValid = false;
    let backupCodeUsed = false;

    if (isBackupCode) {
      const normalizedCode = code.toUpperCase().trim();

      const consumed = await db.runTransaction(async (tx) => {
        const snap = await tx.get(userRef);
        if (!snap.exists) {
          return { ok: false, reason: 'no_user' as const };
        }

        const data = snap.data() ?? {};
        const codes: string[] = Array.isArray(data.backupCodes) ? data.backupCodes : [];
        const matchingCodeIndex = codes.findIndex((hash) =>
          verifyBackupCode(normalizedCode, hash)
        );

        if (matchingCodeIndex === -1) {
          return { ok: false, reason: 'no_match' as const };
        }

        const remaining = codes.filter((_, index) => index !== matchingCodeIndex);
        tx.update(userRef, { backupCodes: remaining });
        return { ok: true, remaining: remaining.length } as const;
      });

      if (!consumed.ok) {
        if (consumed.reason === 'no_user') {
          return NextResponse.json(
            { error: 'User not found' },
            { status: 404 }
          );
        }

        return NextResponse.json(
          { error: 'Invalid verification code' },
          { status: 400 }
        );
      }

      isValid = true;
      backupCodeUsed = true;
    } else {
      const encryptedSecret = userData.mfaSecret;

      if (!encryptedSecret) {
        return NextResponse.json(
          { error: 'MFA secret not found' },
          { status: 400 }
        );
      }

      // A colon marks our encrypted format; anything else is legacy plaintext.
      let secret: string;
      if (encryptedSecret.includes(':')) {
        if (!isEncryptionConfigured()) {
          console.error('[MFA Verify Login] MFA_ENCRYPTION_KEY not configured');
          return NextResponse.json(
            { error: 'MFA encryption not configured' },
            { status: 500 }
          );
        }
        secret = decrypt(encryptedSecret);
      } else {
        // TODO: Migrate old secrets to encrypted format
        secret = encryptedSecret;
      }

      isValid = verifyTOTP(code, secret);
    }

    if (!isValid) {
      return NextResponse.json(
        { error: 'Invalid verification code' },
        { status: 400 }
      );
    }

    // The session cookie is the authoritative MFA gate the proxy reads; this
    // flag used to live in client sessionStorage and was settable without any
    // server check.
    await markSessionMfaVerified(await signInCeremonyNetwork(request, userId));

    // "Trust this device for 30 days": mint an opaque token, store only its
    // SHA-256 hash, return the raw token in an HTTPOnly cookie that a later
    // createSession() reads to be born mfaVerified. Minted once here — the
    // shared success point, strictly after the isValid gate — for both the TOTP
    // and backup-code paths. A persistence failure must NOT fail verification:
    // log and continue with no cookie.
    let rawTrustToken: string | null = null;
    if (trustDevice === true) {
      try {
        const { raw, hash } = mintDeviceTrustToken();
        await createTrustedDevice(
          userId,
          hash,
          request.headers.get('user-agent') ?? '',
          Date.now()
        );
        rawTrustToken = raw;
      } catch (error) {
        console.error('[MFA Verify Login] Failed to persist device trust:', error);
      }
    }

    const response = NextResponse.json({
      success: true,
      backupCodeUsed,
      deviceTrusted: rawTrustToken !== null,
    });

    if (rawTrustToken !== null) {
      response.cookies.set(
        DEVICE_TRUST_COOKIE,
        rawTrustToken,
        deviceTrustCookieOptions()
      );
    }

    return response;
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'mfa/verify-login');
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});
