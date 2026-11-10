/**
 * Firestore trigger on sites/{siteId}/machines/{machineId}/commands/completed.
 * For each command carrying a deployment_id it updates that target's status on
 * the deployment doc and recalculates the overall status — server-side so any
 * consumer (API, tests, scripts) sees it without the dashboard running.
 *
 * CANONICAL reconciler. `reconcileDeploymentStatus` /
 * `reconcileDistributionStatus` were removed 2026-05-30 because they triggered
 * on commands/pending, which the agent never writes status to. Do NOT delete
 * this as "superseded" — nothing supersedes it.
 */

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import {
  mapCommandToTargetStatus,
  calculateDeploymentStatus,
  TARGET_TERMINAL_STATUSES,
  type DeploymentTarget,
} from './lib/deploymentUtils';

/** Diffs before/after to find changed commands, then updates each one's
 * deployment doc. */
export const onCommandCompleted = onDocumentWritten(
  'sites/{siteId}/machines/{machineId}/commands/completed',
  async (event) => {
    const { siteId, machineId } = event.params;

    const beforeData = event.data?.before?.data() || {};
    const afterData = event.data?.after?.data() || {};

    const changedCommands: Array<{ cmdId: string; cmdData: Record<string, any> }> = [];

    for (const [cmdId, cmdData] of Object.entries(afterData)) {
      if (typeof cmdData !== 'object' || !cmdData) continue;

      const beforeCmd = beforeData[cmdId] as Record<string, any> | undefined;

      if (
        !beforeCmd ||
        beforeCmd.status !== cmdData.status ||
        beforeCmd.progress !== cmdData.progress
      ) {
        changedCommands.push({ cmdId, cmdData: cmdData as Record<string, any> });
      }
    }

    if (changedCommands.length === 0) return;

    // Batch per deployment_id.
    const deploymentUpdates = new Map<
      string,
      Array<{ cmdId: string; cmdData: Record<string, any> }>
    >();

    for (const cmd of changedCommands) {
      const deploymentId = cmd.cmdData.deployment_id;
      if (!deploymentId) continue; // Not a deployment command

      if (!deploymentUpdates.has(deploymentId)) {
        deploymentUpdates.set(deploymentId, []);
      }
      deploymentUpdates.get(deploymentId)!.push(cmd);
    }

    if (deploymentUpdates.size === 0) return;

    // resolved here, not at import, so tests can import updateDeployment without an app.
    const db = getFirestore();
    const promises = Array.from(deploymentUpdates.entries()).map(
      ([deploymentId, commands]) =>
        updateDeployment(db, siteId, machineId, deploymentId, commands)
    );

    await Promise.all(promises);
  }
);

/** Update one deployment doc from one machine's command changes. */
export async function updateDeployment(
  db: Firestore,
  siteId: string,
  machineId: string,
  deploymentId: string,
  commands: Array<{ cmdId: string; cmdData: Record<string, any> }>,
): Promise<void> {
  const deploymentRef = db
    .collection('sites')
    .doc(siteId)
    .collection('deployments')
    .doc(deploymentId);

  // read-modify-write in one transaction: machines that report together would
  // otherwise each write back the targets they read, and all but one result
  // would be lost. it can rerun, so it only computes; the logging happens after.
  const outcome = await db.runTransaction(async (tx) => {
    const deploymentSnap = await tx.get(deploymentRef);

    if (!deploymentSnap.exists) return 'deployment_missing' as const;

    const deploymentData = deploymentSnap.data()!;
    const targets: DeploymentTarget[] = deploymentData.targets || [];

    const targetIndex = targets.findIndex((t) => t.machineId === machineId);
    if (targetIndex === -1) return 'target_missing' as const;

    const target = { ...targets[targetIndex] };
    const currentStatus = target.status;

    // A terminal target must not regress to an intermediate state.
    if (TARGET_TERMINAL_STATUSES.has(currentStatus)) {
      // Terminal → terminal is allowed (e.g. uninstall after install).
      const hasTerminalUpdate = commands.some((cmd) => {
        const newStatus = mapCommandToTargetStatus(
          cmd.cmdData.status,
          cmd.cmdData.type || ''
        );
        return TARGET_TERMINAL_STATUSES.has(newStatus);
      });

      if (!hasTerminalUpdate) return 'unchanged' as const;
    }

    // Commands arrive in write order, so the last one is the latest state.
    const latestCmd = commands[commands.length - 1].cmdData;
    const newTargetStatus = mapCommandToTargetStatus(
      latestCmd.status,
      latestCmd.type || ''
    );

    if (
      newTargetStatus === currentStatus &&
      latestCmd.progress === target.progress
    ) {
      return 'unchanged' as const;
    }

    target.status = newTargetStatus;

    if (latestCmd.progress !== undefined) {
      target.progress = latestCmd.progress;
    }

    if (latestCmd.error) {
      target.error = latestCmd.error;
    }

    if (TARGET_TERMINAL_STATUSES.has(newTargetStatus)) {
      delete target.progress; // Clear progress on terminal
      const now = Timestamp.now();

      if (newTargetStatus === 'cancelled') {
        target.cancelledAt = now;
      } else if (newTargetStatus === 'uninstalled') {
        target.uninstalledAt = now;
      } else {
        target.completedAt = now;
      }
    }

    const updatedTargets = [...targets];
    updatedTargets[targetIndex] = target;

    const newDeploymentStatus = calculateDeploymentStatus(updatedTargets);

    const updatePayload: Record<string, unknown> = {
      targets: updatedTargets,
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (newDeploymentStatus !== deploymentData.status) {
      updatePayload.status = newDeploymentStatus;
    }

    // completedAt is stamped once, on the transition to terminal.
    const isNowTerminal = [
      'completed', 'failed', 'partial', 'cancelled', 'uninstalled',
    ].includes(newDeploymentStatus);
    const wasTerminal = [
      'completed', 'failed', 'partial', 'cancelled', 'uninstalled',
    ].includes(deploymentData.status);

    if (isNowTerminal && !wasTerminal) {
      updatePayload.completedAt = FieldValue.serverTimestamp();
    }

    tx.update(deploymentRef, updatePayload);
    return { newTargetStatus, newDeploymentStatus };
  });

  if (outcome === 'deployment_missing') {
    console.warn(
      `Deployment ${deploymentId} not found for command update ` +
      `(site: ${siteId}, machine: ${machineId}). May have been deleted.`
    );
  } else if (outcome === 'target_missing') {
    console.warn(
      `Machine ${machineId} not found in deployment ${deploymentId} targets`
    );
  } else if (outcome !== 'unchanged') {
    console.log(
      `Deployment ${deploymentId}: machine ${machineId} -> ${outcome.newTargetStatus}, ` +
      `overall -> ${outcome.newDeploymentStatus}`
    );
  }
}
