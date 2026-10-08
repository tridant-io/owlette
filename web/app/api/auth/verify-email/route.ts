/**
 * POST /api/auth/verify-email — resends the signed-in user's own verification
 * email (the "resend" on VerifyEmailBanner). The first one goes out from
 * /api/users/bootstrap when a password account is created.
 *
 * Session only: the address comes from the caller's own auth record, never the
 * body, so this can only ever mail the caller. Rate limited per user, inside the
 * handler once the session has resolved the uid. 204 on success; an account that
 * is already verified, or federated, gets the same 204 and no email.
 *
 * Nothing is blocked on verification — this only (re)sends the link.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getAdminAuth } from '@/lib/firebase-admin';
import { ApiAuthError, requireSession } from '@/lib/apiAuth.server';
import { problemFromError, problemUnauthorized } from '@/lib/apiErrors';
import { checkRateLimit, verifyEmailRateLimit } from '@/lib/rateLimit';
import { applyRateLimitCounters, rateLimitedResponse } from '@/lib/withRateLimit';
import { needsEmailVerification, sendVerificationEmail } from '@/lib/emailVerification.server';

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    let userId: string;
    try {
      userId = await requireSession(request);
    } catch (err) {
      if (err instanceof ApiAuthError) return problemUnauthorized(err.message);
      throw err;
    }

    const rateResult = await checkRateLimit(verifyEmailRateLimit, `verify_email:${userId}`);
    if (!rateResult.success) return rateLimitedResponse(rateResult, 'endpoint-rate');

    const userRecord = await getAdminAuth().getUser(userId);
    if (needsEmailVerification(userRecord)) {
      await sendVerificationEmail(userRecord.email);
    }

    return applyRateLimitCounters(new NextResponse(null, { status: 204 }), rateResult);
  } catch (err) {
    return problemFromError(err, 'auth/verify-email:POST');
  }
}
