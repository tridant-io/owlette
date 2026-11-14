/**
 * what a granted machine's call does (ADR 0017): start it, then read it back.
 *
 * a machine tool queues one command on one machine, only through
 * `executeMachineCommand`, which owns the allowlist, the plan gate, the offline
 * check and the dispatch audit row. a tool the server answers itself
 * (`FleetServerTool`) passes the same checks and is answered in the response.
 * a started call is read by its `callId`, `cmd:<machine>:<commandId>`, and the
 * read that hands over a terminal status deletes the result, so it is the last.
 * a task for hoot (`ask_hoot`) is started and read in `task.server.ts`.
 *
 * a call is bound to the machine that started it by a server-only record,
 * `fleet_calls/{commandId}`: a command id is no secret (the target's agent logs
 * every one), so without it a granted machine could read, and so collect, any
 * command on a machine it reaches, a screenshot or a shell's output included.
 *
 * whether a machine is outside the grant has one owner: `hasCapability` with
 * the capability the tool's tier needs.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { problem, problemValidation, ProblemType } from '@/lib/apiErrors';
import { Capability, hasCapability } from '@/lib/capabilities';
import { machineAuditActor } from '@/lib/actions/auditActor.server';
import {
  executeMachineCommand,
  ExecuteMachineCommandError,
} from '@/lib/actions/executeMachineCommand.server';
import { commandErrorToProblem } from '@/lib/machineCommandProblem';
import { COMMAND_ID_RE, lookupCommandStatus } from '@/lib/commandStatus.server';
import {
  COMMAND_TIMEOUT_MS,
  MAX_TOOL_TIMEOUT_SECONDS,
  getMachineSummary,
} from '@/lib/hoot-utils.server';
import { callTier, registryValueRefusal } from '@/lib/hoot/launchChange';
import { isValidMachineId } from '@/lib/hoot/target';
import logger from '@/lib/logger';
import { EXISTING_COMMAND_MAPPINGS, declaredParams, type McpToolDefinition } from '@/lib/mcp-tools';
import { toolParamRefusal } from '@/lib/toolParamValidation';
import { FLEET_CALLS_COLLECTION, type FleetCallRecord } from '@/lib/fleet/calls.server';
import { ASK_HOOT_TOOL, findFleetServerTool, findFleetTool, splitFleetParams } from '@/lib/fleet/catalog.server';
import { LIST_MACHINES_TOOL } from '@/lib/fleet/tools/machines.server';
import type {
  AdmitFleetCall,
  FleetCallRead,
  FleetCallStart,
  FleetContentItem,
  FleetContext,
  FleetRefusal,
} from '@/lib/fleet/context';
import {
  CALL_RECORD_GRACE_MS,
  callNotFound,
  denied,
  isLive,
  machineNotGranted,
} from '@/lib/fleet/refusals.server';
import { isFleetTaskCallId, readFleetTask, startFleetTask } from '@/lib/fleet/task.server';

const CALL_ID_PREFIX = 'cmd:';

/** how long a command may run when its tool names no timeout: hoot's wait for one. */
const DEFAULT_CALL_TIMEOUT_SECONDS = COMMAND_TIMEOUT_MS / 1000;

// firestore's limit for one batch; whatever is left goes at the next call.
const PRUNE_BATCH_LIMIT = 500;

// a refused tool name is the caller's text, bounded before it reaches an audit row.
const MAX_DENIED_TOOL_NAME = 128;

// each machine of a call costs an allow row and a place in the rate limit
const MAX_MACHINES_PER_CALL = 50;

/** tier 1 reads a machine; tiers 2 and 3 run commands on it. */
export function fleetToolCapability(def: McpToolDefinition): Capability {
  return def.tier === 1 ? Capability.MACHINE_VIEW : Capability.MACHINE_EXEC_COMMAND;
}

const SCREENSHOT_TOOL = 'capture_screenshot';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * the tool's own timeout when it defines `timeout_seconds` (the caller's value,
 * else the declared default the agent applies), clamped to hoot's cap; the
 * command default for any other tool.
 */
function callTimeoutSeconds(def: McpToolDefinition, toolParams: Record<string, unknown>): number {
  const declared = def.parameters.properties.timeout_seconds;
  if (!declared) return DEFAULT_CALL_TIMEOUT_SECONDS;
  const asked = toolParams.timeout_seconds ?? declared.default;
  if (typeof asked !== 'number' || !Number.isFinite(asked) || asked <= 0) return DEFAULT_CALL_TIMEOUT_SECONDS;
  // the 30-second floor: configure_gpu_tdr's timeout_seconds is a registry
  // value (TdrDelay, 2-300), not how long the call runs, and no call finishes
  // sooner than the agent picks it up.
  return Math.min(Math.max(Math.ceil(asked), DEFAULT_CALL_TIMEOUT_SECONDS), MAX_TOOL_TIMEOUT_SECONDS);
}

/**
 * a grant is an admin's deliberate grant, as an api key is: a call's parameters
 * are checked as hoot's are, a call that changes what a machine launches counts
 * as tier 3 (ADR 0019), whatever its tool's tier, and the registry values hoot
 * never reaches are refused here too.
 */
function callRefusal(
  ctx: FleetContext,
  def: McpToolDefinition,
  machine: string | null,
  toolParams: Record<string, unknown>,
): FleetRefusal | null {
  // the fleet's own list, which takes no parameters and changes nothing
  if (def.name === LIST_MACHINES_TOOL) return null;
  const machineId = machine !== null && isValidMachineId(machine) ? machine : null;
  const invalidParams = toolParamRefusal(def.name, toolParams, findFleetServerTool(def.name)?.definition);
  if (invalidParams) {
    return denied(
      problem({
        type: ProblemType.ValidationFailed,
        title: 'validation failed',
        status: 400,
        detail: invalidParams,
        code: 'tool_params_invalid',
      }),
      'tool_params_invalid',
      def.name,
      machineId,
    );
  }
  // the catalog offers no tool above the grant, so only a launch change can exceed it
  if (callTier(def.name, toolParams, def.tier) > ctx.grant.maxTier) {
    return denied(
      problem({
        type: ProblemType.Forbidden,
        title: 'forbidden',
        status: 403,
        detail: `this call changes what the machine launches, so it is tier 3, and this machine's grant is tier ${ctx.grant.maxTier}. the site's grant would need tier 3 for it.`,
        code: 'max_tool_tier_exceeded',
      }),
      'max_tool_tier_exceeded',
      def.name,
      machineId,
    );
  }
  const registryRefusal = registryValueRefusal(def.name, toolParams);
  if (registryRefusal) {
    return denied(
      problem({
        type: ProblemType.Forbidden,
        title: 'forbidden',
        status: registryRefusal.status,
        detail: registryRefusal.detail,
        code: registryRefusal.error,
      }),
      registryRefusal.error,
      def.name,
      machineId,
    );
  }
  return null;
}

/**
 * bind a started call to its caller, then prune expired records. both are
 * best-effort: the command is already queued, and a call with no record only
 * cannot be read back. the prune asks for expired records alone, whoever
 * started them: a caller's live ones can run to thousands, and reading them
 * on every call would let one machine run up the bill.
 */
async function recordFleetCall(
  ctx: FleetContext,
  commandId: string,
  call: { machineId: string; tool: string; timeoutSeconds: number },
): Promise<void> {
  const calls = ctx.db.collection(FLEET_CALLS_COLLECTION);
  const now = Date.now();
  const record: FleetCallRecord = {
    siteId: ctx.siteId,
    callerMachineId: ctx.machineId,
    machineId: call.machineId,
    tool: call.tool,
    createdAt: now,
    expiresAt: now + call.timeoutSeconds * 1000 + CALL_RECORD_GRACE_MS,
  };
  try {
    await calls.doc(commandId).set(record);
  } catch (err) {
    logger.warn('[fleet] a started call has no record and cannot be read back', {
      context: 'fleet/dispatch',
      data: { siteId: ctx.siteId, machineId: call.machineId, commandId, err: errorMessage(err) },
    });
  }

  try {
    const expired = await calls.where('expiresAt', '<=', now).limit(PRUNE_BATCH_LIMIT).get();
    if (!expired.empty) {
      const batch = ctx.db.batch();
      for (const doc of expired.docs) batch.delete(doc.ref);
      await batch.commit();
    }
  } catch (err) {
    logger.warn('[fleet] could not prune expired calls', {
      context: 'fleet/dispatch',
      data: { err: errorMessage(err) },
    });
  }
}

function noMachineNamed(tool: string): FleetRefusal {
  return denied(
    problemValidation('params.machine must be the id of a machine, from list_machines', {
      'params.machine': ['required machine id'],
    }),
    'validation_failed',
    tool,
    null,
  );
}

/** a 'machines' tool's call whose machines cannot be told, or are too many. */
function notTheseMachines(tool: string, detail: string): FleetRefusal {
  return denied(problemValidation(detail, { params: [detail] }), 'validation_failed', tool, null);
}

/** why a call may not act on `machine`, or null: it is a machine's id, inside the grant, in the site, with hoot on. */
async function machineRefusal(
  ctx: FleetContext,
  capability: Capability,
  tool: string,
  machine: string,
): Promise<FleetRefusal | null> {
  if (!isValidMachineId(machine)) return noMachineNamed(tool);
  if (!hasCapability(ctx.actor, capability, ctx.siteId, machine)) {
    return denied(machineNotGranted(machine), 'machine_not_granted', tool, machine);
  }

  const target = await getMachineSummary(ctx.db, ctx.siteId, machine);
  if (!target) {
    return denied(
      problem({
        type: ProblemType.NotFound,
        title: 'machine not found',
        status: 404,
        detail: `machine ${machine} is not in this site`,
      }),
      'not_found',
      tool,
      machine,
    );
  }
  if (!target.hootEnabled) {
    return denied(
      problem({
        type: ProblemType.Conflict,
        title: 'hoot disabled',
        status: 423,
        detail: `hoot is turned off on machine ${machine}`,
        code: 'hoot_disabled',
      }),
      'hoot_disabled',
      tool,
      machine,
    );
  }
  return null;
}

export async function startFleetCall(
  ctx: FleetContext,
  input: { tool: unknown; params: unknown },
  admit: AdmitFleetCall,
): Promise<FleetCallStart> {
  const def = typeof input.tool === 'string' ? findFleetTool(input.tool, ctx.grant.maxTier) : null;
  if (!def) {
    return denied(
      problem({
        type: ProblemType.Forbidden,
        title: 'tool not allowed',
        status: 403,
        detail: "this machine's grant offers no tool by that name",
        code: 'tool_not_allowed',
      }),
      'tool_not_allowed',
      typeof input.tool === 'string' ? input.tool.slice(0, MAX_DENIED_TOOL_NAME) : null,
      null,
    );
  }
  const serverTool = findFleetServerTool(def.name);
  const capability = fleetToolCapability(def);
  const { machine, toolParams } = splitFleetParams(input.params);
  if (def.name === ASK_HOOT_TOOL) return startFleetTask(ctx, toolParams, admit);
  const refusal = callRefusal(ctx, def, machine, toolParams);
  if (refusal) return refusal;
  if (serverTool?.target === 'site') {
    const refused = await admit({ capability, tool: def.name, machineId: null });
    if (refused) return { ok: false, response: refused };
    return { ok: true, kind: 'answered', body: await serverTool.run(ctx, declaredParams(serverTool.definition, toolParams)) };
  }

  if (serverTool?.target === 'machines') {
    const params = declaredParams(serverTool.definition, toolParams);
    const named = await serverTool.machines(ctx, params);
    if ('error' in named) return notTheseMachines(def.name, named.error);
    const machines = [...new Set(named.machines)];
    if (machines.length === 0) return notTheseMachines(def.name, 'the call names no machine');
    if (machines.length > MAX_MACHINES_PER_CALL) {
      return notTheseMachines(def.name, `one call acts on at most ${MAX_MACHINES_PER_CALL} machines, and this one names ${machines.length}`);
    }
    // every machine is checked before any is admitted: a call that fails on its last machine leaves no allow row
    for (const id of machines) {
      const refusal = await machineRefusal(ctx, capability, def.name, id);
      if (refusal) return refusal;
    }
    for (const id of machines) {
      const refused = await admit({ capability, tool: def.name, machineId: id });
      if (refused) return { ok: false, response: refused };
    }
    return { ok: true, kind: 'answered', body: await serverTool.run(ctx, machines, params) };
  }

  if (machine === null) return noMachineNamed(def.name);
  const machineRefused = await machineRefusal(ctx, capability, def.name, machine);
  if (machineRefused) return machineRefused;

  const refused = await admit({ capability, tool: def.name, machineId: machine });
  if (refused) return { ok: false, response: refused };

  if (serverTool) {
    return {
      ok: true,
      kind: 'answered',
      body: await serverTool.run(ctx, machine, declaredParams(serverTool.definition, toolParams)),
    };
  }

  // a screenshot goes as its own command type: only that one stores the picture
  // and gets a signed read url on the read, which mcp_tool_call never does. its
  // `monitor` passed the parameter check, so it goes as it is.
  const commandType = def.name === SCREENSHOT_TOOL ? SCREENSHOT_TOOL : EXISTING_COMMAND_MAPPINGS[def.name];
  const timeoutSeconds = commandType ? DEFAULT_CALL_TIMEOUT_SECONDS : callTimeoutSeconds(def, toolParams);
  let commandId: string;
  try {
    ({ commandId } = await executeMachineCommand(
      {
        siteId: ctx.siteId,
        machineId: machine,
        actor: ctx.actor,
        auditActor: machineAuditActor(ctx.machineId),
        correlationId: ctx.correlationId,
      },
      {
        ...(commandType
          ? { type: commandType, payload: toolParams }
          : {
              type: 'mcp_tool_call',
              payload: { tool_name: def.name, tool_params: toolParams, timeout_seconds: timeoutSeconds },
            }),
        auditAttributes: { toolName: def.name },
      },
      { db: ctx.db },
    ));
  } catch (err) {
    if (err instanceof ExecuteMachineCommandError) {
      return denied(commandErrorToProblem(err), err.code, def.name, machine);
    }
    throw err;
  }

  await recordFleetCall(ctx, commandId, { machineId: machine, tool: def.name, timeoutSeconds });
  return {
    ok: true,
    kind: 'started',
    body: { callId: `${CALL_ID_PREFIX}${machine}:${commandId}`, timeoutSeconds },
  };
}

/**
 * `cmd:<machine>:<commandId>`, split on the first and last colons. a machine id
 * never holds a colon (`isValidMachineId`), so `cmd:a:b:cmd_x` is refused.
 */
function parseCallId(callId: string): { machine: string; commandId: string } | null {
  if (!callId.startsWith(CALL_ID_PREFIX)) return null;
  const last = callId.lastIndexOf(':');
  const machine = callId.slice(CALL_ID_PREFIX.length, last);
  const commandId = callId.slice(last + 1);
  return isValidMachineId(machine) && COMMAND_ID_RE.test(commandId) ? { machine, commandId } : null;
}

/** a tool's result arrives as the agent's json string: show it indented. */
function prettyJsonOrText(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  return parsed !== null && typeof parsed === 'object' ? JSON.stringify(parsed, null, 2) : text;
}

function contentFor(result: Record<string, unknown> | string | undefined): FleetContentItem[] {
  if (result === undefined) return [{ type: 'text', text: 'completed with no output' }];
  if (typeof result === 'string') return [{ type: 'text', text: prettyJsonOrText(result) }];
  if (typeof result.screenshot_url === 'string') {
    return [{ type: 'image_url', url: result.screenshot_url, text: `screenshot: ${result.screenshot_url}` }];
  }
  return [{ type: 'text', text: JSON.stringify(result, null, 2) }];
}

/** a poll is a read: no admit, no audit row. */
export async function readFleetCall(ctx: FleetContext, callId: string): Promise<FleetCallRead> {
  if (isFleetTaskCallId(callId)) return readFleetTask(ctx, callId);
  const parsed = parseCallId(callId);
  if (!parsed) return callNotFound();
  const { machine, commandId } = parsed;
  if (!hasCapability(ctx.actor, Capability.MACHINE_VIEW, ctx.siteId, machine)) {
    return { ok: false, response: machineNotGranted(machine) };
  }

  // anything but this caller's own live call reads as unknown, and nothing
  // of the command is read or collected.
  const recordRef = ctx.db.collection(FLEET_CALLS_COLLECTION).doc(commandId);
  const recordSnap = await recordRef.get();
  const record = recordSnap.exists ? recordSnap.data() : undefined;
  if (
    !record ||
    record.siteId !== ctx.siteId ||
    record.callerMachineId !== ctx.machineId ||
    record.machineId !== machine
  ) {
    return callNotFound();
  }
  if (!isLive(record.expiresAt, Date.now())) {
    await recordRef.delete().catch(() => undefined);
    return callNotFound();
  }

  const lookup = await lookupCommandStatus(ctx.db, ctx.siteId, machine, commandId);
  if (!lookup) return callNotFound();
  if (lookup.status === 'pending' || lookup.status === 'in_progress') {
    return { ok: true, body: { status: lookup.status } };
  }

  // the terminal read is the last one: keep the machine's one results document small
  await Promise.all([
    ctx.db
      .collection('sites')
      .doc(ctx.siteId)
      .collection('machines')
      .doc(machine)
      .collection('commands')
      .doc('completed')
      .update({ [commandId]: FieldValue.delete() })
      .catch(() => undefined),
    recordRef.delete().catch(() => undefined),
  ]);

  return {
    ok: true,
    body:
      lookup.status === 'completed'
        ? { status: 'completed', content: contentFor(lookup.result) }
        : { status: 'failed', error: lookup.error ?? 'the command failed without an error message' },
  };
}
