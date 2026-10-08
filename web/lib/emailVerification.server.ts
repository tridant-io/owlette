/**
 * Email verification for password accounts (owlette-free plan, decision 11).
 *
 * Same pipeline as the password reset: `generateEmailVerificationLink` mints an
 * oobCode without sending Firebase's own mail, we rebuild it as an in-app
 * /verify-email link (no continue-URL or authorized-domain dependency) and send
 * our branded email through Resend.
 *
 * Nothing is gated on the result. Callers: the first bootstrap of a password
 * account and the banner's resend (`POST /api/auth/verify-email`).
 */

import type { UserRecord } from 'firebase-admin/auth';
import { getAdminAuth } from '@/lib/firebase-admin';
import { getResend, FROM_EMAIL, isProduction, trustedBaseUrl } from '@/lib/resendClient.server';
import { buildEmailVerificationEmail } from '@/lib/emailTemplates.server';

/**
 * A password account whose email is not verified yet. Federated sign-ups (Google)
 * arrive verified by their provider and never get the email.
 */
export function needsEmailVerification(
  user: UserRecord,
): user is UserRecord & { email: string } {
  return (
    !!user.email &&
    !user.emailVerified &&
    (user.providerData ?? []).some((provider) => provider.providerId === 'password')
  );
}

/**
 * Skips quietly (a log line) when Resend is not configured. Throws when link
 * generation or the send fails; the link is never logged.
 */
export async function sendVerificationEmail(email: string): Promise<void> {
  // minted before the resend check, so with no RESEND_API_KEY (e2e) the code still
  // exists in the auth emulator and the /verify-email flow stays testable
  const link = await getAdminAuth().generateEmailVerificationLink(email);
  const oobCode = new URL(link).searchParams.get('oobCode');
  if (!oobCode) {
    throw new Error('generateEmailVerificationLink returned a link with no oobCode');
  }

  const resend = getResend();
  if (!resend) {
    if (isProduction) {
      console.error('[email-verification] RESEND_API_KEY not configured in production — verification email NOT sent');
    } else {
      console.warn('[email-verification] RESEND_API_KEY not configured — verification email not sent (dev/e2e)');
    }
    return;
  }

  const verifyUrl = `${trustedBaseUrl()}/verify-email?oobCode=${encodeURIComponent(oobCode)}`;
  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: email,
    subject: 'verify your owlette email',
    html: buildEmailVerificationEmail(verifyUrl),
  });
  if (error) throw error;
}
