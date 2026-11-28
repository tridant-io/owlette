/**
 * removeMachine action core. Hard-deletes the machine doc, its config doc, its
 * pending/completed command maps, and every matching `agent_refresh_tokens`
 * row. Capability `MACHINE_REMOVE` (site-scoped).
 *
 * Atomicity: machine + config + its move out of the site (`machine_moves`)
 * delete in one batch; command maps and tokens are
 * best-effort follow-ups because they may not exist (a freshly-paired machine
 * has no commands subcollection). Firestore deletes are idempotent on absent
 * docs, so no existence pre-check. The machine's unended swoop sessions are
 * ended the same best-effort way, as `machine_removed`: their records are a
 * subcollection of the deleted doc and outlive it, and that end is how every
 * viewer of the machine learns it left the site rather than waiting on it.
 * The id then leaves every member's machine scope, and the site's fleet grant
 * with its fleet sessions and call records (ADR 0017), best-effort too: machine
 * ids get reused, and a failed prune is caught when the id next pairs
 * (`recordPairing`). Its stored screenshots, images and history records, go
 * last and best-effort through `deleteScreenshotsBestEffort`, which each caller
 * awaits once everything else is done: they belong to the site, so they never
 * follow a machine that is removed or moved off it, and their delete has no
 * bound, so nothing the removal needs waits on it.
 *
 * No active-deployment guard: the legacy client-side check was racy against
 * in-flight commands and lived in the UI, not the data layer. The audit log
 * records the removal; reconciliation handles abandoned deployments.
 *
 * TODO: delete `web/hooks/useMachineOperations.ts` once this is the only writer.
 */

import { Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';
import type { Actor } from '@/lib/capabilities';
import { pruneMachineFromFleet } from '@/lib/fleet/cleanup.server';
import logger from '@/lib/logger';
import { moveRef } from '@/lib/machineMoves.server';
import { pruneMachineFromMembers } from '@/lib/membership.server';
import { deleteScreenshotsBestEffort } from '@/lib/screenshotStorage.server';
import { recordSwoopSessionEnded } from '@/lib/swoop/audit.server';
import { endSwoopSession, listUnendedSwoopSessionsForMachine } from '@/lib/swoop/sessionStore.server';

const AGENT_REFRESH_TOKEN_DELETE_BATCH_SIZE = 500;

export interface RemoveMachineDataInput {
  siteId: string;
  machineId: string;
  /** Who removed it, for the audit row of each swoop session the removal ends. */
  actor: Actor;
  /** Inject a Firestore instance — tests pass a mock; production omits. */
  db?: Firestore;
}

export interface RemoveMachineInput extends RemoveMachineDataInput {
  /** Audit actor string ("user:<uid>" or "apiKey:<keyId>"). */
  auditActor: string;
}

export interface RemoveMachineResult {
  siteId: string;
  machineId: string;
  /** Paths that were deleted. Always populated regardless of pre-existence. */
  deleted: {
    machine: string;
    config: string;
    pendingCommands: string;
    completedCommands: string;
  };
}

/**
 * End the machine's unended swoop sessions as `machine_removed`, each with its
 * audit row. Each on its own: one that cannot be ended or recorded leaves the
 * rest to end, and the first failure is thrown after them.
 */
async function endSwoopSessions(siteId: string, machineId: string, actor: Actor): Promise<void> {
  const sessions = await listUnendedSwoopSessionsForMachine({ siteId, machineId });
  const results = await Promise.allSettled(
    sessions.map(async (session) => {
      await endSwoopSession({ siteId, machineId, sid: session.sid, endReason: 'machine_removed' });
      await recordSwoopSessionEnded({
        siteId,
        machineId,
        sid: session.sid,
        actor,
        endReason: 'machine_removed',
        durationMs: Date.now() - session.startedAt,
      });
    }),
  );
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw failed.reason;
}

/**
 * Hard-delete a machine and its associated data. Idempotent: re-issuing
 * the call after the first success is a no-op (every delete target is
 * already gone, and Firestore deletes never error on missing docs).
 *
 * Throws if the underlying Firestore write fails. Callers (the route
 * shim) translate to RFC 7807 via `problemFromError`.
 */
export async function removeMachineData(
  input: RemoveMachineDataInput,
): Promise<RemoveMachineResult> {
  const { siteId, machineId } = input;
  if (!siteId) throw new Error('siteId is required');
  if (!machineId) throw new Error('machineId is required');

  const db = input.db ?? getAdminDb();

  const machineRef = db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId);
  const configRef = db
    .collection('config')
    .doc(siteId)
    .collection('machines')
    .doc(machineId);
  const pendingCommandsRef = machineRef.collection('commands').doc('pending');
  const completedCommandsRef = machineRef.collection('commands').doc('completed');

  // Atomic: a failure leaves the machine visible and retryable. the machine's
  // move out of the site goes with it: removing is the way out of a stuck
  // switch, and a move's confirm from its target is this same commit.
  const batch = db.batch();
  batch.delete(machineRef);
  batch.delete(configRef);
  batch.delete(moveRef(db, siteId, machineId));
  await batch.commit();

  // after the batch, so a failed removal leaves its sessions running too.
  try {
    await endSwoopSessions(siteId, machineId, input.actor);
  } catch (err) {
    logger.warn('removeMachine: swoop session end failed (non-fatal)', {
      context: 'removeMachine',
      data: {
        siteId,
        machineId,
        err: err instanceof Error ? err.message : String(err),
      },
    });
  }

  try {
    await pruneMachineFromMembers({ siteId, machineId, db });
  } catch (err) {
    logger.warn('removeMachine: machine scope prune failed (non-fatal)', {
      context: 'removeMachine',
      data: {
        siteId,
        machineId,
        err: err instanceof Error ? err.message : String(err),
      },
    });
  }

  try {
    await pruneMachineFromFleet({ siteId, machineId, db });
  } catch (err) {
    logger.warn('removeMachine: fleet prune failed (non-fatal)', {
      context: 'removeMachine',
      data: {
        siteId,
        machineId,
        err: err instanceof Error ? err.message : String(err),
      },
    });
  }


  // Best-effort: these docs may never have existed. Warn rather than throw,
  // so unexpected modes (e.g. permission denied) stay visible in telemetry.
  try {
    await pendingCommandsRef.delete();
  } catch (err) {
    logger.warn('removeMachine: pending commands delete failed (non-fatal)', {
      context: 'removeMachine',
      data: {
        siteId,
        machineId,
        err: err instanceof Error ? err.message : String(err),
      },
    });
  }

  try {
    await completedCommandsRef.delete();
  } catch (err) {
    logger.warn('removeMachine: completed commands delete failed (non-fatal)', {
      context: 'removeMachine',
      data: {
        siteId,
        machineId,
        err: err instanceof Error ? err.message : String(err),
      },
    });
  }

  // Tokens are top-level docs keyed by hash, so they're found by the same
  // siteId + machineId query the manual revoke route uses.
  try {
    for (;;) {
      const tokensSnapshot = await db.collection('agent_refresh_tokens')
        .where('siteId', '==', siteId)
        .where('machineId', '==', machineId)
        .limit(AGENT_REFRESH_TOKEN_DELETE_BATCH_SIZE)
        .get();

      if (tokensSnapshot.docs.length === 0) break;

      const tokenBatch = db.batch();
      tokensSnapshot.docs.forEach((doc) => {
        tokenBatch.delete(doc.ref);
      });
      await tokenBatch.commit();

      if (tokensSnapshot.docs.length < AGENT_REFRESH_TOKEN_DELETE_BATCH_SIZE) break;
    }
  } catch (err) {
    logger.warn('removeMachine: agent refresh token delete failed (non-fatal)', {
      context: 'removeMachine',
      data: {
        siteId,
        machineId,
        err: err instanceof Error ? err.message : String(err),
      },
    });
  }

  return {
    siteId,
    machineId,
    deleted: {
      machine: `sites/${siteId}/machines/${machineId}`,
      config: `config/${siteId}/machines/${machineId}`,
      pendingCommands: `sites/${siteId}/machines/${machineId}/commands/pending`,
      completedCommands: `sites/${siteId}/machines/${machineId}/commands/completed`,
    },
  };
}

/** a move cleans its source the same way but records its own rows, so only this one writes machine.remove. */
export async function removeMachine(
  input: RemoveMachineInput,
): Promise<RemoveMachineResult> {
  const { siteId, machineId } = input;
  const result = await removeMachineData(input);

  emitMutation({
    kind: 'site_mutated',
    siteId,
    actor: input.auditActor,
    targetId: machineId,
    attributes: {
      verb: 'machine.remove',
      endpoint: 'machines',
      method: 'DELETE',
      machineId,
    },
  });

  await deleteScreenshotsBestEffort(siteId, machineId, 'removeMachine', input.db);
  return result;
}
