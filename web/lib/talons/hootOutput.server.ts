/**
 * The hoot output — a talon-triggered headless assistant turn. A
 * `{ type: 'cortex', directive }` output hands its directive to the assistant
 * with real tools and nobody in the loop, which drives everything below.
 * ("hoot" is user-facing copy only; wire + stored fields stay `cortex`.)
 *
 * Fire-time access re-resolution: the creator's site access is re-resolved on
 * EVERY run (`resolveTalonAuthor`), never trusted from authoring time, so a
 * departed/demoted/soft-deleted author can't keep executing at yesterday's
 * privilege. Terminal by construction, so it carries a
 * {@link TalonDisabledReason} that switches the talon off immediately.
 *
 * Target pre-flight: the run then checks the same things `/api/hoot` checks
 * before it commits a turn — a machine-scoped run that its machine is online
 * and the per-machine hoot kill switch is not engaged
 * ({@link checkMachineGuards}); a site-wide run that at least one machine in the
 * site is online with that same kill switch on ({@link checkSiteGuards}). Every
 * refusal is `skipped`.
 *
 * One fresh chat per run (`chats/talon_{ms}_{runId}`): the turn store holds one
 * lock per chat, so two runs sharing a chat would race for it. The chat is also
 * the artifact the run record points at.
 *
 * Tier ceiling: set explicitly via `maxToolTier`, never by degrading `access` —
 * `startTurn` intersects the two, so a demoted author still drops to tier 1.
 * Default is {@link READ_ONLY_TIER}; `allowActions: true` raises it to
 * {@link UNATTENDED_MAX_TIER} (authoring that flag costs MACHINE_EXEC_COMMAND,
 * same as a `command` output). Tier 3 is capped out in
 * {@link unattendedToolTier} rather than trusted to call sites: tier-3 tools
 * can require in-chat approval, and an unattended turn has nobody to grant it,
 * so the call would hang until declared stale.
 *
 * LLM key: `startTurn` always resolves the CREATOR's own key and takes no
 * override, so it is pre-flighted here (`assertTalonAuthorLlmKey`) before any
 * chat doc or turn lock exists — otherwise a creator who removed their key
 * leaves an empty chat and a claimed lock behind on every firing, and the
 * failure surfaces deep inside a detached runner. The pre-flight never
 * receives the key itself.
 *
 * Dispatch, not completion: the runner outlives the request, so awaiting it
 * would hold the talon run open for a full LLM tool loop.
 *
 * Server-side only — never import this in client components.
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { UIMessage } from 'ai';
import type { ToolTier } from '@/lib/mcp-tools';
import { isHootEnabled, isMachineOnline, listSiteMachines } from '@/lib/hoot-utils.server';
import { startTurn } from '@/lib/hoot/turnRunner.server';
import { acquireTurnLock, generateTurnId } from '@/lib/hoot/turnStore.server';
import {
  chatTargetFields,
  SITE_TARGET_ID,
  type HootTarget,
  type ResolvedTargets,
  type TurnTargetRecord,
} from '@/lib/hoot/target';
import logger from '@/lib/logger';
import {
  TalonAuthorError,
  assertTalonAuthorLlmKey,
  resolveTalonAuthor,
  type TalonAuthor,
} from './author.server';
import type { StoredTalon } from './store.server';
import type { TalonDisabledReason, TalonRunCondition } from './types';

/** Everything a hoot turn needs about the run that is firing it. */
export interface RunHootOutputArgs {
  siteId: string;
  /** The full talon — `createdBy` is what the fire-time access check resolves. */
  talon: StoredTalon;
  runId: string;
  correlationId: string;
  /** The operator's instruction, verbatim. */
  directive: string;
  /** `true` raises the ceiling from read-only to tier 2. Defaults false. */
  allowActions?: boolean;
  /** Human-readable, lowercase trigger description, e.g. `cpu_percent > 90`. */
  triggerSummary: string;
  /** Set on a machine-scoped run; absent runs go site-wide. */
  machineId?: string;
  machineName?: string;
  /** The condition outcome, when the talon had one. */
  condition?: TalonRunCondition;
}

/**
 * `detail` uses the same machine-readable vocabulary as the other output
 * executors; `disabledReason` marks failures retrying can never fix.
 *
 * `skipped` mirrors the command executor's benign refusals: the run was
 * deliberately not attempted, and must not spend one of the ten lives
 * `AUTO_DISABLE_AFTER_FAILURES` counts.
 */
export type RunHootOutputResult =
  | {
      status: 'sent';
      chatId: string;
      /**
       * Online machines a site-wide run did NOT reach because the kill switch is
       * engaged on them (D-A). Omitted when it took nothing out, so an
       * all-machines run records exactly what it always did.
       */
      skippedMachineIds?: string[];
    }
  | { status: 'skipped'; detail: string }
  | {
      status: 'failed';
      detail: string;
      error?: string;
      /** Present iff this failure must switch the talon off immediately. */
      disabledReason?: TalonDisabledReason;
    };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Look, don't touch — every read-only tool, and nothing else. */
export const READ_ONLY_TIER: ToolTier = 1;

/** Ceiling for ANY unattended turn — tier 3 is approval-gated, nobody's here. */
export const UNATTENDED_MAX_TIER: ToolTier = 2;

/** A ceiling, not a grant — `startTurn` intersects it with the earned tier. */
export function unattendedToolTier(allowActions: boolean): ToolTier {
  const requested = allowActions ? UNATTENDED_MAX_TIER : READ_ONLY_TIER;
  return Math.min(UNATTENDED_MAX_TIER, requested) as ToolTier;
}

/**
 * Pre-flight the target machine, in the order `/api/hoot` checks it: online
 * first, then the per-machine hoot kill switch (`machines/{id}.cortexEnabled`,
 * absent = on). Every tool this turn can call is relayed to that agent, so
 * without these the turn burns a full tool-timeout per call and then reports
 * nothing it could actually see.
 *
 * Both refusals are `skipped`, never `failed`: nothing is wrong with the talon,
 * exactly as with the command executor's `machine_offline`. Recording them as
 * failures would auto-disable a healthy talon after ten runs because a machine
 * was away for the night or an operator paused hoot on it.
 *
 * @returns the refusal to record, or `null` when the machine is dispatchable.
 */
async function checkMachineGuards(
  db: Firestore,
  siteId: string,
  machineId: string,
): Promise<RunHootOutputResult | null> {
  try {
    if (!(await isMachineOnline(db, siteId, machineId))) {
      return { status: 'skipped', detail: 'machine_offline' };
    }
    if (!(await isHootEnabled(db, siteId, machineId))) {
      return { status: 'skipped', detail: 'hoot_disabled' };
    }
  } catch (error) {
    // A read that failed says nothing about the machine — keep the never-throws
    // contract and leave it on the transient failure counter.
    return { status: 'failed', detail: 'machine_check_failed', error: errorText(error) };
  }
  return null;
}

/** What a site-wide run will dispatch to, and what the pre-flight took out. */
interface SiteDispatchSet {
  /** Online with hoot enabled — the set the turn fans out over. */
  machineIds: string[];
  /** Online machines the kill switch removed, carried so the turn can say so. */
  hootDisabled: string[];
}

/**
 * Pre-flight a site-wide run the way `/api/hoot` pre-flights site mode: at least
 * one machine online, and the per-machine kill switch applied to it. Without it
 * the turn runner throws `No machines are currently online in this site.` INSIDE
 * an already-locked turn, so a talon firing against a sleeping site leaves an
 * empty chat and a claimed lock behind on every run while still reporting the
 * turn dispatched.
 *
 * The kill switch is read from the SAME listing (D-A), not a second pass of
 * per-machine reads: hoot-off machines drop out of the dispatch set, and a site
 * whose every online machine has hoot off refuses here rather than reaching a
 * turn with nothing to talk to.
 *
 * Both refusals are `skipped`, matching {@link checkMachineGuards}: an away site
 * — or one an operator has deliberately paused hoot across — is not a talon
 * fault and must not spend one of the `AUTO_DISABLE_AFTER_FAILURES` lives.
 *
 * @returns the refusal to record, or the machines the turn will fan out to.
 */
async function checkSiteGuards(
  db: Firestore,
  siteId: string,
): Promise<{ refusal: RunHootOutputResult } | { dispatch: SiteDispatchSet }> {
  try {
    // the whole site: a talon spans the site, and the turn runner narrows the
    // turn to its author's machine scope
    const machines = await listSiteMachines(db, siteId, null);
    const online = machines.filter((machine) => machine.online);
    // Offline is classified first, so a site that is simply asleep never reads
    // back as "somebody switched hoot off".
    if (online.length === 0) {
      return { refusal: { status: 'skipped', detail: 'no_machines_online' } };
    }

    const machineIds: string[] = [];
    const hootDisabled: string[] = [];
    for (const machine of online) {
      if (machine.hootEnabled) machineIds.push(machine.id);
      else hootDisabled.push(machine.id);
    }
    if (machineIds.length === 0) {
      return { refusal: { status: 'skipped', detail: 'no_hoot_enabled_machines' } };
    }
    return { dispatch: { machineIds, hootDisabled } };
  } catch (error) {
    // Same classification as the machine guards: a failed read is transient and
    // decides nothing about the site.
    return {
      refusal: { status: 'failed', detail: 'machine_check_failed', error: errorText(error) },
    };
  }
}

/**
 * The synthetic opening user message: directive plus the facts the assistant
 * would otherwise go looking for. The screenshot is a ~1h signed url (fine for
 * a turn starting in seconds); the run doc keeps the durable storage path.
 */
function buildDirectiveMessage(args: RunHootOutputArgs): UIMessage {
  const lines = [
    args.directive.trim(),
    '',
    'context: a talon fired this. no person is in this conversation, so do not',
    'ask questions — investigate with the tools you have and state what you found.',
    `- talon: ${args.talon.name}`,
    `- trigger: ${args.triggerSummary}`,
  ];

  if (args.machineId) {
    lines.push(`- machine: ${args.machineName || args.machineId} (${args.machineId})`);
  } else {
    lines.push('- scope: every machine in this site');
  }

  const condition = args.condition;
  if (condition && condition.verdict === 'fail') {
    lines.push(
      `- visual check: failed${condition.reason ? ` — ${condition.reason}` : ''}`,
    );
    if (condition.screenshotUrl) {
      lines.push(`- screenshot: ${condition.screenshotUrl}`);
    }
  }

  return {
    id: `talon_msg_${args.runId}`,
    role: 'user',
    parts: [{ type: 'text', text: lines.join('\n') }],
  };
}

/**
 * Fire one hoot turn for a talon run. Never throws — one bad output must not
 * abort the rest of the run. Returns `sent` on dispatch, not on completion.
 */
export async function runHootOutput(
  db: Firestore,
  args: RunHootOutputArgs,
): Promise<RunHootOutputResult> {
  const { siteId, talon, runId } = args;

  // Both pre-flights must precede ANY write, else a creator who can no longer
  // back this talon leaves a chat + turn lock behind on every firing.
  //
  // Whose key: the CREATOR's, and there is no alternative to prefer. BYOK is
  // single-scope since 2026-08-15 — keys live only at `users/{uid}/settings/llm`
  // and `sites/{siteId}/settings/llm` is gone (`resolveLlmConfig` takes a uid
  // and no site fallback), so "prefer the site key" has nothing to resolve. It
  // is also the right payer: the same identity's access is what bounds this
  // turn's tier below, so who pays and who authorized stay one person.
  let author: TalonAuthor;
  try {
    author = await resolveTalonAuthor(db, siteId, talon);
    await assertTalonAuthorLlmKey(db, author.userId);
  } catch (error) {
    if (error instanceof TalonAuthorError) {
      return {
        status: 'failed',
        detail: error.reason,
        error: error.message,
        disabledReason: error.reason,
      };
    }
    // Transient (failed read, missing site) — stays on the failure counter.
    return { status: 'failed', detail: 'author_check_failed', error: errorText(error) };
  }

  // After the author checks, before any write: a dead author is terminal and
  // must still disable the talon even when the machine happens to be down, and
  // a refusal here must leave no chat or claimed lock behind either.
  const machineRefusal = args.machineId
    ? await checkMachineGuards(db, siteId, args.machineId)
    : null;
  if (machineRefusal) return machineRefusal;

  const isSiteMode = !args.machineId;
  let siteDispatch: SiteDispatchSet = { machineIds: [], hootDisabled: [] };
  if (isSiteMode) {
    const siteGuards = await checkSiteGuards(db, siteId);
    if ('refusal' in siteGuards) return siteGuards.refusal;
    siteDispatch = siteGuards.dispatch;
  }

  const access = author.access;
  const machineId = args.machineId ?? SITE_TARGET_ID;
  const chatId = `talon_${Date.now()}_${runId}`;

  /** `null` = the whole site, dynamically; a machine run names its one machine. */
  const target: HootTarget = { machineIds: isSiteMode ? null : [machineId] };

  // A site-scoped talon run fans out over what the pre-flight left — online with
  // hoot enabled (D-A); a machine-scoped one is the single path. The runner
  // re-checks the set at turn start, so a machine that drops off in between
  // still leaves it.
  const turnTarget: TurnTargetRecord = {
    machineIds: target.machineIds,
    fanOut: isSiteMode,
    source: 'talon',
  };
  const resolved: ResolvedTargets = {
    ids: isSiteMode ? siteDispatch.machineIds : [machineId],
    fanOut: isSiteMode,
    // The machines the kill switch took out travel with the turn, so the model
    // is told what it is NOT talking to instead of answering for a smaller fleet
    // than the operator thinks it asked about.
    skipped: { offline: [], disabled: siteDispatch.hootDisabled },
  };

  // Create the chat BEFORE the turn: the runner then sees an existing doc and
  // treats this as a continuation, so its placeholder title can't overwrite
  // `talon: …` and the LLM categorizer skips a machine-authored conversation.
  try {
    await db
      .collection('chats')
      .doc(chatId)
      .set({
        source: 'talon',
        siteId,
        userId: author.userId,
        // The machine's display name, not its id: a talon machine chat is
        // labelled `LOBBY-01` everywhere the stored `machineName` is read,
        // including both sides of a share.
        ...chatTargetFields(target, args.machineName ? { label: args.machineName } : undefined),
        title: `talon: ${talon.name}`,
        talonId: talon.id,
        runId,
        correlationId: args.correlationId,
        messages: [],
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
  } catch (error) {
    return { status: 'failed', detail: 'chat_create_failed', error: errorText(error) };
  }

  // Cannot collide on a brand-new chat, but the lock doc IS what the client
  // watches to render a running turn.
  const turnId = generateTurnId();
  let prior;
  try {
    prior = await acquireTurnLock(db, chatId, {
      turnId,
      siteId,
      machineId,
      target: turnTarget,
      resolvedMachineIds: resolved.ids,
    });
  } catch (error) {
    return { status: 'failed', detail: 'turn_lock_failed', error: errorText(error) };
  }

  try {
    const stream = startTurn(db, {
      chatId,
      turnId,
      siteId,
      messages: [buildDirectiveMessage(args)],
      userId: author.userId,
      access,
      resolved,
      turnTarget,
      // No `chatTarget`: this chat's target fields are written above, with the
      // machine's display name, and the runner must not overwrite that label.
      //
      // Two ceilings and nothing else, on purpose (decided 2026-08-15): the
      // default is read-only, and the per-talon `let hoot act` opt-in raises it
      // to tier 2. There is deliberately NO finer per-call cap to thread down
      // into `getToolsByTier` — an unattended turn either looks, or looks and
      // acts, and tier 3 stays unreachable either way (see UNATTENDED_MAX_TIER).
      maxToolTier: unattendedToolTier(args.allowActions === true),
      priorTurn: prior,
      source: 'talon',
    });

    // CRITICAL: the returned HTTP tee branch has no reader here and would
    // buffer every chunk unbounded. Cancelling drops only that branch; the
    // snapshot pump owns the other and runs the turn to completion.
    void stream.cancel().catch(() => {});
  } catch (error) {
    // `startTurn` never throws by contract; this catches a synchronous stream
    // setup failure, which would otherwise escape as `output_threw`.
    return { status: 'failed', detail: 'turn_start_failed', error: errorText(error) };
  }

  logger.info(`Talon ${talon.id} started hoot turn in chat ${chatId}`, {
    context: 'talons/hoot',
    data: {
      siteId,
      runId,
      machineId,
      turnId,
      // Only when the kill switch actually took something out. The run record
      // carries the same list for the operator; this is the server-side trail.
      ...(siteDispatch.hootDisabled.length > 0
        ? { hootDisabledMachines: siteDispatch.hootDisabled }
        : {}),
    },
  });

  // A site-wide run that reached 2 of 5 machines has to be readable as such on
  // the run afterwards — `sent` with a chat id alone doesn't say it.
  return {
    status: 'sent',
    chatId,
    ...(siteDispatch.hootDisabled.length > 0
      ? { skippedMachineIds: siteDispatch.hootDisabled }
      : {}),
  };
}
