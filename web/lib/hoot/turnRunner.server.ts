/**
 * Hoot turn runner — detached LLM loop.
 *
 * The turn outlives the HTTP request: `startTurn` returns the live UI-message
 * stream immediately and keeps running server-side even if the response dies
 * (proxy idle timeout, page reload, network drop).
 *
 * - The machines it talks to are decided by the CALLER (route, follow-up sweep,
 *   talon) and handed over resolved. The runner may only narrow that set against
 *   what is online and hoot-enabled at turn start — it never re-derives it from
 *   what was requested, so an approved tool call can't be re-aimed by anything
 *   that changed between the request and the dispatch.
 * - The chunk stream is teed: one branch to the route, the other pumped via
 *   `readUIMessageStream` into throttled `writeSnapshot` calls on
 *   `chats/{chatId}/stream/current`, so a reattaching client can render the
 *   turn from Firestore alone.
 * - A transient `data-heartbeat` every ~20s keeps proxies from seeing an idle
 *   connection and bumps the stream doc's `updatedAt` (TURN_STALE_MS is 45s),
 *   which is why tool poll loops need no per-poll touch.
 * - History is repaired before the model call — dangling tool parts recovered
 *   from `commands/completed` via the prior stream doc's `toolCommands` index
 *   — then persisted immediately (turnId-guarded) so the user's message is
 *   durable before any reattach, even if the model or a tool later fails.
 * - A per-turn AbortController fires when `touch` reports lost ownership
 *   (superseded, or stopped via /api/hoot/stop), killing streamText and the
 *   in-flight tool poll loops.
 * - On finish the runner is the persist authority: marks the turn terminal,
 *   writes the final message array (schema mirrors `useHoot.ts`), triggers
 *   categorization for new conversations.
 *
 * `startTurn` never throws; every detached chain ends in `finishTurn('error')`
 * and surfaces an error chunk, so the client always sees the turn terminate.
 * turnStore writes are turnId-guarded no-ops once superseded.
 *
 * Server-side only — never import this in client components.
 */

import {
  convertToModelMessages,
  createUIMessageStream,
  readUIMessageStream,
  stepCountIs,
  streamText,
  type InferUIMessageChunk,
  type UIMessage,
} from 'ai';
import { FieldValue } from 'firebase-admin/firestore';
import {
  buildHootSystemPrompt,
  createCheapModel,
  createModel,
  type HootPromptMode,
  type ProcessSummary,
} from '@/lib/llm';
import { getToolsByTier, type ToolTier } from '@/lib/mcp-tools';
import {
  buildExecutableTools,
  getHootRequireTier3Approval,
  listSiteMachines,
  resolveHootMaxTier,
  resolveLlmConfig,
  type SiteAccessLevel,
  type SiteMachineSummary,
} from '@/lib/hoot-utils.server';
import {
  applyApprovalConsumption,
  reapplyConsumedParts,
  repairDanglingToolParts,
  STILL_RUNNING_ERROR,
  type ApprovalConsumptionResult,
  type LostResultResolution,
} from '@/lib/hoot/repairMessages';
import { claimApproval } from '@/lib/hoot/approvalLedger.server';
import { advisorCallsIn, modelHistoryFor, withAdvisor } from '@/lib/hoot/advisor';
import { ADVISOR_TOOL_NAME } from '@/lib/llmModels';
import {
  approvalRequestedIds,
  finishTurn,
  recordResolvedMachines,
  recordToolCommand,
  touch,
  writeSnapshot,
} from '@/lib/hoot/turnStore.server';
import {
  SITE_TARGET_ID,
  chatTargetFields,
  type HootTarget,
  type HootTurnMetadata,
  type PriorTurn,
  type ResolvedTargets,
  type TurnTargetRecord,
} from '@/lib/hoot/target';
import { categorizeNewChat } from '@/lib/hoot/categorizeChat.server';
import { UNTITLED_CHAT_TITLE } from '@/lib/hoot/untitledChat';
import { sanitizeForLog } from '@/lib/logSanitize';
import { PLAN_REQUIRED_DETAIL, requireEntitlement } from '@/lib/plan.server';

/** Transient heartbeat cadence — keeps proxies from seeing an idle stream. */
export const HEARTBEAT_INTERVAL_MS = 20_000;

const timing = {
  heartbeatMs: HEARTBEAT_INTERVAL_MS,
};

/** Test-only: shrink timer cadences so suites don't need 20s real waits. */
export function _setTurnTimingForTests(overrides?: { heartbeatMs?: number }): void {
  timing.heartbeatMs = overrides?.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
}

export interface StartTurnParams {
  chatId: string;
  turnId: string;
  siteId: string;
  messages: UIMessage[];
  userId: string;
  access: SiteAccessLevel;
  /**
   * The machines this turn dispatches to, already resolved by the caller
   * against the site's listing (and, for an approval resume, inherited from the
   * turn that asked). The runner narrows it at turn start and never widens it.
   */
  resolved: ResolvedTargets;
  /** What the turn ASKED for — the same record the claim wrote on the stream doc. */
  turnTarget: TurnTargetRecord;
  /**
   * The chat's stored SELECTION, given ONLY for a non-resume, user-sent turn.
   * Absent means "leave what is stored alone": a resume, follow-up or talon turn
   * targets a set the user did not just pick, and writing it back would move the
   * chat's selection behind their back.
   */
  chatTarget?: HootTarget;
  /**
   * Ceiling on this turn's tool tier, intersected with what `access` earns so
   * it can only LOWER the tool set. Omitted = whatever `access` earns.
   * The talon path sets this instead of degrading `access`, so fire-time
   * access re-resolution still demotes a demoted author to tier 1.
   */
  maxToolTier?: ToolTier;
  /** The previous turn's record, read inside the claim transaction. */
  priorTurn: PriorTurn | null;
  /**
   * Force the tier-3 in-chat approval gate on for this turn, whatever the site
   * setting says. Raises the gate, never lowers it. Scheduled follow-ups set
   * it: nobody is watching the instant one fires, so a tier-3 tool has to wait
   * for a person rather than auto-executing.
   */
  forceTier3Approval?: boolean;
  source?: 'user' | 'followup' | 'talon';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The resolved set, re-checked against the site listing at turn start. Turns
 * queue behind one another and a machine can drop off (or have hoot switched
 * off) between the request and the dispatch, so what the caller resolved is a
 * CEILING: ids only ever leave this set. A machine that is no longer in the
 * listing at all counts as offline — it can receive nothing either way.
 */
function narrowToLiveMachines(
  resolved: ResolvedTargets,
  machines: SiteMachineSummary[],
): ResolvedTargets {
  const byId = new Map(machines.map((machine) => [machine.id, machine]));
  const ids: string[] = [];
  const offline = [...resolved.skipped.offline];
  const disabled = [...resolved.skipped.disabled];

  for (const id of resolved.ids) {
    const machine = byId.get(id);
    if (!machine || !machine.online) offline.push(id);
    else if (!machine.hootEnabled) disabled.push(id);
    else ids.push(id);
  }

  // `fanOut` follows what was REQUESTED and is decided before this: a two-machine
  // turn with one machine gone still reports per machine.
  return { ids, fanOut: resolved.fanOut, skipped: { offline, disabled } };
}

/** Why a turn has nowhere to run — the site-wide copy is the one e2e pins. */
function noLiveMachinesError(target: TurnTargetRecord, resolved: ResolvedTargets): Error {
  // The kill switch alone, whatever the target's shape: machines that ARE online
  // must not be reported as asleep, or the fix ("turn hoot back on") is invisible.
  if (resolved.skipped.offline.length === 0 && resolved.skipped.disabled.length > 0) {
    return new Error('Hoot is disabled on every machine this turn targets.');
  }
  return new Error(
    target.machineIds === null
      ? 'No machines are currently online in this site.'
      : 'None of the selected machines are online with hoot enabled.',
  );
}

/** Process configs from Firestore, for system-prompt context. */
async function fetchProcessSummaries(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineId: string,
): Promise<ProcessSummary[]> {
  try {
    const configDoc = await db
      .collection('config')
      .doc(siteId)
      .collection('machines')
      .doc(machineId)
      .get();

    if (!configDoc.exists) return [];

    const data = configDoc.data();
    const processes = data?.processes;
    if (!Array.isArray(processes)) return [];

    return processes.map((p: Record<string, unknown>) => ({
      name: (p.name as string) || 'Unknown',
      launch_mode: (p.launch_mode as string) || (p.autolaunch ? 'always' : 'off'),
      exe_path: (p.exe_path as string) || (p.path as string) || '',
      ...(p.file_path ? { file_path: p.file_path as string } : {}),
      ...(p.cwd ? { cwd: p.cwd as string } : {}),
    }));
  } catch {
    return [];
  }
}

/** Per-machine recovery outcome (before it is shaped for single vs site mode). */
type MachineOutcome =
  | { kind: 'output'; output: unknown }
  | { kind: 'error'; errorText: string }
  | null;

/**
 * Classify one machine's `commands/completed` entry:
 * success → `{ output }` (JSON-parsed like executeToolOnAgent); failed /
 * cancelled → `{ errorText }`; running → STILL_RUNNING_ERROR; entry absent
 * (consumed, GC'd, never dispatched) or read failure → `null`.
 */
async function resolveMachineEntry(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineId: string,
  commandId: string,
): Promise<MachineOutcome> {
  try {
    const completedDoc = await db
      .collection('sites')
      .doc(siteId)
      .collection('machines')
      .doc(machineId)
      .collection('commands')
      .doc('completed')
      .get();

    const cmd = completedDoc.exists
      ? ((completedDoc.data() ?? {})[commandId] as Record<string, unknown> | undefined)
      : undefined;
    if (!cmd) return null;

    if (cmd.status === 'running') {
      return { kind: 'error', errorText: STILL_RUNNING_ERROR };
    }
    if (cmd.status === 'failed' || cmd.status === 'cancelled') {
      return {
        kind: 'error',
        errorText:
          (typeof cmd.error === 'string' && cmd.error) ||
          (cmd.status === 'cancelled' ? 'cancelled by user' : 'Tool execution failed'),
      };
    }

    // Parse string results like executeToolOnAgent does.
    const result = cmd.result;
    if (typeof result === 'string') {
      try {
        return { kind: 'output', output: JSON.parse(result) };
      } catch {
        return { kind: 'output', output: { result } };
      }
    }
    return { kind: 'output', output: result };
  } catch {
    // Recovery is best-effort — fall back to the synthesized lost-result error.
    return null;
  }
}

/**
 * Repair-time recovery resolver over the PRIOR turn's `toolCommands` index
 * (`toolCallId → machineId → { commandId }`). Output shape must match what the
 * live path produces: single-machine returns the unwrapped result; site mode
 * aggregates every machine into `{ machines: [{ machine, ...result }] }` (a
 * failure contributes `{ machine, error }`, an absent entry is skipped).
 * `null` when nothing resolves — the repair then synthesizes a lost-result error.
 *
 * The shape follows the turn that DISPATCHED the call (`prior.fanOut`), not the
 * one recovering it: a fan-out recovered under a later single-machine turn must
 * still hand back every machine's result, tagged, and one machine's result
 * recovered under a fan-out must stay unwrapped.
 */
function buildResolveLostResult(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  prior: PriorTurn | null,
): (toolCallId: string) => Promise<LostResultResolution | null> {
  return async (toolCallId) => {
    if (prior === null) return null;
    const machineEntries = prior.toolCommands?.[toolCallId];
    const entries = machineEntries ? Object.entries(machineEntries) : [];
    if (entries.length === 0) return null;

    if (!prior.fanOut) {
      const [machineId, { commandId }] = entries[0];
      const outcome = await resolveMachineEntry(db, siteId, machineId, commandId);
      if (!outcome) return null;
      return outcome.kind === 'output'
        ? { output: outcome.output }
        : { errorText: outcome.errorText };
    }

    const machines: Array<Record<string, unknown>> = [];
    for (const [machineId, { commandId }] of entries) {
      const outcome = await resolveMachineEntry(db, siteId, machineId, commandId);
      if (!outcome) continue; // absent — skip this machine
      if (outcome.kind === 'output') {
        const out = outcome.output;
        machines.push(
          typeof out === 'object' && out !== null
            ? { machine: machineId, ...(out as Record<string, unknown>) }
            : { machine: machineId, result: out },
        );
      } else {
        machines.push({ machine: machineId, error: outcome.errorText });
      }
    }
    if (machines.length === 0) return null;
    return { output: { machines } };
  };
}

/** First user-text in a message array (title seed + categorize input). */
function firstUserText(messages: UIMessage[]): string {
  const firstUserMsg = messages.find((m) => m.role === 'user');
  const firstTextPart = firstUserMsg?.parts?.find((p) => p.type === 'text');
  return firstTextPart && 'text' in firstTextPart ? (firstTextPart as { text: string }).text : '';
}

/**
 * Merge-write a message array to `chats/{chatId}` — server mirror of the
 * client persist in `useHoot.ts`. `isNewConversation` comes from chat-doc
 * existence at turn start, NOT message count, so a superseded first turn can't
 * permanently skip the title/createdAt stamp. Title is a placeholder until the
 * LLM categorizer replaces it, and an LLM title is never overwritten.
 *
 * The chat's target fields are written ONLY for a turn that carries a
 * `chatTarget` — a user-sent, non-resume turn. Every other turn merges without
 * them, so a follow-up firing on one machine, a talon chat's friendly label and
 * a resumed approval all leave the stored selection exactly as it was.
 */
async function persistChatMessages(
  db: FirebaseFirestore.Firestore,
  params: StartTurnParams,
  messages: UIMessage[],
  isNewConversation: boolean,
): Promise<void> {
  const title = isNewConversation
    ? firstUserText(messages).slice(0, 100) || UNTITLED_CHAT_TITLE
    : undefined;

  // JSON round-trip strips nested `undefined`, which Firestore rejects.
  const serializedMessages = messages.map((m) => ({
    id: m.id,
    role: m.role,
    parts: m.parts.map((p) => JSON.parse(JSON.stringify(p))),
    // Per-turn display context (`metadata.hoot`). The transcript labels each
    // assistant message from it, so dropping it here would leave a reloaded
    // chat naming the live selector's machines on every old turn.
    ...(m.metadata === undefined ? {} : { metadata: JSON.parse(JSON.stringify(m.metadata)) }),
  }));

  await db
    .collection('chats')
    .doc(params.chatId)
    .set(
      {
        userId: params.userId,
        siteId: params.siteId,
        ...(params.chatTarget ? chatTargetFields(params.chatTarget) : {}),
        ...(title ? { title } : {}),
        messages: serializedMessages,
        updatedAt: FieldValue.serverTimestamp(),
        ...(isNewConversation ? { createdAt: FieldValue.serverTimestamp() } : {}),
      },
      { merge: true },
    );
}

/**
 * Start a detached Hoot turn. Returns the HTTP tee branch immediately; the
 * snapshot pump consumes the other branch, so the turn completes even if the
 * returned stream is abandoned. Never throws and never rejects the consumer:
 * internal failures → `finishTurn('error', msg)` + an error chunk.
 */
export function startTurn(
  db: FirebaseFirestore.Firestore,
  params: StartTurnParams,
): ReadableStream<InferUIMessageChunk<UIMessage>> {
  const { chatId, turnId } = params;

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const clearHeartbeat = () => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  // First error wins — set by execute failures and by streamText error chunks.
  let turnError: string | null = null;
  const noteError = (error: unknown): string => {
    const message = errorText(error);
    if (turnError === null) turnError = message;
    return message;
  };

  // The repaired history (not the raw client history) is what gets persisted.
  let repairedHistory: UIMessage[] | null = null;

  // Consumed-approval rewrites (one-shot ledger). The SDK's final message is
  // seeded from the RAW history, so these must be re-applied before the final
  // persist or a consumed part resurfaces as a dangling approval.
  let consumedParts: ApprovalConsumptionResult['consumedParts'] = new Map();

  // Drives new-conversation semantics. Captured before the turn-start persist
  // creates the doc.
  let chatExistedAtStart = false;

  // Fired when the heartbeat's `touch` reports lost ownership (superseded or
  // stopped) — kills streamText and the in-flight tool poll loops.
  const abortController = new AbortController();

  // Set by onFinish. If the stream tears down without it (e.g. a chunk the
  // state machine rejects), the pump's finally closes the turn as errored so
  // the stream doc can't leak a fresh-looking 'running' state.
  let turnFinished = false;

  const stream = createUIMessageStream<UIMessage>({
    // Approval-resume: chunks for the PRIOR turn's toolCallId can only attach
    // to a message the state machine already knows, so it must be seeded with
    // the original history — otherwise "No tool invocation found for tool call
    // ID" kills the turn (asyncTurns.integration.test.ts scenario 3).
    originalMessages: params.messages,
    execute: async ({ writer }) => {
      // Transient part keeps the HTTP proxy awake; the touch keeps the stream
      // doc fresh (TURN_STALE_MS 45s) and returns the ownership signal.
      heartbeatTimer = setInterval(() => {
        try {
          writer.write({ type: 'data-heartbeat', transient: true, data: Date.now() });
        } catch {
          // Stream already torn down — nothing to heartbeat.
        }
        void touch(db, chatId, turnId).then((ownership) => {
          // Abort only on genuine loss. A Firestore `error` is indeterminate —
          // aborting on a single blip would drop a healthy in-flight response;
          // the next heartbeat re-checks.
          if (ownership === 'lost') {
            abortController.abort();
            clearHeartbeat();
          }
        });
      }, timing.heartbeatMs);

      // Must precede the turn-start persist, which creates the doc.
      try {
        chatExistedAtStart = (await db.collection('chats').doc(chatId).get()).exists;
      } catch {
        // Fail to "not new" so a read blip can't clobber an existing
        // conversation's LLM title with a placeholder.
        chatExistedAtStart = true;
      }

      // the dashboard route refuses with a 402 before it gets here; this is the
      // gate for follow-up and talon turns, which have no response to refuse
      // with. ahead of the one-shot approval claim, so a refused turn claims nothing.
      if (await requireEntitlement(params.siteId, 'owlette.hoot')) {
        console.warn(
          `[hoot] turn refused in chat ${sanitizeForLog(chatId)}: the site's plan does not include owlette.hoot`,
        );
        throw new Error(PLAN_REQUIRED_DETAIL['owlette.hoot']);
      }

      const resolveLostResult = buildResolveLostResult(db, params.siteId, params.priorTurn);
      const { messages: danglingRepaired, repairedToolCallIds } =
        await repairDanglingToolParts(params.messages, { resolveLostResult });
      if (repairedToolCallIds.length > 0) {
        console.warn(
          `[hoot] repaired ${repairedToolCallIds.length} dangling tool part(s) in chat ${sanitizeForLog(chatId)}: ${sanitizeForLog(repairedToolCallIds.join(', '))}`,
        );
      }

      // One-shot approval enforcement: claim every answered approval on the
      // in-flight segment BEFORE any dispatch. A duplicate resume (reload,
      // second tab) loses the claim and gets a terminal part instead of a
      // second execution of an already-approved tier-3 tool.
      const consumption = await applyApprovalConsumption(danglingRepaired, {
        claim: (toolCallId) => claimApproval(db, chatId, toolCallId, { turnId }),
        resolveLostResult,
      });
      consumedParts = consumption.consumedParts;
      if (consumedParts.size > 0) {
        console.warn(
          `[hoot] blocked re-execution of ${consumedParts.size} already-consumed approval(s) in chat ${sanitizeForLog(chatId)}: ${sanitizeForLog([...consumedParts.keys()].join(', '))}`,
        );
      }
      const repairedMessages = consumption.messages;
      repairedHistory = repairedMessages;

      // Persist the repaired history now so the user's just-sent message is
      // durable before any reattach. Only on confirmed `owned` — `lost` and
      // `error` both risk clobbering another turn's state.
      try {
        if ((await touch(db, chatId, turnId)) === 'owned') {
          await persistChatMessages(db, params, repairedMessages, !chatExistedAtStart);
        }
      } catch (error) {
        // Recoverable via stream doc + repair; must not reject into the stream.
        console.error(`[hoot] turn-start persist failed for chat ${sanitizeForLog(chatId)}:`, error);
      }

      // Re-check the caller's resolved set against the site as it is NOW. This
      // only ever removes machines (see `narrowToLiveMachines`), so an approved
      // tool call cannot reach a machine the approver never saw.
      const resolved = narrowToLiveMachines(
        params.resolved,
        await listSiteMachines(db, params.siteId),
      );
      if (resolved.ids.length === 0) throw noLiveMachinesError(params.turnTarget, resolved);
      // The record has to name what this turn actually dispatches to before it
      // dispatches: the NEXT approval in this chat binds to that list. A resume
      // always rewrites it — the claim copied the list of the turn that ASKED,
      // which is wider than what this one reaches whenever a bound machine has
      // dropped off (and, for a legacy prior, is not a list at all). Every other
      // turn was claimed with the caller's list, so it only rewrites when the
      // narrowing above actually removed something. A write that did not land
      // means the turn was superseded (or Firestore failed), and either way it
      // must not go on to queue commands.
      const inheritedResolvedSet = params.turnTarget.source === 'resume';
      if (inheritedResolvedSet || resolved.ids.length !== params.resolved.ids.length) {
        if (!(await recordResolvedMachines(db, chatId, turnId, resolved.ids))) {
          throw new Error('this turn no longer owns the chat');
        }
      }

      const fanOut = resolved.fanOut;
      // A fan-out dispatches from the id LIST, so the positional id is only the
      // single path's target; in a fan-out it is just the legacy "not one
      // machine" view, and the `chatMachineId` default it feeds is always
      // overridden by `followupTarget` below.
      const dispatchMachineId = fanOut ? SITE_TARGET_ID : resolved.ids[0];

      const [llmConfig, requireTier3Approval, processes] = await Promise.all([
        resolveLlmConfig(db, params.userId),
        // A forced gate needs no site read: the setting could only turn it off,
        // and this flag exists to say it must not.
        params.forceTier3Approval === true
          ? Promise.resolve(true)
          : getHootRequireTier3Approval(db, params.siteId),
        // Process context is a single machine's configuration — a fan-out has no
        // one machine to describe.
        fanOut
          ? Promise.resolve<ProcessSummary[]>([])
          : fetchProcessSummaries(db, params.siteId, resolved.ids[0]),
      ]);

      const earnedTier = resolveHootMaxTier(params.access);
      // A caller cap can only lower what access earns. Resolved once: the tools
      // are cut to it, and `schedule_followup` records it so a follow-up this
      // turn promises fires under the same ceiling.
      const effectiveTier: ToolTier =
        params.maxToolTier === undefined
          ? earnedTier
          : (Math.min(params.maxToolTier, earnedTier) as ToolTier);
      const toolDefs = getToolsByTier(effectiveTier);
      const tools = buildExecutableTools(
        db,
        params.siteId,
        dispatchMachineId,
        chatId,
        toolDefs,
        fanOut,
        resolved.ids,
        {
          userId: params.userId,
          userRole: params.access.role,
          userSiteRole: params.access.siteRole,
          maxToolTier: effectiveTier,
          requireTier3Approval,
          // A follow-up fires where it was promised (D-D): this turn's target
          // AFTER any mention narrowing, with `null` left as the dynamic "all".
          followupTarget: { machineIds: params.turnTarget.machineIds },
          toolCallbacks: {
            onCommandQueued: (toolCallId: string, commandId: string, machineId: string) =>
              recordToolCommand(db, chatId, turnId, toolCallId, commandId, machineId),
            abortSignal: abortController.signal,
          },
        },
      );

      // The Opus 5 advisor joins the agent tools when this model may consult it, capped
      // per reply; a reply resumed after a tier-3 approval keeps counting what it already
      // consulted. History that holds advisor results must not reach a request without
      // the tool — the API rejects it — so it is stripped when this turn can't offer one;
      // failed consultations are always left out (see modelHistoryFor).
      const { tools: turnTools, prepareStep } = withAdvisor(
        llmConfig,
        tools,
        advisorCallsIn(repairedMessages[repairedMessages.length - 1]),
      );
      const modelHistory = modelHistoryFor(repairedMessages, ADVISOR_TOOL_NAME in turnTools);

      // Which machines this turn reached, stated in the top-level system string:
      // Sonnet 5 rejects a system message mid-conversation, and the set changes
      // from turn to turn. Validated ids only — no client-supplied names.
      const promptMode: HootPromptMode = !fanOut
        ? 'single'
        : params.turnTarget.machineIds === null
          ? 'site'
          : 'subset';

      const result = streamText({
        model: createModel(llmConfig),
        system: buildHootSystemPrompt({
          mode: promptMode,
          machineIds: resolved.ids,
          skipped: resolved.skipped,
          processes,
          narrowedByMention: params.turnTarget.source === 'mention',
        }),
        // Pass `tools` so per-tool toModelOutput hooks (e.g. capture_screenshot
        // → image-url) also project PRIOR-turn outputs into model content.
        messages: await convertToModelMessages(modelHistory, { tools: turnTools }),
        tools: turnTools,
        prepareStep,
        stopWhen: stepCountIs(10),
        abortSignal: abortController.signal,
        onFinish: ({ finishReason }) => {
          // A safety-classifier refusal ends the turn with no answer. The chat shows a
          // notice for the empty reply; the log records why.
          if (finishReason === 'content-filter') {
            console.warn(`[hoot] the model declined the turn in chat ${sanitizeForLog(chatId)} (content-filter)`);
          }
        },
      });

      // Per-turn display context, stamped onto the assistant message as it
      // streams and kept by the persist. The transcript labels approval cards
      // and captions from it; it is never a dispatch input, because the client
      // re-sends assistant messages verbatim and could forge it.
      const hootMetadata: HootTurnMetadata = {
        turnId,
        machineIds: resolved.ids,
        via: params.turnTarget.source,
        skipped: resolved.skipped,
        // What the turn ASKED for, not what it resolved to: `null` is the
        // dynamic "all machines", and only the request can tell that apart from
        // a list that happens to cover the site today. The approval prompt says
        // "every online machine" on the strength of this.
        dynamic: params.turnTarget.machineIds === null,
      };

      // Model/tool-loop errors arrive as error CHUNKS, not rejections.
      writer.merge(
        result.toUIMessageStream({
          onError: noteError,
          messageMetadata: () => ({ hoot: hootMetadata }),
        }),
      );
    },
    onError: noteError,
    onFinish: async ({ responseMessage }) => {
      turnFinished = true;
      clearHeartbeat();
      const isNewConversation = !chatExistedAtStart;
      // Replace-or-append: on approval-resume the SDK continues the trailing
      // assistant message (same id), so appending would duplicate it.
      const baseHistory = repairedHistory ?? params.messages;
      const hasResponseParts =
        Array.isArray(responseMessage?.parts) && responseMessage.parts.length > 0;
      // The SDK seeds its state from the RAW history (`originalMessages`), so a
      // consumed approval can resurface on the response message as a dangling
      // `approval-responded` part — re-apply the terminal rewrites.
      const mergedMessages = reapplyConsumedParts(
        !hasResponseParts
          ? baseHistory
          : baseHistory.length > 0 && baseHistory[baseHistory.length - 1].id === responseMessage.id
            ? [...baseHistory.slice(0, -1), responseMessage]
            : [...baseHistory, responseMessage],
        consumedParts,
      );

      // What this turn ended waiting on, written with the terminal status.
      // Stored rather than derived on read: snapshots are throttled, so the
      // final approval-requested part may never have been persisted — and the
      // next turn's resume binds to exactly these ids.
      const finalMessage = mergedMessages[mergedMessages.length - 1];
      const pendingApprovals =
        finalMessage?.role === 'assistant' ? approvalRequestedIds(finalMessage) : [];

      try {
        if (turnError !== null) {
          // Still persist the partial history so a provider error can't erase
          // a brand-new conversation.
          const stillOwned = await finishTurn(
            db,
            chatId,
            turnId,
            'error',
            turnError,
            pendingApprovals,
          );
          if (stillOwned) {
            await persistChatMessages(db, params, mergedMessages, isNewConversation);
          }
          return;
        }

        // finishTurn first — its turnId-guarded write is the supersede check.
        // `false` means a newer turn owns persistence; writing our final array
        // would clobber it.
        const stillOwned = await finishTurn(
          db,
          chatId,
          turnId,
          'complete',
          undefined,
          pendingApprovals,
        );
        if (!stillOwned) return;

        await persistChatMessages(db, params, mergedMessages, isNewConversation);

        const userMessage = firstUserText(mergedMessages);
        if (isNewConversation && userMessage) {
          resolveLlmConfig(db, params.userId)
            .then((cfg) => categorizeNewChat(db, createCheapModel(cfg), chatId, userMessage))
            .catch(() => {
              /* best-effort */
            });
        }
      } catch (error) {
        // Must not reject into the stream machinery; content survives in the
        // stream doc and repair recovers it on the next send.
        console.error(`[hoot] final persist failed for chat ${sanitizeForLog(chatId)}:`, error);
      }
    },
  });

  // One branch to the HTTP response, one to the Firestore snapshot pump. The
  // pump consumes to completion, which keeps the source stream (and onFinish)
  // running after the HTTP branch dies.
  const [httpBranch, snapshotBranch] = stream.tee();

  // Seed the pump for the same approval-resume reason as `originalMessages`.
  const lastMessage = params.messages[params.messages.length - 1];
  const resumeMessage = lastMessage?.role === 'assistant' ? lastMessage : undefined;

  (async () => {
    for await (const message of readUIMessageStream<UIMessage>({
      stream: snapshotBranch,
      message: resumeMessage,
    })) {
      // writeSnapshot self-throttles (≥750ms apart) and never throws.
      await writeSnapshot(db, chatId, turnId, message);
    }
  })()
    .catch(async (error) => {
      console.error(`[hoot] snapshot pump failed for chat ${sanitizeForLog(chatId)}:`, error);
      if (turnError === null) turnError = errorText(error);
    })
    .finally(async () => {
      // Torn down without onFinish (state-machine rejection, pump failure):
      // close as errored, else the doc leaks 'running' and a still-armed
      // heartbeat keeps it looking fresh, defeating stale detection.
      if (turnFinished) return;
      clearHeartbeat();
      await finishTurn(
        db,
        chatId,
        turnId,
        'error',
        turnError ?? 'turn ended without finishing',
      ).catch(() => {
        /* finishTurn never throws by contract; belt and braces. */
      });
    });

  return httpBranch;
}
