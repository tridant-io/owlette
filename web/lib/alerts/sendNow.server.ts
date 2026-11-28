/**
 * The immediate email every site alert sender sends to a recipient on "as it
 * happens" (or the ADMIN_EMAIL fallback). Server-only.
 */

import type { SiteRecipient } from '@/lib/adminUtils.server';
import { generateUnsubscribeToken } from '@/app/api/unsubscribe/route';
import { unsubscribeHeaders } from '@/lib/emailTemplates.server';
import { sanitizeForLog } from '@/lib/logSanitize';
import { FROM_EMAIL, getResend } from '@/lib/resendClient.server';

/**
 * Send one alert email now: the recipient's own unsubscribe link (none for the
 * fallback, which has no uid), their cc list, and one-click headers only on a
 * copy nobody else receives. True when Resend accepted it; false, logged under
 * `log`, when it refused or is not configured.
 */
export async function sendAlertEmailNow(args: {
  /** the sender's log prefix, e.g. `[cron/health-check]` */
  log: string;
  recipient: SiteRecipient;
  baseUrl: string;
  subject: string;
  html: (unsubscribeUrl: string | undefined) => string;
}): Promise<boolean> {
  const { log, recipient } = args;
  const resend = getResend();
  if (!resend) {
    console.warn(`${log} Resend not configured — email not sent`);
    return false;
  }
  const unsubscribeUrl =
    recipient.userId !== 'fallback'
      ? `${args.baseUrl}/api/unsubscribe?token=${generateUnsubscribeToken(recipient.userId)}`
      : undefined;
  const result = await resend.emails.send({
    from: FROM_EMAIL,
    to: [recipient.email],
    ...(recipient.ccEmails.length > 0 ? { cc: recipient.ccEmails } : {}),
    subject: args.subject,
    html: args.html(unsubscribeUrl),
    ...unsubscribeHeaders(unsubscribeUrl, recipient.ccEmails),
  });
  if (result.error) {
    console.error(`${log} Resend error for ${sanitizeForLog(recipient.email)}:`, result.error);
    return false;
  }
  return true;
}
