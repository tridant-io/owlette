/**
 * tells an account's own address that its second factors changed. callers pass
 * `users/{uid}.email`, which firestore.rules keeps out of client writes, never an
 * address from the request.
 *
 * best effort and never throws: the factor has already changed by the time this
 * runs, so mail trouble must not fail the request.
 */

import logger from '@/lib/logger';
import { getResend, FROM_EMAIL } from '@/lib/resendClient.server';
import { buildMfaFactorNoticeEmail, type MfaFactorNotice } from '@/lib/emailTemplates.server';

/** verify-setup's response carries the only copy of the backup codes, so a hung send can't hold it. */
export const MFA_NOTICE_SEND_TIMEOUT_MS = 5000;

export async function sendMfaFactorNotice(email: unknown, notice: MfaFactorNotice): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const resend = getResend();
    if (!resend || typeof email !== 'string' || !email) {
      logger.warn('[mfa/notice] resend or the address is missing; factor notice not sent', {
        context: 'mfa/notice',
      });
      return;
    }
    const { subject, html } = buildMfaFactorNoticeEmail({ ...notice, at: new Date() });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), MFA_NOTICE_SEND_TIMEOUT_MS);
    });
    const { error } = await Promise.race([
      resend.emails.send({ from: FROM_EMAIL, to: email, subject, html }),
      timeout,
    ]);
    if (error) throw new Error(error.message);
  } catch (err) {
    logger.warn('[mfa/notice] could not send a factor notice', {
      context: 'mfa/notice',
      data: { err: err instanceof Error ? err.message : String(err) },
    });
  } finally {
    clearTimeout(timer);
  }
}
