/**
 * Distribution fan-out (roost wave 2b.3): two firestore triggers driving a
 * canary → fleet rollout. `onRoostWritten` starts the canary when
 * `currentVersionId` changes; `onTargetStateWritten` advances or aborts on
 * agent reports. Pure decision logic lives in lib/fanoutLogic.ts (unit-tested);
 * handlers only load state, call it, and write the outcome.
 *
 * Fleet promotion is two-phase: the transaction writes the state transition
 * with pendingCommandsDispatched=false, then command batches (<=400 ops) are
 * written outside it so large fleets can't hit the transaction write ceiling.
 * The flag flips true only after every chunk commits, so a later trigger can
 * retry the merge-set writes without duplicating commands. A single-machine
 * site has no fleet wave (the lone target IS the canary), so that promotion
 * must complete inside the transaction — nothing would re-enter the trigger.
 *
 * Canary first, never all-at-once: cf. the cloudflare 2025-11-18 config push.
 */

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { getFirestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import {
  evaluateWave,
  nextStage,
  selectCanary,
  type RolloutStage,
  type TargetState,
  type TargetStatus,
} from './lib/fanoutLogic';
import { buildSyncPullCommand, syncPullCommandId } from './lib/syncPullCommand';

const db = getFirestore();
const FLEET_COMMAND_BATCH_SIZE = 400;

interface Roost {
  currentVersionId?: string;
  versionUrl?: string;
  targets?: string[];
  extractPath?: string;
}

// Fallback when the roost doc has no extractPath. Must match the windows
// entry of the agent's `default_roots()` in destination_allowlist.py.
const DEFAULT_EXTRACT_ROOT = '~/Documents/Owlette';

interface RolloutDoc {
  stage: RolloutStage;
  versionId: string;
  versionUrl: string;
  extractRoot: string;
  canary: string[];
  fleet: string[];
  pendingCommandsDispatched?: boolean;
  startedAt?: FirebaseFirestore.Timestamp;
  completedAt?: FirebaseFirestore.Timestamp;
  abortedAt?: FirebaseFirestore.Timestamp;
  abortReason?: string;
}

interface FleetDispatchPlan {
  rolloutRef: FirebaseFirestore.DocumentReference;
  siteId: string;
  roostId: string;
  versionId: string;
  versionUrl: string;
  extractRoot: string;
  machineIds: string[];
}

export const onRoostWritten = onDocumentWritten(
  'sites/{siteId}/roosts/{roostId}',
  async (event) => {
    const { siteId, roostId } = event.params;

    const before = event.data?.before?.data() as Roost | undefined;
    const after = event.data?.after?.data() as Roost | undefined;

    // deletion or no-op write
    if (!after) return;
    if (!after.currentVersionId || !after.versionUrl) return;
    if (before?.currentVersionId === after.currentVersionId) return;

    const versionId = after.currentVersionId;
    const versionUrl = after.versionUrl;
    const targets = Array.isArray(after.targets) ? after.targets : [];
    const extractRoot =
      typeof after.extractPath === 'string' && after.extractPath.trim()
        ? after.extractPath.trim()
        : DEFAULT_EXTRACT_ROOT;

    if (targets.length === 0) {
      console.warn(
        `[fanout] roost ${siteId}/${roostId} has no targets; ` +
          `version ${versionId} will not be fanned out.`,
      );
      return;
    }

    const { canary, fleet } = selectCanary(targets, versionId);

    const rolloutRef = db
      .collection('sites')
      .doc(siteId)
      .collection('roosts')
      .doc(roostId)
      .collection('rollouts')
      .doc(versionId);

    // idempotent: an existing rollout doc means a trigger retry, not a new publish
    const existing = await rolloutRef.get();
    if (existing.exists) {
      console.log(
        `[fanout] rollout already initialised for ${siteId}/${roostId}/${versionId}; skipping.`,
      );
      return;
    }

    const rolloutDoc: RolloutDoc = {
      stage: 'canary',
      versionId,
      versionUrl,
      extractRoot,
      canary,
      fleet,
      startedAt: FieldValue.serverTimestamp() as unknown as FirebaseFirestore.Timestamp,
    };

    const batch = db.batch();
    batch.set(rolloutRef, rolloutDoc);
    for (const machineId of canary) {
      queueSyncCommand(batch, siteId, machineId, roostId, versionId, versionUrl, extractRoot);
    }
    await batch.commit();

    console.log(
      `[fanout] ${siteId}/${roostId}/${versionId}: canary started with ` +
        `${canary.length}/${targets.length} machine(s); ${fleet.length} queued for fleet wave`,
    );
  },
);

export const onTargetStateWritten = onDocumentWritten(
  'sites/{siteId}/roosts/{roostId}/target_state/{machineId}',
  async (event) => {
    const { siteId, roostId, machineId } = event.params;
    const after = event.data?.after?.data() as
      | { reportedVersionId?: string; status?: string }
      | undefined;

    if (!after?.reportedVersionId || !after.status) return;
    const reportedVersionId = after.reportedVersionId;

    const rolloutRef = db
      .collection('sites')
      .doc(siteId)
      .collection('roosts')
      .doc(roostId)
      .collection('rollouts')
      .doc(reportedVersionId);

    // Atomic read-evaluate-write: two concurrent target_state writes must not
    // both promote canary → fleet.
    const fleetDispatchPlan = await db.runTransaction<FleetDispatchPlan | null>(async (tx) => {
      const snap = await tx.get(rolloutRef);
      if (!snap.exists) return null; // no rollout for this version

      const rollout = snap.data() as RolloutDoc;
      if (rollout.stage === 'complete' || rollout.stage === 'aborted') return null;

      const extractRoot = rollout.extractRoot || DEFAULT_EXTRACT_ROOT;

      if (rollout.stage === 'fleet' && rollout.pendingCommandsDispatched === false) {
        console.warn(
          `[fanout] ${siteId}/${roostId}/${reportedVersionId}: retrying pending fleet command dispatch`,
        );
        return buildFleetDispatchPlan(
          rolloutRef,
          siteId,
          roostId,
          reportedVersionId,
          rollout.versionUrl,
          extractRoot,
          rollout.fleet,
        );
      }

      const waveIds =
        rollout.stage === 'canary' ? rollout.canary : rollout.fleet;
      if (!waveIds.includes(machineId)) return null; // not part of current wave

      // pull reported status for every machine in the current wave
      const waveStates = await readWaveStates(
        tx,
        siteId,
        roostId,
        reportedVersionId,
        waveIds,
      );

      const evaluation = evaluateWave(waveStates);
      const transition = nextStage(rollout.stage, evaluation);
      if (!transition) return null; // still in flight

      if (transition.stage === 'fleet') {
        // Single-machine site: the lone target IS the canary, `fleet` is empty,
        // and no fleet target_state write will re-enter this trigger — so run the
        // empty wave here or the rollout parks at "fleet" forever.
        const fleetTransition =
          rollout.fleet.length === 0
            ? nextStage('fleet', evaluateWave([]))
            : null;
        if (fleetTransition?.stage === 'complete') {
          tx.update(rolloutRef, {
            stage: 'complete',
            fleetStartedAt: FieldValue.serverTimestamp(),
            // nothing outstanding; keeps the retry branch above off this rollout
            pendingCommandsDispatched: true,
            completedAt: FieldValue.serverTimestamp(),
          });
          console.log(
            `[fanout] ${siteId}/${roostId}/${reportedVersionId}: ${transition.reason}; ` +
              `no fleet wave (canary covered every target) — ${fleetTransition.reason}`,
          );
          return null;
        }

        // state first; command batches run after the transaction (write ceiling)
        tx.update(rolloutRef, {
          stage: 'fleet',
          fleetStartedAt: FieldValue.serverTimestamp(),
          pendingCommandsDispatched: false,
        });
        console.log(
          `[fanout] ${siteId}/${roostId}/${reportedVersionId}: ${transition.reason}; fleet wave ready for dispatch`,
        );
        return buildFleetDispatchPlan(
          rolloutRef,
          siteId,
          roostId,
          reportedVersionId,
          rollout.versionUrl,
          extractRoot,
          rollout.fleet,
        );
      }

      if (transition.stage === 'aborted') {
        tx.update(rolloutRef, {
          stage: 'aborted',
          abortedAt: FieldValue.serverTimestamp(),
          abortReason: transition.reason,
        });
        console.error(
          `[fanout] ${siteId}/${roostId}/${reportedVersionId}: ABORTED — ${transition.reason}`,
        );
        return null;
      }

      if (transition.stage === 'complete') {
        tx.update(rolloutRef, {
          stage: 'complete',
          completedAt: FieldValue.serverTimestamp(),
        });
        console.log(
          `[fanout] ${siteId}/${roostId}/${reportedVersionId}: ${transition.reason}`,
        );
        return null;
      }

      return null;
    });

    if (fleetDispatchPlan) {
      await dispatchFleetCommands(fleetDispatchPlan);
    }
  },
);

/**
 * The subset of WriteBatch/Transaction we use. A `WriteBatch | Transaction`
 * union doesn't narrow — their set() generics differ.
 */
interface Writable {
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

function buildFleetDispatchPlan(
  rolloutRef: FirebaseFirestore.DocumentReference,
  siteId: string,
  roostId: string,
  versionId: string,
  versionUrl: string,
  extractRoot: string,
  machineIds: string[],
): FleetDispatchPlan {
  return {
    rolloutRef,
    siteId,
    roostId,
    versionId,
    versionUrl,
    extractRoot,
    machineIds: [...machineIds],
  };
}

async function dispatchFleetCommands(plan: FleetDispatchPlan): Promise<void> {
  try {
    const chunks = chunk(plan.machineIds, FLEET_COMMAND_BATCH_SIZE);
    await Promise.all(
      chunks.map(async (machineIds) => {
        const batch = db.batch();
        for (const machineId of machineIds) {
          queueSyncCommand(
            batch,
            plan.siteId,
            machineId,
            plan.roostId,
            plan.versionId,
            plan.versionUrl,
            plan.extractRoot,
          );
        }
        await batch.commit();
      }),
    );

    await plan.rolloutRef.set(
      {
        pendingCommandsDispatched: true,
        pendingCommandsDispatchedAt: FieldValue.serverTimestamp(),
        pendingCommandsDispatchError: FieldValue.delete(),
        pendingCommandsDispatchFailedAt: FieldValue.delete(),
      },
      { merge: true },
    );

    console.log(
      `[fanout] ${plan.siteId}/${plan.roostId}/${plan.versionId}: fleet wave dispatched to ` +
        `${plan.machineIds.length} machine(s)`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await plan.rolloutRef.set(
      {
        pendingCommandsDispatched: false,
        pendingCommandsDispatchError: message,
        pendingCommandsDispatchFailedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    console.error(
      `[fanout] ${plan.siteId}/${plan.roostId}/${plan.versionId}: fleet command dispatch failed; ` +
        `will retry on the next target_state trigger`,
      err,
    );
    throw err;
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Queue a `sync_pull` in the machine's pending commands doc; the agent's
 * command_router dispatches it and the result lands in completed/. Payload shape
 * lives in `lib/syncPullCommand.ts` so it is contract-testable without firebase-admin.
 */
function queueSyncCommand(
  writable: Writable,
  siteId: string,
  machineId: string,
  roostId: string,
  versionId: string,
  versionUrl: string,
  extractRoot: string,
): void {
  const pendingRef = db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('commands')
    .doc('pending');

  // One pending doc per machine (as in deploymentStatus.ts). The command id is
  // deterministic per version+roost so retries don't duplicate.
  const cmdId = syncPullCommandId(roostId, versionId);
  writable.set(
    pendingRef,
    {
      [cmdId]: buildSyncPullCommand(
        siteId,
        roostId,
        versionId,
        versionUrl,
        extractRoot,
        FieldValue.serverTimestamp(),
      ),
    },
    { merge: true },
  );
}

async function readWaveStates(
  tx: FirebaseFirestore.Transaction,
  siteId: string,
  roostId: string,
  versionId: string,
  machineIds: string[],
): Promise<TargetState[]> {
  const col = db
    .collection('sites')
    .doc(siteId)
    .collection('roosts')
    .doc(roostId)
    .collection('target_state');

  // all reads must precede writes in a transaction; unreported => 'pending'
  const refs = machineIds.map((mid) => col.doc(mid));
  const snaps = await Promise.all(refs.map((ref) => tx.get(ref)));
  return snaps.map((snap, i) => {
    const data = snap.exists ? (snap.data() as any) : null;
    const reportedVersion = data?.reportedVersionId as string | undefined;
    const rawStatus = data?.status as string | undefined;
    // a stale status from a prior version must not inform this wave
    const status: TargetStatus =
      reportedVersion === versionId && rawStatus
        ? coerceStatus(rawStatus)
        : 'pending';
    return { machineId: machineIds[i], status };
  });
}

/** Collapse the agent's fine-grained sync states to the four the fan-out cares about. */
function coerceStatus(raw: string): TargetStatus {
  switch (raw) {
    case 'committed':
    case 'succeeded':
      return 'succeeded';
    case 'failed':
    case 'error':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'pending':
      return 'pending';
    default:
      // downloading / assembling / any unknown in-flight state
      return 'in_progress';
  }
}
