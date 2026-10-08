/**
 * Core chat API endpoint — async turn architecture (hoot-async-turns).
 *
 * POST authenticates, verifies site access, RESOLVES which machines this turn
 * talks to, acquires the per-chat turn lock (`chats/{chatId}/stream/current`)
 * and starts a detached turn runner. The runner owns the LLM loop + tool relay
 * and persists to Firestore, so the turn survives a dead HTTP stream; the stream
 * returned here is a best-effort live branch (clients reattach).
 *
 * Targets are decided HERE, once, and handed over resolved — the runner may only
 * narrow them. Two shapes of turn arrive:
 *
 * - a normal send, whose target is the chat's selection (`target.machineIds`,
 *   or the legacy `machineId`), optionally narrowed for this one turn by an
 *   `@machine` mention the server re-parses out of the message itself;
 * - an approval resume, which is BOUND to the turn that asked for the approval.
 *   Its target comes from that turn's record, never from the request, and a
 *   record that no longer matches is 409 `approval_stale` — refused before the
 *   one-shot approval claim, so the approval survives to be answered again.
 *
 * Audits `chat_mutated` / `send`, the same verb the conversations-API send emits,
 * once the turn lock is held — that write is the committed state change, and
 * `emitMutation` is fire-and-forget, so the audit adds no failure path.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createUIMessageStreamResponse, type UIMessage } from 'ai';
import { ApiAuthError, resolveAuth, requireScope } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';
import { emitMutation } from '@/lib/auditLogClient';
import {
  SiteAccessError,
  resolveHootTargets,
  verifyUserSiteAccess,
  type ResolveTargetsFailure,
} from '@/lib/hoot-utils.server';
import { parseMentions } from '@/lib/hoot/mentions';
import {
  SITE_TARGET_ID,
  approvalResponseIds,
  isValidMachineId,
  neverWidenLegacyMachineId,
  type HootTarget,
  type PriorTurn,
  type ResolvedTargets,
  type TurnTargetRecord,
} from '@/lib/hoot/target';
import { startTurn } from '@/lib/hoot/turnRunner.server';
import {
  ApprovalStaleError,
  acquireTurnLock,
  generateTurnId,
  readTurnRecord,
  TurnActiveError,
  type TurnResumeBinding,
} from '@/lib/hoot/turnStore.server';
import { requireEntitlement } from '@/lib/plan.server';

/** The request body, as far as this route reads it. `machineName` is ignored. */
interface HootRequestBody {
  messages: UIMessage[]; // AI SDK UIMessages (text + file + tool/approval parts)
  siteId: string;
  chatId: string;
  /** The chat's selection, plus any `@machine` ids the composer resolved. */
  target?: { machineIds?: string[] | null; mentions?: string[] };
  /** Legacy single target: `__site__` or one machine id. Accepted indefinitely. */
  machineId?: string;
  /** Claim the turn lock even while another turn is running (new user message mid-turn). */
  supersede?: boolean;
}

/**
 * Server-authored turn openers. Nobody typed an `@` into one, so their text can
 * never narrow a turn — a follow-up note quoting `@kiosk-01` is the assistant's
 * own words coming back, not a targeting instruction.
 */
const MACHINE_AUTHORED_MESSAGE_ID = /^(?:followup_msg_|talon_msg_)/;

/**
 * What the request ASKS to target: the new `target.machineIds`, else the legacy
 * `machineId`. `null` means every machine in the site, dynamically. A `target`
 * that is present but unreadable is refused rather than falling back to the
 * legacy field — falling back could widen a subset to the whole site.
 */
function readRequestedTarget(body: HootRequestBody): HootTarget | null {
  const target = body.target;
  if (target !== undefined && target !== null) {
    if (typeof target !== 'object') return null;
    const ids = target.machineIds;
    if (ids === null) return { machineIds: null };
    // Entry-level validation belongs to `resolveHootTargets`, the one place that
    // decides what a turn may reach.
    return Array.isArray(ids) ? { machineIds: ids } : null;
  }

  const legacy = body.machineId;
  if (typeof legacy !== 'string' || legacy.length === 0) return null;
  return legacy === SITE_TARGET_ID ? { machineIds: null } : { machineIds: [legacy] };
}

/** Text of one message, for the mention re-parse. */
function messageText(message: UIMessage): string {
  return message.parts
    .filter(
      (part): part is { type: 'text'; text: string } =>
        part.type === 'text' && typeof (part as { text?: unknown }).text === 'string',
    )
    .map((part) => part.text)
    .join('\n');
}

/**
 * The `@machine` ids that narrow THIS turn, or none.
 *
 * Three conditions, all required (D-I). The body must carry `target.mentions`,
 * which only the new composer sends — an old tab or an API key gets no
 * narrowing. The caller must be a person, not a chat-scoped key. And the server
 * re-parses the final user message itself and keeps only the ids that really
 * appear in it as mentions, so the body cannot retarget a turn whose text says
 * something else.
 */
function turnMentions(body: HootRequestBody, isApiKeyCaller: boolean): string[] {
  const claimed = body.target?.mentions;
  if (!Array.isArray(claimed) || claimed.length === 0 || isApiKeyCaller) return [];

  const last = body.messages[body.messages.length - 1];
  if (!last || last.role !== 'user' || MACHINE_AUTHORED_MESSAGE_ID.test(last.id)) return [];

  return parseMentions(messageText(last), claimed.filter(isValidMachineId));
}

/** Deduped copy of an already-validated id list, for the stored selection. */
function dedupe(ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) if (!out.includes(id)) out.push(id);
  return out;
}

/** Refusal copy for a target nothing can run on. The single-machine wording is pinned by e2e. */
function targetRefusal(failure: ResolveTargetsFailure): NextResponse {
  const named = failure.machineIds.join(', ');

  if (failure.reason === 'hoot_disabled') {
    const subject =
      failure.machineIds.length === 1 ? `"${failure.machineIds[0]}"` : `these machines: ${named}`;
    return NextResponse.json(
      {
        error: `Hoot is disabled on ${subject}. Re-enable it from the Hoot header to deliver tool calls.`,
        code: failure.reason,
      },
      { status: failure.status },
    );
  }

  if (failure.reason === 'machine_offline') {
    return NextResponse.json(
      {
        error:
          failure.machineIds.length === 1
            ? `Machine "${failure.machineIds[0]}" appears to be offline.`
            : `These machines appear to be offline: ${named}.`,
        code: failure.reason,
      },
      { status: failure.status },
    );
  }

  if (failure.reason === 'no_machines') {
    return NextResponse.json(
      { error: 'No machines are currently online in this site.', code: failure.reason },
      { status: failure.status },
    );
  }

  return NextResponse.json(
    {
      error:
        failure.reason === 'unknown_machine'
          ? `This site has no machine named ${named}.`
          : 'target.machineIds must be a list of machine ids in this site.',
      code: failure.reason,
    },
    { status: failure.status },
  );
}

/**
 * A resume whose approval no longer binds to the record it was requested on.
 * Distinct `code` on purpose: the client's 409 handler auto-retries with
 * `supersede`, and a stale approval must never be retried into one.
 */
function approvalStale(): NextResponse {
  return NextResponse.json(
    {
      error: 'that approval expired — another turn ran in this chat.',
      code: 'approval_stale',
    },
    { status: 409 },
  );
}

/** The status an access refusal deserves; everything else is a 500 through `apiError`. */
function siteAccessStatus(error: SiteAccessError): number {
  return error.code === 'site_not_found' ? 404 : 403;
}

// Streaming responses are incompatible with withRateLimit's header injection.
export async function POST(request: NextRequest) {
  try {
    // Accept session, ID-token, or scoped API key. Session/ID-token callers
    // bypass scope enforcement (dashboard); api-key callers must hold
    // `chat=<siteId>:write` to send a message into a conversation.
    const auth = await resolveAuth(request);
    const userId = auth.userId;
    const body = (await request.json()) as HootRequestBody;
    const { messages, siteId, chatId, supersede } = body;

    if (!messages || !Array.isArray(messages) || messages.length === 0 || !siteId || !chatId) {
      return NextResponse.json(
        { error: 'messages, siteId, and chatId are required' },
        { status: 400 },
      );
    }

    // Scope is enforced for API-key callers only; session / ID-token auth is checked
    // below via verifyUserSiteAccess. Throws 403 scope_insufficient on mismatch.
    requireScope(auth, 'chat', siteId, 'write');

    const db = getAdminDb();

    // Verify access and resolve the tier ceiling. API-key callers are capped to
    // read-only tools so a chat-scoped key cannot inherit the owner's admin role and
    // dispatch destructive machine/process/deploy tools.
    const access = await verifyUserSiteAccess(db, userId, siteId);
    const effectiveAccess = auth.keyContext
      ? { ...access, isSuperadmin: false, isSiteAdmin: false }
      : access;

    // Chat ownership guard: site access alone is not enough — a chat belongs to its
    // creator. An existing doc must match (userId, siteId); a mismatch is a cross-user
    // write, and since the runner persists via the admin SDK (bypassing rules) this is
    // the only gate. A non-existent doc is fine — the first turn legitimately creates it.
    const existingChatSnap = await db.collection('chats').doc(chatId).get();
    if (existingChatSnap.exists) {
      const chatData = existingChatSnap.data();
      if (chatData?.userId !== userId || chatData?.siteId !== siteId) {
        return NextResponse.json({ error: 'you do not own this chat' }, { status: 403 });
      }
    }

    // before the turn lock: `startTurn` refuses too, but only as an error chunk
    // inside a 200 stream.
    const planRefusal = await requireEntitlement(siteId, 'owlette.control');
    if (planRefusal) return planRefusal;

    // Everything below resolves the turn's target. `siteId` is verified by this
    // point, so a machine listing can be trusted to name this site's machines.
    const approvalIds = approvalResponseIds(messages);
    let turnTarget: TurnTargetRecord;
    let resolved: ResolvedTargets;
    /** Only a user-sent, non-resume turn rewrites the chat's stored selection. */
    let chatTarget: HootTarget | undefined;
    let resume: TurnResumeBinding | undefined;

    if (approvalIds.length > 0) {
      // An approval resume runs on the machines resolved when the approval was
      // REQUESTED, intersected with what is reachable now — never on whatever
      // the request happens to name (D-C).
      const resumeMessageId = messages[messages.length - 1]?.id;
      const prior = await readTurnRecord(db, chatId);
      if (
        prior === null ||
        typeof resumeMessageId !== 'string' ||
        prior.messageId !== resumeMessageId ||
        !approvalIds.every((toolCallId) => prior.pendingApprovals.includes(toolCallId))
      ) {
        // Refused before the runner's one-shot ledger claim, so a stale resume
        // leaves the approval unconsumed and answerable on a fresh turn.
        return approvalStale();
      }

      // `null` only for a legacy site-wide record, whose set was never written
      // down; anything the new lock wrote carries its explicit list.
      const outcome = await resolveHootTargets(db, siteId, {
        requested: prior.resolvedMachineIds,
      });
      if (!outcome.ok) return targetRefusal(outcome);

      resolved = outcome.resolved;
      turnTarget = {
        machineIds: prior.resolvedMachineIds,
        fanOut: outcome.resolved.fanOut,
        source: 'resume',
      };
      // `fanOut` rides along because it belongs to THIS turn's set, not the
      // bound one's: an "all machines" approval that comes down to one reachable
      // machine resumes on the single path. The machine list is deliberately not
      // passed — the claim re-reads it from the record, in the transaction.
      resume = {
        messageId: resumeMessageId,
        toolCallIds: approvalIds,
        fanOut: outcome.resolved.fanOut,
      };
    } else {
      const requested = readRequestedTarget(body);
      if (requested === null) {
        return NextResponse.json(
          { error: 'target.machineIds (or the legacy machineId) is required' },
          { status: 400 },
        );
      }

      const mentions = turnMentions(body, auth.keyContext !== null);
      const outcome = await resolveHootTargets(db, siteId, {
        requested: requested.machineIds,
        mentions,
      });
      if (!outcome.ok) return targetRefusal(outcome);

      resolved = outcome.resolved;
      turnTarget = {
        // A mention narrows THIS turn only; `chatTarget` below still carries the
        // selection, so the chat goes back to it on the next message.
        machineIds: mentions.length > 0 ? mentions : requested.machineIds,
        fanOut: outcome.resolved.fanOut,
        source: mentions.length > 0 ? 'mention' : 'chat',
      };
      chatTarget = {
        machineIds:
          requested.machineIds === null ? null : dedupe(requested.machineIds),
      };
    }

    // acquireTurnLock returns the PRIOR turn's record — including its
    // toolCommands recovery index — read inside the same claim transaction, so
    // this turn can splice in real agent results for tool calls whose runner
    // died, with no separate pre-lock read (which would be a TOCTOU against the
    // overwrite the claim performs). In resume mode it also RE-VERIFIES the
    // binding checked above, which on its own is a TOCTOU against an
    // intervening turn.
    const turnId = generateTurnId();
    const legacyMachineId = neverWidenLegacyMachineId({ machineIds: turnTarget.machineIds });
    let prior: PriorTurn | null;
    try {
      prior = await acquireTurnLock(db, chatId, {
        turnId,
        siteId,
        machineId: legacyMachineId,
        supersede: supersede === true,
        ...(resume ? { resume } : { target: turnTarget, resolvedMachineIds: resolved.ids }),
      });
    } catch (error) {
      if (error instanceof ApprovalStaleError) return approvalStale();
      if (error instanceof TurnActiveError) {
        return NextResponse.json(
          { error: 'a turn is already running', code: 'turn_active' },
          { status: 409 },
        );
      }
      throw error;
    }

    // The lock write has committed, so the turn exists whatever the runner does
    // next. Message CONTENT is deliberately absent — the audit records that a turn
    // was started against this chat, not what was said. `machineId` stays for the
    // readers that already parse it; `machineIds` is what actually got dispatched.
    emitMutation({
      kind: 'chat_mutated',
      siteId,
      actor: auth.keyContext ? `apiKey:${auth.keyContext.keyId}` : `user:${userId}`,
      targetId: chatId,
      attributes: {
        verb: 'send',
        endpoint: request.nextUrl.pathname,
        method: 'POST',
        siteId,
        machineId: legacyMachineId,
        machineIds: resolved.ids,
        turnId,
        supersede: supersede === true,
      },
    });

    // Detached runner: returns immediately with the live stream branch; the
    // turn itself keeps running (and persisting to Firestore) even if this
    // HTTP response dies.
    const stream = startTurn(db, {
      chatId,
      turnId,
      siteId,
      messages,
      userId,
      access: effectiveAccess,
      resolved,
      turnTarget,
      priorTurn: prior,
      ...(chatTarget ? { chatTarget } : {}),
    });

    // Client disconnect: cancel the HTTP tee branch so the response isn't held open.
    // The turn keeps running (the snapshot pump owns the other branch), so nothing is
    // lost — the client reattaches via the stream doc.
    request.signal.addEventListener('abort', () => {
      void stream.cancel().catch(() => {});
    });

    return createUIMessageStreamResponse({ stream });
  } catch (error: unknown) {
    // These two carry their own status; everything else is genuinely a 500.
    if (error instanceof ApiAuthError) {
      return NextResponse.json(
        { error: error.message, ...(error.code ? { code: error.code } : {}) },
        { status: error.status },
      );
    }
    if (error instanceof SiteAccessError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: siteAccessStatus(error) },
      );
    }
    return apiError(error, 'hoot');
  }
}
