/**
 * Scheduled-rollout sweep. Every 5 minutes, fires the rollouts that
 * `POST /api/roosts/{roostId}/deploy` parked at `stage: 'scheduled'` with a
 * future `scheduleAt` — without this nothing ever moves them off that stage.
 *
 * Firing means entering the SAME pipeline an immediate deploy enters: flip the
 * rollout to `canary` and queue one `sync_pull` per canary machine under the
 * deterministic `roost_sync_{roostId}_{versionId}` id (lib/syncPullCommand.ts).
 * `onTargetStateWritten` in distributionFanout.ts takes it from there — canary →
 * fleet → complete. No rollout logic is duplicated here.
 *
 * Claim: the stage flip IS the claim, and it happens in the same transaction as
 * the command writes, so two overlapping sweeps cannot both fire one rollout and
 * no rollout can be left flipped with no commands queued. The canary is capped
 * at 50 machines (CANARY_MAX), so a claim is at most 51 writes.
 *
 * Missed windows: anything more than {@link MISSED_FIRE_GRACE_MS} past its slot
 * is written off as `aborted` rather than fired, so a stalled sweep does not
 * push an overnight rollout to a whole fleet at midday — the same posture the
 * talon cron takes (`web/app/api/cron/talons/route.ts`). `aborted` is terminal,
 * so the operator can simply deploy that version again.
 *
 * Kill switch: a site with `roostEnabled: false` is skipped untouched (no fire,
 * no write-off) until the switch flips back. Fail-open on a read error, as the
 * web and agent mirrors do.
 *
 * plan gate (plan.md decision 13): a due rollout whose site owner's plan
 * snapshot withholds roost or control is written off as `aborted`, with the
 * reason, instead of fired, but only when the snapshot is newer than the
 * rollout. one scheduled after it passed the web's live entitlement check,
 * which is fresher, so a payer who just upgraded is not refused on a day-old
 * snapshot. unlike the kill switch it is not left `scheduled`: a lapse lasts far
 * past the grace window, and those rollouts would sit at the head of the
 * oldest-first due query and starve every other site's.
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import {
  planBlockReason,
  readSitePlanSnapshot,
  type PlanSnapshot,
  type PlanSnapshotFlag,
} from './lib/planSnapshot';
import { buildSyncPullCommand, syncPullCommandId } from './lib/syncPullCommand';
import {
  decideScheduledRollout,
  isRoostEnabled,
  DEFAULT_EXTRACT_ROOT,
  MISSED_FIRE_GRACE_MS,
  ROOST_ENABLED_FIELD,
  type ScheduledRolloutDecision,
} from './lib/rolloutScheduleLogic';

/**
 * Rollouts claimed per sweep. Same fleet-wide budget as the talon cron: a
 * backlog drains across sweeps rather than firing everything at once.
 */
const MAX_CLAIMS_PER_SWEEP = 25;

// a scheduled rollout is a roost deploy (decision 8) that queues machine commands, which are control (decision 7).
const ROLLOUT_PLAN_FLAGS: readonly PlanSnapshotFlag[] = ['roost', 'control'];

/** Identifies one `sites/{siteId}/roosts/{roostId}/rollouts/{versionId}` doc. */
export interface ScheduledRolloutRef {
  siteId: string;
  roostId: string;
  /** Rollouts are keyed by version id — `rolloutId` in the API. */
  versionId: string;
}

/** The fields the claim reads off the rollout doc. */
export interface RolloutDocData {
  stage?: unknown;
  scheduledAt?: unknown;
  versionUrl?: unknown;
  extractRoot?: unknown;
  canary?: unknown;
  /** set by the deploy route when it parks the rollout: when it was scheduled. */
  startedAt?: unknown;
}

/**
 * The subset of `Transaction` the claim writes through. A
 * `WriteBatch | Transaction` union doesn't narrow — their set() generics differ
 * (same reason distributionFanout.ts declares its own `Writable`).
 */
export interface ClaimWriter {
  set(
    ref: FirebaseFirestore.DocumentReference,
    data: FirebaseFirestore.DocumentData,
    options: FirebaseFirestore.SetOptions,
  ): unknown;
  update(
    ref: FirebaseFirestore.DocumentReference,
    data: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData>,
  ): unknown;
}

/** Where a claim writes: the rollout itself, and each machine's command queue. */
export interface ClaimTargets {
  rolloutRef: FirebaseFirestore.DocumentReference;
  /** `sites/{siteId}/machines/{machineId}/commands/pending`. */
  pendingCommandRef(machineId: string): FirebaseFirestore.DocumentReference;
}

export interface ClaimArgs {
  writer: ClaimWriter;
  targets: ClaimTargets;
  ref: ScheduledRolloutRef;
  /** The rollout doc as re-read inside the claim, or null if it is gone. */
  data: RolloutDocData | null;
  nowMs: number;
  graceMs: number;
  /** the site payer's plan snapshot, or null to proceed. */
  planSnapshot: PlanSnapshot | null;
}

/** Firestore Timestamp | number | Date → epoch ms, else null. */
function toMillis(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.getTime();
  const maybe = value as { toMillis?: () => number } | null | undefined;
  if (maybe && typeof maybe.toMillis === 'function') {
    const ms = maybe.toMillis();
    return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * why the plan withholds this rollout, or null to fire it. the snapshot applies
 * only when it is newer than the rollout; a rollout with no `startedAt` counts
 * as older, and a snapshot with no readable `resolvedAt` as never newer.
 */
function rolloutPlanBlock(snapshot: PlanSnapshot | null, startedAt: unknown): string | null {
  if (!snapshot) return null;
  const startedMs = toMillis(startedAt);
  const resolvedMs = toMillis(snapshot.resolvedAt);
  if (startedMs !== null && (resolvedMs === null || resolvedMs <= startedMs)) return null;
  return planBlockReason(snapshot, ROLLOUT_PLAN_FLAGS);
}

/**
 * Decide and write, inside the caller's transaction. Returns what it applied.
 *
 * All writes for one rollout land here so the stage flip and the canary commands
 * commit together — see the claim note at the top of the file.
 */
export function applyScheduledRolloutClaim(args: ClaimArgs): ScheduledRolloutDecision {
  const { writer, targets, ref, data, nowMs, graceMs, planSnapshot } = args;

  // Deleted between the due query and the claim — nothing to claim.
  if (!data) return { action: 'skip', reason: 'claimed' };

  const canary = Array.isArray(data.canary)
    ? (data.canary as unknown[]).filter(
        (machineId): machineId is string =>
          typeof machineId === 'string' && machineId.length > 0,
      )
    : [];
  const versionUrl = typeof data.versionUrl === 'string' ? data.versionUrl : '';

  let decision = decideScheduledRollout(
    {
      stage: data.stage,
      scheduledAtMs: toMillis(data.scheduledAt),
      canaryCount: canary.length,
      hasVersionUrl: versionUrl.length > 0,
    },
    nowMs,
    graceMs,
  );
  const planBlock = decision.action === 'fire' ? rolloutPlanBlock(planSnapshot, data.startedAt) : null;
  if (planBlock) decision = { action: 'write_off', reason: planBlock };

  if (decision.action === 'skip') return decision;

  if (decision.action === 'write_off') {
    // Same shape distributionFanout.ts writes when a canary aborts, so the
    // rollout detail endpoint renders it without a special case.
    writer.update(targets.rolloutRef, {
      stage: 'aborted',
      abortedAt: FieldValue.serverTimestamp(),
      abortReason: decision.reason,
    });
    return decision;
  }

  const extractRoot =
    typeof data.extractRoot === 'string' && data.extractRoot.trim()
      ? data.extractRoot.trim()
      : DEFAULT_EXTRACT_ROOT;

  writer.update(targets.rolloutRef, {
    stage: 'canary',
    // The canary starts now; `scheduledAt` keeps the instant that was requested
    // and `startedAt` was only ever the moment the rollout was queued.
    startedAt: FieldValue.serverTimestamp(),
    scheduledFiredAt: FieldValue.serverTimestamp(),
  });

  const cmdId = syncPullCommandId(ref.roostId, ref.versionId);
  for (const machineId of canary) {
    writer.set(
      targets.pendingCommandRef(machineId),
      {
        [cmdId]: buildSyncPullCommand(
          ref.siteId,
          ref.roostId,
          ref.versionId,
          versionUrl,
          extractRoot,
          FieldValue.serverTimestamp(),
        ),
      },
      { merge: true },
    );
  }

  return decision;
}

/** Firestore access the sweep needs, injectable so the loop is testable. */
export interface RolloutScheduleStore {
  /** Rollouts at `stage: 'scheduled'` due at or before `nowMs`, oldest first. */
  listDue(nowMs: number, limit: number): Promise<ScheduledRolloutRef[]>;
  /** Raw `roostEnabled` field off `sites/{siteId}`; undefined when absent. */
  readRoostEnabled(siteId: string): Promise<unknown>;
  /** the plan snapshot of the site's payer, or null to proceed. */
  readPlanSnapshot(siteId: string): Promise<PlanSnapshot | null>;
  /** Transactionally re-read the rollout and apply `applyScheduledRolloutClaim`. */
  claim(
    ref: ScheduledRolloutRef,
    nowMs: number,
    graceMs: number,
    planSnapshot: PlanSnapshot | null,
  ): Promise<ScheduledRolloutDecision>;
}

export interface SweepDeps {
  store: RolloutScheduleStore;
  now?: () => number;
  limit?: number;
  graceMs?: number;
}

export interface ScheduledSweepCounts {
  /** Rollouts the due query returned. */
  due: number;
  fired: number;
  /** Written off — missed window, or unusable rollout state. */
  missed: number;
  /** Already claimed elsewhere, or no longer due on re-read. */
  skipped: number;
  /** Left alone because the site's roost kill switch is engaged. */
  disabled: number;
  /** written off because the site owner's plan withholds the rollout. */
  planBlocked: number;
  failed: number;
}

/**
 * Claim and fire every scheduled rollout that has come due. One rollout's
 * failure never aborts the sweep — the next sweep retries it, still inside the
 * grace window.
 */
export async function sweepDueScheduledRollouts(
  deps: SweepDeps,
): Promise<ScheduledSweepCounts> {
  const nowMs = deps.now ? deps.now() : Date.now();
  const limit = deps.limit ?? MAX_CLAIMS_PER_SWEEP;
  const graceMs = deps.graceMs ?? MISSED_FIRE_GRACE_MS;

  const due = await deps.store.listDue(nowMs, limit);
  const counts: ScheduledSweepCounts = {
    due: due.length,
    fired: 0,
    missed: 0,
    skipped: 0,
    disabled: 0,
    planBlocked: 0,
    failed: 0,
  };

  // One kill-switch read per site per sweep, not per rollout. Same for the plan.
  const enabledBySite = new Map<string, boolean>();
  const snapshotBySite = new Map<string, PlanSnapshot | null>();

  for (const ref of due) {
    const label = `${ref.siteId}/${ref.roostId}/${ref.versionId}`;
    try {
      let enabled = enabledBySite.get(ref.siteId);
      if (enabled === undefined) {
        enabled = await readRoostEnabledFailOpen(deps.store, ref.siteId);
        enabledBySite.set(ref.siteId, enabled);
      }
      if (!enabled) {
        counts.disabled += 1;
        console.warn(
          `[rolloutScheduler] roost disabled for site ${ref.siteId}; ` +
            `leaving ${label} scheduled`,
        );
        continue;
      }

      if (!snapshotBySite.has(ref.siteId)) {
        snapshotBySite.set(ref.siteId, await deps.store.readPlanSnapshot(ref.siteId));
      }
      const snapshot = snapshotBySite.get(ref.siteId) ?? null;

      const decision = await deps.store.claim(ref, nowMs, graceMs, snapshot);
      if (decision.action === 'fire') {
        counts.fired += 1;
        console.log(`[rolloutScheduler] ${label}: scheduled rollout fired; canary wave queued`);
      } else if (decision.action === 'write_off') {
        // a late rollout is written off for lateness first, and counts as missed.
        if (decision.reason === planBlockReason(snapshot, ROLLOUT_PLAN_FLAGS)) counts.planBlocked += 1;
        else counts.missed += 1;
        console.warn(`[rolloutScheduler] ${label}: written off — ${decision.reason}`);
      } else {
        counts.skipped += 1;
      }
    } catch (err) {
      counts.failed += 1;
      console.error(
        `[rolloutScheduler] ${label}: claim failed — ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return counts;
}

/** Kill-switch read, fail-open on error (as `gateOrProceed` does web-side). */
async function readRoostEnabledFailOpen(
  store: RolloutScheduleStore,
  siteId: string,
): Promise<boolean> {
  try {
    return isRoostEnabled(await store.readRoostEnabled(siteId));
  } catch (err) {
    console.warn(
      `[rolloutScheduler] could not read the kill switch for site ${siteId}; ` +
        `proceeding (fail-open): ${err instanceof Error ? err.message : String(err)}`,
    );
    return true;
  }
}

/**
 * Every 5 minutes, matching `sweepStaleDeployments`. A rollout therefore fires
 * within 5 minutes of its scheduled instant, well inside the grace window.
 */
export const sweepScheduledRollouts = onSchedule(
  { schedule: 'every 5 minutes', timeoutSeconds: 60 },
  async () => {
    const counts = await sweepDueScheduledRollouts({ store: getDefaultStore() });
    if (counts.due === 0) return;
    console.log(
      `[rolloutScheduler] sweep complete: due=${counts.due} fired=${counts.fired} ` +
        `missed=${counts.missed} skipped=${counts.skipped} ` +
        `disabled=${counts.disabled} planBlocked=${counts.planBlocked} failed=${counts.failed}`,
    );
  },
);

/**
 * Firestore-backed store. `getFirestore()` is resolved lazily so importing this
 * module (as the unit tests do) never needs an initialised app.
 */
function getDefaultStore(): RolloutScheduleStore {
  const db = getFirestore();

  const rolloutRefFor = (ref: ScheduledRolloutRef) =>
    db
      .collection('sites')
      .doc(ref.siteId)
      .collection('roosts')
      .doc(ref.roostId)
      .collection('rollouts')
      .doc(ref.versionId);

  return {
    async listDue(nowMs, limit) {
      // Needs the `rollouts` COLLECTION_GROUP composite index
      // (stage ASC, scheduledAt ASC) in firestore.indexes.json.
      const snap = await db
        .collectionGroup('rollouts')
        .where('stage', '==', 'scheduled')
        .where('scheduledAt', '<=', Timestamp.fromMillis(nowMs))
        .orderBy('scheduledAt', 'asc')
        .limit(limit)
        .get();

      const refs: ScheduledRolloutRef[] = [];
      for (const doc of snap.docs) {
        const roostRef = doc.ref.parent.parent;
        const siteRef = roostRef?.parent.parent;
        if (!roostRef || !siteRef) {
          console.warn(
            `[rolloutScheduler] rollout ${doc.ref.path} is not under a site/roost — skipping`,
          );
          continue;
        }
        refs.push({ siteId: siteRef.id, roostId: roostRef.id, versionId: doc.id });
      }
      return refs;
    },

    async readRoostEnabled(siteId) {
      const snap = await db.collection('sites').doc(siteId).get();
      return snap.exists ? snap.data()?.[ROOST_ENABLED_FIELD] : undefined;
    },

    readPlanSnapshot(siteId) {
      return readSitePlanSnapshot(db, siteId);
    },

    async claim(ref, nowMs, graceMs, planSnapshot) {
      const rolloutRef = rolloutRefFor(ref);
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(rolloutRef);
        return applyScheduledRolloutClaim({
          writer: tx,
          targets: {
            rolloutRef,
            pendingCommandRef: (machineId: string) =>
              db
                .collection('sites')
                .doc(ref.siteId)
                .collection('machines')
                .doc(machineId)
                .collection('commands')
                .doc('pending'),
          },
          ref,
          data: snap.exists ? (snap.data() as RolloutDocData) : null,
          nowMs,
          graceMs,
          planSnapshot,
        });
      });
    },
  };
}
