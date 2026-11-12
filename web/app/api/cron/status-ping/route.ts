import { NextRequest, NextResponse } from 'next/server';
import { cronSecretMatches } from '@/lib/secretMatches.server';
import { FieldValue } from 'firebase-admin/firestore';
import { apiError } from '@/lib/apiErrorResponse';
import {
  type HealthCheckResult,
  type StatusComponent,
  runStatusHealthChecks,
} from '@/lib/healthChecks.server';
import {
  type InstatusPublishResult,
  statusForHealth,
  setInstatusComponentStatus,
  validateInstatusConfig,
} from '@/lib/instatusClient';
import { getAdminDb } from '@/lib/firebase-admin';
import * as Sentry from '@sentry/nextjs';

// Components whose degrade transition pages Sentry. alert_delivery only: the HTTP-probe
// components produce server-side-probe false-negatives, so paging on them is noise.
const SENTRY_ALERTING_COMPONENTS = new Set<StatusComponent>(['alert_delivery']);

interface StatusPingDoc {
  id: string;
  observedAtMs: number;
  checkedAt: string;
  results: HealthCheckResult[];
}

export interface ComponentStatusUpdate {
  component: StatusComponent;
  previousOk: boolean;
  currentOk: boolean;
  status: ReturnType<typeof statusForHealth>;
  reason: 'second_consecutive_failure' | 'recovered';
}

interface StatusPingResponseResult {
  component: StatusComponent;
  ok: boolean;
  latency_ms: number;
  status?: number;
  placeholder?: boolean;
}

function componentMap(results: HealthCheckResult[]): Map<StatusComponent, HealthCheckResult> {
  return new Map(results.map((entry) => [entry.component, entry]));
}

export function computeComponentStatusUpdates(
  current: HealthCheckResult[],
  previous?: HealthCheckResult[],
  prior?: HealthCheckResult[],
): ComponentStatusUpdate[] {
  if (!previous) return [];

  const previousByComponent = componentMap(previous);
  const priorByComponent = prior ? componentMap(prior) : new Map<StatusComponent, HealthCheckResult>();
  const updates: ComponentStatusUpdate[] = [];

  for (const currentResult of current) {
    const previousResult = previousByComponent.get(currentResult.component);
    if (!previousResult) continue;

    if (currentResult.ok && !previousResult.ok) {
      updates.push({
        component: currentResult.component,
        previousOk: previousResult.ok,
        currentOk: currentResult.ok,
        status: statusForHealth(true),
        reason: 'recovered',
      });
      continue;
    }

    if (!currentResult.ok && !previousResult.ok) {
      const priorResult = priorByComponent.get(currentResult.component);
      if (priorResult?.ok === false) continue;

      updates.push({
        component: currentResult.component,
        previousOk: previousResult.ok,
        currentOk: currentResult.ok,
        status: statusForHealth(false),
        reason: 'second_consecutive_failure',
      });
    }
  }

  return updates;
}

function normalizePingDoc(doc: {
  id: string;
  data: () => Record<string, unknown> | undefined;
}): StatusPingDoc | null {
  const data = doc.data() ?? {};
  if (!Array.isArray(data.results)) return null;

  return {
    id: doc.id,
    observedAtMs: typeof data.observedAtMs === 'number' ? data.observedAtMs : 0,
    checkedAt: typeof data.checkedAt === 'string' ? data.checkedAt : '',
    results: data.results as HealthCheckResult[],
  };
}

async function latestStatusPings(): Promise<StatusPingDoc[]> {
  const snapshot = await getAdminDb()
    .collection('status_pings')
    .orderBy('observedAtMs', 'desc')
    .limit(2)
    .get();

  return snapshot.docs
    .map(normalizePingDoc)
    .filter((doc): doc is StatusPingDoc => doc !== null);
}

async function writeStatusPing(
  results: HealthCheckResult[],
): Promise<{ pingId: string; checkedAt: string; observedAtMs: number }> {
  const observedAtMs = Date.now();
  const checkedAt = new Date(observedAtMs).toISOString();
  const pingId = String(observedAtMs);

  await getAdminDb()
    .collection('status_pings')
    .doc(pingId)
    .set({
      observedAtMs,
      checkedAt,
      ok: results.every((entry) => entry.ok),
      results,
      createdAt: FieldValue.serverTimestamp(),
    });

  return { pingId, checkedAt, observedAtMs };
}

async function publishStatusUpdates(
  updates: ComponentStatusUpdate[],
): Promise<InstatusPublishResult[]> {
  const attempts = updates.map((update) => ({
    update,
    promise: setInstatusComponentStatus(update.component, update.status),
  }));
  const settled = await Promise.allSettled(attempts.map((attempt) => attempt.promise));

  return settled.map((outcome, index) => {
    if (outcome.status === 'fulfilled') {
      if (!outcome.value.ok && !outcome.value.skipped) {
        console.warn('[cron/status-ping] Instatus publish failed', outcome.value);
      }
      return outcome.value;
    }

    const { update } = attempts[index];
    const result = {
      component: update.component,
      status: update.status,
      ok: false,
      error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
    };
    console.warn('[cron/status-ping] Instatus publish failed', result);
    return {
      ...result,
    };
  });
}

function summarizeHealthResults(results: HealthCheckResult[]): StatusPingResponseResult[] {
  return results.map((entry) => ({
    component: entry.component,
    ok: entry.ok,
    latency_ms: entry.latency_ms,
    ...(typeof entry.status === 'number' ? { status: entry.status } : {}),
    ...(entry.metadata?.placeholder === true ? { placeholder: true } : {}),
  }));
}

function summarizePublishResults(results: InstatusPublishResult[]) {
  return {
    attempted: results.length,
    succeeded: results.filter((entry) => entry.ok).length,
    failed: results.filter((entry) => !entry.ok && !entry.skipped).length,
    skipped: results.filter((entry) => entry.skipped).length,
    failedComponents: results
      .filter((entry) => !entry.ok && !entry.skipped)
      .map((entry) => entry.component),
    skippedComponents: results
      .filter((entry) => entry.skipped)
      .map((entry) => entry.component),
  };
}

export async function GET(request: NextRequest) {
  if (!cronSecretMatches(request.headers.get('x-cron-secret'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const previousPings = await latestStatusPings();
    // Server env only — deliberately NOT `request.nextUrl.origin`: that derives from the
    // Host header, so a CRON_SECRET holder could aim these probes at an arbitrary host
    // (blind SSRF — status + latency leak reachability) and poison the status page.
    //
    // Without the key, publicBaseUrl() resolves from trusted sources only:
    // OWLETTE_STATUS_BASE_URL -> NEXT_PUBLIC_APP_URL -> RAILWAY_PUBLIC_DOMAIN ->
    // https://owlette.app. RAILWAY_PUBLIC_DOMAIN is platform-injected, so each Railway
    // service probes its own domain with no per-env config; the Vercel failover origin has
    // no RAILWAY_* vars and lands on the default. Mirrors trustedBaseUrl() in
    // /api/auth/forgot-password.
    const results = await runStatusHealthChecks({});
    const ping = await writeStatusPing(results);
    const updates = computeComponentStatusUpdates(
      results,
      previousPings[0]?.results,
      previousPings[1]?.results,
    );

    // Fail loud on the degrade transition (second consecutive failure) only, so a human sees
    // it without watching the status page — not every cycle.
    for (const update of updates) {
      if (update.reason !== 'second_consecutive_failure') continue;
      const detail = results.find((entry) => entry.component === update.component);
      console.error(
        `[status-ping] component degraded: ${update.component}`,
        detail?.error ?? '',
      );
      // Scoped by SENTRY_ALERTING_COMPONENTS — see the note on that constant.
      if (!SENTRY_ALERTING_COMPONENTS.has(update.component)) continue;
      // Non-identifying detail only: the error string has the safe summary, while raw
      // component metadata can carry a hostname (agent_registry.latest_machine_id).
      Sentry.captureMessage(`status.${update.component}_degraded`, {
        level: 'error',
        tags: { status_component: update.component, surface: 'status-ping' },
        extra: {
          error: detail?.error,
          status_code: detail?.status,
        },
      });
    }

    const publishResults = await publishStatusUpdates(updates);
    const configValidation = validateInstatusConfig();

    return NextResponse.json({
      ok: results.every((entry) => entry.ok),
      pingId: ping.pingId,
      checkedAt: ping.checkedAt,
      observedAtMs: ping.observedAtMs,
      results: summarizeHealthResults(results),
      updates: updates.map((update) => ({
        component: update.component,
        status: update.status,
        reason: update.reason,
      })),
      statusPage: {
        configured: configValidation.ok,
        missing: configValidation.missing,
        publish: summarizePublishResults(publishResults),
      },
    });
  } catch (error) {
    return apiError(error, 'cron/status-ping');
  }
}
