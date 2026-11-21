/**
 * POST /api/mfa/backup-codes — mints a fresh generation of recovery codes for the
 * caller's own account and returns the plaintext EXACTLY ONCE (only hashes are
 * stored). Regeneration retires every previously issued code.
 *
 * Proof, one of three shapes:
 *   { code: "123456" }                        — current TOTP code
 *   { code: "A1B2C3D4", isBackupCode: true }  — unused backup code
 *   { credential, challengeId }               — passkey step-up assertion
 *     (from /api/passkeys/step-up/options)
 * 200: { success: true, backupCodes: string[], count: number }
 *
 * Exists because backup codes used to be a side effect of TOTP enrollment, so a
 * passkey-only account — fully MFA-enrolled — had no recovery material at all.
 * All three factors are interchangeable here for the same reason.
 *
 * Gated on proof IN THIS REQUEST, not `session.mfaVerified`: a stolen 7-day
 * `__session` cookie (‘/api/*’ is not MFA-gated by the proxy) could otherwise
 * mint a permanent offline second factor that also satisfies `/api/mfa/disable`,
 * a route that demands live proof every time.
 *
 * First enrollment is the one exception, and the boundary is a module call, not
 * a flag: `/api/mfa/verify-setup` calls `issueBackupCodes()` in-process after
 * verifying the enrolling TOTP code. This HTTP route has no bypass parameter and
 * must never gain one.
 */

import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, assertActiveUser, requireSession } from '@/lib/apiAuth.server';
import { apiError } from '@/lib/apiErrorResponse';
import { issueBackupCodes, BACKUP_CODE_COUNT } from '@/lib/backupCodes.server';
import {
  mfaProofErrorResponse,
  parseMfaProof,
  verifyMfaProof,
} from '@/lib/mfaProof.server';
import { emitMutation } from '@/lib/auditLogClient';

export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    // No `userId` parameter by design: the session decides whose doc we touch.
    const userId = await requireSession(request);
    const userData = await assertActiveUser(userId);

    const body = await request.json().catch(() => ({}));

    // shape first: a malformed body is refused before any Firestore work
    const parsed = parseMfaProof(body);
    if (!parsed.ok) {
      return mfaProofErrorResponse(parsed);
    }

    // nothing below runs without a factor demonstrated in this request
    const proof = await verifyMfaProof(userId, parsed.proof, userData);
    if (!proof.ok) {
      return mfaProofErrorResponse(proof);
    }

    // hashes as it generates, so the plaintext never reaches a write payload
    const { plaintext, hashed } = issueBackupCodes(BACKUP_CODE_COUNT);

    // Wholesale replacement, never a merge — a new sheet must retire the old one.
    // Deliberately does not touch `mfaEnrolled` / `requiresMfaSetup` (owned by
    // lib/mfaFactors.server.ts): codes are recovery material, not a factor.
    await getAdminDb().collection('users').doc(userId).update({
      backupCodes: hashed,
      backupCodesGeneratedAt: FieldValue.serverTimestamp(),
    });

    // siteId '' = platform partition, mirroring mfa_enrolled / mfa_disabled.
    emitMutation({
      kind: 'user_mutated',
      siteId: '',
      actor: `user:${userId}`,
      targetId: userId,
      attributes: {
        endpoint: '/api/mfa/backup-codes',
        method: 'POST',
        verb: 'mfa_backup_codes_regenerated',
        factor: 'backup_codes',
        factorUsed: proof.factorUsed,
        backupCodesIssued: hashed.length,
      },
    });

    return NextResponse.json({
      success: true,
      backupCodes: plaintext,
      count: plaintext.length,
    });
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return apiError(error, 'mfa/backup-codes');
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});
