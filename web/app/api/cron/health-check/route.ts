import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { getSiteAlertRecipients, getSiteLabel } from '@/lib/adminUtils.server';
import { getResend, FROM_EMAIL } from '@/lib/resendClient.server';
import { wrapEmailLayout, EMAIL_COLORS, emailTimestamp, escapeHtml, safeEmailSubject } from '@/lib/emailTemplates.server';
import { generateUnsubscribeToken } from '@/app/api/unsubscribe/route';
import { fireWebhooks } from '@/lib/webhookSender.server';
import { tapTalonMatcher } from '@/lib/talons/matcher.server';
import { createPlanMemo } from '@/lib/planPause.server';
import { apiError } from '@/lib/apiErrorResponse';
import { publicOrigin } from '@/lib/publicOrigin.server';

/**
 * GET /api/cron/health-check — scans machines for stale heartbeats and emails
 * site admins. Auth: X-Cron-Secret must equal CRON_SECRET. Dedupe:
 * health.lastCronAlertAt suppresses repeats within ALERT_COOLDOWN_MS.
 *
 * Runs on cron-job.org, NOT Railway — register once per environment:
 *   * /5 * * * *  GET https://<app>/api/cron/health-check
 *   Header: X-Cron-Secret: <that environment's CRON_SECRET>
 */

// Clear of the agent's 120s idle heartbeat cadence so two missed beats don't trip
// it — at 3 minutes one slow tick marked healthy machines stale.
const OFFLINE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// Don't re-alert for the same machine within this window
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// Suppresses alerts inside an announced reboot/shutdown window. Requires BOTH the
// agent's boolean (`rebooting`/`shuttingDown`) AND its target instant
// (`rebootScheduledAt`/`shutdownScheduledAt`, Unix seconds) within ±grace of now.
// Bounding both sides: a stuck boolean + clock-skewed far-future instant can't
// suppress a real outage forever, and a stale instant left by a cancel can't either.
const PLANNED_DOWNTIME_GRACE_MS = 15 * 60 * 1000; // 15 minutes, applied symmetrically

// Debounce: require the machine still stale this long after first observed stale,
// so a transient gap in the 120s heartbeat cadence never pages.
const STALE_CONFIRM_MS = OFFLINE_THRESHOLD_MS; // ~one extra cron interval of confirmed staleness

// Site-level settling window: a confirmed-offline machine joins the site's pending
// set and the consolidated alert only fires once that set stops GROWING for this
// long, so a staggered shutdown coalesces into ONE full-count email. Cron interval
// plus margin; costs ~one extra interval of latency on the first alert.
const SETTLE_MS = 7 * 60 * 1000; // 7 minutes (cron interval + margin)

// Graceful shutdowns (online:false) with a heartbeat this recent show as context in
// the email — recent enough to be this outage, not a box powered down days ago.
const RECENT_SHUTDOWN_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours

function timestampToMillis(value: unknown): number {
  return (value as FirebaseFirestore.Timestamp | null)?.toMillis?.() ?? 0;
}

function unixSecondsOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export interface MachineHealthSnapshot {
  online: boolean;
  lastHeartbeatMs: number;
  lastCronAlertAtMs: number;
  staleSinceMs: number;
  rebooting: boolean;
  shuttingDown: boolean;
  rebootScheduledAtSec: number; // Unix seconds, 0 when unset
  shutdownScheduledAtSec: number; // Unix seconds, 0 when unset
}

/**
 * Inside an announced reboot/shutdown window: in-progress boolean AND target
 * instant within ±PLANNED_DOWNTIME_GRACE_MS of `now`.
 */
function plannedDowntimeActive(inProgress: boolean, scheduledAtSec: number, now: number): boolean {
  if (inProgress !== true || scheduledAtSec <= 0) return false;
  const scheduledAtMs = scheduledAtSec * 1000;
  return (
    now >= scheduledAtMs - PLANNED_DOWNTIME_GRACE_MS &&
    now < scheduledAtMs + PLANNED_DOWNTIME_GRACE_MS
  );
}

/**
 * Which reboot/shutdown latches are stale (window elapsed past grace, flag still
 * set). Nobody else can clear them — a completed shutdown is powered off and a
 * failed reboot never returns — so the status pill would pulse forever. Each flag
 * is judged against its own window; anchored on `scheduledAt`, not heartbeat, so a
 * just-set latch is never cleared prematurely.
 */
export function stalePlannedDowntime(
  m: MachineHealthSnapshot,
  now: number
): { clearShutdown: boolean; clearReboot: boolean } {
  const elapsed = (inProgress: boolean, scheduledAtSec: number) =>
    inProgress === true &&
    scheduledAtSec > 0 &&
    now >= scheduledAtSec * 1000 + PLANNED_DOWNTIME_GRACE_MS;
  return {
    clearShutdown: elapsed(m.shuttingDown, m.shutdownScheduledAtSec),
    clearReboot: elapsed(m.rebooting, m.rebootScheduledAtSec),
  };
}

export type HealthDecision =
  | { action: 'ok' } // online + fresh heartbeat — clear any stale marker
  | { action: 'ignore'; reason: 'offline-flag' | 'planned-downtime' | 'cooldown' }
  | { action: 'debounce' } // stale but not yet confirmed — record staleSince, don't alert yet
  | { action: 'alert'; heartbeatAgeMinutes: number };

/** Pure per-machine offline decision; the GET handler maps it to writes/emails. */
export function classifyMachineHealth(m: MachineHealthSnapshot, now: number): HealthDecision {
  // Only machines the agent last reported online can transition to "offline".
  if (m.online !== true) return { action: 'ignore', reason: 'offline-flag' };

  const heartbeatAge = now - m.lastHeartbeatMs;
  if (heartbeatAge <= OFFLINE_THRESHOLD_MS) return { action: 'ok' };

  // Announced reboot/shutdown plausibly happening right now — don't page.
  if (
    plannedDowntimeActive(m.rebooting, m.rebootScheduledAtSec, now) ||
    plannedDowntimeActive(m.shuttingDown, m.shutdownScheduledAtSec, now)
  ) {
    return { action: 'ignore', reason: 'planned-downtime' };
  }

  // Already alerted within the cooldown window.
  if (now - m.lastCronAlertAtMs <= ALERT_COOLDOWN_MS) {
    return { action: 'ignore', reason: 'cooldown' };
  }

  // Debounce: require sustained staleness across scans before paging.
  if (m.staleSinceMs <= 0 || now - m.staleSinceMs < STALE_CONFIRM_MS) {
    return { action: 'debounce' };
  }

  return { action: 'alert', heartbeatAgeMinutes: Math.floor(heartbeatAge / 60000) };
}

// Confirmed not-responding this scan. `ref` is retained so the per-machine
// cooldown stamp can be written at send time.
interface PendingMachine {
  machineId: string;
  ref: FirebaseFirestore.DocumentReference;
  lastHeartbeatMs: number;
  heartbeatAgeMinutes: number;
  timezone?: string;
}

// A single machine row rendered in one of the offline email's sections.
interface OfflineRow {
  machineId: string;
  heartbeatAgeMinutes: number;
}

// The three buckets describing a site's full offline picture, so the email's
// count always reconciles.
interface OfflineSections {
  notResponding: OfflineRow[]; // confirmed stale with no shutdown announcement — the page trigger
  shuttingDown: OfflineRow[]; // online:false with a recent heartbeat — graceful, context only
  stillOffline: OfflineRow[]; // stale but inside their per-machine re-alert cooldown — context only
}

// A settled per-site alert, queued during the scan phase and emailed afterwards.
interface SendPlan {
  siteId: string;
  siteName: string;
  sections: OfflineSections;
  webhookMachines: { machineId: string; lastHeartbeatMs: number }[];
  timezone?: string;
}

function heartbeatAgeMinutes(lastHeartbeatMs: number, now: number): number {
  if (lastHeartbeatMs <= 0) return 0;
  return Math.max(0, Math.floor((now - lastHeartbeatMs) / 60000));
}

function offlineRowsHtml(rows: OfflineRow[]): string {
  return rows
    .map(
      (r) => `
      <tr>
        <td style="padding:10px 14px;color:${EMAIL_COLORS.text};border-bottom:1px solid ${EMAIL_COLORS.border};font-size:13px;">${escapeHtml(r.machineId)}</td>
        <td style="padding:10px 14px;color:${EMAIL_COLORS.muted};border-bottom:1px solid ${EMAIL_COLORS.border};font-size:13px;">${r.heartbeatAgeMinutes} minute(s) ago</td>
      </tr>`
    )
    .join('');
}

function offlineSectionHtml(label: string, description: string, accent: string, rows: OfflineRow[]): string {
  if (rows.length === 0) return '';
  return `
    <p style="margin:22px 0 6px;color:${accent};font-size:13px;font-weight:700;text-transform:lowercase;">${label} (${rows.length})</p>
    <p style="margin:0 0 10px;color:${EMAIL_COLORS.muted};font-size:12px;">${description}</p>
    <table width="100%" style="border-collapse:collapse;border:1px solid ${EMAIL_COLORS.border};border-radius:6px;overflow:hidden;" cellpadding="0" cellspacing="0">
      <thead>
        <tr>
          <th style="padding:10px 14px;text-align:left;background:${EMAIL_COLORS.altRow};color:${EMAIL_COLORS.muted};font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid ${EMAIL_COLORS.border};">machine</th>
          <th style="padding:10px 14px;text-align:left;background:${EMAIL_COLORS.altRow};color:${EMAIL_COLORS.muted};font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid ${EMAIL_COLORS.border};">last seen</th>
        </tr>
      </thead>
      <tbody>${offlineRowsHtml(rows)}</tbody>
    </table>`;
}

/**
 * Consolidated offline email for a site. The caller's subject count must match the
 * total listed here (page trigger + both context buckets).
 */
function buildOfflineEmail(
  siteLabel: string,
  sections: OfflineSections,
  timezone?: string,
  unsubscribeUrl?: string
): string {
  const total = sections.notResponding.length + sections.shuttingDown.length + sections.stillOffline.length;

  const content = `
    <h2 style="color:${EMAIL_COLORS.red};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">machines offline</h2>
    <p style="margin:0 0 4px;color:${EMAIL_COLORS.muted};">${total} machine(s) in site <strong style="color:${EMAIL_COLORS.text};">${escapeHtml(siteLabel)}</strong> are offline or not responding.</p>
    ${offlineSectionHtml('not responding', 'no heartbeat received — these machines may have crashed or lost their connection.', EMAIL_COLORS.red, sections.notResponding)}
    ${offlineSectionHtml('reported shutting down', 'the agent announced a shutdown before going offline.', EMAIL_COLORS.amber, sections.shuttingDown)}
    ${offlineSectionHtml('still offline', 'already alerted earlier and still not responding.', EMAIL_COLORS.muted, sections.stillOffline)}
    <p style="margin:20px 0 0;color:${EMAIL_COLORS.muted};font-size:13px;">please check each machine and verify that the owlette service is running.</p>
    <p style="margin:8px 0 0;color:${EMAIL_COLORS.border};font-size:11px;">checked at ${emailTimestamp(new Date(), timezone)}</p>
    <p style="margin:8px 0 0;color:${EMAIL_COLORS.border};font-size:11px;">alerts are sent at most once per hour per machine.</p>
  `;

  return wrapEmailLayout(content, {
    unsubscribeUrl,
    preheader: `${total} machine(s) offline in ${siteLabel}`,
  });
}

/** Drop muted machines from every section; caller skips a now-empty page trigger. */
function filterSectionsForRecipient(sections: OfflineSections, mutedMachines: string[]): OfflineSections {
  if (mutedMachines.length === 0) return sections;
  const muted = new Set(mutedMachines);
  const keep = (r: OfflineRow) => !muted.has(r.machineId);
  return {
    notResponding: sections.notResponding.filter(keep),
    shuttingDown: sections.shuttingDown.filter(keep),
    stillOffline: sections.stillOffline.filter(keep),
  };
}

/**
 * Merge-write health.offlineAlert. Own try/catch so a failed site write logs and
 * the run continues; `merge:true` deep-merges, leaving the rest of health.* alone.
 */
async function writeSiteOfflineState(
  ref: FirebaseFirestore.DocumentReference,
  siteId: string,
  opts: {
    pendingIds?: string[];
    bumpPendingUpdatedAt?: boolean;
    clearPendingUpdatedAt?: boolean;
    setLastAlertAt?: boolean;
  }
): Promise<void> {
  const offlineAlert: Record<string, unknown> = {};
  if (opts.pendingIds !== undefined) offlineAlert.pendingIds = opts.pendingIds;
  if (opts.bumpPendingUpdatedAt) offlineAlert.pendingUpdatedAt = FieldValue.serverTimestamp();
  else if (opts.clearPendingUpdatedAt) offlineAlert.pendingUpdatedAt = FieldValue.delete();
  if (opts.setLastAlertAt) offlineAlert.lastAlertAt = FieldValue.serverTimestamp();

  try {
    await ref.set({ health: { offlineAlert } }, { merge: true });
  } catch (error) {
    console.error(`[cron/health-check] Failed to persist offline state for site ${siteId}:`, error);
  }
}

export async function GET(request: NextRequest) {
  const cronSecret = request.headers.get('x-cron-secret');
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getAdminDb();
  const now = Date.now();
  const sendPlans: SendPlan[] = [];
  let sitesChecked = 0;
  let machinesChecked = 0;
  let offlineMachines = 0;

  try {
    const sitesSnap = await db.collection('sites').get();
    sitesChecked = sitesSnap.size;

    for (const siteDoc of sitesSnap.docs) {
      const siteId = siteDoc.id;
      const siteData = siteDoc.data();

      const machinesSnap = await db
        .collection('sites')
        .doc(siteId)
        .collection('machines')
        .get();

      machinesChecked += machinesSnap.size;

      // Buckets for this site: the page trigger plus the two context sections.
      const notResponding: PendingMachine[] = [];
      const shuttingDown: OfflineRow[] = [];
      const stillOffline: OfflineRow[] = [];

      for (const machineDoc of machinesSnap.docs) {
        const machine = machineDoc.data();

        const lastHeartbeatMs = timestampToMillis(machine.lastHeartbeat);
        const staleSinceMs = timestampToMillis(machine.health?.staleSince);
        // IANA name only — Intl rejects the sibling Windows registry name, which
        // would silently fall back to UTC in emailTimestamp.
        const timezone = machine.machine_timezone_iana || machine.machine_timezone || undefined;

        const snapshot: MachineHealthSnapshot = {
          online: machine.online === true,
          lastHeartbeatMs,
          lastCronAlertAtMs: timestampToMillis(machine.health?.lastCronAlertAt),
          staleSinceMs,
          rebooting: machine.rebooting === true,
          shuttingDown: machine.shuttingDown === true,
          rebootScheduledAtSec: unixSecondsOrZero(machine.rebootScheduledAt),
          shutdownScheduledAtSec: unixSecondsOrZero(machine.shutdownScheduledAt),
        };

        // Clear stale reboot/shutdown latches at the source so the status pill is
        // correct for every client. One-shot: later scans skip it. Must run before
        // the alert decision so it applies regardless of outcome.
        const stale = stalePlannedDowntime(snapshot, now);
        if (stale.clearShutdown || stale.clearReboot) {
          const clearPayload: Record<string, unknown> = {};
          if (stale.clearShutdown) {
            clearPayload.shuttingDown = false;
            clearPayload.shutdownScheduledAt = FieldValue.delete();
          }
          if (stale.clearReboot) {
            clearPayload.rebooting = false;
            clearPayload.rebootScheduledAt = FieldValue.delete();
            clearPayload.rebootCancellable = false;
          }
          await machineDoc.ref.set(clearPayload, { merge: true });
        }

        const decision = classifyMachineHealth(snapshot, now);

        if (decision.action === 'ok') {
          // Recovered — drop the stale marker so the next outage debounces from
          // scratch. Pending-set removal happens in the aggregation below.
          if (staleSinceMs > 0) {
            await machineDoc.ref.set(
              { health: { staleSince: FieldValue.delete() } },
              { merge: true }
            );
          }
          continue;
        }

        if (decision.action === 'debounce') {
          // First scan seen stale — record when; only alert if still stale later.
          if (staleSinceMs <= 0) {
            await machineDoc.ref.set(
              { health: { staleSince: FieldValue.serverTimestamp() } },
              { merge: true }
            );
          }
          continue;
        }

        if (decision.action === 'alert') {
          // Do NOT email or stamp cooldown yet — settling aggregation decides.
          notResponding.push({
            machineId: machineDoc.id,
            ref: machineDoc.ref,
            lastHeartbeatMs,
            heartbeatAgeMinutes: decision.heartbeatAgeMinutes,
            timezone,
          });
          continue;
        }

        // 'ignore' is never a page trigger but can still fill a context section.
        if (
          machine.online === false &&
          lastHeartbeatMs > 0 &&
          now - lastHeartbeatMs <= RECENT_SHUTDOWN_WINDOW_MS
        ) {
          // Agent explicitly flushed online:false — graceful shutdown.
          shuttingDown.push({
            machineId: machineDoc.id,
            heartbeatAgeMinutes: heartbeatAgeMinutes(lastHeartbeatMs, now),
          });
        } else if (decision.reason === 'cooldown') {
          // Still stale, already alerted within the last hour.
          stillOffline.push({
            machineId: machineDoc.id,
            heartbeatAgeMinutes: heartbeatAgeMinutes(lastHeartbeatMs, now),
          });
        }
      }

      // Site-level settling: persist the not-responding set and only fire once it
      // has stopped growing for SETTLE_MS, so a staggered shutdown emits ONE email.
      const priorState = (siteData.health?.offlineAlert ?? {}) as {
        pendingIds?: unknown;
        pendingUpdatedAt?: unknown;
      };
      const priorPendingIds = Array.isArray(priorState.pendingIds)
        ? (priorState.pendingIds as string[])
        : [];
      const priorPendingSet = new Set(priorPendingIds);
      const priorPendingUpdatedAtMs = timestampToMillis(priorState.pendingUpdatedAt);

      const currentIds = notResponding.map((m) => m.machineId);
      const currentSet = new Set(currentIds);
      const newIdAdded = currentIds.some((id) => !priorPendingSet.has(id));
      const idRemoved = priorPendingIds.some((id) => !currentSet.has(id));

      if (currentIds.length === 0) {
        // Clear lingering pending state so a future outage settles from clean.
        if (priorPendingIds.length > 0) {
          await writeSiteOfflineState(siteDoc.ref, siteId, {
            pendingIds: [],
            clearPendingUpdatedAt: true,
          });
        }
        continue;
      }

      // Only a NEW member resets the timer (a growing outage keeps settling). A
      // missing timestamp forces one more cycle rather than firing on partial state.
      const bump = newIdAdded || priorPendingUpdatedAtMs <= 0;
      const settled = !bump && now - priorPendingUpdatedAtMs >= SETTLE_MS;

      if (!settled) {
        // Removals keep the existing timer running; skip the write if unchanged.
        if (bump || idRemoved) {
          await writeSiteOfflineState(siteDoc.ref, siteId, {
            pendingIds: currentIds,
            bumpPendingUpdatedAt: bump,
          });
        }
        continue;
      }

      // Settled. Stamp per-machine cooldown and clear the pending set BEFORE
      // sending, so a send failure can never loop into repeated re-alerts.
      for (const m of notResponding) {
        try {
          await m.ref.set(
            { health: { lastCronAlertAt: FieldValue.serverTimestamp() } },
            { merge: true }
          );
        } catch (error) {
          console.error(`[cron/health-check] Failed to stamp cooldown for ${siteId}/${m.machineId}:`, error);
        }
      }
      await writeSiteOfflineState(siteDoc.ref, siteId, {
        pendingIds: [],
        clearPendingUpdatedAt: true,
        setLastAlertAt: true,
      });

      offlineMachines += notResponding.length;
      sendPlans.push({
        siteId,
        siteName: (siteData.name as string) || siteId,
        sections: {
          notResponding: notResponding.map(({ machineId, heartbeatAgeMinutes }) => ({ machineId, heartbeatAgeMinutes })),
          shuttingDown,
          stillOffline,
        },
        webhookMachines: notResponding.map(({ machineId, lastHeartbeatMs }) => ({ machineId, lastHeartbeatMs })),
        timezone: notResponding[0]?.timezone,
      });
    }
  } catch (error) {
    return apiError(error, 'cron/health-check');
  }

  if (sendPlans.length === 0) {
    return NextResponse.json({
      ok: true,
      sitesChecked,
      machinesChecked,
      offlineMachines: 0,
      alertsSent: 0,
    });
  }

  const resendClient = getResend();
  const baseUrl = publicOrigin(request);
  let alertsSent = 0;
  // one plan lookup per payer for the whole run, shared by recipients, webhooks and talons
  const planMemo = createPlanMemo();

  for (const plan of sendPlans) {
    try {
      const recipients = await getSiteAlertRecipients(plan.siteId, 'healthAlerts', planMemo);
      if (recipients.length === 0) {
        console.warn(`[cron/health-check] No recipients for site ${plan.siteId}`);
        continue;
      }

      if (!resendClient) {
        console.warn('[cron/health-check] Resend not configured — skipping email');
        continue;
      }

      const siteLabel = await getSiteLabel(plan.siteId);

      // One email per user so each gets their own unsubscribe link.
      for (const recipient of recipients) {
        try {
          const sections = filterSectionsForRecipient(plan.sections, recipient.mutedMachines);
          // Muted every triggering machine = opted out, even if context remains.
          if (sections.notResponding.length === 0) continue;

          const total = sections.notResponding.length + sections.shuttingDown.length + sections.stillOffline.length;

          const unsubscribeUrl = recipient.userId !== 'fallback'
            ? `${baseUrl}/api/unsubscribe?token=${generateUnsubscribeToken(recipient.userId)}`
            : undefined;

          const result = await resendClient.emails.send({
            from: FROM_EMAIL,
            to: [recipient.email],
            ...(recipient.ccEmails.length > 0 ? { cc: recipient.ccEmails } : {}),
            subject: safeEmailSubject(`${total} machine(s) offline in ${siteLabel}`),
            html: buildOfflineEmail(siteLabel, sections, plan.timezone, unsubscribeUrl),
          });

          if (result.error) {
            console.error(`[cron/health-check] Resend error for ${recipient.email}:`, result.error);
          } else {
            alertsSent++;
          }
        } catch (emailError) {
          console.error(`[cron/health-check] Failed to send to ${recipient.email}:`, emailError);
        }
      }

      console.log(
        `[cron/health-check] Alert sent for site ${plan.siteId}: ` +
          `${plan.sections.notResponding.length} not responding, ${recipients.length} recipient(s)`
      );

      // Fire webhooks for each not-responding machine (non-blocking).
      for (const m of plan.webhookMachines) {
        fireWebhooks(
          plan.siteId,
          plan.siteName,
          'machine.offline',
          {
            machine: { id: m.machineId, name: m.machineId, lastSeen: new Date(m.lastHeartbeatMs).toISOString() },
          },
          planMemo,
        ).catch(console.error);

        // Deliberately with the webhook fan-out, not the email branch:
        // `machine_offline` talons must fire even with no email recipients. This
        // is the only dispatcher — an offline machine can't report itself offline.
        tapTalonMatcher(db, plan.siteId, {
          kind: 'event',
          eventType: 'machine_offline',
          machineId: m.machineId,
        }, planMemo);
      }
    } catch (error) {
      console.error(`[cron/health-check] Failed to send alert for site ${plan.siteId}:`, error);
    }
  }

  return NextResponse.json({
    ok: true,
    sitesChecked,
    machinesChecked,
    offlineMachines,
    alertsSent,
  });
}
