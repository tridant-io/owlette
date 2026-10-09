/**
 * Webhook dispatch for owlette. Fires JSON payloads to every enabled webhook on a site
 * subscribed to an event type. Non-blocking (Promise.allSettled), never throws.
 * Each delivery carries an HMAC-SHA256 signature in X-owlette-Signature.
 * A webhook auto-disables after 10 consecutive delivery failures.
 */

import { getAdminDb } from '@/lib/firebase-admin';
import { WEBHOOK_SECRETS_COLLECTION } from '@/lib/webhookSecrets.server';
import logger from '@/lib/logger';
import { pausedByPlan, type PlanMemo } from '@/lib/planPause.server';
import { DISPLAY_EVENT_ROUTING } from '@/lib/alerts/displayEventRouting';
import crypto from 'crypto';

export type WebhookPlatform = 'slack' | 'discord' | 'generic';

export interface WebhookPayload {
  event: string;
  timestamp: string;
  site: { id: string; name: string };
  data: Record<string, unknown>;
}

/** Detect the target platform from a webhook URL. */
export function detectPlatform(url: string): WebhookPlatform {
  if (url.includes('hooks.slack.com')) return 'slack';
  if (url.includes('discord.com/api/webhooks')) return 'discord';
  return 'generic';
}

interface EventMeta {
  title: string;
  colorHex: string;
  discordColor: number;
}

const DEFAULT_META: EventMeta = { title: 'owlette Event', colorHex: '#6366f1', discordColor: 6526705 };

// Color tokens — keep aligned with the process.* entries so a Slack/Discord receiver can
// deduce severity from color alone: red critical, amber warning, green healthy,
// indigo informational.
const COLOR_RED_HEX = '#dc2626';
const COLOR_RED_DISCORD = 14427686;
const COLOR_AMBER_HEX = '#ca8a04';
const COLOR_AMBER_DISCORD = 13273604;
const COLOR_GREEN_HEX = '#16a34a';
const COLOR_GREEN_DISCORD = 1483594;

const EVENT_META: Record<string, EventMeta> = {
  'process.crashed':     { title: 'Process Crashed',      colorHex: COLOR_RED_HEX,   discordColor: COLOR_RED_DISCORD },
  'process.restarted':   { title: 'Process Start Failed', colorHex: '#ea580c',       discordColor: 15358988 },
  'machine.offline':     { title: 'Machine Offline',      colorHex: COLOR_RED_HEX,   discordColor: COLOR_RED_DISCORD },
  'machine.online':      { title: 'Machine Online',       colorHex: COLOR_GREEN_HEX, discordColor: COLOR_GREEN_DISCORD },
  'threshold.breached':  { title: 'Threshold Alert',      colorHex: COLOR_AMBER_HEX, discordColor: COLOR_AMBER_DISCORD },

  // [B1.2] Display events. Critical (red): hardware lost, apply died, sync dropped.
  // Warning (amber): drift/swap/mosaic. Success/added are mostly for the dashboard feed
  // and only reach webhooks if an operator opts in via the routing table.
  'display.monitor_removed':       { title: 'Display Removed',          colorHex: COLOR_RED_HEX,   discordColor: COLOR_RED_DISCORD },
  'display.apply_failed':          { title: 'Display Apply Failed',     colorHex: COLOR_RED_HEX,   discordColor: COLOR_RED_DISCORD },
  'display.auto_revert_fired':     { title: 'Display Auto-Reverted',    colorHex: COLOR_RED_HEX,   discordColor: COLOR_RED_DISCORD },
  'display.sync_lost':             { title: 'Display Sync Lost',        colorHex: COLOR_RED_HEX,   discordColor: COLOR_RED_DISCORD },
  'display.drift':                 { title: 'Display Drift Detected',   colorHex: COLOR_AMBER_HEX, discordColor: COLOR_AMBER_DISCORD },
  'display.monitor_swapped':       { title: 'Display Swapped',          colorHex: COLOR_AMBER_HEX, discordColor: COLOR_AMBER_DISCORD },
  'display.mosaic_disabled':       { title: 'Mosaic Disabled',          colorHex: COLOR_AMBER_HEX, discordColor: COLOR_AMBER_DISCORD },
  'display.apply_refused_mosaic':  { title: 'Display Apply Refused',    colorHex: COLOR_AMBER_HEX, discordColor: COLOR_AMBER_DISCORD },
  'display.monitor_added':         { title: 'Display Added',            colorHex: '#6366f1',       discordColor: 6526705 },
  'display.apply_succeeded':       { title: 'Display Apply Succeeded',  colorHex: COLOR_GREEN_HEX, discordColor: COLOR_GREEN_DISCORD },
};

// Sanity check: the 10 display.* names above must match the central routing table.
// Missing entries warn at load time rather than drifting silently.
if (process.env.NODE_ENV !== 'production') {
  const missing = Object.values(DISPLAY_EVENT_ROUTING)
    .map((r) => r.webhookEventName)
    .filter((name) => !(name in EVENT_META));
  if (missing.length > 0) {
    console.warn(
      '[webhookSender] EVENT_META missing entries for display events:',
      missing,
    );
  }
}

/** Extract human-readable fields from the webhook data object. */
function extractFields(eventType: string, data: Record<string, unknown>) {
  const machine = data.machine as Record<string, unknown> | undefined;
  const machineName = (machine?.name ?? machine?.id ?? '') as string;

  const processName = ((data.process as Record<string, unknown> | undefined)?.name ?? data.processName ?? '') as string;

  const details = (data.errorMessage ?? data.details ?? '') as string;

  const metric = data.metric as string | undefined;
  const value = data.value as string | number | undefined;
  const threshold = data.threshold as string | number | undefined;

  // [B1.2] Display-specific. `monitor` is the per-event subject (friendly name + port for
  // the render, edidHash for stable identity); `changes` is the drifted-field list from the
  // agent. Neither is required — monitor_added may carry only the monitor, apply_failed
  // only an error.
  const monitor = data.monitor as Record<string, unknown> | undefined;
  const monitorName = (monitor?.friendlyName ?? monitor?.id ?? '') as string;
  const monitorPort = (monitor?.port ?? '') as string;
  const changesRaw = data.changes;
  const changes: string[] = Array.isArray(changesRaw)
    ? changesRaw.filter((c): c is string => typeof c === 'string')
    : [];

  return {
    machineName,
    processName,
    details,
    metric,
    value,
    threshold,
    monitorName,
    monitorPort,
    changes,
  };
}

/**
 * Format a webhook payload for the target platform; returns the JSON body string.
 * Exported for the talon webhook output (`@/lib/talons/outputs.server`), which signs on
 * its own path but must render Slack/Discord bodies identically to the fan-out below.
 */
export function formatForPlatform(
  platform: WebhookPlatform,
  payload: WebhookPayload,
): string {
  if (platform === 'generic') return JSON.stringify(payload);

  const meta = EVENT_META[payload.event] ?? DEFAULT_META;
  const {
    machineName,
    processName,
    details,
    metric,
    value,
    threshold,
    monitorName,
    monitorPort,
    changes,
  } = extractFields(payload.event, payload.data);

  const summaryParts = [meta.title];
  // For display events the monitor is a more useful subject than the process, so Slack's
  // preview reads "Display Drift Detected: DELL P2415Q on lobby-kiosk-01".
  const isDisplayEvent = payload.event.startsWith('display.');
  if (isDisplayEvent && monitorName) summaryParts.push(monitorName);
  else if (processName) summaryParts.push(processName);
  if (machineName) summaryParts.push(`on ${machineName}`);
  const summary = summaryParts.join(': ');

  let detailText = details;
  if (metric && value !== undefined && threshold !== undefined) {
    detailText = `${metric}: ${value} (threshold: ${threshold})`;
  }
  // Display events surface the per-field change list as the detail body so the operator
  // sees which fields drifted. Falls back to the generic detail when there are none.
  if (isDisplayEvent && changes.length > 0) {
    detailText = `Changes: ${changes.join(', ')}`;
  }

  if (platform === 'slack') {
    const blocks: Record<string, unknown>[] = [
      { type: 'header', text: { type: 'plain_text', text: meta.title } },
    ];

    // Fields section. Display events show monitor (+ port) instead of process, which means
    // nothing to an operator reading a display alert.
    const sectionFields: Record<string, unknown>[] = [];
    if (machineName) sectionFields.push({ type: 'mrkdwn', text: `*Machine:*\n${machineName}` });
    if (isDisplayEvent && monitorName) {
      const monitorLabel = monitorPort
        ? `${monitorName} (${monitorPort})`
        : monitorName;
      sectionFields.push({ type: 'mrkdwn', text: `*Monitor:*\n${monitorLabel}` });
    } else if (processName) {
      sectionFields.push({ type: 'mrkdwn', text: `*Process:*\n${processName}` });
    }
    if (sectionFields.length > 0) {
      blocks.push({ type: 'section', fields: sectionFields });
    }

    if (detailText) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: detailText } });
    }

    const ts = new Date(payload.timestamp).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `owlette | ${payload.site.name} | ${ts}` }],
    });

    return JSON.stringify({
      text: summary,
      blocks,
      attachments: [{ color: meta.colorHex }],
    });
  }

  // Discord
  const fields: Record<string, unknown>[] = [];
  if (machineName) fields.push({ name: 'Machine', value: machineName, inline: true });
  if (isDisplayEvent && monitorName) {
    const monitorLabel = monitorPort
      ? `${monitorName} (${monitorPort})`
      : monitorName;
    fields.push({ name: 'Monitor', value: monitorLabel, inline: true });
  } else if (processName) {
    fields.push({ name: 'Process', value: processName, inline: true });
  }
  fields.push({ name: 'Site', value: payload.site.name, inline: true });

  return JSON.stringify({
    embeds: [{
      title: meta.title,
      description: detailText || undefined,
      color: meta.discordColor,
      fields,
      timestamp: payload.timestamp,
      footer: { text: 'owlette' },
    }],
  });
}

/**
 * Fire all enabled webhooks for a site subscribed to the given event. Non-blocking
 * (Promise.allSettled), never throws. Returns the number delivered successfully.
 * Paused, not failed, when the site's payer has no `owlette.webhooks`; pass a
 * batch's `planMemo` to resolve each payer once.
 */
export async function fireWebhooks(
  siteId: string,
  siteName: string,
  eventType: string,
  data: Record<string, unknown>,
  planMemo?: PlanMemo
): Promise<number> {
  const db = getAdminDb();

  // Liveness is filtered in memory, not by an equality on `enabled`.
  //
  // Firestore equality filters require the field to EXIST, and the creator
  // (app/api/webhooks/route.ts) writes `paused: false, deletedAt: null` and no
  // `enabled` at all — so `.where('enabled','==',true)` matched nothing rather
  // than erroring, and every subscription created since that change delivered
  // silently nothing while the dashboard showed it active with zero failures.
  // The inverse also held: a legacy document still carrying `enabled: true` kept
  // firing after being paused or soft-deleted, because neither field was read.
  //
  // This is the same predicate roostWebhooks.server.ts:75 and
  // WebhookSettingsDialog already use; only this sender was left behind. A site
  // has a handful of webhooks, so filtering after the array-contains costs
  // nothing.
  const snapshot = await db
    .collection(`sites/${siteId}/webhooks`)
    .where('events', 'array-contains', eventType)
    .get();

  const liveDocs = snapshot.docs.filter((doc) => {
    const d = doc.data();
    if (d.deletedAt) return false;
    if (d.paused === true) return false;
    if (d.enabled === false) return false;
    return true;
  });

  if (liveDocs.length === 0) return 0;

  // after the subscription query on purpose: a site with nothing subscribed has
  // nothing to pause, and checking first would charge every event the lookup.
  // a pause touches no delivery state, so it never counts toward auto-disable.
  if (await pausedByPlan(siteId, 'owlette.webhooks', planMemo)) {
    logger.warn("webhook delivery paused: the site's plan has no webhooks", {
      context: 'webhookSender',
      data: { siteId, eventType, webhooks: liveDocs.length },
    });
    return 0;
  }

  const payload: WebhookPayload = {
    event: eventType,
    timestamp: new Date().toISOString(),
    site: { id: siteId, name: siteName },
    data,
  };

  let successCount = 0;

  // Signing secrets live outside the webhook document (lib/webhookSecrets.server.ts),
  // so they are fetched separately. One batched read for the whole fan-out; the
  // legacy in-document `secret` / `signingSecret` remain the fallback for
  // subscriptions that predate the migration.
  const secretSnaps = await db.getAll(
    ...liveDocs.map((doc) =>
      db
        .collection('sites')
        .doc(siteId)
        .collection(WEBHOOK_SECRETS_COLLECTION)
        .doc(doc.id),
    ),
  );
  const secretByWebhookId = new Map<string, string>();
  liveDocs.forEach((doc, i) => {
    const stored = secretSnaps[i]?.data();
    const resolved =
      (typeof stored?.signingSecret === 'string' && stored.signingSecret) ||
      (typeof doc.data().signingSecret === 'string' && doc.data().signingSecret) ||
      (typeof doc.data().secret === 'string' && doc.data().secret) ||
      '';
    if (resolved) secretByWebhookId.set(doc.id, resolved);
  });

  const deliveries = liveDocs.map(async (doc) => {
    const webhook = doc.data();
    try {
      const platform = detectPlatform(webhook.url);
      const body = formatForPlatform(platform, payload);

      // Skip HMAC for Slack/Discord — they don't use it.
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'owlette-Webhooks/1.0',
      };

      if (platform === 'generic') {
        const signingSecret = secretByWebhookId.get(doc.id);
        if (!signingSecret) {
          // No secret anywhere: skip rather than let createHmac throw, which the
          // catch below would count as a delivery failure and eventually
          // auto-disable a subscription whose only fault is a missing key.
          logger.warn('webhook has no signing secret; skipping delivery', {
            context: 'webhookSender',
            data: { siteId, webhookId: doc.id, eventType },
          });
          return;
        }
        const signature = crypto
          .createHmac('sha256', signingSecret)
          .update(body)
          .digest('hex');
        headers['X-owlette-Signature'] = `sha256=${signature}`;
        headers['X-owlette-Event'] = eventType;
      }

      const response = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(5000),
      });

      const newFailCount = response.ok ? 0 : (webhook.failCount || 0) + 1;

      await doc.ref.update({
        lastTriggered: new Date(),
        lastStatus: response.status,
        failCount: newFailCount,
        ...(newFailCount >= 10 ? { enabled: false } : {}),
      });

      if (newFailCount >= 10) {
        console.warn(`[webhooks] Webhook ${doc.id} auto-disabled after 10 consecutive failures`);
      }

      if (response.ok) successCount++;
    } catch {
      const newFailCount = (webhook.failCount || 0) + 1;

      await doc.ref.update({
        lastTriggered: new Date(),
        lastStatus: 0, // network error
        failCount: newFailCount,
        ...(newFailCount >= 10 ? { enabled: false } : {}),
      });

      if (newFailCount >= 10) {
        console.warn(`[webhooks] Webhook ${doc.id} auto-disabled after 10 consecutive failures`);
      }
    }
  });

  await Promise.allSettled(deliveries);
  return successCount;
}

/** Send a test payload to one webhook. Returns the HTTP status, or 0 on network error. */
export async function testWebhook(
  url: string,
  secret: string
): Promise<{ status: number; error?: string }> {
  const platform = detectPlatform(url);

  // Realistic payload so Slack/Discord render a proper preview.
  const payload: WebhookPayload = {
    event: 'process.crashed',
    timestamp: new Date().toISOString(),
    site: { id: 'test', name: 'Test Site' },
    data: {
      machine: { name: 'MEDIA-SERVER-01' },
      process: { name: 'TouchDesigner' },
      details: 'This is a test webhook from owlette.',
    },
  };

  const body = formatForPlatform(platform, payload);

  // Skip HMAC for Slack/Discord.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'owlette-Webhooks/1.0',
  };

  if (platform === 'generic') {
    const signature = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');
    headers['X-owlette-Signature'] = `sha256=${signature}`;
    headers['X-owlette-Event'] = 'test';
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10000),
    });

    return { status: response.status };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Network error';
    return { status: 0, error: message };
  }
}
