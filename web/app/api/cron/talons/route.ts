/**
 * GET /api/cron/talons — the schedule sweep. Runs once a minute on cron-job.org
 * (NOT Railway — see `docs/runbooks/talons.md`); auth is `X-Cron-Secret` vs
 * per-env `CRON_SECRET`. Threshold and (non-delayed) event talons never appear
 * here.
 *
 * Two passes, deferrals FIRST: a deferral past {@link MISSED_FIRE_GRACE_MS} is
 * written off permanently, whereas a schedule that runs out of budget keeps its
 * `nextRunAt` and is claimed next minute. The deferral pass is fault-isolated
 * because its collection-group index may still be building.
 *
 * Scheduled hoot follow-ups ride this cron too (decision 2026-08-11), as a
 * third fault-isolated pass — `fireDueFollowups` dispatches without awaiting
 * the turns, so it costs the schedule pass little of the budget.
 *
 * Claiming is transactional: overlapping sweeps (slow run, or both LB origins
 * hit) must never fire a talon twice, so the claim re-reads, re-checks and
 * advances `nextRunAt` in one commit. The loser skips silently.
 *
 * Stalled sweeps must not burst on recovery: anything more than
 * {@link MISSED_FIRE_GRACE_MS} late is recorded `missed` and skipped, so a
 * one-hour outage does not reboot twelve machines at once.
 *
 * Caps: {@link MAX_CLAIMS_PER_SWEEP} claims, none past {@link SWEEP_BUDGET_MS};
 * leftovers are reported as `deferred`, not dropped.
 */
import { NextRequest, NextResponse } from 'next/server';
import { FieldValue, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import { apiError } from '@/lib/apiErrorResponse';
import { generateCorrelationId } from '@/lib/auditLog.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { timestampToMs } from '@/lib/firestoreTime.server';
import {
  fireDueFollowups,
  type FollowupSweepCounts,
} from '@/lib/hoot/followupSweep.server';
import logger from '@/lib/logger';
import { createPlanMemo, pausedByPlan, type PlanMemo } from '@/lib/planPause.server';
import { runTalon, STALE_RUN_MS } from '@/lib/talons/engine.server';
import { computeNextRunAt } from '@/lib/talons/schedule.server';
import { getSiteTimezone, getTalon, type StoredTalon } from '@/lib/talons/store.server';
import type { TalonDoc, TalonRunDoc } from '@/lib/talons/types';

/** Fleet-wide budget of 25 executions/minute; backlogs drain across sweeps. */
const MAX_CLAIMS_PER_SWEEP = 25;

/**
 * Wall-clock claim budget: inside the 60s cadence so a sweep finishes before its
 * successor starts, and inside cron-job.org's request timeout.
 */
const SWEEP_BUDGET_MS = 50_000;

/**
 * How late a schedule (or deferred event trigger) may fire before write-off.
 * Wider than a normal hiccup, narrower than any outage worth noticing — also
 * where the `talon_dispatch` health component starts reporting degraded.
 */
const MISSED_FIRE_GRACE_MS = 10 * 60_000;

/** Stale `running` runs closed out per sweep. */
const STALE_RUN_SCAN_LIMIT = 50;

/** Same budget/reasoning as {@link MAX_CLAIMS_PER_SWEEP}; leftovers stay pending. */
const MAX_DEFERRAL_CLAIMS_PER_SWEEP = 25;

/** Recorded as the trigger summary on every run this sweep produces. */
const SCHEDULE_TRIGGER_SUMMARY = 'schedule';

/** A talon this sweep owns, and the instant it was due at before the claim. */
interface TalonClaim {
  talon: StoredTalon;
  dueAtMs: number;
}

function talonRunsCollection(db: Firestore, siteId: string) {
  return db.collection('sites').doc(siteId).collection('talon_runs');
}

/**
 * Take ownership of a due talon and re-arm it, atomically.
 *
 * @returns `null` when this sweep must NOT execute it: disabled, deleted,
 *          already claimed by a concurrent sweep, or no longer a schedule.
 */
async function claimDueTalon(
  db: Firestore,
  ref: DocumentReference,
  timezone: string,
  now: Date,
): Promise<TalonClaim | null> {
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const data = snapshot.exists ? (snapshot.data() as TalonDoc | undefined) : undefined;
    // Disabled or deleted between the collection-group query and the claim.
    if (!data || data.enabled !== true) return null;

    const dueAtMs = timestampToMs(data.nextRunAt);
    // Already advanced by another sweep — a normal outcome, not an error.
    if (dueAtMs === null || dueAtMs > now.getTime()) return null;

    const nextRunAt = computeNextRunAt(data.trigger, timezone, now);
    if (!nextRunAt) {
      // Trigger edited away from a schedule (or no reachable slot) leaving a
      // stale `nextRunAt`. Drop it, or it matches `<= now` on every sweep.
      transaction.update(ref, { nextRunAt: FieldValue.delete() });
      return null;
    }

    transaction.update(ref, { nextRunAt });
    return { talon: { id: ref.id, ...data }, dueAtMs };
  });
}

/**
 * Record a fire skipped for being too far past its slot. Written as a real run
 * so the operator sees WHY nothing happened at 03:00 — an absent run reads
 * identically to a talon nobody configured.
 */
async function recordMissedRun(
  db: Firestore,
  siteId: string,
  talon: StoredTalon,
  now: Date,
): Promise<void> {
  const run: TalonRunDoc = {
    talonId: talon.id,
    talonName: talon.name,
    triggerType: 'schedule',
    triggerSummary: SCHEDULE_TRIGGER_SUMMARY,
    status: 'missed',
    startedAt: now,
    completedAt: now,
    durationMs: 0,
    outputs: [],
    correlationId: generateCorrelationId(),
    error: 'missed_fire_window',
    ...(talon.chatId ? { chatId: talon.chatId } : {}),
  };

  await talonRunsCollection(db, siteId).add(run);
}

/** What one sweep did with the deferrals that came due. */
interface DeferralSweepCounts {
  due: number;
  fired: number;
  missed: number;
  skipped: number;
}

/** A deferral this sweep owns, and what it is allowed to do with it. */
interface DeferralClaim {
  outcome: 'fire' | 'missed';
  deferral: TalonRunDoc;
}

/**
 * Take ownership of one due deferral, atomically. The status flip out of
 * `pending` IS the claim, so an overlapping sweep re-reads a non-pending doc.
 * A deferral more than {@link MISSED_FIRE_GRACE_MS} past its instant is written
 * off in the same transaction — a three-minute post-crash check is not worth
 * carrying out forty minutes later.
 *
 * @returns `null` when another sweep already resolved it.
 */
async function claimDueDeferral(
  db: Firestore,
  ref: DocumentReference,
  now: Date,
): Promise<DeferralClaim | null> {
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const data = snapshot.exists ? (snapshot.data() as TalonRunDoc | undefined) : undefined;
    if (!data || data.status !== 'pending') return null;

    const runAfterMs = timestampToMs(data.runAfterAt);
    // Guard against a stale query result; leaving it pending is the safe answer.
    if (runAfterMs === null || runAfterMs > now.getTime()) return null;

    if (now.getTime() - runAfterMs > MISSED_FIRE_GRACE_MS) {
      transaction.update(ref, {
        status: 'missed',
        error: 'missed_fire_window',
        completedAt: now,
        durationMs: 0,
      });
      return { outcome: 'missed', deferral: data };
    }

    transaction.update(ref, { status: 'fired', firedAt: now });
    return { outcome: 'fire', deferral: data };
  });
}

/**
 * Run the talon a claimed deferral was waiting for, and close the crumb out.
 * The talon is re-read, not reconstructed from the deferral: it may have been
 * edited, disabled or deleted in the intervening minutes — a deferral is a
 * promise to reconsider running, not to run.
 *
 * An empty summary list means the engine's cooldown gate stopped it, the one
 * outcome that records nothing of its own, so the crumb must record it.
 *
 * @returns which counter this deferral belongs in.
 */
async function fireClaimedDeferral(
  db: Firestore,
  siteId: string,
  ref: DocumentReference,
  deferral: TalonRunDoc,
  now: Date,
  planMemo: PlanMemo,
): Promise<'fired' | 'skipped'> {
  const talon = await getTalon(db, siteId, deferral.talonId);
  const paused = talon?.enabled === true && (await pausedByPlan(siteId, 'owlette.talons', planMemo));
  if (!talon || talon.enabled !== true || paused) {
    await ref.update({
      status: 'skipped',
      error: paused ? 'plan_paused' : talon ? 'talon_disabled' : 'talon_deleted',
      completedAt: now,
      durationMs: 0,
    });
    return 'skipped';
  }

  const startedMs = Date.now();
  const summaries = await runTalon(db, talon, {
    siteId,
    ...(deferral.machineId ? { machineId: deferral.machineId } : {}),
    triggerSummary: deferral.triggerSummary,
  });

  const completedAt = new Date();
  await ref.update({
    ...(summaries.length === 0 ? { status: 'skipped', error: 'cooldown' } : {}),
    firedRunIds: summaries.map((summary) => summary.runId),
    completedAt,
    // Times the FIRE, not the wait, or every 3-minute deferral reads as a
    // 3-minute run.
    durationMs: completedAt.getTime() - startedMs,
  });

  return summaries.length === 0 ? 'skipped' : 'fired';
}

/**
 * Fire every deferral whose wait has expired. Backed by the `talon_runs`
 * collection-group index (`status` ASC, `runAfterAt` ASC). Oldest first, so a
 * backlog drains in event order.
 */
async function fireDueDeferrals(
  db: Firestore,
  now: Date,
  deadline: number,
): Promise<DeferralSweepCounts> {
  const snapshot = await db
    .collectionGroup('talon_runs')
    .where('status', '==', 'pending')
    .where('runAfterAt', '<=', now)
    .orderBy('runAfterAt', 'asc')
    .limit(MAX_DEFERRAL_CLAIMS_PER_SWEEP)
    .get();

  const counts: DeferralSweepCounts = {
    due: snapshot.docs.length,
    fired: 0,
    missed: 0,
    skipped: 0,
  };
  const planMemo = createPlanMemo();

  for (const doc of snapshot.docs) {
    // Leftovers stay `pending` with `runAfterAt` untouched — next sweep claims
    // them, still inside the grace window.
    if (Date.now() >= deadline) {
      logger.warn('Talon deferral pass hit the sweep budget with work left', {
        context: 'cron/talons',
      });
      break;
    }

    const siteId = doc.ref.parent.parent?.id;
    if (!siteId) {
      logger.warn(`Talon deferral ${doc.id} has no parent site — skipping`, {
        context: 'cron/talons',
      });
      continue;
    }

    try {
      const claim = await claimDueDeferral(db, doc.ref, now);
      if (!claim) continue;

      if (claim.outcome === 'missed') {
        counts.missed += 1;
        logger.warn(
          `Talon deferral ${doc.id} missed its window — not executing ${claim.deferral.talonId}`,
          { context: 'cron/talons', data: { siteId } },
        );
        continue;
      }

      const outcome = await fireClaimedDeferral(db, siteId, doc.ref, claim.deferral, now, planMemo);
      counts[outcome] += 1;
    } catch (error) {
      // One deferral's failure must not abort the pass.
      logger.error(`Talon deferral failed for ${siteId}/${doc.id}`, {
        context: 'cron/talons',
        data: { error: String(error) },
      });
    }
  }

  return counts;
}

/**
 * Close out runs abandoned mid-flight (owning process killed or redeployed).
 * The engine's in-flight guard covers the SAME talon executing again; this
 * covers the talon that never does — a stuck `running` run blocks it forever.
 *
 * @returns how many runs were closed out.
 */
async function recoverStaleRuns(db: Firestore, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_RUN_MS);
  const snapshot = await db
    .collectionGroup('talon_runs')
    .where('status', '==', 'running')
    .where('startedAt', '<=', cutoff)
    .limit(STALE_RUN_SCAN_LIMIT)
    .get();

  let recovered = 0;
  for (const doc of snapshot.docs) {
    const startedMs = timestampToMs((doc.data() as TalonRunDoc).startedAt);
    try {
      await doc.ref.update({
        status: 'failed',
        error: 'stale',
        completedAt: now,
        ...(startedMs !== null ? { durationMs: now.getTime() - startedMs } : {}),
      });
      recovered += 1;
    } catch (error) {
      logger.warn(`Talon run ${doc.id} could not be closed out as stale`, {
        context: 'cron/talons',
        data: { error: String(error) },
      });
    }
  }

  return recovered;
}

export async function GET(request: NextRequest) {
  const cronSecret = request.headers.get('x-cron-secret');
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getAdminDb();
  const now = new Date();
  const deadline = Date.now() + SWEEP_BUDGET_MS;

  // Janitor first and outside the sweep's error path: a wedged run blocks its
  // talon, and a janitor failure (usually a still-building index) must not take
  // dispatch down with it.
  let staleRecovered = 0;
  try {
    staleRecovered = await recoverStaleRuns(db, now);
  } catch (error) {
    logger.error('Talon stale-run recovery failed', {
      context: 'cron/talons',
      data: { error: String(error) },
    });
  }

  // Deferrals before schedules and isolated from them — see the two-pass note
  // at the top of the file.
  let deferrals: DeferralSweepCounts = { due: 0, fired: 0, missed: 0, skipped: 0 };
  try {
    deferrals = await fireDueDeferrals(db, now, deadline);
  } catch (error) {
    logger.error('Talon deferral dispatch failed', {
      context: 'cron/talons',
      data: { error: String(error) },
    });
  }

  // Follow-ups are a different feature sharing this cadence — isolated so a
  // hoot failure (or a still-building `cortex-followups` index) cannot stop a
  // talon from firing.
  let followups: FollowupSweepCounts = {
    due: 0,
    fired: 0,
    failed: 0,
    skipped: 0,
    turnActive: 0,
  };
  try {
    followups = await fireDueFollowups(db, now, deadline);
  } catch (error) {
    logger.error('Hoot follow-up dispatch failed', {
      context: 'cron/talons',
      data: { error: String(error) },
    });
  }

  try {
    const dueSnapshot = await db
      .collectionGroup('talons')
      .where('enabled', '==', true)
      .where('nextRunAt', '<=', now)
      .orderBy('nextRunAt', 'asc')
      .limit(MAX_CLAIMS_PER_SWEEP)
      .get();

    const due = dueSnapshot.docs.length;
    // One timezone read per site per sweep, not per talon.
    const timezones = new Map<string, string>();
    const planMemo = createPlanMemo();
    let executed = 0;
    let missed = 0;
    let deferred = 0;

    for (let index = 0; index < dueSnapshot.docs.length; index++) {
      if (Date.now() >= deadline) {
        // Leftovers keep their `nextRunAt` and are still due next minute.
        deferred = due - index;
        logger.warn(`Talon sweep hit its ${SWEEP_BUDGET_MS}ms budget with ${deferred} talon(s) left`, {
          context: 'cron/talons',
        });
        break;
      }

      const doc = dueSnapshot.docs[index];
      const siteId = doc.ref.parent.parent?.id;
      if (!siteId) {
        logger.warn(`Talon ${doc.id} has no parent site — skipping`, { context: 'cron/talons' });
        continue;
      }

      try {
        let timezone = timezones.get(siteId);
        if (timezone === undefined) {
          timezone = await getSiteTimezone(db, siteId);
          timezones.set(siteId, timezone);
        }

        const claim = await claimDueTalon(db, doc.ref, timezone, now);
        if (!claim) continue;

        if (now.getTime() - claim.dueAtMs > MISSED_FIRE_GRACE_MS) {
          await recordMissedRun(db, siteId, claim.talon, now);
          missed += 1;
          logger.warn(
            `Talon ${claim.talon.id} missed its window by ` +
              `${Math.round((now.getTime() - claim.dueAtMs) / 60_000)}m — not executing`,
            { context: 'cron/talons', data: { siteId } },
          );
          continue;
        }

        // the claim already moved nextRunAt on, so a paused talon simply waits for its next slot
        if (await pausedByPlan(siteId, 'owlette.talons', planMemo)) continue;

        await runTalon(db, claim.talon, { siteId, triggerSummary: SCHEDULE_TRIGGER_SUMMARY });
        executed += 1;
      } catch (error) {
        // One talon's failure must never abort the sweep.
        logger.error(`Talon sweep failed for ${siteId}/${doc.id}`, {
          context: 'cron/talons',
          data: { error: String(error) },
        });
      }
    }

    // `deferred` = schedule-pass leftovers; the `deferred*` fields are the
    // delayed-event pass. Unrelated despite the names.
    return NextResponse.json({
      ok: true,
      due,
      executed,
      missed,
      deferred,
      staleRecovered,
      deferredDue: deferrals.due,
      deferredFired: deferrals.fired,
      deferredMissed: deferrals.missed,
      deferredSkipped: deferrals.skipped,
      followupDue: followups.due,
      followupFired: followups.fired,
      followupFailed: followups.failed,
      followupSkipped: followups.skipped,
      followupTurnActive: followups.turnActive,
    });
  } catch (error) {
    return apiError(error, 'cron/talons');
  }
}
