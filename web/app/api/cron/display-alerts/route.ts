import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { getSiteAlertRecipients, getMachineTimezone, getSiteLabel, recipientWantsMachine } from '@/lib/adminUtils.server';
import { getResend, FROM_EMAIL } from '@/lib/resendClient.server';
import {
  buildDisplayDigestEmail,
  safeEmailSubject,
  type PendingDisplayAlert,
} from '@/lib/emailTemplates.server';
import { generateUnsubscribeToken } from '@/app/api/unsubscribe/route';
import { apiError } from '@/lib/apiErrorResponse';
import { publicOrigin } from '@/lib/publicOrigin.server';

/**
 * GET /api/cron/display-alerts
 *
 * HTTP cron endpoint (cron-job.org) that drains the `pending_display_alerts` queue
 * and sends batched digest emails grouped by site.
 *
 * Alerts are held for ACCUMULATION_WINDOW_MS so a burst (a video-wall power
 * blip emits ~9 events in a minute) becomes one email per site.
 *
 * Authentication: X-Cron-Secret header must match CRON_SECRET env var.
 *
 * cron-job.org config (NOT Railway — register once per environment):
 *   Schedule:  * /3 * * * *   (every 3 minutes — matches process-alerts)
 *   URL:       GET https://<your-app>/api/cron/display-alerts
 *   Header:    X-Cron-Secret: <that environment's CRON_SECRET>
 *
 * `display_monitor_removed` and `display_auto_revert_fired` bypass the digest
 * and email inline from `/api/agent/alert` for a sub-minute alert.
 */

// Only drain alerts older than this, so a burst accumulates into one digest.
const ACCUMULATION_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

export async function GET(request: NextRequest) {
  const cronSecret = request.headers.get('x-cron-secret');
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getAdminDb();
  const cutoff = new Date(Date.now() - ACCUMULATION_WINDOW_MS);

  try {
    const alertsSnap = await db
      .collection('pending_display_alerts')
      .where('timestamp', '<=', cutoff)
      .get();

    if (alertsSnap.empty) {
      return NextResponse.json({ ok: true, alertsProcessed: 0 });
    }

    const alerts: PendingDisplayAlert[] = alertsSnap.docs.map((doc) => {
      const raw = doc.data() as Omit<PendingDisplayAlert, 'docId'>;
      return {
        docId: doc.id,
        ...raw,
      };
    });

    const alertsBySite = new Map<string, PendingDisplayAlert[]>();
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
        // `displayAlerts` opt-outs get no digest, but their queue entries are
        // still drained alongside everyone else's.
        const recipients = await getSiteAlertRecipients(siteId, 'displayAlerts');
        if (recipients.length === 0) {
          console.warn(`[cron/display-alerts] No recipients for site ${siteId}`);
          continue;
        }

        if (!resendClient) {
          console.warn('[cron/display-alerts] Resend not configured — skipping');
          continue;
        }

        // Display timezone comes from the first machine.
        const tz = await getMachineTimezone(siteId, siteAlerts[0].machineId);
        const siteLabel = await getSiteLabel(siteId);

        // Per-recipient so each carries its own unsubscribe link.
        for (const recipient of recipients) {
          try {
            // Per-user mutes and machine scope; an empty result skips the send.
            const userAlerts = siteAlerts.filter(
              (a) => recipientWantsMachine(recipient, a.machineId),
            );
            if (userAlerts.length === 0) continue;

            const unsubscribeUrl = recipient.userId !== 'fallback'
              ? `${baseUrl}/api/unsubscribe?token=${generateUnsubscribeToken(recipient.userId)}`
              : undefined;

            // One alert → a focused subject; otherwise count + site, for triage.
            const userSubject = userAlerts.length === 1
              ? `[owlette] display event on ${userAlerts[0].machineId}`
              : `[owlette] ${userAlerts.length} display event(s) in ${siteLabel}`;

            const html = buildDisplayDigestEmail(siteLabel, userAlerts, unsubscribeUrl, tz);

            const result = await resendClient.emails.send({
              from: FROM_EMAIL,
              to: [recipient.email],
              ...(recipient.ccEmails.length > 0 ? { cc: recipient.ccEmails } : {}),
              subject: safeEmailSubject(userSubject),
              html,
            });

            if (result.error) {
              console.error(`[cron/display-alerts] Resend error for ${recipient.email}:`, result.error);
            } else {
              emailsSent++;
            }
          } catch (emailError) {
            console.error(`[cron/display-alerts] Failed to send to ${recipient.email}:`, emailError);
          }
        }

        console.log(
          `[cron/display-alerts] Digest sent for site ${siteId}: ` +
          `${siteAlerts.length} event(s), ${recipients.length} recipient(s)`,
        );
      } catch (error) {
        console.error(`[cron/display-alerts] Failed for site ${siteId}:`, error);
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
    return apiError(error, 'cron/display-alerts');
  }
}
