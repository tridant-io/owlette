/**
 * Talon command dispatch — the ONLY module that acts as the `talon_runner`
 * system actor. Every talon-queued command routes through here so each
 * dispatch audits as `system:talon_runner`, consumes the SYSTEM rate-limit
 * bucket (a talon burst can never throttle operators on the same site), and
 * passes the single `SystemCapabilityMatrix.talon_runner` gate — widen that
 * matrix, not this file.
 *
 * Lives under `web/lib/jobs/` because `invokeAsSystem` may only be imported
 * from `web/lib/hoot/**`, `web/lib/jobs/**`, or tests (eslint
 * `no-restricted-imports` + `scripts/check-system-invoker-callers.mjs`).
 * `web/lib/talons/**` calls in here instead of importing the invoker, which
 * keeps that allowlist a boundary rather than a formality.
 *
 * Modelled on `@/lib/hoot/dispatch.server` — same privileged-write /
 * unprivileged-poll split, same non-terminal `running` marker handling.
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { invokeAsSystem, type SystemInvokerContext } from '@/lib/systemInvoker.server';
import { Capability, type SystemActor } from '@/lib/capabilities';
import {
  executeMachineCommand,
  type ExecuteMachineCommandContext,
} from '@/lib/actions/executeMachineCommand.server';
import {
  COMMAND_POLL_INTERVAL_MS,
  COMMAND_TIMEOUT_MS,
} from '@/lib/hoot-utils.server';
import { isTerminalCommandStatus } from '@/lib/commandLifecycle';

export interface TalonDispatchInput {
  siteId: string;
  machineId: string;
  /** Agent command type — must be in `ALLOWED_COMMAND_TYPES`. */
  type: string;
  /** Per-type command fields, merged into the firestore command envelope. */
  payload: Record<string, unknown>;
  /**
   * `talon_runs/{runId}.correlationId`, stamped into audit metadata as
   * `talonCorrelationId` so an investigator can pivot run → audit → command.
   * The envelope still carries the INVOKER's correlation id (the authorizing
   * audit row), as every other `executeMachineCommand` caller does.
   */
  correlationId: string;
}

/**
 * A terminal `commands/completed` entry, or a poll timeout. `timeout` is not
 * an error — the command may still be running; the caller decides.
 */
export type TalonCommandOutcome =
  | { status: 'completed'; commandId: string; entry: Record<string, unknown> }
  | { status: 'timeout'; commandId: string };

export interface DispatchAndAwaitOptions {
  /**
   * Poll budget; defaults to the shared 30s agent command timeout. Visual
   * checks pass 45s — the capture round-trips through the user desktop
   * session and GCS.
   */
  timeoutMs?: number;
}

function actorFor(siteId: string): SystemActor {
  return { type: 'system', name: 'talon_runner', siteId };
}

function actionContextFor(
  machineId: string,
  systemCtx: SystemInvokerContext,
): ExecuteMachineCommandContext {
  return {
    siteId: systemCtx.siteId,
    machineId,
    actor: systemCtx.actor,
    auditActor: `system:${systemCtx.actor.name}`,
    correlationId: systemCtx.correlationId,
  };
}

function commandsCollection(db: Firestore, siteId: string, machineId: string) {
  return db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('commands');
}

/**
 * Queue one command on a machine as the `talon_runner` system actor; returns
 * the firestore command id for polling. Throws through: `SystemInvoker*` when
 * capability/rate-limit/audit refuses, `ExecuteMachineCommandError` from the
 * action core (notably 409 `machine_offline`). Callers classify.
 */
export async function dispatchTalonCommand(
  db: Firestore,
  input: TalonDispatchInput,
): Promise<{ commandId: string }> {
  const { siteId, machineId, type, payload, correlationId } = input;

  return invokeAsSystem({
    actor: actorFor(siteId),
    capability: Capability.MACHINE_EXEC_COMMAND,
    siteId,
    target: { kind: 'machine', id: machineId, machineId },
    metadata: {
      talonCorrelationId: correlationId,
      commandType: type,
    },
    action: async (systemCtx) =>
      executeMachineCommand(
        actionContextFor(machineId, systemCtx),
        { type, payload },
        { db },
      ),
  });
}

/**
 * Poll `commands/completed` for a TERMINAL entry; `null` on timeout, after a
 * best-effort removal of the orphaned pending entry.
 *
 * Deliberately OUTSIDE the `invokeAsSystem` frame — the privileged act is
 * writing the pending command; reading the reply is not.
 *
 * CROSS-SIDE CONTRACT: the agent writes `{status:'running', startedAt}` on
 * start (`agent/src/firebase_client.py` `_mark_command_running`), and progress
 * statuses for installs and updates. Those entries are NON-terminal
 * ({@link isTerminalCommandStatus}): keep polling, never delete them — the
 * agent's terminal write overwrites the marker.
 */
export async function pollTalonCommandResult(
  db: Firestore,
  siteId: string,
  machineId: string,
  commandId: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  const commands = commandsCollection(db, siteId, machineId);
  const completed = commands.doc('completed');
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, COMMAND_POLL_INTERVAL_MS));

    const completedDoc = await completed.get();
    if (!completedDoc.exists) continue;

    const data = completedDoc.data();
    const cmdResult = data?.[commandId] as Record<string, unknown> | undefined;
    if (cmdResult) {
      if (!isTerminalCommandStatus(cmdResult.status)) continue;

      // Best-effort cleanup so the doc doesn't grow unbounded.
      await completed.update({ [commandId]: FieldValue.delete() }).catch(() => undefined);
      return cmdResult;
    }
  }

  // Timeout — try to remove the pending entry too.
  try {
    await commands.doc('pending').update({ [commandId]: FieldValue.delete() });
  } catch {
    // Best effort.
  }
  return null;
}

/**
 * Dispatch and wait for the machine's terminal reply — what the talon
 * executors use, since a run's status depends on what the machine said.
 */
export async function dispatchAndAwait(
  db: Firestore,
  input: TalonDispatchInput,
  options: DispatchAndAwaitOptions = {},
): Promise<TalonCommandOutcome> {
  const { commandId } = await dispatchTalonCommand(db, input);
  const entry = await pollTalonCommandResult(
    db,
    input.siteId,
    input.machineId,
    commandId,
    options.timeoutMs ?? COMMAND_TIMEOUT_MS,
  );
  return entry === null
    ? { status: 'timeout', commandId }
    : { status: 'completed', commandId, entry };
}
