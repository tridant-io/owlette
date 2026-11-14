/**
 * POST /api/auth/forgot-password — branded reset email via Resend instead of
 * Firebase's built-in template.
 *
 * `generatePasswordResetLink` mints an oobCode without sending Firebase's mail;
 * we rebuild it as an in-app /reset-password link (no continue-URL or
 * authorized-domain dependency) and send our own email.
 *
 * Enumeration-safe: unknown addresses get the same 200 as known ones; only
 * malformed input gets a 400. Rate limited per IP — this is the public,
 * unauthenticated abuse boundary for reset sends.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { getAdminAuth } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';
import { getResend, FROM_EMAIL, isProduction, trustedBaseUrl } from '@/lib/resendClient.server';
import { buildPasswordResetEmail } from '@/lib/emailTemplates.server';
import { TURNSTILE_TOKEN_FIELD, verifyTurnstileToken } from '@/lib/turnstile.server';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      const body = await request.json().catch(() => null);
      const email = typeof body?.email === 'string' ? body.email.trim() : '';

      if (!email || !EMAIL_RE.test(email)) {
        return NextResponse.json({ error: 'Missing or invalid email' }, { status: 400 });
      }

      // Bot gate before the account lookup: the 403 is identical for known and
      // unknown addresses, so it leaks nothing.
      const challenge = await verifyTurnstileToken(
        request,
        body?.[TURNSTILE_TOKEN_FIELD],
        'forgot-password'
      );
      if (!challenge.ok) {
        console.warn('[forgot-password] turnstile rejected:', challenge.reason);
        return NextResponse.json({ error: 'Challenge verification failed' }, { status: 403 });
      }

      // Existence check FIRST: getUserByEmail throws a stable
      // 'auth/user-not-found', while generatePasswordResetLink throws an opaque
      // 'auth/internal-error' for unknown users on REAL Firebase (the emulator
      // throws user-not-found, which is why this gap passed e2e and review).
      // Without it unknown emails 500 while real ones 200 — an enumeration oracle.
      try {
        await getAdminAuth().getUserByEmail(email);
      } catch (err: unknown) {
        if ((err as { code?: string } | null)?.code === 'auth/user-not-found') {
          // No account — respond exactly as the success case.
          return NextResponse.json({ success: true });
        }
        throw err;
      }

      // Mint the reset link server-side WITHOUT triggering Firebase's own email.
      const link = await getAdminAuth().generatePasswordResetLink(email);
      const oobCode = new URL(link).searchParams.get('oobCode');
      if (!oobCode) {
        // Link with no parsable oobCode is unexpected; surface as 500.
        throw new Error('generatePasswordResetLink returned a link with no oobCode');
      }

      const resetUrl = `${trustedBaseUrl()}/reset-password?oobCode=${encodeURIComponent(oobCode)}`;

      // No Resend (local dev / e2e) still responds 200: the code was minted and
      // the existence-agnostic contract holds.
      const resend = getResend();
      if (resend) {
        const { error } = await resend.emails.send({
          from: FROM_EMAIL,
          to: email,
          subject: 'reset your owlette password',
          html: buildPasswordResetEmail(resetUrl),
        });
        if (error) throw error;
      } else if (isProduction) {
        // Error level so a missing RESEND_API_KEY can't silently black-hole resets
        // behind a "link is on its way" confirmation.
        console.error('[forgot-password] RESEND_API_KEY not configured in production — reset email NOT sent');
      } else {
        console.warn('[forgot-password] RESEND_API_KEY not configured — reset email not sent (dev/e2e)');
      }

      return NextResponse.json({ success: true });
    } catch (error) {
      return apiError(error, 'auth/forgot-password POST');
    }
  },
  {
    strategy: 'auth',
    identifier: 'ip',
  },
);
