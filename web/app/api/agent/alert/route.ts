import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import { getSiteAlertRecipients, getMachineTimezone, getSiteLabel, recipientWantsMachine } from '@/lib/adminUtils.server';
import { ENV_LABEL } from '@/lib/resendClient.server';
import {
  wrapEmailLayout,
  emailDataTable,
  emailTimestamp,
  EMAIL_COLORS,
  buildDisplayDigestEmail,
  safeEmailSubject,
  type PendingDisplayAlert,
} from '@/lib/emailTemplates.server';
import { alertEmailDelivery, displayDigestEvent, type DigestEvent } from '@/lib/alerts/digest.server';
import { sendAlertEmailNow } from '@/lib/alerts/sendNow.server';
import { withRateLimit } from '@/lib/withRateLimit';
import {
  checkRateLimit,
  processAlertRateLimit,
  getDisplayAlertRateLimit,
} from '@/lib/rateLimit';
import { fireWebhooks } from '@/lib/webhookSender.server';
import {
  DISPLAY_EVENT_ROUTING,
  isDisplayEventType,
} from '@/lib/alerts/displayEventRouting';
import { tapTalonMatcher } from '@/lib/talons/matcher.server';
import { apiError } from '@/lib/apiErrorResponse';
import { publicOrigin } from '@/lib/publicOrigin.server';
import { hootInternalSecret } from '@/lib/hootInternalSecret';
import { sanitizeForLog } from '@/lib/logSanitize';

/**
 * POST /api/agent/alert — agent-authenticated alert intake (connection
 * failures, process crash/start failures, display events).
 * Auth: `Authorization: Bearer <agent-firebase-id-token>`.
 * Rate limits: 5/hr per IP for every event, plus 3/hr per
 * `machineId:processName` for process alerts and one per `machineId:eventType`
 * per hour (four hours for drift) for display events.
 */

/** the `errorCode` the agent's reboot-pending check posts (`_check_and_alert_reboot_pending`). */
const REBOOT_PENDING_NOTICE = 'reboot_pending';

/** the digest row for a connection failure or a reboot-pending notice: each is posted once, so no source key */
function agentAlertDigestEvent(siteId: string, machineId: string, errorCode: string, errorMessage: string): DigestEvent {
  const notice = errorCode === REBOOT_PENDING_NOTICE;
  return {
    sourceKey: null,
    siteId,
    machineId,
    category: 'healthAlerts',
    kind: notice ? 'reboot_pending' : 'agent_error',
    severity: notice ? 'info' : 'critical',
    title: notice ? 'reboot pending' : 'agent error',
    detail: errorMessage,
    data: { errorCode },
    at: Date.now(),
  };
}

/** the email's wording: a pending reboot is a notice from a machine that is fine, not an agent error. */
function alertEmailCopy(errorCode: string) {
  return errorCode === REBOOT_PENDING_NOTICE
    ? {
        subject: '[owlette] reboot pending on',
        color: EMAIL_COLORS.amber,
        title: 'reboot pending',
        intro: 'an owlette agent reports that its machine is waiting for a reboot.',
        outro: 'nothing has failed. reboot the machine when it suits you.',
        showErrorCode: false,
      }
    : {
        subject: '[ALERT] owlette agent error on',
        color: EMAIL_COLORS.red,
        title: 'agent alert',
        intro: 'an error was detected on an owlette agent.',
        outro: 'please check the machine and service logs for more details.',
        showErrorCode: true,
      };
}

function buildAlertEmail(
  siteId: string,
  machineId: string,
  errorCode: string,
  errorMessage: string,
  agentVersion: string,
  unsubscribeUrl?: string,
  timezone?: string
): string {
  const copy = alertEmailCopy(errorCode);
  const content = `
    <h2 style="color:${copy.color};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">${copy.title}</h2>
    <p style="margin:0 0 20px;color:${EMAIL_COLORS.muted};">${copy.intro}</p>
    ${emailDataTable([
      { label: 'site', value: siteId },
      { label: 'machine', value: machineId },
      ...(copy.showErrorCode ? [{ label: 'error code', value: errorCode }] : []),
      { label: 'message', value: errorMessage },
      { label: 'agent version', value: agentVersion },
      { label: 'time', value: emailTimestamp(new Date(), timezone) },
      { label: 'environment', value: ENV_LABEL },
    ])}
    <p style="margin:20px 0 0;color:${EMAIL_COLORS.muted};font-size:13px;">${copy.outro}</p>
  `;
  return wrapEmailLayout(content, { unsubscribeUrl });
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      const authHeader = request.headers.get('Authorization') || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

      if (!token) {
        return NextResponse.json({ error: 'Missing Authorization header' }, { status: 401 });
      }

      let decodedToken;
      try {
        const adminAuth = getAdminAuth();
        decodedToken = await adminAuth.verifyIdToken(token);
      } catch {
        return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
      }

      if (decodedToken.role !== 'agent') {
        return NextResponse.json({ error: 'Forbidden — agent token required' }, { status: 403 });
      }

      const body = await request.json() as Record<string, unknown>;
      const siteId = readString(body.siteId);
      const machineId = readString(body.machineId);
      const errorCode = readString(body.errorCode);
      const errorMessage = readString(body.errorMessage);
      const agentVersion = readString(body.agentVersion);
      const eventType = readString(body.eventType);
      const processName = readString(body.processName);
      const alertData = readRecord(body.data);
      const resolvedProcessName =
        processName ||
        readString(alertData.process_name) ||
        readString(alertData.processName);
      const resolvedErrorMessage =
        errorMessage ||
        readString(alertData.error_message) ||
        readString(alertData.errorMessage);

      // Defaults to connection_failure — pre-eventType agents omit the field.
      const resolvedEventType = eventType || 'connection_failure';
      const isProcessEvent = resolvedEventType === 'process_crash' || resolvedEventType === 'process_start_failed';
      const isExeMissingEvent = resolvedEventType === 'exe_missing';
      // Display events route through `DISPLAY_EVENT_ROUTING`, not the legacy
      // email-immediate / process-digest branches.
      const isDisplayEvent =
        typeof resolvedEventType === 'string' &&
        resolvedEventType.startsWith('display_') &&
        isDisplayEventType(resolvedEventType);
      const isGenericDataEvent =
        !!eventType &&
        !isProcessEvent &&
        !isDisplayEvent &&
        !isExeMissingEvent &&
        Object.keys(alertData).length > 0;
      const displayData: Record<string, unknown> =
        isDisplayEvent ? alertData : {};

      if (!siteId || !machineId) {
        return NextResponse.json(
          { error: 'Missing required fields: siteId, machineId' },
          { status: 400 }
        );
      }

      if (!isProcessEvent && !isDisplayEvent && !isExeMissingEvent && !isGenericDataEvent && !errorCode) {
        return NextResponse.json(
          { error: 'Missing required field: errorCode (for connection_failure events)' },
          { status: 400 }
        );
      }

      if (isProcessEvent && !resolvedProcessName) {
        return NextResponse.json(
          { error: 'Missing required field: processName (for process events)' },
          { status: 400 }
        );
      }

      // Token's site_id must match the claimed siteId.
      if (decodedToken.site_id && decodedToken.site_id !== siteId) {
        console.warn(
          `[agent/alert] site_id mismatch: token=${decodedToken.site_id}, body=${sanitizeForLog(siteId)}`
        );
        return NextResponse.json({ error: 'site_id mismatch' }, { status: 403 });
      }

      if (decodedToken.machine_id !== machineId) {
        console.warn(
          `[agent/alert] machine_id mismatch: token=${decodedToken.machine_id}, body=${sanitizeForLog(machineId)}`
        );
        return NextResponse.json({ error: 'machine_id_mismatch' }, { status: 403 });
      }

      // Per-process limit, separate from the IP-based limiter.
      if (isProcessEvent && processAlertRateLimit) {
        const processRateLimitKey = `process_alert:${machineId}:${resolvedProcessName}`;
        const processRateResult = await checkRateLimit(processAlertRateLimit, processRateLimitKey);
        if (!processRateResult.success) {
          console.warn(`[agent/alert] Process alert rate limited: ${sanitizeForLog(processRateLimitKey)}`);
          return NextResponse.json({
            success: true,
            emailSent: false,
            reason: 'Process alert rate limited (3/hr per process per machine)',
          });
        }
      }

      const db = getAdminDb();

      // Talon tap sits here, not after routing: every branch below returns its
      // own response, so there is no shared exit. Above this line is only
      // auth/validation/rate-limiting. Fire-and-forget by contract.
      //
      // SINGLE SOURCE: display events are excluded on purpose —
      // `functions/src/talonLogEvents.ts` already fires them off the agent's
      // `sites/{siteId}/logs` write. Tapping here too double-fires. Do not
      // "restore" this.
      if (!isDisplayEvent) {
        tapTalonMatcher(db, siteId, { kind: 'event', eventType: resolvedEventType, machineId });
      }

      // `suppressAlert` (agent-stamped when the event fires within 90s of a
      // successful apply) skips email but STILL fires the webhook — receivers
      // dedupe themselves and the audit trail stays complete. `criticalPath`
      // events bypass the 3-min digest and email inline.
      if (isDisplayEvent) {
        const route = DISPLAY_EVENT_ROUTING[resolvedEventType];
        const suppressAlert = displayData.suppressAlert === true;
        const correlatedApplyId =
          typeof displayData.correlatedApplyId === 'string'
            ? displayData.correlatedApplyId
            : '';

        // Per-(machineId, eventType) rate limit — drift gets 4h, others 1h.
        const displayLimiter = getDisplayAlertRateLimit(resolvedEventType);
        if (displayLimiter) {
          const rateLimitKey = `display_alert:${machineId}:${resolvedEventType}`;
          const rateResult = await checkRateLimit(displayLimiter, rateLimitKey);
          if (!rateResult.success) {
            console.warn(
              `[agent/alert] Display alert rate limited: ${rateLimitKey}`,
            );
            return NextResponse.json({
              success: true,
              emailSent: false,
              webhookFired: false,
              reason: 'Display alert rate limited',
            });
          }
        }

        // Critical-path sends inline; everything else queues to the digest cron.
        let queuedForEmail = false;
        let immediateEmailsSent = 0;
        let digested = 0;
        if (route.email && !suppressAlert) {
          if (route.criticalPath) {
            ({ sent: immediateEmailsSent, queued: digested } = await deliverCriticalDisplayEmail({
              siteId,
              machineId,
              eventType: resolvedEventType,
              data: displayData,
              agentVersion: agentVersion || '',
              correlatedApplyId,
              baseUrl: publicOrigin(request),
            }));
          } else {
            await db.collection('pending_display_alerts').add({
              siteId,
              machineId,
              eventType: resolvedEventType,
              data: displayData,
              agentVersion: agentVersion || '',
              correlatedApplyId,
              timestamp: FieldValue.serverTimestamp(),
            });
            queuedForEmail = true;
          }
        }

        // Fires even when suppressAlert is set — receivers still see activity.
        let webhookFired = false;
        if (route.webhook) {
          const siteDoc = await db.collection('sites').doc(siteId).get();
          const siteName = siteDoc.data()?.name || siteId;
          fireWebhooks(siteId, siteName, route.webhookEventName, {
            machine: { id: machineId, name: machineId },
            ...displayData,
          }).catch(console.error);
          webhookFired = true;
        }

        console.log(
          `[agent/alert] Display ${sanitizeForLog(resolvedEventType)} on ${sanitizeForLog(machineId)} (${sanitizeForLog(siteId)}): ` +
          `email=${queuedForEmail ? 'queued' : immediateEmailsSent > 0 ? `inline:${immediateEmailsSent}` : digested > 0 ? `digest:${digested}` : 'no'} ` +
          `webhook=${webhookFired} suppressed=${suppressAlert}`,
        );
        return NextResponse.json({
          success: true,
          emailSent: immediateEmailsSent > 0,
          emailsSent: immediateEmailsSent,
          queued: queuedForEmail,
          digested,
          webhookFired,
          suppressed: suppressAlert,
          criticalPath: !!route.criticalPath,
        });
      }

      if (isExeMissingEvent) {
        const exePath =
          readString(alertData.exe_path) ||
          readString(alertData.exePath) ||
          resolvedErrorMessage;
        if (!exePath) {
          return NextResponse.json(
            { error: 'Missing required field: data.exe_path (for exe_missing events)' },
            { status: 400 },
          );
        }

        const processId =
          readString(alertData.process_id) ||
          readString(alertData.processId);
        const suggestedPaths = [
          ...readStringArray(alertData.suggested_paths),
          ...readStringArray(alertData.suggestedPaths),
        ].slice(0, 5);

        const logPayload: Record<string, unknown> = {
          timestamp: FieldValue.serverTimestamp(),
          action: 'exe_missing',
          level: 'error',
          machineId,
          machineName: machineId,
          processName: resolvedProcessName || 'unknown process',
          details: exePath,
          eventType: resolvedEventType,
          exePath,
          suggestedPaths,
          agentVersion,
        };
        if (processId) logPayload.processId = processId;

        await db.collection('sites').doc(siteId).collection('logs').add(logPayload);

        console.log(
          `[agent/alert] Executable missing for ${resolvedProcessName || processId || 'unknown process'} ` +
          `on ${sanitizeForLog(machineId)} (${sanitizeForLog(siteId)})`,
        );
        return NextResponse.json({ success: true, logged: true });
      }

      if (isGenericDataEvent) {
        await db.collection('sites').doc(siteId).collection('logs').add({
          timestamp: FieldValue.serverTimestamp(),
          action: resolvedEventType,
          level: 'error',
          machineId,
          machineName: machineId,
          details: resolvedErrorMessage || readString(alertData.message),
          eventType: resolvedEventType,
          data: alertData,
          agentVersion,
        });

        console.log(`[agent/alert] Generic ${sanitizeForLog(resolvedEventType)} on ${sanitizeForLog(machineId)} (${sanitizeForLog(siteId)})`);
        return NextResponse.json({ success: true, logged: true });
      }

      const webhookEvent = resolvedEventType === 'process_crash' ? 'process.crashed'
        : resolvedEventType === 'process_start_failed' ? 'process.restarted'
        : 'machine.offline';

      // Process events: queue for the batched digest email.
      if (isProcessEvent) {
        await db.collection('pending_process_alerts').add({
          siteId,
          machineId,
          processName: resolvedProcessName,
          errorMessage: resolvedErrorMessage || 'Process exited unexpectedly',
          agentVersion,
          eventType: resolvedEventType,
          timestamp: FieldValue.serverTimestamp(),
        });

        console.log(`[agent/alert] Queued process alert: ${sanitizeForLog(resolvedEventType)} - ${sanitizeForLog(resolvedProcessName)} on ${sanitizeForLog(machineId)} (${sanitizeForLog(siteId)})`);

        const siteDoc = await db.collection('sites').doc(siteId).get();
        const siteName = siteDoc.data()?.name || siteId;
        fireWebhooks(siteId, siteName, webhookEvent, {
          machine: { id: machineId, name: machineId },
          process: { name: resolvedProcessName, error: resolvedErrorMessage || '' },
        }).catch(console.error);

        const localHootRunning = await isLocalHootRunning(db, siteId, machineId);
        if (localHootRunning) {
          console.log(`[agent/alert] Local Hoot is running on ${sanitizeForLog(machineId)} — skipping server-side investigation`);
        } else {
          triggerAutonomousHoot(db, {
            siteId,
            machineId,
            machineName: machineId,
            eventType: resolvedEventType,
            processName: resolvedProcessName,
            errorMessage: resolvedErrorMessage || '',
            agentVersion,
          }).catch(err => console.error('[agent/alert] Hoot trigger failed:', err));
        }

        return NextResponse.json({ success: true, queued: true });
      }

      // before the email, which has two early exits below: a site that routes
      // this alert to a webhook must hear about it with no email recipients.
      // not for a reboot-pending notice, which rides this branch with no
      // eventType: that machine is online and saying it has a restart pending,
      // so it keeps its email and is no machine.offline.
      if (errorCode !== REBOOT_PENDING_NOTICE) {
        const siteDoc = await db.collection('sites').doc(siteId).get();
        const siteName = siteDoc.data()?.name || siteId;
        fireWebhooks(siteId, siteName, webhookEvent, {
          machine: { id: machineId, name: machineId },
        }).catch(console.error);
      }

      // Connection failures email immediately, or queue for each recipient's digest.
      const [recipients, tz] = await Promise.all([
        getSiteAlertRecipients(siteId, 'healthAlerts'),
        getMachineTimezone(siteId, machineId),
      ]);

      if (recipients.length === 0) {
        console.warn(`[agent/alert] No recipients found for site ${sanitizeForLog(siteId)}`);
        return NextResponse.json({ success: true, emailSent: false, reason: 'No recipients' });
      }

      const subject = safeEmailSubject(`${alertEmailCopy(errorCode).subject} ${machineId}`);
      const baseUrl = publicOrigin(request);
      const digestEvent = agentAlertDigestEvent(siteId, machineId, errorCode, errorMessage || '');
      const delivery = alertEmailDelivery();
      let emailsSent = 0;
      let digested = 0;

      for (const recipient of recipients) {
        // Honor per-machine mutes and machine scope (mirrors the critical-display loop).
        if (!recipientWantsMachine(recipient, machineId)) continue;
        try {
          const outcome = await delivery.deliver(recipient, [digestEvent], () =>
            sendAlertEmailNow({
              log: '[agent/alert]',
              recipient,
              baseUrl,
              subject,
              html: (unsubscribeUrl) => buildAlertEmail(siteId, machineId, errorCode, errorMessage || '', agentVersion, unsubscribeUrl, tz),
            }),
          );
          if (outcome === 'sent') emailsSent++;
          else if (outcome === 'queued') digested++;
        } catch (emailError) {
          console.error(`[agent/alert] Failed to send to ${sanitizeForLog(recipient.email)}:`, emailError);
        }
      }

      console.log(`[agent/alert] Alert handled for ${sanitizeForLog(machineId)} (${sanitizeForLog(siteId)}): ${sanitizeForLog(resolvedEventType)}, ${emailsSent} sent, ${digested} queued of ${recipients.length} recipient(s)`);

      return NextResponse.json({ success: true, emailSent: emailsSent > 0, recipients: emailsSent, digested });
    } catch (error: unknown) {
      return apiError(error, 'agent/alert');
    }
  },
  { strategy: 'agentAlert', identifier: 'ip' }
);

/** True when local Hoot has a heartbeat within 30s. */
async function isLocalHootRunning(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineId: string,
): Promise<boolean> {
  try {
    const machineDoc = await db
      .collection('sites')
      .doc(siteId)
      .collection('machines')
      .doc(machineId)
      .get();

    if (!machineDoc.exists) return false;

    // Wire field `machines/{id}.cortexStatus` keeps its legacy spelling — the
    // agent writes it.
    const hootStatus = machineDoc.data()?.cortexStatus;
    if (!hootStatus?.online) return false;

    const lastHeartbeat = hootStatus.lastHeartbeat;
    if (!lastHeartbeat) return false;

    const heartbeatTime = lastHeartbeat.toDate
      ? lastHeartbeat.toDate().getTime()
      : new Date(lastHeartbeat).getTime();

    return Date.now() - heartbeatTime < 30_000;
  } catch {
    return false;
  }
}

/** Fire a non-blocking autonomous Hoot investigation if the site enabled it. */
async function triggerAutonomousHoot(
  db: FirebaseFirestore.Firestore,
  params: {
    siteId: string;
    machineId: string;
    machineName: string;
    eventType: string;
    processName: string;
    errorMessage: string;
    agentVersion: string;
  }
) {
  const secret = hootInternalSecret();
  if (!secret) return; // Not configured — autonomous mode unavailable

  const settingsDoc = await db.doc(`sites/${params.siteId}/settings/cortex`).get();
  if (!settingsDoc.exists || !settingsDoc.data()?.autonomousEnabled) return;

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://owlette.app';

  // Fire and forget.
  fetch(`${baseUrl}/api/hoot/autonomous`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-cortex-secret': secret,
    },
    body: JSON.stringify(params),
  }).catch(err => console.error('[agent/alert] Autonomous Hoot request failed:', err));
}

/**
 * Deliver one critical-path display alert without the 3-minute drain —
 * `display_monitor_removed` / `display_auto_revert_fired` can't wait minutes —
 * inline to each recipient on `immediate`, into the digest for the rest. Shares
 * `buildDisplayDigestEmail` with the cron path so the layout is identical, and
 * honors mutes, machine scope and unsubscribe links the same way.
 */
async function deliverCriticalDisplayEmail(params: {
  siteId: string;
  machineId: string;
  eventType: string;
  data: Record<string, unknown>;
  agentVersion: string;
  correlatedApplyId: string;
  baseUrl: string;
}): Promise<{ sent: number; queued: number }> {
  const { siteId, machineId, eventType, data, agentVersion, correlatedApplyId, baseUrl } = params;

  const [recipients, tz] = await Promise.all([
    getSiteAlertRecipients(siteId, 'displayAlerts'),
    getMachineTimezone(siteId, machineId),
  ]);
  if (recipients.length === 0) return { sent: 0, queued: 0 };

  // Synthetic single-alert payload mirroring the digest path's queue-write
  // shape, so the template can't tell the two routes apart.
  const alert: PendingDisplayAlert = {
    docId: `inline-${Date.now()}`,
    siteId,
    machineId,
    eventType,
    data,
    agentVersion,
    correlatedApplyId,
    timestamp: new Date(),
  };

  const siteLabel = await getSiteLabel(siteId);
  const digestEvent = displayDigestEvent(alert, null);
  const subject = safeEmailSubject(`[owlette] critical display alert on ${machineId}`);
  const delivery = alertEmailDelivery();
  let sent = 0;
  let queued = 0;
  for (const recipient of recipients) {
    try {
      // Critical-path bypass must not override the operator's mute or machine scope.
      if (!recipientWantsMachine(recipient, machineId)) continue;

      const outcome = await delivery.deliver(recipient, [digestEvent], () =>
        sendAlertEmailNow({
          log: '[agent/alert]',
          recipient,
          baseUrl,
          subject,
          html: (unsubscribeUrl) => buildDisplayDigestEmail(siteLabel, [alert], unsubscribeUrl, tz),
        }),
      );
      if (outcome === 'sent') sent++;
      else if (outcome === 'queued') queued++;
    } catch (e) {
      console.error(`[agent/alert] Failed to send critical display email to ${sanitizeForLog(recipient.email)}:`, e);
    }
  }
  console.log(
    `[agent/alert] Critical display alert: ${eventType} on ${sanitizeForLog(machineId)} → ${sent} sent, ${queued} queued of ${recipients.length} recipients`,
  );
  return { sent, queued };
}
