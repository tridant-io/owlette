/**
 * When autonomous Hoot can't resolve an issue it emails site admins with what
 * it investigated and attempted.
 *
 * Server-side only — never import this in client components.
 */

import { getSiteAlertRecipients, getMachineTimezone, recipientWantsMachine } from '@/lib/adminUtils.server';
import { generateUnsubscribeToken } from '@/app/api/unsubscribe/route';
import { getResend, FROM_EMAIL, ENV_LABEL, isProduction } from '@/lib/resendClient.server';
import { wrapEmailLayout, emailDataTable, emailTimestamp, EMAIL_COLORS, escapeHtml, safeEmailSubject } from '@/lib/emailTemplates.server';
import { sanitizeForLog } from '@/lib/logSanitize';

export async function escalate(
  siteId: string,
  eventId: string,
  machineName: string,
  processName: string,
  hootResponse: string
): Promise<boolean> {
  const recipients = await getSiteAlertRecipients(siteId, 'cortexAlerts');
  if (recipients.length === 0) {
    console.warn(`[hoot/escalation] No admin emails found for site ${sanitizeForLog(siteId)}`);
    return false;
  }

  const resend = getResend();
  if (!resend) {
    console.warn('[hoot/escalation] Resend not configured — escalation email not sent');
    return false;
  }

  const tz = await getMachineTimezone(siteId, machineName);
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || (isProduction ? 'https://owlette.app' : 'https://dev.owlette.app');
  const subject = safeEmailSubject(`hoot escalation: ${processName} on ${machineName}`);

  let anySent = false;
  for (const recipient of recipients) {
    // machineName is the machine id here, as the timezone lookup above reads it
    if (!recipientWantsMachine(recipient, machineName)) continue;

    const unsubscribeUrl = recipient.userId !== 'fallback'
      ? `${baseUrl}/api/unsubscribe?token=${generateUnsubscribeToken(recipient.userId)}`
      : undefined;
    const html = buildEscalationEmail(siteId, machineName, processName, hootResponse, eventId, { unsubscribeUrl, timezone: tz });

    const result = await resend.emails.send({
      from: FROM_EMAIL,
      to: [recipient.email],
      ...(recipient.ccEmails.length > 0 ? { cc: recipient.ccEmails } : {}),
      subject,
      html,
    });

    if (result.error) {
      console.error(`[hoot/escalation] Resend error for ${sanitizeForLog(recipient.email)}:`, result.error);
    } else {
      anySent = true;
    }
  }

  if (anySent) {
    console.log(`[hoot/escalation] Escalation sent for ${sanitizeForLog(processName)} on ${sanitizeForLog(machineName)} (${sanitizeForLog(eventId)})`);
  }
  return anySent;
}

function buildEscalationEmail(
  siteId: string,
  machineName: string,
  processName: string,
  hootResponse: string,
  eventId: string,
  options: { unsubscribeUrl?: string; timezone?: string } = {}
): string {
  const { unsubscribeUrl, timezone } = options;
  const truncatedResponse = hootResponse.length > 2000
    ? hootResponse.slice(0, 2000) + '\n\n... (truncated)'
    : hootResponse;

  const escapedResponse = truncatedResponse
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');

  const content = `
    <h2 style="color:${EMAIL_COLORS.amber};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">hoot escalation: ${escapeHtml(processName)}</h2>
    <p style="margin:0 0 20px;color:${EMAIL_COLORS.muted};">owlette hoot investigated an issue autonomously but was unable to resolve it. human attention is needed.</p>

    ${emailDataTable([
      { label: 'site', value: siteId },
      { label: 'machine', value: machineName },
      { label: 'process', value: processName },
      { label: 'event id', value: eventId },
      { label: 'time', value: emailTimestamp(new Date(), timezone) },
      { label: 'environment', value: ENV_LABEL },
    ])}

    <h3 style="color:${EMAIL_COLORS.cyan};margin:24px 0 12px;font-size:15px;font-weight:600;text-transform:lowercase;">hoot investigation report</h3>
    <div style="background:${EMAIL_COLORS.bodyBg};border:1px solid ${EMAIL_COLORS.border};padding:14px;border-radius:6px;font-family:'Courier New',Courier,monospace;font-size:12px;line-height:1.6;color:${EMAIL_COLORS.muted};overflow:auto;">
      ${escapedResponse}
    </div>

    <p style="margin:20px 0 0;color:${EMAIL_COLORS.muted};font-size:13px;">review the autonomous conversation in the hoot dashboard for full details.</p>
  `;

  return wrapEmailLayout(content, { preheader: `hoot escalation: ${processName} on ${machineName}`, unsubscribeUrl });
}
