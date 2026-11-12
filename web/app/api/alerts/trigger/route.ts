import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { getSiteAlertRecipients, getMachineTimezone, getSiteLabel, recipientWantsMachine } from '@/lib/adminUtils.server';
import { generateUnsubscribeToken } from '@/app/api/unsubscribe/route';
import { getResend, FROM_EMAIL, ENV_LABEL } from '@/lib/resendClient.server';
import { wrapEmailLayout, emailDataTable, emailTimestamp, EMAIL_COLORS, SEVERITY_COLORS, METRIC_LABELS, escapeHtml, safeEmailSubject } from '@/lib/emailTemplates.server';
import { fireWebhooks } from '@/lib/webhookSender.server';
import { tapTalonMatcher } from '@/lib/talons/matcher.server';
import { apiError } from '@/lib/apiErrorResponse';
import { publicOrigin } from '@/lib/publicOrigin.server';
import { hootInternalSecret } from '@/lib/hootInternalSecret';
import { sanitizeForLog } from '@/lib/logSanitize';

/**
 * POST /api/alerts/trigger — internal endpoint the Cloud Function calls on a
 * breached threshold rule; sends email and/or webhook notifications.
 *
 * Auth: `x-internal-secret` matching the hoot internal secret (env var
 * CORTEX_INTERNAL_SECRET — see lib/hootInternalSecret.ts).
 *
 * Body: siteId, machineId, ruleName, metric, value, threshold, operator
 * (>, <, >=, <=), severity (info|warning|critical), channels[] (email|webhook).
 */
export async function POST(request: NextRequest) {
  try {
    const secret = request.headers.get('x-internal-secret');
    const expectedSecret = hootInternalSecret();

    if (!expectedSecret || secret !== expectedSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const {
      siteId,
      machineId,
      ruleName,
      metric,
      value,
      threshold,
      operator,
      severity,
      channels,
    } = body;

    if (!siteId || !machineId || !ruleName || !metric || value === undefined || threshold === undefined || !operator || !severity || !Array.isArray(channels)) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    const db = getAdminDb();
    let emailSent = false;
    let webhooksFired = 0;

    if (channels.includes('email')) {
      const resendClient = getResend();
      if (resendClient) {
        const recipients = await getSiteAlertRecipients(siteId, 'thresholdAlerts');
        const tz = await getMachineTimezone(siteId, machineId);
        const baseUrl = publicOrigin(request);
        const siteLabel = await getSiteLabel(siteId);

        if (recipients.length > 0) {
          const severityLabel = severity.toUpperCase();
          const subject = safeEmailSubject(`[${severityLabel}] ${ruleName} — ${machineId}`);

          for (const recipient of recipients) {
            // Skip if user has muted this machine or their machine scope does not reach it
            if (!recipientWantsMachine(recipient, machineId)) continue;

            try {
              const unsubscribeUrl = recipient.userId !== 'fallback'
                ? `${baseUrl}/api/unsubscribe?token=${generateUnsubscribeToken(recipient.userId)}`
                : undefined;

              const html = buildThresholdAlertEmail({
                siteLabel,
                machineId,
                ruleName,
                metric,
                value,
                threshold,
                operator,
                severity,
                unsubscribeUrl,
                timezone: tz,
              });

              const result = await resendClient.emails.send({
                from: FROM_EMAIL,
                to: [recipient.email],
                ...(recipient.ccEmails.length > 0 ? { cc: recipient.ccEmails } : {}),
                subject,
                html,
              });

              if (result.error) {
                console.error(`[alerts/trigger] Resend error for ${sanitizeForLog(recipient.email)}:`, result.error);
              } else {
                emailSent = true;
              }
            } catch (emailError) {
              console.error(`[alerts/trigger] Failed to send to ${sanitizeForLog(recipient.email)}:`, emailError);
            }
          }

          if (emailSent) {
            console.log(`[alerts/trigger] Email sent to ${recipients.length} recipient(s) for ${sanitizeForLog(ruleName)}`);
          }
        }
      } else {
        console.warn('[alerts/trigger] RESEND_API_KEY not configured — email skipped');
      }
    }

    if (channels.includes('webhook')) {
      const siteDoc = await db.collection('sites').doc(siteId).get();
      const siteName = siteDoc.data()?.name || siteId;

      webhooksFired = await fireWebhooks(siteId, siteName, 'threshold.breached', {
        machine: { id: machineId, name: machineId },
        alert: {
          ruleName,
          metric,
          value,
          threshold,
          operator,
          severity,
        },
      });
    }

    // The only entry point for a threshold breach, so the only place a
    // threshold talon can match. Fire-and-forget by contract: a talon run can
    // capture a screenshot and call a vision model, and the caller is waiting.
    tapTalonMatcher(db, siteId, { kind: 'threshold', metric, operator, value, machineId });

    console.log(
      `[alerts/trigger] Processed threshold alert: ${sanitizeForLog(ruleName)} on ${sanitizeForLog(machineId)} ` +
      `(email=${emailSent}, webhooks=${webhooksFired})`
    );

    return NextResponse.json({
      success: true,
      emailSent,
      webhooksFired,
    });
  } catch (error: unknown) {
    return apiError(error, 'alerts/trigger');
  }
}

function buildThresholdAlertEmail(params: {
  siteLabel: string;
  machineId: string;
  ruleName: string;
  metric: string;
  value: number;
  threshold: number;
  operator: string;
  severity: string;
  unsubscribeUrl?: string;
  timezone?: string;
}): string {
  const { siteLabel, machineId, ruleName, metric, value, threshold, operator, severity, unsubscribeUrl, timezone } = params;
  const color = SEVERITY_COLORS[severity] || SEVERITY_COLORS.warning;
  const metricLabel = METRIC_LABELS[metric] || metric;

  const content = `
    <h2 style="color:${color};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">threshold alert: ${escapeHtml(ruleName)}</h2>
    <p style="margin:0 0 20px;color:${EMAIL_COLORS.muted};">a metric threshold has been breached on one of your machines.</p>
    ${emailDataTable([
      { label: 'site', value: siteLabel },
      { label: 'machine', value: machineId },
      { label: 'rule', value: ruleName },
      { label: 'metric', value: metricLabel },
      { label: 'condition', value: `${metricLabel} ${operator} ${threshold}` },
      { label: 'current value', value: String(value), highlight: color },
      { label: 'severity', value: severity.toUpperCase(), highlight: color },
      { label: 'time', value: emailTimestamp(new Date(), timezone) },
      { label: 'environment', value: ENV_LABEL },
    ])}
    <p style="margin:20px 0 0;color:${EMAIL_COLORS.muted};font-size:13px;">please check the machine and service metrics for more details.</p>
  `;
  return wrapEmailLayout(content, { unsubscribeUrl, preheader: `${severity.toUpperCase()}: ${ruleName} on ${machineId}` });
}
