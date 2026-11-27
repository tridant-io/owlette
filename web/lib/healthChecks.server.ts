import { getAdminDb } from '@/lib/firebase-admin';
import { ALERT_DIGESTS, ALERT_DIGEST_STALE_MS, alertDigestStatusRef } from '@/lib/alerts/digest.server';

export const STATUS_COMPONENTS = [
  'dashboard',
  'api',
  'agent_registry',
  'webhook_delivery',
  'alert_delivery',
  'talon_dispatch',
  'r2_uploads',
  'firestore',
  'cortex_chat',
] as const;

export type StatusComponent = (typeof STATUS_COMPONENTS)[number];

export interface HealthCheckResult {
  component: StatusComponent;
  ok: boolean;
  latency_ms: number;
  checked_at: string;
  status?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

interface HealthCheckOptions {
  baseUrl?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://owlette.app';
const API_TIMEOUT_MS = 2_000;
const DASHBOARD_TIMEOUT_MS = 3_000;
const AGENT_HEARTBEAT_WINDOW_MS = 5 * 60 * 1000;
const WEBHOOK_WINDOW_MS = 60 * 60 * 1000;
const WEBHOOK_SUCCESS_FLOOR = 0.95;
const FIRESTORE_LATENCY_LIMIT_MS = 500;
// Healthy process and display queues clear in ~5min (3-min drain + 2-min
// accumulation); older than this means a drain cron is down and alerts are piling up.
const ALERT_DELIVERY_STALE_MS = 15 * 60 * 1000;
// `/api/cron/talons` advances `nextRunAt` in the claim txn, so a still-due
// talon means the sweep is dead. Wider than its 10-min missed-fire grace.
const TALON_DISPATCH_STALE_MS = 15 * 60 * 1000;

function publicBaseUrl(baseUrl?: string): string {
  const configured =
    baseUrl ||
    process.env.OWLETTE_STATUS_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '') ||
    DEFAULT_BASE_URL;
  return configured.replace(/\/+$/, '');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function millisFromValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value && typeof value === 'object') {
    const maybeTimestamp = value as {
      toMillis?: () => number;
      toDate?: () => Date;
      seconds?: number;
      _seconds?: number;
    };
    if (typeof maybeTimestamp.toMillis === 'function') return maybeTimestamp.toMillis();
    if (typeof maybeTimestamp.toDate === 'function') return maybeTimestamp.toDate().getTime();
    if (typeof maybeTimestamp.seconds === 'number') return maybeTimestamp.seconds * 1000;
    if (typeof maybeTimestamp._seconds === 'number') return maybeTimestamp._seconds * 1000;
  }
  return 0;
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  options: HealthCheckOptions,
): Promise<{ status: number; latency_ms: number }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json,text/html;q=0.9,*/*;q=0.8' },
      signal: controller.signal,
    });
    await response.arrayBuffer().catch(() => undefined);
    return { status: response.status, latency_ms: Date.now() - started };
  } finally {
    clearTimeout(timeout);
  }
}

function result(
  component: StatusComponent,
  startedAt: number,
  ok: boolean,
  patch: Omit<Partial<HealthCheckResult>, 'component' | 'ok' | 'checked_at'> = {},
): HealthCheckResult {
  return {
    component,
    ok,
    latency_ms: Math.max(0, Date.now() - startedAt),
    checked_at: new Date().toISOString(),
    ...patch,
  };
}

export async function dashboardHealth(options: HealthCheckOptions = {}): Promise<HealthCheckResult> {
  const started = Date.now();
  const url = publicBaseUrl(options.baseUrl);

  try {
    const probe = await fetchWithTimeout(url, DASHBOARD_TIMEOUT_MS, options);
    const ok = probe.status >= 200 && probe.status < 400;
    return result('dashboard', started, ok, {
      status: probe.status,
      latency_ms: probe.latency_ms,
      ...(ok ? {} : { error: `dashboard returned ${probe.status}` }),
    });
  } catch (error) {
    return result('dashboard', started, false, { error: errorMessage(error) });
  }
}

export async function apiHealth(options: HealthCheckOptions = {}): Promise<HealthCheckResult> {
  const started = Date.now();
  const baseUrl = publicBaseUrl(options.baseUrl);

  try {
    const [version, whoami, openapi, docs] = await Promise.all([
      fetchWithTimeout(`${baseUrl}/api/version`, API_TIMEOUT_MS, options),
      fetchWithTimeout(`${baseUrl}/api/whoami`, API_TIMEOUT_MS, options),
      fetchWithTimeout(`${baseUrl}/api/openapi`, API_TIMEOUT_MS, options),
      fetchWithTimeout(`${baseUrl}/docs/api`, API_TIMEOUT_MS, options),
    ]);
    const versionOk = version.status >= 200 && version.status < 300;
    const whoamiOk = whoami.status === 401 || (whoami.status >= 200 && whoami.status < 300);
    const openapiOk = openapi.status >= 200 && openapi.status < 300;
    const docsOk = docs.status >= 200 && docs.status < 300;
    const ok = versionOk && whoamiOk && openapiOk && docsOk;

    return result('api', started, ok, {
      status: ok
        ? 200
        : !versionOk
          ? version.status
          : !whoamiOk
            ? whoami.status
            : !openapiOk
              ? openapi.status
              : docs.status,
      metadata: {
        version_status: version.status,
        whoami_status: whoami.status,
        openapi_status: openapi.status,
        docs_status: docs.status,
      },
      ...(ok
        ? {}
        : {
            error:
              `api probes returned version=${version.status}, whoami=${whoami.status}, ` +
              `openapi=${openapi.status}, docs=${docs.status}`,
          }),
    });
  } catch (error) {
    return result('api', started, false, { error: errorMessage(error) });
  }
}

export async function agentRegistryHealth(
  options: HealthCheckOptions = {},
): Promise<HealthCheckResult> {
  const started = Date.now();
  const now = options.now?.() ?? Date.now();

  try {
    const snapshot = await getAdminDb()
      .collectionGroup('machines')
      .orderBy('lastHeartbeat', 'desc')
      .limit(1)
      .get();
    const latest = snapshot.docs[0];

    if (!latest) {
      return result('agent_registry', started, false, { error: 'no machine heartbeats found' });
    }

    const data = latest.data() as Record<string, unknown>;
    const lastHeartbeatMs = millisFromValue(data.lastHeartbeat);
    const ageMs = lastHeartbeatMs > 0 ? now - lastHeartbeatMs : Number.POSITIVE_INFINITY;
    const ok = ageMs <= AGENT_HEARTBEAT_WINDOW_MS;

    return result('agent_registry', started, ok, {
      metadata: {
        latest_machine_id: latest.id,
        last_heartbeat_ms: lastHeartbeatMs,
        heartbeat_age_ms: Number.isFinite(ageMs) ? ageMs : null,
      },
      ...(ok ? {} : { error: 'latest machine heartbeat is stale' }),
    });
  } catch (error) {
    return result('agent_registry', started, false, { error: errorMessage(error) });
  }
}

export async function webhookDeliveryHealth(
  options: HealthCheckOptions = {},
): Promise<HealthCheckResult> {
  const started = Date.now();
  const now = options.now?.() ?? Date.now();
  const cutoff = now - WEBHOOK_WINDOW_MS;

  try {
    const snapshot = await getAdminDb()
      .collection('webhook_deliveries')
      .where('createdAt', '>=', cutoff)
      .limit(500)
      .get();
    const docs = snapshot.docs;

    if (docs.length === 0) {
      return result('webhook_delivery', started, true, {
        metadata: { sample_size: 0, success_rate: null },
      });
    }

    const successes = docs.filter((doc) => {
      const data = doc.data() as Record<string, unknown>;
      const state = typeof data.state === 'string' ? data.state : '';
      const status = typeof data.lastStatus === 'number'
        ? data.lastStatus
        : typeof data.status === 'number'
          ? data.status
          : 0;
      return state === 'succeeded' || (status >= 200 && status < 300);
    }).length;
    const successRate = successes / docs.length;
    const ok = successRate >= WEBHOOK_SUCCESS_FLOOR;

    return result('webhook_delivery', started, ok, {
      metadata: {
        sample_size: docs.length,
        success_count: successes,
        success_rate: successRate,
      },
      ...(ok ? {} : { error: `webhook success rate ${successRate.toFixed(3)} below 0.950` }),
    });
  } catch (error) {
    return result('webhook_delivery', started, false, { error: errorMessage(error) });
  }
}

/**
 * Stalled alert pipeline. If the 3-min drain crons stop, the pending_* queues
 * grow silently and nobody is paged; if the digest job has stopped, or never
 * ran, while a digest is queued, that digest waits. This makes both visible.
 * With nothing queued a missing job is fine: senders then email at once.
 */
export async function alertDeliveryHealth(
  options: HealthCheckOptions = {},
): Promise<HealthCheckResult> {
  const started = Date.now();
  const now = options.now?.() ?? Date.now();
  const cutoff = new Date(now - ALERT_DELIVERY_STALE_MS);

  try {
    const db = getAdminDb();
    const [processSnap, displaySnap, digestStatus, digestPending] = await Promise.all([
      db.collection('pending_process_alerts').where('timestamp', '<=', cutoff).limit(10).get(),
      db.collection('pending_display_alerts').where('timestamp', '<=', cutoff).limit(10).get(),
      alertDigestStatusRef(db).get(),
      db.collection(ALERT_DIGESTS).where('pending', '==', true).limit(1).get(),
    ]);
    const staleProcess = processSnap.docs.length;
    const staleDisplay = displaySnap.docs.length;
    const digestLastRunMs = millisFromValue(digestStatus.data()?.lastRunAt);
    const digestsWaiting = !digestPending.empty;
    const digestStale = digestsWaiting && (digestLastRunMs === 0 || now - digestLastRunMs > ALERT_DIGEST_STALE_MS);
    const queuesOk = staleProcess === 0 && staleDisplay === 0;
    const ok = queuesOk && !digestStale;

    const errors = [
      ...(queuesOk
        ? []
        : [
            `${staleProcess + staleDisplay} alert(s) undelivered for >${ALERT_DELIVERY_STALE_MS / 60_000}m ` +
              `(process=${staleProcess}, display=${staleDisplay}) — a drain cron is likely down`,
          ]),
      ...(digestStale
        ? [
            `${digestLastRunMs > 0 ? `the alert digest job last ran over ${ALERT_DIGEST_STALE_MS / 60_000}m ago` : 'the alert digest job has never run'}` +
              ' with digests queued — its cron is likely down or unregistered',
          ]
        : []),
    ];

    return result('alert_delivery', started, ok, {
      metadata: {
        stale_process_alerts: staleProcess,
        stale_display_alerts: staleDisplay,
        threshold_minutes: ALERT_DELIVERY_STALE_MS / 60_000,
        alert_digest_last_run_at: digestLastRunMs > 0 ? new Date(digestLastRunMs).toISOString() : null,
        alert_digest_threshold_minutes: ALERT_DIGEST_STALE_MS / 60_000,
        alert_digests_pending: digestsWaiting,
      },
      ...(ok ? {} : { error: errors.join('; ') }),
    });
  } catch (error) {
    return result('alert_delivery', started, false, { error: errorMessage(error) });
  }
}

/**
 * Stalled talon scheduler. `/api/cron/talons` is the only runtime writer of
 * `nextRunAt`, so a still-due talon proves the sweep is dead — otherwise
 * indistinguishable from a talon nobody configured.
 */
export async function talonDispatchHealth(
  options: HealthCheckOptions = {},
): Promise<HealthCheckResult> {
  const started = Date.now();
  const now = options.now?.() ?? Date.now();
  const cutoff = new Date(now - TALON_DISPATCH_STALE_MS);

  try {
    const snapshot = await getAdminDb()
      .collectionGroup('talons')
      .where('enabled', '==', true)
      .where('nextRunAt', '<=', cutoff)
      .limit(10)
      .get();
    const overdue = snapshot.docs.length;
    const ok = overdue === 0;

    return result('talon_dispatch', started, ok, {
      metadata: {
        overdue_talons: overdue,
        threshold_minutes: TALON_DISPATCH_STALE_MS / 60_000,
      },
      ...(ok
        ? {}
        : {
            error:
              `${overdue} talon(s) unclaimed for >${TALON_DISPATCH_STALE_MS / 60_000}m ` +
              `— the talon sweep is likely down`,
          }),
    });
  } catch (error) {
    return result('talon_dispatch', started, false, { error: errorMessage(error) });
  }
}

export async function firestoreHealth(): Promise<HealthCheckResult> {
  const started = Date.now();

  try {
    const snapshot = await getAdminDb()
      .collection('system_status')
      .doc('heartbeat')
      .get();
    const latencyMs = Date.now() - started;
    const ok = latencyMs <= FIRESTORE_LATENCY_LIMIT_MS;

    return {
      component: 'firestore',
      ok,
      latency_ms: latencyMs,
      checked_at: new Date().toISOString(),
      metadata: { heartbeat_doc_exists: snapshot.exists },
      ...(ok ? {} : { error: `firestore read took ${latencyMs}ms` }),
    };
  } catch (error) {
    return result('firestore', started, false, { error: errorMessage(error) });
  }
}

export async function r2UploadsHealth(): Promise<HealthCheckResult> {
  const started = Date.now();
  return result('r2_uploads', started, true, {
    metadata: {
      placeholder: true,
      reason: 'r2 upload 5xx signal is not instrumented yet',
    },
  });
}

export async function hootChatHealth(): Promise<HealthCheckResult> {
  const started = Date.now();
  return result('cortex_chat', started, true, {
    metadata: {
      placeholder: true,
      reason: 'hoot SSE success-rate signal is not instrumented yet',
    },
  });
}

export async function runStatusHealthChecks(
  options: HealthCheckOptions = {},
): Promise<HealthCheckResult[]> {
  return Promise.all([
    dashboardHealth(options),
    apiHealth(options),
    agentRegistryHealth(options),
    webhookDeliveryHealth(options),
    alertDeliveryHealth(options),
    talonDispatchHealth(options),
    r2UploadsHealth(),
    firestoreHealth(),
    hootChatHealth(),
  ]);
}
