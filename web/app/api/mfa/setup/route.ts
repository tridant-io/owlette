/**
 * POST /api/mfa/setup — `{userId, email}` → `{secret, qrCodeUrl}`.
 *
 * The secret lands in `mfa_pending` only; /api/mfa/verify-setup does the real
 * enrollment write.
 *
 * Gated: adding a second factor needs an MFA-verified session, so a stolen
 * session can't enroll its own (see lib/mfaEnrollmentGate.server.ts). Gating at
 * step one fails with an actionable code instead of after a QR scan.
 *
 * Audits `user_mutated` / `mfa_enrollment_started` — the sibling that opens the
 * `mfa_enrolled` (verify-setup) / `mfa_disabled` (disable) pair — but only when a
 * secret is actually minted; the idempotent reuse path changes no state. The TOTP
 * secret never reaches the audit row.
 */

import { NextRequest, NextResponse } from 'next/server';
import { generateTOTPSecret, generateQRCode } from '@/lib/totp';
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, assertActiveUser, requirePreMfaSessionUser } from '@/lib/apiAuth.server';
import { apiError } from '@/lib/apiErrorResponse';
import { emitMutation } from '@/lib/auditLogClient';
import { checkMfaEnrollmentGate } from '@/lib/mfaEnrollmentGate.server';

export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const body = await request.json();
    const { userId, email } = body;

    if (!userId || typeof userId !== 'string') {
      return NextResponse.json(
        { error: 'Invalid user ID' },
        { status: 400 }
      );
    }

    if (!email || typeof email !== 'string') {
      return NextResponse.json(
        { error: 'Invalid email' },
        { status: 400 }
      );
    }

    await requirePreMfaSessionUser(request, userId);
    await assertActiveUser(userId);

    // Open while the account has no factor (mandatory-setup path).
    const gate = await checkMfaEnrollmentGate(userId);
    if (gate.denied) {
      return gate.denied;
    }

    const db = getAdminDb();

    // Idempotent by design. setup-2fa fires this from an effect, so remounts
    // POST again; minting per call let the LAST `mfa_pending` write win while
    // the user scanned the FIRST QR, and verify-setup then rejected a correct
    // code (flaked the setup-2fa e2e ~50%). Expired pendings still fall through.
    const pendingRef = db.collection('mfa_pending').doc(userId);
    const pending = await pendingRef.get();
    const pendingData = pending.exists ? pending.data() : undefined;
    const pendingExpiresAt =
      pendingData?.expiresAt?.toDate?.() ??
      (pendingData?.expiresAt ? new Date(pendingData.expiresAt) : undefined);
    const reusableSecret =
      typeof pendingData?.secret === 'string' &&
      pendingExpiresAt instanceof Date &&
      pendingExpiresAt > new Date()
        ? pendingData.secret
        : null;

    if (reusableSecret) {
      return NextResponse.json({
        secret: reusableSecret,
        qrCodeUrl: await generateQRCode(email, reusableSecret),
      });
    }

    let secret: string;
    try {
      secret = generateTOTPSecret();
    } catch (e) {
      console.error('[MFA Setup] generateTOTPSecret failed:', e);
      throw e;
    }

    let qrCodeUrl: string;
    try {
      qrCodeUrl = await generateQRCode(email, secret);
    } catch (e) {
      console.error('[MFA Setup] generateQRCode failed:', e);
      throw e;
    }

    try {
      await pendingRef.set({
        secret,
        email,
        createdAt: FieldValue.serverTimestamp(),
        expiresAt: Timestamp.fromDate(new Date(Date.now() + 10 * 60 * 1000)), // 10 minutes
      });
    } catch (e) {
      console.error('[MFA Setup] Firestore write failed:', e);
      throw e;
    }

    // Only the mint path audits: the reuse branch above returns an existing
    // pending secret and writes nothing. Platform-tenant row (siteId = ''),
    // matching `mfa_enrolled` / `mfa_disabled`.
    emitMutation({
      kind: 'user_mutated',
      siteId: '',
      actor: `user:${userId}`,
      targetId: userId,
      attributes: {
        endpoint: '/api/mfa/setup',
        method: 'POST',
        verb: 'mfa_enrollment_started',
        factor: 'totp',
        passkeysEnrolled: gate.factors.passkeys,
      },
    });

    return NextResponse.json({
      secret,
      qrCodeUrl,
    });
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'mfa/setup');
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});
