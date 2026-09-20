/**
 * Action core: clear a machine's `rebootPending` flag.
 *
 * The flag lives on the live machine status doc, which firestore.rules keeps
 * agent/service-account-only — the dashboard cannot clear it itself. It also
 * OUTLIVES the machine that set it: an agent writes it on a relaunch-limit
 * breach and only clears it on its own next service start
 * (`owlette_service.py`), so a machine that crashed a process and never came
 * back carries the banner indefinitely. Dismissal therefore must not depend on
 * the agent collecting a command, which is all the old `dismiss_reboot_pending`
 * command path did.
 *
 * The agent command is still queued, best-effort, so a reachable agent also
 * resets its relaunch counters and drops its local restart-prompt gate.
 */
import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';
import logger from '@/lib/logger';
import { ActionInputError, type ActionContext } from './createProcess.server';
import { executeMachineCommand } from './executeMachineCommand.server';

export interface DismissRebootPendingContext extends ActionContext {
  /** Stamped into the agent command envelope so its write-back correlates. */
  correlationId?: string;
}

export interface DismissRebootPendingInput {
  machineId: string;
}

export interface DismissRebootPendingResult {
  machineId: string;
  /** Agent command id, or null when the machine could not be commanded. */
  commandId: string | null;
}

/** Exactly what `FirebaseClient.clear_reboot_pending` and `configure_site --dismiss-reboot` write. */
const CLEARED = {
  active: false,
  processName: null,
  reason: null,
  timestamp: null,
} as const;

export async function dismissRebootPending(
  ctx: DismissRebootPendingContext,
  input: DismissRebootPendingInput,
): Promise<DismissRebootPendingResult> {
  const { siteId } = ctx;
  const { machineId } = input;

  const machineRef = getAdminDb()
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId);

  const snap = await machineRef.get();
  if (!snap.exists) {
    throw new ActionInputError(
      404,
      'machine_not_found',
      `machine ${machineId} not found on site ${siteId}`,
    );
  }

  // `update` replaces the whole map, matching the agent's cleared shape; the
  // existence check above keeps it from 500ing on a machine that is gone.
  await machineRef.update({ rebootPending: { ...CLEARED } });

  // The agent leg is advisory. The common case for a days-old flag is a machine
  // that is offline, where this throws `machine_offline` — never fail the
  // dismissal over it, and never let any other dispatch fault undo a clear that
  // already landed.
  let commandId: string | null = null;
  const processName = snap.data()?.rebootPending?.processName;
  try {
    const result = await executeMachineCommand(
      {
        siteId,
        machineId,
        actor: ctx.actor,
        auditActor: ctx.auditActor,
        correlationId: ctx.correlationId,
      },
      {
        type: 'dismiss_reboot_pending',
        payload: {
          timeout_seconds: 60,
          ...(typeof processName === 'string' && processName.length > 0
            ? { process_name: processName }
            : {}),
        },
      },
    );
    commandId = result.commandId;
  } catch (err) {
    logger.warn(`could not relay dismiss_reboot_pending to ${machineId}`, {
      context: 'actions/dismissRebootPending',
      data: { err: err instanceof Error ? err.message : String(err) },
    });
  }

  emitMutation({
    kind: 'machine_command_dispatched',
    siteId,
    actor: ctx.auditActor,
    targetId: machineId,
    attributes: {
      commandType: 'dismiss_reboot_pending',
      endpoint: `/api/sites/${siteId}/machines/${machineId}/reboot-pending`,
      method: 'DELETE',
      machineId,
      agentCommandId: commandId,
    },
  });

  return { machineId, commandId };
}
