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

  await Promise.all(
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

  const installerName =
    typeof data.installer_name === 'string' ? data.installer_name : '';
  const cancelResults = await fanOutToMachines({
    siteId: ctx.siteId,
    machineIds: cancellable.map((target) => target.machineId),
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
  const failedCancel = cancelResults.find((result) => !result.ok);
  if (failedCancel) {
    throw new Error(
      `failed to fan out cancel_installation command to ${failedCancel.machineId}: ${failedCancel.error ?? 'unknown error'}`,
    );
  }

  const cancelledAt = Timestamp.fromMillis(now());
  const cancelledMachineIds = new Set(cancellable.map((target) => target.machineId));
  // re-read in a transaction: writing back the array read above would undo a
  // concurrent cancel of another machine, or a status the reconciler just wrote.
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
  });

  // the cancel commands above are already on their way, so every outcome from
  // here is audited, including the two that mark nothing in the record.
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
        cancel_sent_to: [...cancelledMachineIds],
        correlationId: ctx.correlationId,
      },
    });
  } catch (err) {
    logger.warn('[cancelDeployment] mutation emit threw synchronously', {
      context: 'cancelDeployment',
      data: { err: err instanceof Error ? err.message : String(err) },
    });
  }

  if (!settled) {
    return {
      ok: false,
      code: 'not_found',
      message: `deployment ${ctx.deploymentId} not found on site ${ctx.siteId}`,
    };
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
