/**
 * what a granted machine's call does (ADR 0017): start it, then read it back.
 *
 * a machine tool queues one command on one machine, only through
 * `executeMachineCommand`, which owns the allowlist, the plan gate, the offline
 * check and the dispatch audit row. `list_machines` the server answers itself.
 * a started call is read by its `callId`, `cmd:<machine>:<commandId>`, and the
 * read that hands over a terminal status deletes the result, so it is the last.
 *
 * a call is bound to the machine that started it by a server-only record,
 * `fleet_calls/{commandId}`: a command id is no secret (the target's agent logs
 * every one), so without it a granted machine could read, and so collect, any
 * command on a machine it reaches, a screenshot or a shell's output included.
 *
 * whether a machine is outside the grant has one owner: `hasCapability` with
 * the capability the tool's tier needs. `grantCovers` only filters a list.
 */

import type { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { problem, problemValidation, ProblemType } from '@/lib/apiErrors';
import { Capability, hasCapability } from '@/lib/capabilities';
import { machineAuditActor } from '@/lib/actions/auditActor.server';
import {
  executeMachineCommand,
  ExecuteMachineCommandError,
} from '@/lib/actions/executeMachineCommand.server';
import { commandErrorToProblem } from '@/lib/machineCommandProblem';
import { COMMAND_ID_RE, lookupCommandStatus, type CommandStatus } from '@/lib/commandStatus.server';
import { timestampToMs } from '@/lib/firestoreTime.server';
import {
  COMMAND_TIMEOUT_MS,
  MAX_TOOL_TIMEOUT_SECONDS,
  getMachineSummary,
} from '@/lib/hoot-utils.server';
import { isValidMachineId } from '@/lib/hoot/target';
import logger from '@/lib/logger';
import { EXISTING_COMMAND_MAPPINGS, type McpToolDefinition } from '@/lib/mcp-tools';
import { FLEET_CALLS_COLLECTION, type FleetCallRecord } from '@/lib/fleet/calls.server';
import { LIST_MACHINES_TOOL, findFleetTool, splitFleetParams } from '@/lib/fleet/catalog.server';
import { grantCovers } from '@/lib/fleet/policy.server';
import type { AdmitFleetCall, FleetCallDenial, FleetContext } from '@/lib/fleet/context';

/** every item carries `text`, so a script that does not know a kind still shows words. */
export type FleetContentItem =
  | { type: 'text'; text: string }
  | { type: 'image_url'; url: string; text: string };

/** `deny` is absent when `admit` refused: the request handler recorded that one. */
export interface FleetRefusal {
  ok: false;
  response: NextResponse;
  deny?: FleetCallDenial;
}

export type FleetCallStart =
  | { ok: true; kind: 'answered'; body: { status: 'completed'; content: FleetContentItem[] } }
  | { ok: true; kind: 'started'; body: { callId: string; timeoutSeconds: number } }
  | FleetRefusal;

export interface FleetCallState {
  status: CommandStatus;
  content?: FleetContentItem[];
  error?: string;
}

export type FleetCallRead = { ok: true; body: FleetCallState } | FleetRefusal;

const CALL_ID_PREFIX = 'cmd:';

/** how long a command may run when its tool names no timeout: hoot's wait for one. */
const DEFAULT_CALL_TIMEOUT_SECONDS = COMMAND_TIMEOUT_MS / 1000;

// a record outlives its call's timeout by an hour, so a script still polling
// at the edge finds it; after that the next call anyone starts prunes it.
const CALL_RECORD_GRACE_MS = 60 * 60 * 1000;

// firestore's limit for one batch; whatever is left goes at the next call.
const PRUNE_BATCH_LIMIT = 500;

// a refused tool name is the caller's text, bounded before it reaches an audit row.
const MAX_DENIED_TOOL_NAME = 128;

/** tier 1 reads a machine; tiers 2 and 3 run commands on it. */
export function fleetToolCapability(def: McpToolDefinition): Capability {
  return def.tier === 1 ? Capability.MACHINE_VIEW : Capability.MACHINE_EXEC_COMMAND;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function denied(response: NextResponse, reason: string, tool: string | null, machineId: string | null): FleetRefusal {
  return { ok: false, response, deny: { reason, tool, machineId } };
}

function machineNotGranted(machine: string): NextResponse {
  return problem({
    type: ProblemType.Forbidden,
    title: 'machine not granted',
    status: 403,
    detail: `this machine's grant does not reach ${machine}`,
    code: 'machine_not_granted',
  });
}

function callNotFound(): FleetRefusal {
  return {
    ok: false,
    response: problem({
      type: ProblemType.NotFound,
      title: 'call not found',
      status: 404,
      detail: 'no such call: it never started, or its result was already collected',
    }),
  };
}

function isLive(expiresAt: unknown, now: number): boolean {
  return typeof expiresAt === 'number' && expiresAt > now;
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

async function listMachines(ctx: FleetContext): Promise<FleetCallStart> {
  const snap = await ctx.db.collection('sites').doc(ctx.siteId).collection('machines').get();
  const now = Date.now();
  const machines = snap.docs
    .filter((doc) => grantCovers(ctx.grant, doc.id))
    .map((doc) => {
      const data = doc.data();
      // read as the public machines list route reads them
      const heartbeatMs = timestampToMs(data.lastHeartbeat ?? data.presence?.lastHeartbeat ?? null);
      return {
        id: doc.id,
        online: data.online === true,
        lastHeartbeatAgeSeconds: heartbeatMs === null ? null : Math.max(0, Math.floor((now - heartbeatMs) / 1000)),
        os: data.os ?? data.presence?.os ?? null,
        agentVersion: data.agent_version ?? data.presence?.agent_version ?? null,
        // as isHootEnabled reads it: absent means on
        hootEnabled: data.cortexEnabled !== false,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    ok: true,
    kind: 'answered',
    body: { status: 'completed', content: [{ type: 'text', text: JSON.stringify(machines, null, 2) }] },
  };
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
  if (def.name === LIST_MACHINES_TOOL) {
    const refused = await admit({ capability: Capability.MACHINE_VIEW, tool: def.name, machineId: null });
    if (refused) return { ok: false, response: refused };
    return listMachines(ctx);
  }

  const { machine, toolParams } = splitFleetParams(input.params);
  if (machine === null || !isValidMachineId(machine)) {
    return denied(
      problemValidation('params.machine must be the id of a machine, from list_machines', {
        'params.machine': ['required machine id'],
      }),
      'validation_failed',
      def.name,
      null,
    );
  }
  const capability = fleetToolCapability(def);
  if (!hasCapability(ctx.actor, capability, ctx.siteId, machine)) {
    return denied(machineNotGranted(machine), 'machine_not_granted', def.name, machine);
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
      def.name,
      machine,
    );
  }
  if (!target.hootEnabled) {
    return denied(
      problem({
        type: ProblemType.Conflict,
        title: 'hoot disabled',
        status: 409,
        detail: `hoot is turned off on machine ${machine}`,
        code: 'hoot_disabled',
      }),
      'hoot_disabled',
      def.name,
      machine,
    );
  }

  const refused = await admit({ capability, tool: def.name, machineId: machine });
  if (refused) return { ok: false, response: refused };

  const commandType = EXISTING_COMMAND_MAPPINGS[def.name];
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
