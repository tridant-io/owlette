/**
 * a task a granted machine hands hoot (ADR 0017): one hoot turn on the server,
 * in the shape a talon's turn has, started here and read back by its `callId`,
 * `task:<chatId>:<turnId>`.
 *
 * the site owner's llm key pays, as it does for the site's other unattended
 * runs, and the chat shows in the site owner's dashboard. nobody is there to
 * approve anything, so the turn can look and make bounded changes (tier 2 at
 * most) and is offered no override, talon or follow-up. it runs as the machine
 * that asked: its tools act, and are audited, as `machine:<id>`, on machines
 * inside the grant.
 *
 * a sender may start `FLEET_TASKS_PER_HOUR` tasks an hour and run one at a
 * time, so two machines cannot hand each other tasks without end. the count
 * is read, not locked: two starts in the same instant can both pass, and the
 * hourly count catches up with them.
 *
 * the answer is handed over once, as well as one unlocked write can: two polls
 * in the same instant may both get it. a turn read as failed is over for its
 * caller, and a reply saved after that stays in the chat. nothing stops a turn
 * that outruns `TASK_TIMEOUT_SECONDS`: the script gives up, the turn runs on,
 * and the sender's next task waits for it.
 */

import crypto from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';
import type { UIMessage } from 'ai';
import { problem, problemRateLimited, problemValidation, ProblemType } from '@/lib/apiErrors';
import { Capability, hasCapability } from '@/lib/capabilities';
import {
  assertLlmKeyAvailable,
  resolveHootTargets,
  resolveSiteKeyOwner,
  verifyUserSiteAccess,
  type ResolveTargetsFailure,
  type SiteAccessLevel,
} from '@/lib/hoot-utils.server';
import {
  MAX_TARGET_MACHINES,
  chatTargetFields,
  isValidMachineId,
  neverWidenLegacyMachineId,
  type HootTarget,
  type TurnTargetRecord,
} from '@/lib/hoot/target';
import { readTurn } from '@/lib/hoot/turnReader.server';
import { startTurn } from '@/lib/hoot/turnRunner.server';
import { TURN_STALE_MS, acquireTurnLock, generateTurnId } from '@/lib/hoot/turnStore.server';
import logger from '@/lib/logger';
import type { ToolTier } from '@/lib/mcp-tools';
import { UNATTENDED_MAX_TIER } from '@/lib/talons/hootOutput.server';
import { FLEET_CALLS_COLLECTION, type FleetCallRecord } from '@/lib/fleet/calls.server';
import { ASK_HOOT_TOOL } from '@/lib/fleet/catalog.server';
import type { AdmitFleetCall, FleetCallRead, FleetCallStart, FleetContext } from '@/lib/fleet/context';
import {
  CALL_RECORD_GRACE_MS,
  callNotFound,
  denied,
  isLive,
  machineNotGranted,
} from '@/lib/fleet/refusals.server';

export const FLEET_TASKS_PER_HOUR = 6;

const HOUR_MS = 60 * 60 * 1000;

/** how long a caller waits for a task: a turn of several tool calls, and the reader's window after it. */
const TASK_TIMEOUT_SECONDS = 600 + TURN_STALE_MS / 1000;

const MAX_PROMPT_LENGTH = 8000;

const TASK_CALL_PREFIX = 'task:';
const TASK_CHAT_ID_RE = /^machine_[A-Za-z0-9_-]{1,80}$/;
const TURN_ID_RE = /^turn_[A-Za-z0-9_-]{1,40}$/;

const NO_WRITTEN_ANSWER = 'hoot finished the task without a written answer';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isFleetTaskCallId(callId: string): boolean {
  return callId.startsWith(TASK_CALL_PREFIX);
}

function parseTaskCallId(callId: string): { chatId: string; turnId: string } | null {
  const last = callId.lastIndexOf(':');
  const chatId = callId.slice(TASK_CALL_PREFIX.length, last);
  const turnId = callId.slice(last + 1);
  return TASK_CHAT_ID_RE.test(chatId) && TURN_ID_RE.test(turnId) ? { chatId, turnId } : null;
}

/** the task's words and the machines it names, or what is wrong with them. */
function readTask(
  params: Record<string, unknown>,
): { ok: true; prompt: string; machines: string[] | null } | { ok: false; field: string; detail: string } {
  const prompt = typeof params.prompt === 'string' ? params.prompt.trim() : '';
  if (prompt.length === 0) return { ok: false, field: 'params.prompt', detail: 'the task, in words' };
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return { ok: false, field: 'params.prompt', detail: `at most ${MAX_PROMPT_LENGTH} characters` };
  }
  if (params.machines === undefined) return { ok: true, prompt, machines: null };
  if (
    !Array.isArray(params.machines) ||
    params.machines.length === 0 ||
    params.machines.length > MAX_TARGET_MACHINES ||
    !params.machines.every((id): id is string => isValidMachineId(id))
  ) {
    return {
      ok: false,
      field: 'params.machines',
      detail: `a list of up to ${MAX_TARGET_MACHINES} machine ids, from list_machines`,
    };
  }
  return { ok: true, prompt, machines: [...new Set(params.machines)] };
}

function taskMessage(ctx: FleetContext, turnId: string, prompt: string): UIMessage {
  return {
    // the prefix marks it server-authored, so an `@` in the task never narrows a later turn
    id: `task_msg_${turnId}`,
    role: 'user',
    parts: [
      {
        type: 'text',
        text: [
          `This task comes from the machine ${ctx.machineId} on this site, which a site admin has allowed to act on other machines.`,
          'Nobody is watching this chat and nobody can approve anything. Do the task with the tools you have, and finish with a written answer: it is all the machine that asked will read.',
          '',
          prompt,
        ].join('\n'),
      },
    ],
  };
}

function hootUnavailable(detail: string): FleetCallStart {
  return denied(
    problem({ type: ProblemType.Conflict, title: 'hoot unavailable', status: 409, detail, code: 'hoot_unavailable' }),
    'hoot_unavailable',
    ASK_HOOT_TOOL,
    null,
  );
}

function noMachines(failure: ResolveTargetsFailure): FleetCallStart {
  const named = failure.machineIds.length > 0 ? `: ${failure.machineIds.join(', ')}` : '';
  if (failure.reason === 'hoot_disabled') {
    return denied(
      problem({
        type: ProblemType.Conflict,
        title: 'hoot disabled',
        status: 423,
        detail: `hoot is turned off on every machine this task names${named}`,
        code: 'hoot_disabled',
      }),
      'hoot_disabled',
      ASK_HOOT_TOOL,
      null,
    );
  }
  if (failure.reason === 'machine_offline' || failure.reason === 'no_machines') {
    return denied(
      problem({
        type: ProblemType.Conflict,
        title: 'machine offline',
        status: 409,
        detail: `no machine this task names is online${named}`,
        code: 'machine_offline',
      }),
      'machine_offline',
      ASK_HOOT_TOOL,
      null,
    );
  }
  return denied(
    problemValidation(`params.machines names a machine this site does not have${named}`, {
      'params.machines': ['machine ids from list_machines'],
    }),
    'validation_failed',
    ASK_HOOT_TOOL,
    null,
  );
}

/**
 * why this sender may not start a task now, or null. its task records are few
 * (they are asked for by tool), so reading them all is cheap.
 */
async function budgetRefusal(ctx: FleetContext, now: number): Promise<FleetCallStart | null> {
  const snap = await ctx.db
    .collection(FLEET_CALLS_COLLECTION)
    .where('siteId', '==', ctx.siteId)
    .where('callerMachineId', '==', ctx.machineId)
    .where('tool', '==', ASK_HOOT_TOOL)
    .get();
  const tasks = snap.docs.map((doc) => ({ turnId: doc.id, record: doc.data() as FleetCallRecord }));

  const thisHour = tasks.map((task) => task.record.createdAt).filter((at) => at > now - HOUR_MS);
  if (thisHour.length >= FLEET_TASKS_PER_HOUR) {
    const retryAfter = Math.ceil((Math.min(...thisHour) + HOUR_MS - now) / 1000);
    return denied(
      problemRateLimited(retryAfter, `this machine has started ${FLEET_TASKS_PER_HOUR} tasks for hoot in the last hour`),
      'task_budget_spent',
      ASK_HOOT_TOOL,
      null,
    );
  }

  for (const { turnId, record } of tasks) {
    if (record.collectedAt !== undefined || !record.chatId || !isLive(record.expiresAt, now)) continue;
    if ((await readTurn(ctx.db, record.chatId, turnId)).status === 'running') {
      return denied(
        problemRateLimited(30, 'a task this machine handed hoot is still running: read its answer first'),
        'task_running',
        ASK_HOOT_TOOL,
        null,
      );
    }
  }
  return null;
}

/** the site owner's access, held to the machines the grant covers. */
async function payerAccess(ctx: FleetContext): Promise<{ userId: string; access: SiteAccessLevel } | null> {
  try {
    const userId = await resolveSiteKeyOwner(ctx.db, ctx.siteId);
    await assertLlmKeyAvailable(ctx.db, userId);
    const access = await verifyUserSiteAccess(ctx.db, userId, ctx.siteId);
    return { userId, access: { ...access, standing: { ...access.standing, machineIds: ctx.grant.machineIds } } };
  } catch (err) {
    logger.warn('[fleet] a task for hoot has nobody to run as', {
      context: 'fleet/task',
      data: { siteId: ctx.siteId, err: errorMessage(err) },
    });
    return null;
  }
}

export async function startFleetTask(
  ctx: FleetContext,
  params: Record<string, unknown>,
  admit: AdmitFleetCall,
): Promise<FleetCallStart> {
  const task = readTask(params);
  if (!task.ok) {
    return denied(
      problemValidation(`${task.field}: ${task.detail}`, { [task.field]: [task.detail] }),
      'validation_failed',
      ASK_HOOT_TOOL,
      null,
    );
  }

  // every machine the task names is checked, as a queued call's one machine is
  if (task.machines) {
    const outside = task.machines.find(
      (id) => !hasCapability(ctx.actor, Capability.MACHINE_EXEC_COMMAND, ctx.siteId, id),
    );
    if (outside !== undefined) {
      return denied(machineNotGranted(outside), 'machine_not_granted', ASK_HOOT_TOOL, outside);
    }
  } else if (ctx.grant.machineIds?.length === 0) {
    return denied(
      problem({
        type: ProblemType.Forbidden,
        title: 'machine not granted',
        status: 403,
        detail: "this machine's grant names no machine to work on",
        code: 'machine_not_granted',
      }),
      'machine_not_granted',
      ASK_HOOT_TOOL,
      null,
    );
  }

  const now = Date.now();
  const overBudget = await budgetRefusal(ctx, now);
  if (overBudget) return overBudget;

  const payer = await payerAccess(ctx);
  if (!payer) {
    return hootUnavailable(
      "hoot cannot run this task now: it runs on the site owner's llm key, kept in account settings under hoot",
    );
  }

  const targets = await resolveHootTargets(ctx.db, ctx.siteId, {
    requested: task.machines,
    machineScope: ctx.grant.machineIds,
  });
  if (!targets.ok) return noMachines(targets);
  const { resolved } = targets;

  const refused = await admit({ capability: Capability.MACHINE_EXEC_COMMAND, tool: ASK_HOOT_TOOL, machineId: null });
  if (refused) return { ok: false, response: refused };

  // "every machine" is the whole site only for a whole-site grant; otherwise
  // the turn's record names the machines it reached
  const target: HootTarget = {
    machineIds: task.machines ?? (ctx.grant.machineIds === null ? null : resolved.ids),
  };
  const turnTarget: TurnTargetRecord = { machineIds: target.machineIds, fanOut: resolved.fanOut, source: 'machine' };
  const chatId = `machine_${now}_${crypto.randomBytes(6).toString('hex')}`;
  const turnId = generateTurnId();
  const recordRef = ctx.db.collection(FLEET_CALLS_COLLECTION).doc(turnId);

  // the record first: it is what lets the caller read the answer, and what the
  // budget counts
  const record: FleetCallRecord = {
    siteId: ctx.siteId,
    callerMachineId: ctx.machineId,
    tool: ASK_HOOT_TOOL,
    chatId,
    createdAt: now,
    expiresAt: now + TASK_TIMEOUT_SECONDS * 1000 + CALL_RECORD_GRACE_MS,
  };
  await recordRef.set(record);

  try {
    // the chat before the turn, as a talon's is: the runner then keeps this title
    await ctx.db
      .collection('chats')
      .doc(chatId)
      .set({
        source: 'machine',
        siteId: ctx.siteId,
        userId: payer.userId,
        ...chatTargetFields(target),
        title: `task from ${ctx.machineId}`,
        callerMachineId: ctx.machineId,
        correlationId: ctx.correlationId,
        messages: [],
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    const priorTurn = await acquireTurnLock(ctx.db, chatId, {
      turnId,
      siteId: ctx.siteId,
      machineId: neverWidenLegacyMachineId(target),
      target: turnTarget,
      resolvedMachineIds: resolved.ids,
    });
    const stream = startTurn(ctx.db, {
      chatId,
      turnId,
      siteId: ctx.siteId,
      messages: [taskMessage(ctx, turnId, task.prompt)],
      userId: payer.userId,
      access: payer.access,
      resolved,
      turnTarget,
      maxToolTier: Math.min(ctx.grant.maxTier, UNATTENDED_MAX_TIER) as ToolTier,
      priorTurn,
      machineActor: ctx.actor,
    });
    // nobody reads this branch, and unread it would buffer every chunk; the
    // runner's own branch carries the turn to its end
    void stream.cancel().catch(() => {});
  } catch (err) {
    await recordRef.delete().catch(() => undefined);
    logger.error('[fleet] a task for hoot could not be started', {
      context: 'fleet/task',
      data: { siteId: ctx.siteId, machineId: ctx.machineId, chatId, err: errorMessage(err) },
    });
    return hootUnavailable('hoot could not start this task: try again');
  }

  return {
    ok: true,
    kind: 'started',
    body: { callId: `${TASK_CALL_PREFIX}${chatId}:${turnId}`, timeoutSeconds: TASK_TIMEOUT_SECONDS },
  };
}

/** a poll is a read: no admit, no audit row. a failed read of the turn throws, and the script polls again. */
export async function readFleetTask(ctx: FleetContext, callId: string): Promise<FleetCallRead> {
  const parsed = parseTaskCallId(callId);
  if (!parsed) return callNotFound();

  // anything but this caller's own task, still to be collected, reads as unknown
  const recordRef = ctx.db.collection(FLEET_CALLS_COLLECTION).doc(parsed.turnId);
  const snap = await recordRef.get();
  const record = snap.exists ? snap.data() : undefined;
  if (
    !record ||
    record.siteId !== ctx.siteId ||
    record.callerMachineId !== ctx.machineId ||
    record.tool !== ASK_HOOT_TOOL ||
    record.chatId !== parsed.chatId ||
    record.collectedAt !== undefined ||
    !isLive(record.expiresAt, Date.now())
  ) {
    return callNotFound();
  }

  const turn = await readTurn(ctx.db, parsed.chatId, parsed.turnId);
  if (turn.status === 'running') return { ok: true, body: { status: 'in_progress' } };

  // the answer is handed over once. the record stays, marked, until it expires:
  // the hourly count reads it
  await recordRef.update({ collectedAt: Date.now() }).catch(() => undefined);
  return {
    ok: true,
    body:
      turn.status === 'complete'
        ? { status: 'completed', content: [{ type: 'text', text: turn.text || NO_WRITTEN_ANSWER }] }
        : { status: 'failed', error: turn.error },
  };
}
