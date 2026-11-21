/**
 * POST /api/mfa/disable — server-mediated MFA disable for the session's own user.
 *
 * Wave 1B locked the user-doc write rules (firestore.rules affectedKeys allowlist),
 * so `mfaEnrolled` / `mfaSecret` / `backupCodes` can no longer be mutated from a
 * client; this admin-SDK route is the only authorized path. There is no `userId`
 * parameter — the session decides the account. Rate-limited 10/min/IP.
 *
 * Request: { code: string, isBackupCode?: boolean } → { success, backupCodeUsed }
 * 400 bad code / not enrolled · 401 no session · 404 no user doc · 500 no MFA key.
 *
 * Flow: verify the factor → `applyMfaFactorChange` drops the TOTP leg, clears
 * secret + backup codes and stamps `mfaDisabledAt` in ONE write (it also owns
 * `mfaEnrolled` / `requiresMfaSetup`: an account still holding passkeys stays
 * enrolled, one dropping to zero factors is re-armed into mandatory setup) →
 * re-mint the session via `markSessionMfaDisabled` so the user isn't bounced to
 * /verify-2fa → emit a `user_mutated` audit row (platform tenant, no siteId).
 *
 * No re-auth shortcut: the second factor is proven every time. Losing both TOTP
 * and every backup code means manual support recovery.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyBackupCode } from '@/lib/totp';
import { decrypt, isEncryptionConfigured } from '@/lib/encryption.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { rateLimitedResponse, withRateLimit } from '@/lib/withRateLimit';
import { MFA_ATTEMPTS_EXCEEDED, consumeTotpCode, spendMfaAttempt } from '@/lib/mfaAttempts.server';
import {
  ApiAuthError,
  assertActiveUser,
  requirePreMfaSession,
} from '@/lib/apiAuth.server';
import { apiError } from '@/lib/apiErrorResponse';
import { markSessionMfaDisabled } from '@/lib/sessionManager.server';
import {
  revokeAllTrustedDevices,
  DEVICE_TRUST_COOKIE,
  deviceTrustCookieOptions,
} from '@/lib/deviceTrust.server';
import { emitMutation } from '@/lib/auditLogClient';
import { applyMfaFactorChange } from '@/lib/mfaFactors.server';
import { sendMfaFactorNotice } from '@/lib/mfaNotice.server';

export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const body = await request.json().catch(() => ({}));
    const { code, isBackupCode = false } = body as {
      code?: unknown;
      isBackupCode?: unknown;
    };

    if (!code || typeof code !== 'string') {
      return NextResponse.json(
        { error: 'Invalid verification code' },
        { status: 400 }
      );
    }
    const useBackup = isBackupCode === true;
    if (!useBackup && code.length !== 6) {
      return NextResponse.json(
        { error: 'TOTP code must be 6 digits' },
        { status: 400 }
      );
    }

    // The session is authoritative — no userId from the body, so this route can
    // never be redirected against another account.
    const userId = await requirePreMfaSession(request);

    const userData = await assertActiveUser(userId);
    const db = getAdminDb();
    const userRef = db.collection('users').doc(userId);

    if (!userData.mfaEnrolled) {
      return NextResponse.json(
        { error: 'MFA is not enrolled for this account' },
        { status: 400 }
      );
    }

    const attempt = await spendMfaAttempt(userId);
    if (!attempt.success) {
      return rateLimitedResponse(attempt, 'endpoint-rate', MFA_ATTEMPTS_EXCEEDED);
    }

    let backupCodeUsed = false;

    if (useBackup) {
      const normalizedCode = code.toUpperCase().trim();

      const consumed = await db.runTransaction(async (tx) => {
        const snap = await tx.get(userRef);
        if (!snap.exists) {
          return { ok: false, reason: 'no_user' as const };
        }
        const data = snap.data() ?? {};
        const codes: string[] = Array.isArray(data.backupCodes) ? data.backupCodes : [];
        const idx = codes.findIndex((hash) => verifyBackupCode(normalizedCode, hash));
        if (idx === -1) {
          return { ok: false, reason: 'no_match' as const };
        }
        // Consume inside the transaction so a crash between verification and the
        // disable-write below can't leave the backup code re-usable.
        const remaining = codes.filter((_, i) => i !== idx);
        tx.update(userRef, { backupCodes: remaining });
        return { ok: true } as const;
      });

      if (!consumed.ok) {
        if (consumed.reason === 'no_user') {
          return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }
        return NextResponse.json(
          { error: 'Invalid verification code' },
          { status: 400 }
        );
      }
      backupCodeUsed = true;
    } else {
      const encryptedSecret = userData.mfaSecret;
      if (!encryptedSecret || typeof encryptedSecret !== 'string') {
        return NextResponse.json(
          { error: 'MFA secret not found' },
          { status: 400 }
        );
      }

      let secret: string;
      if (encryptedSecret.includes(':')) {
        if (!isEncryptionConfigured()) {
          console.error('[MFA Disable] MFA_ENCRYPTION_KEY not configured');
          return NextResponse.json(
            { error: 'MFA encryption not configured' },
            { status: 500 }
          );
        }
        secret = decrypt(encryptedSecret);
      } else {
        // Legacy unencrypted format — same handling as verify-login.
        secret = encryptedSecret;
      }

      if (!(await consumeTotpCode(userId, code, secret))) {
        return NextResponse.json(
          { error: 'Invalid verification code' },
          { status: 400 }
        );
      }
    }

    // Single write so partial failure can't leave the user enrolled with a deleted
    // `mfaSecret` — verify-login would then error and lock them out. The inventory
    // module derives `mfaEnrolled` / `requiresMfaSetup` from what remains: dropping
    // the last factor is always allowed and re-arms the /setup-2fa nag rather than
    // silently losing 2FA.
    const factorResult = await applyMfaFactorChange(
      userId,
      { totp: false },
      {
        extraUpdate: {
          mfaSecret: FieldValue.delete(),
          backupCodes: [],
          mfaDisabledAt: FieldValue.serverTimestamp(),
        },
      },
    );

    // The user just proved possession, so keep them signed in instead of
    // re-challenging against an MFA configuration that no longer exists.
    await markSessionMfaDisabled();

    // Purge trusted-device records so a later re-enroll can't inherit stale trust.
    // They're already unusable once mfaEnrolled=false, so a revocation failure must
    // never block the disable.
    let trustedDevicesRevoked = 0;
    try {
      trustedDevicesRevoked = await revokeAllTrustedDevices(userId);
    } catch (revokeError) {
      console.error('[MFA Disable] failed to revoke trusted devices', revokeError);
    }

    // Platform-tenant mutation (siteId = '') — recorded on the platform partition.
    emitMutation({
      kind: 'user_mutated',
      siteId: '',
      actor: `user:${userId}`,
      targetId: userId,
      attributes: {
        endpoint: '/api/mfa/disable',
        method: 'POST',
        verb: 'mfa_disabled',
        factor: 'totp',
        factorUsed: useBackup ? 'backup_code' : 'totp',
        trustedDevicesRevoked,
        // A passkey-only account stays enrolled; only a drop to zero re-arms the nag.
        passkeysEnrolled: factorResult.factors.passkeys,
        stillEnrolled: factorResult.mfaEnrolled,
        setupReArmed: factorResult.requiresMfaSetup,
      },
    });

    // a passkey-only account reaches here on a backup code, and loses only the sheet
    await sendMfaFactorNotice(userData.email, {
      change: 'removed',
      factor: userData.mfaSecret ? 'authenticator app' : 'backup codes',
    });

    // Expire the device-trust cookie; the server-side records are already gone.
    const response = NextResponse.json({ success: true, backupCodeUsed });
    response.cookies.set(DEVICE_TRUST_COOKIE, '', {
      ...deviceTrustCookieOptions(),
      maxAge: 0,
    });
    return response;
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'mfa/disable');
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});
