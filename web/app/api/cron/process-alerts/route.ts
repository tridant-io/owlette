import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { getSiteAlertRecipients, getMachineTimezone, getSiteLabel, recipientWantsMachine } from '@/lib/adminUtils.server';
import { getResend, FROM_EMAIL } from '@/lib/resendClient.server';
import { wrapEmailLayout, EMAIL_COLORS, emailTimestamp, escapeHtml, safeEmailSubject } from '@/lib/emailTemplates.server';
import { generateUnsubscribeToken } from '@/app/api/unsubscribe/route';
import { apiError } from '@/lib/apiErrorResponse';
import { publicOrigin } from '@/lib/publicOrigin.server';

/**
 * GET /api/cron/process-alerts — drains pending_process_alerts into batched per-site digest
 * emails. Alerts are held for ACCUMULATION_WINDOW_MS so machines crashing together share one email.
 *
 * Auth: X-Cron-Secret must match CRON_SECRET.
 *
 * cron-job.org config (NOT Railway — register once per environment):
 *   Schedule:  * /3 * * * *   (every 3 minutes)
 *   URL:       GET https://<your-app>/api/cron/process-alerts
 *   Header:    X-Cron-Secret: <that environment's CRON_SECRET>
 */

// Alerts younger than this are left to accumulate.
const ACCUMULATION_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

interface PendingAlert {
  docId: string;
  siteId: string;
  machineId: string;
  processName: string;
  errorMessage: string;
  agentVersion: string;
  eventType: string;
  timestamp: FirebaseFirestore.Timestamp;
}

function buildProcessDigestEmail(
  siteLabel: string,
  alerts: PendingAlert[],
  unsubscribeUrl?: string,
  timezone?: string,
): string {
  // Single alert: simpler layout.
  if (alerts.length === 1) {
    const a = alerts[0];
    const eventLabel = a.eventType === 'process_start_failed' ? 'failed to start' : 'crashed';
    const content = `
      <h2 style="color:${EMAIL_COLORS.red};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">process ${eventLabel}: ${escapeHtml(a.processName)}</h2>
      <p style="margin:0 0 20px;color:${EMAIL_COLORS.muted};">a monitored process has ${eventLabel} on one of your machines.</p>
      <table width="100%" style="border-collapse:collapse;" cellpadding="0" cellspacing="0">
        ${alertRow('site', siteLabel, false)}
        ${alertRow('machine', a.machineId, true)}
        ${alertRow('process', a.processName, false)}
        ${alertRow('event', eventLabel, true, EMAIL_COLORS.red)}
        ${alertRow('error', a.errorMessage, false)}
        ${alertRow('agent version', a.agentVersion, true)}
        ${alertRow('time', emailTimestamp(a.timestamp?.toDate?.() ?? new Date(), timezone), false)}
      </table>
      <p style="margin:20px 0 0;color:${EMAIL_COLORS.muted};font-size:13px;">please check the machine and service logs for more details.</p>
    `;
    return wrapEmailLayout(content, {
      preheader: `process ${eventLabel}: ${a.processName} on ${a.machineId}`,
      unsubscribeUrl,
    });
  }

  const rows = alerts
    .map((a, i) => {
      const eventLabel = a.eventType === 'process_start_failed' ? 'failed to start' : 'crashed';
      const bg = i % 2 === 1 ? `background:${EMAIL_COLORS.altRow};` : '';
      return `
      <tr>
        <td style="padding:10px 14px;${bg}color:${EMAIL_COLORS.text};border-bottom:1px solid ${EMAIL_COLORS.border};font-size:13px;">${escapeHtml(a.machineId)}</td>
        <td style="padding:10px 14px;${bg}color:${EMAIL_COLORS.text};border-bottom:1px solid ${EMAIL_COLORS.border};font-size:13px;">${escapeHtml(a.processName)}</td>
        <td style="padding:10px 14px;${bg}color:${EMAIL_COLORS.red};border-bottom:1px solid ${EMAIL_COLORS.border};font-size:13px;">${eventLabel}</td>
        <td style="padding:10px 14px;${bg}color:${EMAIL_COLORS.muted};border-bottom:1px solid ${EMAIL_COLORS.border};font-size:13px;">${escapeHtml(a.errorMessage)}</td>
      </tr>`;
    })
    .join('');

  const thStyle = `padding:10px 14px;text-align:left;background:${EMAIL_COLORS.altRow};color:${EMAIL_COLORS.muted};font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid ${EMAIL_COLORS.border};`;

  const content = `
    <h2 style="color:${EMAIL_COLORS.red};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">process alerts: ${alerts.length} event(s)</h2>
    <p style="margin:0 0 20px;color:${EMAIL_COLORS.muted};">${alerts.length} process event(s) detected in site <strong style="color:${EMAIL_COLORS.text};">${escapeHtml(siteLabel)}</strong>.</p>
    <table width="100%" style="border-collapse:collapse;border:1px solid ${EMAIL_COLORS.border};border-radius:6px;overflow:hidden;" cellpadding="0" cellspacing="0">
      <thead>
        <tr>
          <th style="${thStyle}">machine</th>
          <th style="${thStyle}">process</th>
          <th style="${thStyle}">event</th>
          <th style="${thStyle}">error</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin:20px 0 0;color:${EMAIL_COLORS.muted};font-size:13px;">please check each machine and verify that processes are running correctly.</p>
    <p style="margin:8px 0 0;color:${EMAIL_COLORS.border};font-size:11px;">checked at ${emailTimestamp(new Date(), timezone)}</p>
  `;

  return wrapEmailLayout(content, {
    preheader: `${alerts.length} process event(s) in ${siteLabel}`,
    unsubscribeUrl,
  });
}

/** Key-value row for single-alert emails; matches emailDataTable style. */
function alertRow(label: string, value: string, alt: boolean, highlight?: string): string {
  const bg = alt ? `background:${EMAIL_COLORS.altRow};` : '';
  const color = highlight || EMAIL_COLORS.text;
  return `
    <tr>
      <td style="padding:10px 14px;${bg}color:${EMAIL_COLORS.muted};font-size:13px;font-weight:600;white-space:nowrap;border-bottom:1px solid ${EMAIL_COLORS.border};width:140px;">${label}</td>
      <td style="padding:10px 14px;${bg}color:${color};font-size:13px;border-bottom:1px solid ${EMAIL_COLORS.border};">${escapeHtml(value)}</td>
    </tr>`;
}

export async function GET(request: NextRequest) {
  const cronSecret = request.headers.get('x-cron-secret');
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getAdminDb();
  const cutoff = new Date(Date.now() - ACCUMULATION_WINDOW_MS);

  try {
    const alertsSnap = await db
      .collection('pending_process_alerts')
      .where('timestamp', '<=', cutoff)
      .get();

    if (alertsSnap.empty) {
      return NextResponse.json({ ok: true, alertsProcessed: 0 });
    }

    const alerts: PendingAlert[] = alertsSnap.docs.map(doc => ({
      docId: doc.id,
      ...(doc.data() as Omit<PendingAlert, 'docId'>),
    }));

    const alertsBySite = new Map<string, PendingAlert[]>();
    for (const alert of alerts) {
      const existing = alertsBySite.get(alert.siteId) ?? [];
      existing.push(alert);
      alertsBySite.set(alert.siteId, existing);
    }

    const resendClient = getResend();
    const baseUrl = publicOrigin(request);
    let emailsSent = 0;

    for (const [siteId, siteAlerts] of alertsBySite) {
      try {
        const recipients = await getSiteAlertRecipients(siteId, 'processAlerts');
        if (recipients.length === 0) {
          console.warn(`[cron/process-alerts] No recipients for site ${siteId}`);
          continue;
        }

        if (!resendClient) {
          console.warn('[cron/process-alerts] Resend not configured — skipping');
          continue;
        }

        // Display timezone comes from the first machine.
        const tz = await getMachineTimezone(siteId, siteAlerts[0].machineId);
        const siteLabel = await getSiteLabel(siteId);

        // Per-recipient, so each carries its own unsubscribe link.
        for (const recipient of recipients) {
          try {
            const userAlerts = siteAlerts.filter(a => recipientWantsMachine(recipient, a.machineId));
            if (userAlerts.length === 0) continue;

            const unsubscribeUrl = recipient.userId !== 'fallback'
              ? `${baseUrl}/api/unsubscribe?token=${generateUnsubscribeToken(recipient.userId)}`
              : undefined;

            const userSubject = userAlerts.length === 1
              ? `Process ${userAlerts[0].eventType === 'process_start_failed' ? 'failed to start' : 'crashed'}: ${userAlerts[0].processName} on ${userAlerts[0].machineId}`
              : `${userAlerts.length} process event(s) in ${siteLabel}`;

            const html = buildProcessDigestEmail(siteLabel, userAlerts, unsubscribeUrl, tz);

            const result = await resendClient.emails.send({
              from: FROM_EMAIL,
              to: [recipient.email],
              ...(recipient.ccEmails.length > 0 ? { cc: recipient.ccEmails } : {}),
              subject: safeEmailSubject(userSubject),
              html,
            });

            if (result.error) {
              console.error(`[cron/process-alerts] Resend error for ${recipient.email}:`, result.error);
            } else {
              emailsSent++;
            }
          } catch (emailError) {
            console.error(`[cron/process-alerts] Failed to send to ${recipient.email}:`, emailError);
          }
        }

        console.log(
          `[cron/process-alerts] Digest sent for site ${siteId}: ` +
          `${siteAlerts.length} event(s), ${recipients.length} recipient(s)`
        );
      } catch (error) {
        console.error(`[cron/process-alerts] Failed for site ${siteId}:`, error);
      }
    }

    // Firestore batch limit is 500.
    const docs = alertsSnap.docs;
    for (let i = 0; i < docs.length; i += 500) {
      const batch = db.batch();
      for (const doc of docs.slice(i, i + 500)) {
        batch.delete(doc.ref);
      }
      await batch.commit();
    }

    return NextResponse.json({
      ok: true,
      alertsProcessed: alerts.length,
      emailsSent,
      sites: alertsBySite.size,
    });
  } catch (error) {
    return apiError(error, 'cron/process-alerts');
  }
}
