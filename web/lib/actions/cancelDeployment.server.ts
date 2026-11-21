/**
 * cancelDeployment action core (security-boundary-migration wave 3.3).
 *
 * Extracted from
 * `web/app/api/sites/[siteId]/deployments/[deploymentId]/cancel/route.ts`.
 * The HTTP route remains responsible for auth, idempotency, and RFC 7807
 * mapping; this core owns the Firestore mutation sequence.
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { fanOutToMachines } from '@/lib/fanOut.server';
import { emitMutation } from '@/lib/auditLogClient';
import logger from '@/lib/logger';
import {
  PRE_FLIGHT_DEPLOYMENT_STATUSES,
  TERMINAL_DEPLOYMENT_STATUSES,
} from '@/lib/deploymentStatuses';

interface DeploymentTargetData {
  machineId: string;
  status: string;
  [key: string]: unknown;
}

export interface CancelDeploymentContext {
  siteId: string;
  deploymentId: string;
  /** `user:<uid>` or `apiKey:<keyId>` for audit-log mutation events. */
  actorIdentifier: string;
  /** Opaque correlation id from authorizedSiteHandler. */
  correlationId: string;
  /** cancel only these machines' targets; omitted → every cancellable target. */
  machines?: string[];
  db?: ReturnType<typeof getAdminDb>;
  now?: () => number;
}

export type CancelDeploymentResult =
  | {
      ok: true;
      deploymentId: string;
      siteId: string;
      status: string;
      cancelled: number;
      machine_ids: string[];
    }
  | {
      ok: false;
      code: 'not_found' | 'no_cancellable_targets';
      message: string;
    }
  | {
      // a write or read failed. the record was settled first unless writing it is
      // what failed, and the outcome is audited either way.
      ok: false;
      code: 'write_failed';
      cause: unknown;
    };

export async function cancelDeployment(
  ctx: CancelDeploymentContext,
): Promise<CancelDeploymentResult> {
  const db = ctx.db ?? getAdminDb();
  const now = ctx.now ?? (() => Date.now());

  const deploymentRef = db
    .collection('sites')
    .doc(ctx.siteId)
    .collection('deployments')
    .doc(ctx.deploymentId);
  const snap = await deploymentRef.get();

  if (!snap.exists) {
    return {
      ok: false,
      code: 'not_found',
      message: `deployment ${ctx.deploymentId} not found on site ${ctx.siteId}`,
    };
  }

  const data = snap.data() ?? {};
  const targets: DeploymentTargetData[] = Array.isArray(data.targets)
    ? (data.targets as DeploymentTargetData[])
    : [];
  const machineFilter = ctx.machines ? new Set(ctx.machines) : null;
  const cancellable = targets.filter(
    (target) =>
      PRE_FLIGHT_DEPLOYMENT_STATUSES.has(target.status) &&
      (!machineFilter || machineFilter.has(target.machineId)),
  );

  if (cancellable.length === 0) {
    return {
      ok: false,
      code: 'no_cancellable_targets',
      message: machineFilter
        ? 'no targets in `pending`, `closing_processes` or `downloading` state matching the machines filter'
        : 'every target is already past the queued phase or terminal',
    };
  }

  // a target whose queued install could not be removed may still install, so it is
  // neither sent a cancel nor marked; one machine's failure does not stop the others.
  const purges = await Promise.allSettled(
    cancellable.map(async (target) => {
      const pendingRef = db
        .collection('sites')
        .doc(ctx.siteId)
        .collection('machines')
        .doc(target.machineId)
        .collection('commands')
        .doc('pending');
      const pendingSnap = await pendingRef.get();
      if (!pendingSnap.exists) return;
      const queued = pendingSnap.data() ?? {};
      const updates: Record<string, unknown> = {};
      for (const [cmdId, payload] of Object.entries(queued)) {
        if (
          payload &&
          typeof payload === 'object' &&
          (payload as Record<string, unknown>).deployment_id === ctx.deploymentId &&
          (payload as Record<string, unknown>).type === 'install_software'
        ) {
          updates[cmdId] = FieldValue.delete();
        }
      }
      if (Object.keys(updates).length > 0) {
        await pendingRef.update(updates);
      }
    }),
  );
  const purged = cancellable
    .filter((_, i) => purges[i].status === 'fulfilled')
    .map((target) => target.machineId);
  const unpurged = cancellable
    .filter((_, i) => purges[i].status === 'rejected')
    .map((target) => target.machineId);
  const failedPurge = purges.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );

  const installerName =
    typeof data.installer_name === 'string' ? data.installer_name : '';
  const cancelResults = await fanOutToMachines({
    siteId: ctx.siteId,
    machineIds: purged,
    correlationId: ctx.correlationId,
    db,
    now,
    builder: () => ({
      commandIdPrefix: `cancel_${now()}`,
      commandData: {
        type: 'cancel_installation',
        installer_name: installerName,
        deployment_id: ctx.deploymentId,
        timestamp: FieldValue.serverTimestamp(),
      },
    }),
  });
  const reached = cancelResults.filter((result) => result.ok).map((result) => result.machineId);
  const unreached = cancelResults.filter((result) => !result.ok);

  const cancelledAt = Timestamp.fromMillis(now());
  // every purged target is marked, whether or not its cancel command arrived: the
  // purge is what stops an install that has not started, and the command cannot
  // stop one that has. failures are reported only after the record is settled,
  // unless writing the record is what failed.
  const cancelledMachineIds = new Set(purged);
  // re-read in a transaction: writing back the array read above would undo a
  // concurrent cancel of another machine, or a status the reconciler just wrote.
  let transactionFailure: unknown;
  const settled = await db.runTransaction(async (tx) => {
    const fresh = await tx.get(deploymentRef);
    if (!fresh.exists) return null;
    const freshData = fresh.data() ?? {};
    const freshTargets: DeploymentTargetData[] = Array.isArray(freshData.targets)
      ? (freshData.targets as DeploymentTargetData[])
      : [];

    const marked: string[] = [];
    const updatedTargets = freshTargets.map((target) => {
      if (
        !cancelledMachineIds.has(target.machineId) ||
        !PRE_FLIGHT_DEPLOYMENT_STATUSES.has(target.status)
      ) {
        return target;
      }
      marked.push(target.machineId);
      return {
        ...target,
        status: 'cancelled',
        cancelledAt,
      };
    });
    if (marked.length === 0) return 'moved_on' as const;

    const allTerminal = updatedTargets.every((target) =>
      TERMINAL_DEPLOYMENT_STATUSES.has(target.status),
    );

    const updatePayload: Record<string, unknown> = {
      targets: updatedTargets,
      updatedAt: FieldValue.serverTimestamp(),
    };
    let status = 'in_progress';
    if (allTerminal) {
      const statuses = new Set(updatedTargets.map((target) => target.status));
      if (statuses.size === 1 && statuses.has('cancelled')) {
        status = 'cancelled';
      } else if (statuses.size === 1 && statuses.has('completed')) {
        status = 'completed';
      } else if (statuses.has('failed') && !statuses.has('completed')) {
        status = 'failed';
      } else {
        status = 'partial';
      }
      updatePayload.status = status;
      updatePayload.completedAt = FieldValue.serverTimestamp();
    }

    tx.update(deploymentRef, updatePayload);
    return { status, machineIds: marked };
  }).catch((err: unknown) => {
    // the installs are purged and the commands sent, so this is audited and
    // answered like any other failed write; those targets wait for the sweeper.
    transactionFailure = err;
    return undefined;
  });

  // the cancel commands above are already on their way, so every outcome from
  // here is audited, including the ones that mark nothing in the record.
  const marked = settled && settled !== 'moved_on' ? settled.machineIds : [];
  try {
    emitMutation({
      kind: 'deployment_mutated',
      siteId: ctx.siteId,
      actor: ctx.actorIdentifier,
      targetId: ctx.deploymentId,
      attributes: {
        endpoint: `/api/sites/${ctx.siteId}/deployments/${ctx.deploymentId}/cancel`,
        method: 'POST',
        verb: 'cancel',
        cancelled_count: marked.length,
        machine_ids: marked,
        cancel_sent_to: reached,
        ...(unreached.length > 0
          ? { unreached_machine_ids: unreached.map((result) => result.machineId) }
          : {}),
        ...(unpurged.length > 0 ? { unpurged_machine_ids: unpurged } : {}),
        correlationId: ctx.correlationId,
      },
    });
  } catch (err) {
    logger.warn('[cancelDeployment] mutation emit threw synchronously', {
      context: 'cancelDeployment',
      data: { err: err instanceof Error ? err.message : String(err) },
    });
  }

  if (settled === null) {
    return {
      ok: false,
      code: 'not_found',
      message: `deployment ${ctx.deploymentId} not found on site ${ctx.siteId}`,
    };
  }
  const failure =
    transactionFailure ??
    failedPurge?.reason ??
    (unreached.length > 0
      ? new Error(
          `could not send cancel_installation to ${unreached.map((result) => result.machineId).join(', ')}: ` +
            `${unreached[0].error ?? 'unknown error'}`,
        )
      : undefined);
  if (settled === undefined || failure !== undefined) {
    return { ok: false, code: 'write_failed', cause: failure };
  }
  if (settled === 'moved_on') {
    return {
      ok: false,
      code: 'no_cancellable_targets',
      message:
        'every target moved past the queued phase while the cancel ran, ' +
        'though cancel_installation may already have been sent to those machines',
    };
  }

  return {
    ok: true,
    deploymentId: ctx.deploymentId,
    siteId: ctx.siteId,
    status: settled.status,
    cancelled: settled.machineIds.length,
    machine_ids: settled.machineIds,
  };
}
