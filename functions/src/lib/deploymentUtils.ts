/**
 * Deployment status calculation shared by the Firestore trigger
 * (deploymentStatus.ts) and the scheduled sweeper (deploymentSweeper.ts).
 */

// Constants

/** Target statuses that indicate the machine is done (success or failure). */
export const TARGET_TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'uninstalled',
]);

/** Deployment-level statuses that mean no more work is expected. */
export const DEPLOYMENT_TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'partial',
  'cancelled',
  'uninstalled',
]);

// Types

export interface DeploymentTarget {
  machineId: string;
  status: string;
  progress?: number;
  error?: string;
  completedAt?: number | FirebaseFirestore.Timestamp;
  cancelledAt?: number | FirebaseFirestore.Timestamp;
  uninstalledAt?: number | FirebaseFirestore.Timestamp;
  /** Stamped by the retry route when it resets a failed target to pending. */
  retriedAt?: number | FirebaseFirestore.Timestamp;
  /** Set by the reconciler on a `failed` target: the command type that failed. */
  failedCommandType?: string;
}

// Stale-target timeouts (the sweeper)

/** How long a target can sit at "pending" before we fail it (ms). */
const PENDING_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

/** How long a target can sit at "downloading"/"installing" before we fail it (ms). */
const ACTIVE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/** Epoch ms of a stored instant: numeric on legacy docs, a Timestamp on new ones, 0 when absent. */
export function instantMs(value: unknown): number {
  if (typeof value === 'number') return value;
  return (value as FirebaseFirestore.Timestamp | undefined)?.toMillis?.() || 0;
}

/**
 * Fail every non-terminal target that has outlived its timeout. Returns the new
 * targets array, or null when no target changed.
 */
export function timeOutStaleTargets(
  targets: DeploymentTarget[],
  deploymentCreatedAtMs: number,
  nowMs: number,
  failedAt: number | FirebaseFirestore.Timestamp,
): DeploymentTarget[] | null {
  let changed = false;
  const updatedTargets = targets.map((target) => {
    if (TARGET_TERMINAL_STATUSES.has(target.status)) {
      return target;
    }

    // A retried target's attempt starts at its retry: timed from the deployment,
    // every retry of a deployment older than the timeout failed at the next sweep.
    const targetAge = nowMs - Math.max(deploymentCreatedAtMs, instantMs(target.retriedAt));

    if (target.status === 'pending' && targetAge > PENDING_TIMEOUT_MS) {
      changed = true;
      return {
        ...target,
        status: 'failed',
        error: `Timed out: agent did not start after ${Math.round(PENDING_TIMEOUT_MS / 60000)} minutes`,
        completedAt: failedAt,
      };
    }

    if (
      ['downloading', 'installing', 'uninstalling'].includes(target.status) &&
      targetAge > ACTIVE_TIMEOUT_MS
    ) {
      changed = true;
      return {
        ...target,
        status: 'failed',
        error: `Timed out: agent stalled during ${target.status} after ${Math.round(ACTIVE_TIMEOUT_MS / 60000)} minutes`,
        completedAt: failedAt,
      };
    }

    return target;
  });
  return changed ? updatedTargets : null;
}

// Command → Target status mapping

/**
 * Command status + type → deployment target status. Agent statuses are
 * downloading/installing/uninstalling (intermediate) and
 * completed/failed/cancelled (terminal); `type` separates install from
 * uninstall completions.
 */
export function mapCommandToTargetStatus(
  commandStatus: string,
  commandType: string,
): string {
  if (['downloading', 'installing', 'uninstalling'].includes(commandStatus)) {
    return commandStatus;
  }

  if (commandStatus === 'cancelled') {
    return 'cancelled';
  }

  if (commandStatus === 'failed') {
    return 'failed';
  }

  // completed — meaning depends on the command type.
  if (commandStatus === 'completed') {
    if (commandType === 'uninstall_software') {
      return 'uninstalled';
    }
    return 'completed';
  }

  // Unknown status — pass through.
  return commandStatus;
}

// Deployment-level status calculation

/**
 * Calculate the overall deployment status from the targets array.
 *
 * Rules (evaluated in order):
 * 1. If any target is non-terminal → in_progress
 * 2. All targets completed → completed
 * 3. All targets cancelled → cancelled
 * 4. All targets uninstalled → uninstalled
 * 5. Mixed terminal states → partial
 */
export function calculateDeploymentStatus(targets: DeploymentTarget[]): string {
  if (!targets || targets.length === 0) return 'pending';

  const hasNonTerminal = targets.some(
    (t) => !TARGET_TERMINAL_STATUSES.has(t.status)
  );

  if (hasNonTerminal) return 'in_progress';

  const statuses = new Set(targets.map((t) => t.status));

  if (statuses.size === 1) {
    const only = statuses.values().next().value as string;
    if (only === 'completed') return 'completed';
    if (only === 'cancelled') return 'cancelled';
    if (only === 'uninstalled') return 'uninstalled';
    if (only === 'failed') return 'failed';
  }

  return 'partial';
}
