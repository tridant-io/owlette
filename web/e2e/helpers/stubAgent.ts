/**
 * Agent-dispatch stubs: mirror what the real agent does after running a command
 * from `sites/{siteId}/machines/{machineId}/commands/pending`.
 *
 * Contract (see `agent/src/firebase_client.py::_mark_command_completed`):
 *   1. merge `{ [commandId]: { result, status, completedAt, … } }` into
 *      `commands/completed`
 *   2. field-delete `commandId` from `commands/pending`
 * Order matters — a crash between the two must leave the command in pending
 * (retryable) rather than lose it.
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from './emulator';

function commandRefs(siteId: string, machineId: string) {
  const db = getAdminDb();
  const machineRef = db.collection('sites').doc(siteId).collection('machines').doc(machineId);
  return {
    completedRef: machineRef.collection('commands').doc('completed'),
    pendingRef: machineRef.collection('commands').doc('pending'),
  };
}

interface CompleteCommandOptions {
  /** Override the status field. Defaults to 'completed'. */
  status?: 'completed' | 'failed';
  /** Set when the command belongs to a deployment (maps to agent's deployment_id). */
  deploymentId?: string;
  /** Command type hint (maps to agent's cmd_type, e.g. 'reboot', 'kill_process'). */
  cmdType?: string;
}

/**
 * Agent finished a command successfully. Same order-of-ops as the real agent.
 */
export async function completeCommand(
  siteId: string,
  machineId: string,
  commandId: string,
  result: unknown,
  opts: CompleteCommandOptions = {},
): Promise<void> {
  const { completedRef, pendingRef } = commandRefs(siteId, machineId);

  const payload: Record<string, unknown> = {
    result,
    status: opts.status ?? 'completed',
    completedAt: Timestamp.now(),
  };
  if (opts.deploymentId) payload.deployment_id = opts.deploymentId;
  if (opts.cmdType) payload.type = opts.cmdType;

  // completed FIRST: if this throws the command stays in pending (retryable).
  await completedRef.set({ [commandId]: payload }, { merge: true });

  // Per-field delete, not a doc delete — that would discard other in-flight
  // commands.
  await pendingRef.update({ [commandId]: FieldValue.delete() });
}

/**
 * Agent failed a command: like `completeCommand` but status='failed' with an
 * `error` string instead of `result`. Mirrors `_mark_command_failed`.
 */
export async function failCommand(
  siteId: string,
  machineId: string,
  commandId: string,
  error: string,
  opts: Omit<CompleteCommandOptions, 'status'> = {},
): Promise<void> {
  const { completedRef, pendingRef } = commandRefs(siteId, machineId);

  const payload: Record<string, unknown> = {
    error,
    status: 'failed',
    completedAt: Timestamp.now(),
  };
  if (opts.deploymentId) payload.deployment_id = opts.deploymentId;
  if (opts.cmdType) payload.type = opts.cmdType;

  await completedRef.set({ [commandId]: payload }, { merge: true });
  await pendingRef.update({ [commandId]: FieldValue.delete() });
}

/**
 * The error a guarded agent fails a restart, shutdown or deployment with
 * inside active hours (`owlette_service._active_hours_block`), for
 * `failCommand`.
 */
export function activeHoursRefusal(window: { start: number; end: number }): string {
  const clock = (hour: number) => `${String(hour).padStart(2, '0')}:00`;
  return (
    `Error: active_hours: inside active hours ${clock(window.start)}–${clock(window.end)} ` +
    `(machine time); they end at ${clock(window.end)}`
  );
}

/** Pending command IDs — specs grab the generated commandId before stubbing. */
export async function getPendingCommandIds(
  siteId: string,
  machineId: string,
): Promise<string[]> {
  const { pendingRef } = commandRefs(siteId, machineId);
  const snap = await pendingRef.get();
  if (!snap.exists) return [];
  return Object.keys(snap.data() ?? {});
}

// Convenience stubs for agent behaviours that show up only as machine-doc
// status changes rather than a command doc (reboot completion, screenshot
// landing). A reboot flow typically needs BOTH completeCommand and
// stubRebootSuccess.

function machineRef(siteId: string, machineId: string) {
  return getAdminDb().collection('sites').doc(siteId).collection('machines').doc(machineId);
}

/**
 * Agent finished a reboot cycle: clears the three reboot-state flags so
 * dashboard listeners flip the "rebooting" pill back to online. Mirrors
 * `agent/src/owlette_service.py:4260`.
 */
export async function stubRebootSuccess(siteId: string, machineId: string): Promise<void> {
  await machineRef(siteId, machineId).set(
    {
      rebooting: false,
      rebootScheduledAt: null,
      rebootCancellable: false,
    },
    { merge: true },
  );
}

/**
 * Patch one target on `sites/{siteId}/deployments/{deploymentId}.targets`.
 * Firestore has no per-index array update, so this is a read-modify-write.
 * Throws when the deployment or the target is missing, so specs fail fast
 * instead of silently no-op'ing.
 */
export async function stubDeploymentTarget(
  siteId: string,
  deploymentId: string,
  machineId: string,
  patch: { status?: string; progress?: number; error?: string },
): Promise<void> {
  const db = getAdminDb();
  const ref = db.collection('sites').doc(siteId).collection('deployments').doc(deploymentId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new Error(`stubDeploymentTarget: deployment ${deploymentId} not found`);
  }
  const targets = (snap.data()?.targets ?? []) as Array<Record<string, unknown>>;
  const idx = targets.findIndex((t) => t.machineId === machineId);
  if (idx === -1) {
    throw new Error(
      `stubDeploymentTarget: machine ${machineId} not in targets for ${deploymentId}`,
    );
  }
  targets[idx] = { ...targets[idx], ...patch };
  await ref.update({ targets });
}

/**
 * Screenshot arriving on the machine doc as `lastScreenshot`
 * ({ url, timestamp, sizeKB }) — the shape `useFirestore.ts:273` consumes.
 */
export async function stubScreenshotCapture(
  siteId: string,
  machineId: string,
  url: string,
  sizeKB = 128,
): Promise<void> {
  await machineRef(siteId, machineId).set(
    {
      lastScreenshot: {
        url,
        // Timestamp.now(), not serverTimestamp(): the latter resolves AFTER
        // set() does, which races specs that read back immediately.
        timestamp: Timestamp.now(),
        sizeKB,
      },
    },
    { merge: true },
  );
}
