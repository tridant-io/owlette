/**
 * Hoot autonomous-mode tool dispatcher: routes every autonomously dispatched
 * command through `invokeAsSystem` + the canonical `executeMachineCommand` core
 * so each one gets an `allow` audit row (actor `system`/`cortex_autonomous`),
 * consumes the SYSTEM rate-limit bucket (a burst can't throttle human operators
 * on the same site), and is gated solely by the capability matrix — new
 * autonomous capabilities are added to `SystemCapabilityMatrix`, not here.
 *
 * User-mode hoot deliberately keeps calling `executeToolOnAgent` /
 * `executeExistingCommand` directly: those callers are session-authenticated and
 * routing them through `invokeAsSystem` would misattribute the audit actor.
 *
 * `provision_cortex_key` is NOT dispatched here — see
 * `dev/active/security-boundary-migration/reference/hoot-integration.md`.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { invokeAsSystem, type SystemInvokerContext } from '@/lib/systemInvoker.server';
import { Capability, type SystemActor } from '@/lib/capabilities';
import {
  executeMachineCommand,
  type ExecuteMachineCommandContext,
} from '@/lib/actions/executeMachineCommand.server';
import { COMMAND_POLL_INTERVAL_MS, COMMAND_TIMEOUT_MS } from '@/lib/hoot-utils.server';
import { keyedHash, toolCallHash } from '@/lib/hoot/launchAudit.server';

// types

export interface AutonomousDispatchContext {
  db: FirebaseFirestore.Firestore;
  siteId: string;
  machineId: string;
  /** Hoot investigation chat id — stamped into audit metadata. */
  chatId: string;
  /** Hoot event id (`cortex-events/{eventId}`) — stamped into audit metadata. */
  eventId: string;
}

interface DispatchOutcome {
  /** Optional structured result the LLM consumes. */
  result?: unknown;
  /** Optional error message — surfaced to the LLM as a tool failure. */
  error?: string;
}

// helpers

function actorFor(siteId: string): SystemActor {
  return { type: 'system', name: 'cortex_autonomous', siteId };
}

function metadataFor(ctx: AutonomousDispatchContext, extra: Record<string, unknown> = {}) {
  return {
    cortexChatId: ctx.chatId,
    cortexEventId: ctx.eventId,
    ...extra,
  };
}

function actionContextFor(
  ctx: AutonomousDispatchContext,
  systemCtx: SystemInvokerContext,
): ExecuteMachineCommandContext {
  return {
    siteId: systemCtx.siteId,
    machineId: ctx.machineId,
    actor: systemCtx.actor,
    auditActor: `system:${systemCtx.actor.name}`,
    correlationId: systemCtx.correlationId,
  };
}

function pendingRef(db: FirebaseFirestore.Firestore, siteId: string, machineId: string) {
  return db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('commands')
    .doc('pending');
}

function completedRef(db: FirebaseFirestore.Firestore, siteId: string, machineId: string) {
  return db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('commands')
    .doc('completed');
}

/**
 * Poll `commands/completed` for `commandId`; `null` on timeout, with best-effort
 * pending-entry cleanup callers need not await. Polling sits outside
 * `invokeAsSystem` on purpose — the privileged action is the pending-command
 * WRITE; reading the response is only an observation.
 */
async function pollForResult(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineId: string,
  commandId: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  const completed = completedRef(db, siteId, machineId);
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, COMMAND_POLL_INTERVAL_MS));

    const completedDoc = await completed.get();
    if (!completedDoc.exists) continue;

    const data = completedDoc.data();
    const cmdResult = data?.[commandId] as Record<string, unknown> | undefined;
    if (cmdResult) {
      // Cross-side contract: the agent writes `{status:'running', startedAt}` on
      // start (firebase_client.py `_mark_command_running`). Non-terminal — keep
      // polling and never delete it; the agent's terminal write overwrites it.
      if (cmdResult.status === 'running') continue;

      // Best-effort cleanup so the doc doesn't grow unbounded.
      await completed.update({ [commandId]: FieldValue.delete() }).catch(() => undefined);
      return cmdResult;
    }
  }

  // Timeout — try to remove the pending entry too.
  try {
    await pendingRef(db, siteId, machineId).update({
      [commandId]: FieldValue.delete(),
    });
  } catch {
    // Best effort.
  }
  return null;
}

// mcp tool-call dispatch

/**
 * Dispatch an MCP tool call (tier 1/2) for an autonomous investigation. The
 * pending write is wrapped in `invokeAsSystem({capability: MACHINE_EXEC_COMMAND})`;
 * polling runs outside the privileged frame. Mirrors `executeToolOnAgent` with
 * audit + rate-limit + capability mediation.
 */
export async function dispatchToolCallAsSystem(
  ctx: AutonomousDispatchContext,
  toolName: string,
  toolParams: Record<string, unknown>,
): Promise<unknown> {
  const { db, siteId, machineId, chatId } = ctx;

  // Honor any caller-supplied per-tool timeout (mirrors executeToolOnAgent).
  const toolTimeout =
    typeof toolParams.timeout_seconds === 'number'
      ? toolParams.timeout_seconds * 1000
      : COMMAND_TIMEOUT_MS;
  const pollTimeoutMs = toolTimeout + 10_000;

  const queued = await invokeAsSystem({
    actor: actorFor(siteId),
    capability: Capability.MACHINE_EXEC_COMMAND,
    siteId,
    target: { kind: 'machine', id: machineId, machineId },
    metadata: metadataFor(ctx, {
      toolName,
      commandType: 'mcp_tool_call',
      paramNames: Object.keys(toolParams),
      paramsHash: keyedHash(toolCallHash(toolName, toolParams)),
    }),
    action: async (systemCtx) =>
      executeMachineCommand(
        actionContextFor(ctx, systemCtx),
        {
          type: 'mcp_tool_call',
          payload: {
            tool_name: toolName,
            tool_params: toolParams,
            chat_id: chatId,
            timeout_seconds: toolTimeout / 1000,
          },
        },
        { db },
      ),
  });

  const { commandId } = queued;
  const cmdResult = await pollForResult(db, siteId, machineId, commandId, pollTimeoutMs);
  return interpretToolCallResult(toolName, cmdResult, pollTimeoutMs);
}

function interpretToolCallResult(
  toolName: string,
  cmdResult: Record<string, unknown> | null,
  pollTimeoutMs: number,
): DispatchOutcome | unknown {
  if (cmdResult === null) {
    return {
      error: `Tool '${toolName}' timed out after ${Math.round(pollTimeoutMs / 1000)} seconds. The machine may be slow to respond or offline.`,
    };
  }

  if (cmdResult.status === 'failed') {
    return { error: (cmdResult.error as string) || 'Tool execution failed' };
  }

  // A `cancelled` entry (no `result` field) is terminal but NOT a success —
  // surface it as a failure so the LLM doesn't read undefined as success.
  if (cmdResult.status === 'cancelled') {
    return { error: (cmdResult.error as string) || 'cancelled by user' };
  }

  const result = cmdResult.result;
  if (typeof result === 'string') {
    try {
      return JSON.parse(result);
    } catch {
      return { result };
    }
  }
  return result;
}

// legacy-typed command dispatch

/**
 * Dispatch a legacy-typed command (`restart_process`, `reboot_machine`, …).
 * Same audit/rate-limit semantics as `dispatchToolCallAsSystem`; only the
 * firestore shape differs (`process_name` instead of `tool_name`/`tool_params`).
 */
export async function dispatchExistingCommandAsSystem(
  ctx: AutonomousDispatchContext,
  commandType: string,
  commandParams: Record<string, unknown> | string = {},
): Promise<unknown> {
  const { db, siteId, machineId } = ctx;
  const payload = normalizeExistingCommandPayload(commandParams);
  const processName =
    typeof payload.process_name === 'string' ? payload.process_name : undefined;

  const queued = await invokeAsSystem({
    actor: actorFor(siteId),
    capability: Capability.MACHINE_EXEC_COMMAND,
    siteId,
    target: { kind: 'machine', id: machineId, machineId },
    metadata: metadataFor(ctx, {
      commandType,
      ...(processName ? { processName } : {}),
      paramNames: Object.keys(payload),
      paramsHash: keyedHash(toolCallHash(commandType, payload)),
    }),
    action: async (systemCtx) =>
      executeMachineCommand(
        actionContextFor(ctx, systemCtx),
        {
          type: commandType,
          payload,
        },
        { db },
      ),
  });

  const { commandId } = queued;
  const cmdResult = await pollForResult(db, siteId, machineId, commandId, COMMAND_TIMEOUT_MS);
  if (cmdResult === null) {
    return { error: `Command '${commandType}' timed out` };
  }

  // pollForResult skips `running` markers, so cmdResult is terminal here. A
  // `cancelled` entry has no `result` and carries `error: 'cancelled by user'`,
  // surfaced by the `|| cmdResult.error` fallback below.
  return {
    status: cmdResult.status,
    result: cmdResult.result || cmdResult.error || 'Command completed',
  };
}

function normalizeExistingCommandPayload(
  commandParams: Record<string, unknown> | string,
): Record<string, unknown> {
  if (typeof commandParams === 'string') {
    return commandParams ? { process_name: commandParams } : {};
  }
  if (
    commandParams === null ||
    typeof commandParams !== 'object' ||
    Array.isArray(commandParams)
  ) {
    return {};
  }
  return { ...commandParams };
}
