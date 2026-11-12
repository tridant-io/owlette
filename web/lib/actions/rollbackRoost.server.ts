/**
 * Action core: roll a roost back to an already-published version. Moved out of
 * `POST /api/roosts/{roostId}/rollback` unchanged; the route keeps auth, the
 * kill-switch gate, idempotency and the response, and the fleet tool calls this
 * as the calling machine.
 *
 * Flips `currentVersionId` and mints NO new version — versions are immutable, a
 * rollback is a pointer change. The pointer flip must NOT let the fan-out
 * trigger replay its deterministic `roost_sync_{roostId}_{versionId}` command
 * id, so this keeps/creates `rollouts/{targetVersionId}` (making
 * `onRoostWritten` bail) and enqueues nonce'd `sync_pull` commands itself.
 */
import type { Firestore, WriteBatch } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { ProblemType } from '@/lib/apiErrors';
import { emitMutation } from '@/lib/auditLogClient';
import { getAdminDb } from '@/lib/firebase-admin';
import { resolveVersion, ResolveVersionError } from '@/lib/resolveVersion';
import { emitRoostWebhook } from '@/lib/roostWebhooks.server';
import { RoostProblem, sameMachineSet, type RoostActionContext } from './deployRoost.server';

const DEFAULT_TARGET = 'previous';
const DEFAULT_EXTRACT_ROOT = '~/Documents/Owlette';
const ROLLBACK_DISPATCH_BATCH_SIZE = 400;

export interface RollbackRoostInput {
  roostId: string;
  /** as received: this core validates it. Defaults to 'previous'. */
  targetVersion?: unknown;
  /** who is recorded as the rollback's requester: a user id, or `machine:<id>`. */
  requestedBy: string;
  /** audit attributes: the route passes its own path and method. */
  endpoint: string;
  method: string;
  /**
   * the machines a caller already checked. The rollback is refused, before it
   * writes anything, if the roost's targets are not exactly this set.
   */
  approvedMachines?: readonly string[];
  db?: Firestore;
}

export interface RollbackRoostResult {
  ok: true;
  roostId: string;
  siteId: string;
  currentVersionId: string;
  currentVersionNumber: number;
  previousVersionId: string | null;
}

/** the machines a rollback acts on: every target of the roost, de-duplicated. */
export function rollbackMachineSet(roost: Record<string, unknown>): string[] {
  return Array.isArray(roost.targets)
    ? [
        ...new Set(
          (roost.targets as unknown[]).filter(
            (target): target is string =>
              typeof target === 'string' && target.length > 0,
          ),
        ),
      ]
    : [];
}

function roostNotFound(roostId: string, siteId: string): RoostProblem {
  return new RoostProblem({
    type: ProblemType.NotFound,
    title: 'not found',
    status: 404,
    detail: `roost ${roostId} not found on site ${siteId}`,
    instance: `/api/roosts/${roostId}/rollback`,
  });
}

/** the machines a rollback of this roost would act on; throws RoostProblem when it is missing or deleted. */
export async function readRollbackMachines(
  db: Firestore,
  siteId: string,
  roostId: string,
): Promise<string[]> {
  const snap = await db.collection('sites').doc(siteId).collection('roosts').doc(roostId).get();
  const data = snap.data() ?? {};
  if (!snap.exists || data.deletedAt) throw roostNotFound(roostId, siteId);
  return rollbackMachineSet(data);
}

/** the target version as the route reads it: validated, then resolved. */
export async function resolveRollbackTarget(
  siteId: string,
  roostId: string,
  targetVersion: unknown,
) {
  // Optional; string OR number only. Objects/arrays/booleans 400 here rather
  // than being coerced or buried in the resolver.
  if (
    targetVersion !== undefined &&
    targetVersion !== null &&
    typeof targetVersion !== 'string' &&
    typeof targetVersion !== 'number'
  ) {
    throw new RoostProblem({
      type: ProblemType.ValidationFailed,
      title: 'validation failed',
      status: 400,
      detail: 'targetVersion must be a string or number when provided',
      errors: { 'body.targetVersion': ['must be a string or number'] },
    });
  }
  const refInput =
    targetVersion === undefined || targetVersion === null
      ? DEFAULT_TARGET
      : String(targetVersion);

  // Same ref grammar as GET/PATCH /versions/{versionRef}. Side-effect free;
  // throws ResolveVersionError.
  try {
    const resolved = await resolveVersion({ roostId, siteId, ref: refInput });
    return { refInput, resolved };
  } catch (err) {
    if (err instanceof ResolveVersionError) {
      // Mirrors the helper in the versions/[versionRef] route so error
      // envelopes stay identical across every versionRef endpoint.
      throw new RoostProblem({
        type: err.status === 404 ? ProblemType.NotFound : ProblemType.ValidationFailed,
        title: err.status === 404 ? 'version not found' : 'targetVersion malformed',
        status: err.status,
        detail: err.message,
        instance: `/api/roosts/${roostId}/rollback`,
        code: err.code,
      });
    }
    throw err;
  }
}

async function commitBatchIfNeeded(
  state: { batch: WriteBatch; ops: number },
  db: Firestore,
  nextOps: number,
): Promise<void> {
  if (state.ops > 0 && state.ops + nextOps > ROLLBACK_DISPATCH_BATCH_SIZE) {
    await state.batch.commit();
    state.batch = db.batch();
    state.ops = 0;
  }
}

async function dispatchRollbackSyncPulls(args: {
  db: Firestore;
  siteId: string;
  roostId: string;
  versionId: string;
  versionUrl: string;
  extractRoot: string;
  targets: string[];
  nonce: string;
  requestedBy: string;
}): Promise<void> {
  const {
    db,
    siteId,
    roostId,
    versionId,
    versionUrl,
    extractRoot,
    targets,
    nonce,
    requestedBy,
  } = args;
  const deterministicCmdId = `roost_sync_${roostId}_${versionId}`;
  const rollbackCmdId = `roost_rollback_${roostId}_${versionId}_${nonce}`;
  const state = { batch: db.batch(), ops: 0 };

  for (const machineId of targets) {
    await commitBatchIfNeeded(state, db, 3);

    const machineRef = db
      .collection('sites')
      .doc(siteId)
      .collection('machines')
      .doc(machineId);
    const pendingRef = machineRef.collection('commands').doc('pending');
    const completedRef = machineRef.collection('commands').doc('completed');
    const targetStateRef = db
      .collection('sites')
      .doc(siteId)
      .collection('roosts')
      .doc(roostId)
      .collection('target_state')
      .doc(machineId);

    state.batch.set(
      pendingRef,
      {
        [rollbackCmdId]: {
          type: 'sync_pull',
          site_id: siteId,
          roost_id: roostId,
          version_id: versionId,
          version_url: versionUrl,
          extract_root: extractRoot,
          queued_at: FieldValue.serverTimestamp(),
          rollback: true,
          rollback_requested_by: requestedBy,
        },
        [deterministicCmdId]: FieldValue.delete(),
      },
      { merge: true },
    );
    state.ops += 1;

    state.batch.set(
      completedRef,
      { [deterministicCmdId]: FieldValue.delete() },
      { merge: true },
    );
    state.ops += 1;

    state.batch.delete(targetStateRef);
    state.ops += 1;
  }

  if (state.ops > 0) {
    await state.batch.commit();
  }
}

export async function rollbackRoost(
  ctx: RoostActionContext,
  input: RollbackRoostInput,
): Promise<RollbackRoostResult> {
  const { roostId, requestedBy } = input;
  const siteId = ctx.siteId;

  const { refInput, resolved } = await resolveRollbackTarget(siteId, roostId, input.targetVersion);
  const resolvedData = resolved.doc.data() ?? {};
  const versionUrl =
    typeof resolvedData.versionUrl === 'string' && resolvedData.versionUrl
      ? resolvedData.versionUrl
      : null;

  // Compare-and-swap in a transaction: the transactional read of the roost
  // head catches a concurrent push landing between resolveVersion() and the
  // update — firestore retries the callback if the doc moved.
  const db = input.db ?? getAdminDb();
  const roostRef = db
    .collection('sites')
    .doc(siteId)
    .collection('roosts')
    .doc(roostId);
  const rolloutRef = roostRef.collection('rollouts').doc(resolved.versionId);
  const nonce = Date.now().toString(36);

  const txResult = await db.runTransaction(async (tx) => {
    const roostSnap = await tx.get(roostRef);
    if (!roostSnap.exists) {
      return { kind: 'not_found' as const };
    }
    const existing = roostSnap.data() ?? {};
    if (existing.deletedAt) {
      return { kind: 'not_found' as const };
    }

    const currentId = (existing.currentVersionId as string | undefined) ?? null;
    if (currentId === resolved.versionId) {
      return { kind: 'no_op' as const, currentId };
    }
    if (!versionUrl) {
      return { kind: 'version_url_missing' as const };
    }
    const targets = rollbackMachineSet(existing);
    if (input.approvedMachines && !sameMachineSet(targets, input.approvedMachines)) {
      return { kind: 'machines_changed' as const };
    }
    const extractRoot =
      typeof existing.extractPath === 'string' && existing.extractPath.trim()
        ? existing.extractPath.trim()
        : DEFAULT_EXTRACT_ROOT;

    // Denormalised onto the roost doc so the /roost list and the dispatcher
    // cloud function read it without a sub-collection round-trip. Same field
    // set POST /versions writes on a fresh push.
    tx.update(roostRef, {
      currentVersionId: resolved.versionId,
      currentVersionNumber: resolved.versionNumber,
      currentVersionDescription:
        typeof resolvedData.description === 'string'
          ? resolvedData.description
          : null,
      previousVersionId: currentId,
      versionUrl,
      totalFiles:
        typeof resolvedData.totalFiles === 'number' ? resolvedData.totalFiles : 0,
      totalSize:
        typeof resolvedData.totalSize === 'number' ? resolvedData.totalSize : 0,
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Terminal guard: onRoostWritten bails when rollouts/{versionId} exists,
    // and terminal also stops an older in-flight rollout from later promoting
    // a deterministic fleet command for this version.
    tx.set(
      rolloutRef,
      {
        stage: 'complete',
        versionId: resolved.versionId,
        versionUrl,
        extractRoot,
        canary: targets,
        fleet: [],
        startedAt: FieldValue.serverTimestamp(),
        completedAt: FieldValue.serverTimestamp(),
        pendingCommandsDispatched: true,
        pendingCommandsDispatchedAt: FieldValue.serverTimestamp(),
        rollback: true,
        rollbackFromVersionId: currentId,
        rollbackBy: requestedBy,
        rollbackNonce: nonce,
      },
      { merge: true },
    );

    return {
      kind: 'flipped' as const,
      previousVersionId: currentId,
      versionUrl,
      targets,
      extractRoot,
    };
  });

  if (txResult.kind === 'not_found') {
    throw roostNotFound(roostId, siteId);
  }
  if (txResult.kind === 'no_op') {
    // Defensive: the UI hides rollback on the current row, but a direct API
    // caller deserves a 400 over a silent no-op.
    throw new RoostProblem({
      type: ProblemType.ValidationFailed,
      title: 'rollback no-op',
      status: 400,
      detail: 'targetVersion is already the current version',
      instance: `/api/roosts/${roostId}/rollback`,
      code: 'rollback_no_op',
    });
  }
  if (txResult.kind === 'version_url_missing') {
    throw new RoostProblem({
      type: ProblemType.Conflict,
      title: 'version has no url',
      status: 409,
      detail: 'the target version exists but its R2 url is missing; cannot fan out rollback',
      instance: `/api/roosts/${roostId}/rollback`,
      code: 'version_url_missing',
    });
  }
  if (txResult.kind === 'machines_changed') {
    throw new RoostProblem({
      type: ProblemType.Conflict,
      title: 'machines changed',
      status: 409,
      detail: 'the machines this roost deploys to changed since they were checked; nothing was rolled back',
      instance: `/api/roosts/${roostId}/rollback`,
      code: 'machines_changed',
    });
  }

  await dispatchRollbackSyncPulls({
    db,
    siteId,
    roostId,
    versionId: resolved.versionId,
    versionUrl: txResult.versionUrl,
    extractRoot: txResult.extractRoot,
    targets: txResult.targets,
    nonce,
    requestedBy,
  });

  // Awaited so a 200 means the event is durably queued; the scheduled pump in
  // functions/src/webhookDispatch.ts does the POSTing. Never throws — a
  // webhook outage must not fail a completed rollback.
  await emitRoostWebhook({
    db,
    siteId,
    event: 'version.rolled_back',
    data: {
      roostId,
      siteId,
      fromVersion: txResult.previousVersionId,
      toVersion: resolved.versionId,
      triggeredBy: requestedBy,
    },
  });

  emitMutation({
    kind: 'roost_mutated',
    siteId,
    actor: ctx.auditActor,
    targetId: resolved.versionId,
    attributes: {
      verb: 'rollback',
      endpoint: input.endpoint,
      method: input.method,
      roostId,
      targetVersion: refInput,
      fromVersionId: txResult.previousVersionId,
      toVersionId: resolved.versionId,
      toVersionNumber: resolved.versionNumber,
    },
  });

  return {
    ok: true,
    roostId,
    siteId,
    currentVersionId: resolved.versionId,
    currentVersionNumber: resolved.versionNumber,
    previousVersionId: txResult.previousVersionId,
  };
}
