/**
 * Talon log-event bridge (talons wave 2, task 2.3).
 *
 * Firestore trigger on `sites/{siteId}/logs/{logId}` forwarding the fleet events
 * talons can subscribe to but no web route ever sees. Most agent events reach the
 * dashboard through an http endpoint that taps the talon matcher in-process;
 * `process_restarted` and the `display_*` events are written STRAIGHT into the
 * site's log collection, so without this trigger those talons could never fire.
 *
 * SINGLE source for display talons — `/api/agent/alert` deliberately skips its
 * talon tap for display types. Every agent writes the log but only new enough
 * agents post the alert, so firing from both would double-run every display
 * talon on an up-to-date fleet.
 *
 * Matches are POSTed to `/api/talons/internal/match`. Failures are logged, never
 * thrown: a log write must not be retried because a talon run had a bad day.
 */

import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import https = require('https');
import http = require('http');

/**
 * The `action` values worth forwarding. MUST stay a subset of `TALON_EVENT_TYPES`
 * (`web/lib/talons/types.ts`) and mirror `DISPLAY_EVENT_ROUTING`
 * (`web/lib/alerts/displayEventRouting.ts`) plus `process_restarted`. Duplicated
 * rather than imported because functions/ and web/ build separately; the match
 * route re-validates, so drift degrades to "never forwarded", not a bad write.
 *
 * Excluded on purpose: display audit actions with no routing entry
 * (`display_auto_restore_fired`, `display_apply_acked`, `display_revert_deferred`,
 * `display_auto_restore_skipped_unfixable`,
 * `display_auto_restore_circuit_breaker_tripped`,
 * `display_auto_restore_parked`), and the engine's own `talon_*`
 * companion logs — the latter is what stops a run re-triggering itself here.
 */
const TALON_LOG_ACTIONS: ReadonlySet<string> = new Set([
  'process_restarted',
  // DISPLAY_EVENT_ROUTING keys — email + webhook
  'display_monitor_removed',
  'display_apply_failed',
  'display_auto_revert_fired',
  'display_sync_lost',
  // DISPLAY_EVENT_ROUTING keys — webhook only
  'display_drift',
  'display_monitor_swapped',
  'display_mosaic_disabled',
  'display_apply_refused_mosaic',
  // DISPLAY_EVENT_ROUTING keys — in-dashboard only
  'display_monitor_added',
  'display_apply_succeeded',
]);

/** Sentinel the talon engine writes for a site-level run — never a real machine. */
const SITE_LOG_SENTINEL = 'site';

const REQUEST_TIMEOUT_MS = 10_000;

/** Web API base URL from the project id — same heuristic as `metricsHistory.ts`. */
function getApiBaseUrl(): string {
  const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || '';
  if (projectId.includes('dev')) return 'https://dev.owlette.app';
  return 'https://owlette.app';
}

/** POST to `/api/talons/internal/match` using node http/https (no external deps). */
function callTalonMatchApi(body: Record<string, unknown>): Promise<void> {
  const baseUrl = process.env.API_BASE_URL || getApiBaseUrl();
  const secret = process.env.CORTEX_INTERNAL_SECRET;

  if (!secret) {
    console.warn('CORTEX_INTERNAL_SECRET not configured — skipping talon match');
    return Promise.resolve();
  }

  const url = new URL('/api/talons/internal/match', baseUrl);
  const payload = JSON.stringify(body);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  return new Promise<void>((resolve, reject) => {
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'x-internal-secret': secret,
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        // Consume the response body to free resources
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`Talon match API returned status ${res.statusCode}`));
        }
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Talon match API request timed out'));
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Forward talon-relevant log entries to the matcher. Cheap by construction: a set
 * lookup on `action` then an immediate return — the site log stream carries every
 * command, deployment and audit line in the fleet, so most invocations do no work.
 */
export const onTalonLogEventCreated = onDocumentCreated(
  'sites/{siteId}/logs/{logId}',
  async (event) => {
    const data = event.data?.data();
    if (!data) return;

    const action = typeof data.action === 'string' ? data.action : '';
    if (!TALON_LOG_ACTIONS.has(action)) return;

    const { siteId } = event.params;
    const rawMachineId = typeof data.machineId === 'string' ? data.machineId : '';
    // The sentinel means "no machine"; forwarding it would let a machine-scoped
    // talon match a site that happens to own a machine literally named `site`.
    const machineId = rawMachineId && rawMachineId !== SITE_LOG_SENTINEL ? rawMachineId : '';

    try {
      await callTalonMatchApi({
        siteId,
        eventType: action,
        ...(machineId ? { machineId } : {}),
      });
    } catch (err) {
      // Never rethrow: a retried invocation would re-run every matching talon,
      // and the log entry itself is already durable.
      console.error(`Failed to forward ${action} on ${siteId} to the talon matcher:`, err);
    }
  }
);
