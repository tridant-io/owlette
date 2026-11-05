/**
 * Talon trigger matcher — fan-in from live fleet signals to talon runs.
 *
 * Schedule triggers are found by query; threshold and event triggers arrive at a
 * dispatcher first, so the talons that care must be looked up afterwards. This
 * is that lookup, and the only one — dispatch sites call {@link tapTalonMatcher}
 * and know nothing about talons beyond the signal shape they hand over.
 *
 * Signal sources (verified 2026-08-14): `/api/alerts/trigger` (threshold
 * breaches), `/api/agent/alert` (process_crash, process_start_failed,
 * exe_missing), `/api/cron/health-check` (machine_offline — nothing else can
 * report it). `process_restarted` and the `display_*` events are written by the
 * agent straight into `sites/{siteId}/logs` and reach here via the
 * `onTalonLogEventCreated` firestore trigger calling
 * `POST /api/talons/internal/match`.
 *
 * Taps never block and never throw: a run is slow (screenshot + vision model)
 * and a misconfigured talon must not turn its host route into a 500 — hence
 * fire-and-forget with a terminal catch, plus per-talon isolation inside
 * {@link matchAndRunTalons}.
 *
 * An event trigger's `delayMinutes` is NOT slept here: a `pending` deferral goes
 * into `talon_runs` and `/api/cron/talons` claims it once `runAfterAt` passes,
 * so the delay survives a deploy or a process restart.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { generateCorrelationId } from '@/lib/auditLog.server';
import logger from '@/lib/logger';
import { pausedByPlan, type PlanMemo } from '@/lib/planPause.server';
import { runTalon, type TalonRunSummary } from './engine.server';
import type { StoredTalon } from './store.server';
import { TALON_EVENT_TYPES, type TalonDoc, type TalonOperator, type TalonRunDoc } from './types';
import { MAX_TALONS_PER_SITE } from './validation';

/** A metric threshold was crossed on one machine. */
export interface TalonThresholdMatchEvent {
  kind: 'threshold';
  /** Raw dispatcher value — compared against `TALON_METRICS` members by equality. */
  metric: string;
  /** Raw dispatcher value — compared against `TALON_OPERATORS` members by equality. */
  operator: string;
  /** The observed metric value that breached, NOT the rule's bound. */
  value: number;
  machineId: string;
}

/** A catalog event landed. `machineId` absent only for a site-level event — see {@link matchesScope}. */
export interface TalonEventMatchEvent {
  kind: 'event';
  /** Raw dispatcher value — compared against `TALON_EVENT_TYPES` members by equality. */
  eventType: string;
  machineId?: string;
}

export type TalonMatchEvent = TalonThresholdMatchEvent | TalonEventMatchEvent;

/** What one dispatch did. `matched` counts TALONS; `runs` counts EXECUTIONS. */
export interface TalonMatchResult {
  /** Talons whose trigger and scope both matched the signal. */
  matched: number;
  /** Every run recorded, across all matched talons — a visual-check talon contributes one per machine. */
  runs: TalonRunSummary[];
}

/**
 * Does the breach value satisfy the talon's OWN predicate? The payload only
 * proves an alert rule fired: rule `cpu_percent > 80` and talon `cpu_percent >
 * 95` are different questions, and 84% answers only the first. `default` is
 * reachable — `operator` is typed off a Firestore document.
 */
function satisfiesThreshold(value: number, operator: TalonOperator, bound: number): boolean {
  switch (operator) {
    case '>':
      return value > bound;
    case '<':
      return value < bound;
    case '>=':
      return value >= bound;
    case '<=':
      return value <= bound;
    default:
      return false;
  }
}

/**
 * `machineIds === null` — or any non-array, which is what validateTalonInput
 * normalizes a missing scope to — means every machine and matches anything. A
 * machine-scoped talon needs the signal to name one of its machines, so a
 * site-level signal (no `machineId`) matches only the all-machines talons.
 */
function matchesScope(machineIds: unknown, eventMachineId: string | undefined): boolean {
  if (!Array.isArray(machineIds)) return true;
  if (typeof eventMachineId !== 'string' || eventMachineId.length === 0) return false;
  return machineIds.includes(eventMachineId);
}

/** Does this talon subscribe to the signal, on a machine it is scoped to? */
function matchesEvent(talon: StoredTalon, event: TalonMatchEvent): boolean {
  const trigger = talon.trigger;
  if (!trigger) return false;
  if (!matchesScope(talon.scope?.machineIds, event.machineId)) return false;

  if (event.kind === 'threshold') {
    return (
      trigger.type === 'threshold' &&
      trigger.metric === event.metric &&
      trigger.operator === event.operator &&
      satisfiesThreshold(event.value, trigger.operator, trigger.value)
    );
  }

  return (
    trigger.type === 'event' &&
    Array.isArray(trigger.eventTypes) &&
    trigger.eventTypes.some((eventType) => eventType === event.eventType)
  );
}

/**
 * Lowercase one-liner for the run record: what happened, not what the talon
 * subscribes to (describeTrigger covers that). For a breach the observed value
 * is the operational fact; the bound is only context.
 */
function describeMatch(talon: StoredTalon, event: TalonMatchEvent): string {
  if (event.kind === 'event') return `on ${event.eventType}`;
  // Guard only narrows the union for the compiler — a matched threshold event
  // always carries a threshold trigger.
  const bound = talon.trigger.type === 'threshold' ? ` ${talon.trigger.value}` : '';
  return `${event.metric} ${event.value} crossed ${event.operator}${bound}`;
}

/**
 * The talon's configured wait in whole minutes, 0 for "run now". Only event
 * triggers can carry one (validateTalonInput rejects it on the others), so a
 * threshold breach never defers. Read defensively: `trigger` comes off Firestore.
 */
function eventDelayMinutes(talon: StoredTalon): number {
  const trigger = talon.trigger;
  if (!trigger || trigger.type !== 'event') return 0;
  const delay = trigger.delayMinutes;
  if (typeof delay !== 'number' || !Number.isFinite(delay) || delay <= 0) return 0;
  return Math.floor(delay);
}

/**
 * Record the intent to run `delayMinutes` from now and let the sweep do it.
 *
 * Coalescing: a crash loop during the wait must produce ONE run, so this skips
 * when a `pending` deferral for the same talon+machine already exists. Two
 * equality filters (talonId, status) off Firestore's automatic single-field
 * indexes, machine compared in memory — a site-level deferral has no `machineId`
 * field and `where('machineId','==',null)` does not match a missing field.
 *
 * Deliberately non-transactional: simultaneous events can both write, which is
 * benign (each deferral is claimed once, the second fire hits the cooldown), and
 * serializing the hot path is the worse trade. Coalescing is silent by design.
 */
async function deferTalonRun(
  db: Firestore,
  siteId: string,
  talon: StoredTalon,
  event: TalonEventMatchEvent,
  delayMinutes: number,
  now: Date,
): Promise<void> {
  const runs = db.collection('sites').doc(siteId).collection('talon_runs');

  const pending = await runs
    .where('talonId', '==', talon.id)
    .where('status', '==', 'pending')
    .get();

  const machineId = event.machineId ?? null;
  const alreadyPending = pending.docs.some(
    (doc) => ((doc.data() as TalonRunDoc).machineId ?? null) === machineId,
  );
  if (alreadyPending) return;

  // `machineName` omitted on purpose — resolving it costs a machine read per
  // event. The fired run resolves it; the run list falls back to the id.
  const deferral: TalonRunDoc = {
    talonId: talon.id,
    talonName: talon.name,
    triggerType: 'event',
    triggerSummary: `${describeMatch(talon, event)} · after ${delayMinutes} min`,
    ...(event.machineId ? { machineId: event.machineId } : {}),
    status: 'pending',
    // Equal by construction: the deferral lifecycle reads `createdAt`, the run
    // history orders by `startedAt` (see TalonRunDoc).
    createdAt: now,
    startedAt: now,
    runAfterAt: new Date(now.getTime() + delayMinutes * 60_000),
    outputs: [],
    correlationId: generateCorrelationId(),
    ...(talon.chatId ? { chatId: talon.chatId } : {}),
  };

  await runs.add(deferral);
}

/**
 * The site's enabled talons: `enabled` filtered server-side, capped at
 * {@link MAX_TALONS_PER_SITE}. The cap is belt-and-braces — createTalon counts
 * before writing rather than transacting, so a race can leave a site marginally
 * over, and a signal must not fan out unbounded runs. Trigger type and scope are
 * matched in memory; at N ≤ 20 a second query buys nothing.
 */
async function readEnabledTalons(db: Firestore, siteId: string): Promise<StoredTalon[]> {
  const snapshot = await db
    .collection('sites')
    .doc(siteId)
    .collection('talons')
    .where('enabled', '==', true)
    .limit(MAX_TALONS_PER_SITE)
    .get();

  return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as TalonDoc) }));
}

/**
 * Find every talon subscribed to `event` and run it. Sequential, individually
 * isolated — one throwing talon (dead webhook, lost write race) must not stop
 * the others. Cooldown, the in-flight guard and the auto-disable backoff belong
 * to the engine. A talon carrying a delay is deferred instead of run: it counts
 * as matched but contributes no run until the sweep fires it.
 *
 * Paused — nothing run or deferred — when the site's payer has no
 * `owlette.talons`; pass a batch's `planMemo` to resolve each payer once.
 */
export async function matchAndRunTalons(
  db: Firestore,
  siteId: string,
  event: TalonMatchEvent,
  planMemo?: PlanMemo,
): Promise<TalonMatchResult> {
  // A non-numeric breach cannot be compared against a bound. Dropped here so
  // each dispatcher stays free to forward what it was handed.
  if (event.kind === 'threshold' && !Number.isFinite(event.value)) {
    logger.warn(`Talon matcher dropped a non-numeric ${event.metric} breach`, {
      context: 'talons/matcher',
      data: { siteId, machineId: event.machineId },
    });
    return { matched: 0, runs: [] };
  }

  // Catalog check BEFORE the read: `/api/agent/alert` taps this for
  // `connection_failure` on every alert, which must not cost a query each.
  if (event.kind === 'event' && !TALON_EVENT_TYPES.some((type) => type === event.eventType)) {
    return { matched: 0, runs: [] };
  }

  const matches = (await readEnabledTalons(db, siteId)).filter((talon) =>
    matchesEvent(talon, event),
  );
  if (matches.length === 0) return { matched: 0, runs: [] };

  // after the talon read on purpose: most signals match nothing, and checking
  // first would charge every one of them the lookup.
  if (await pausedByPlan(siteId, 'owlette.talons', planMemo)) {
    logger.warn("Talon matching paused: the site's plan has no talons", {
      context: 'talons/matcher',
      data: { siteId, kind: event.kind, talons: matches.length },
    });
    return { matched: 0, runs: [] };
  }

  const now = new Date();
  const runs: TalonRunSummary[] = [];
  for (const talon of matches) {
    try {
      if (event.kind === 'event') {
        const delayMinutes = eventDelayMinutes(talon);
        if (delayMinutes > 0) {
          await deferTalonRun(db, siteId, talon, event, delayMinutes, now);
          continue;
        }
      }

      runs.push(
        ...(await runTalon(db, talon, {
          siteId,
          ...(event.machineId ? { machineId: event.machineId } : {}),
          triggerSummary: describeMatch(talon, event),
        })),
      );
    } catch (error) {
      logger.error(`Talon ${talon.id} threw while running from a ${event.kind} signal`, {
        context: 'talons/matcher',
        data: { siteId, error: String(error) },
      });
    }
  }

  return { matched: matches.length, runs };
}

/**
 * Fire-and-forget {@link matchAndRunTalons}. The caller's response must not wait
 * on a talon run, nor fail because one did; every rejection terminates here.
 */
export function tapTalonMatcher(
  db: Firestore,
  siteId: string,
  event: TalonMatchEvent,
  planMemo?: PlanMemo,
): void {
  void matchAndRunTalons(db, siteId, event, planMemo).catch((error) => {
    logger.error('Talon matcher tap failed', {
      context: 'talons/matcher',
      data: { siteId, kind: event.kind, error: String(error) },
    });
  });
}
