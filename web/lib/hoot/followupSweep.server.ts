/**
 * The scheduled-follow-up pass of the talons cron sweep.
 *
 * A follow-up is a promise the assistant made to come back to a chat — "check
 * whether that render finished in ten minutes". Firing one starts a normal hoot
 * turn in the SAME chat, on behalf of the user who owns it.
 *
 * Rides `/api/cron/talons` (once a minute) rather than a cron of its own —
 * decision 2026-08-11, `dev/active/talons/plan.md`. The route calls
 * {@link fireDueFollowups} in its own try/catch, so nothing here can take talon
 * dispatch down.
 *
 * ONE query does both jobs: `status == 'scheduled'` ordered by `runAt` asc.
 * Time-due follow-ups sort first, so a bounded scan always sees every one of
 * them; the nearest-future entries that trail them are where an early fire can
 * be found. A follow-up watching a command therefore fires early only while it
 * sits inside {@link FOLLOWUP_SCAN_LIMIT} — past that it still fires at its own
 * `runAt`, which is the whole point of storing one. The alternative (a second
 * indexed query keyed on a `watching` flag) buys precision nobody needs at a
 * handful of live follow-ups per fleet, and starves in its own way.
 *
 * Fire-time authority: site access is re-resolved on every fire, never trusted
 * from scheduling time, so a user removed or demoted in the meantime cannot
 * keep driving tools through a promise they left behind. Re-resolution alone
 * only bounds the fire from above by the OWNER's standing, which is more than a
 * capped turn had — a chat-scoped API key is held to tier 1 yet may still call
 * `schedule_followup`. So the scheduling turn's own ceiling rides on the doc
 * (`maxToolTier`) and the fire takes the lower of the two.
 *
 * The TARGET is re-validated the same way and from the same place: a follow-up
 * fires on the set it was scheduled with (D-D) — not on the chat's current
 * selection, which may have moved since — minus whatever has left the site,
 * gone offline or had hoot switched off in the meantime. Nothing left fails the
 * follow-up instead of starting a turn that can reach nobody.
 *
 * Tier 3 always waits for a person (plan decision 9). Unlike a talon this is a
 * forced approval gate, not a tier-2 ceiling: the model may still reach for a
 * tier-3 tool, and the turn parks at approval-requested for the owner to answer
 * when they come back to the chat. `forceTier3Approval` therefore overrides the
 * site's `requireTier3Approval` setting — a site that lets a person auto-run
 * tier 3 while they watch has not agreed to it running while nobody does.
 *
 * A follow-up NEVER supersedes a live turn: someone typing in the chat right
 * now outranks a reminder, so `TurnActiveError` puts the doc back to
 * `scheduled` and the next sweep tries again.
 *
 * Dispatch, not completion: the runner outlives this request, so `fired` means
 * the turn started. Failures after that point are recorded on the turn's own
 * stream doc, not here.
 *
 * Server-side only — never import this in client components.
 */

import { FieldValue, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import type { UIMessage } from 'ai';
import { timestampToMs } from '@/lib/firestoreTime.server';
import {
  SiteAccessError,
  resolveHootTargets,
  verifyUserSiteAccess,
  type SiteAccessLevel,
} from '@/lib/hoot-utils.server';
import { startTurn } from '@/lib/hoot/turnRunner.server';
import {
  acquireTurnLock,
  generateTurnId,
  TurnActiveError,
} from '@/lib/hoot/turnStore.server';
import {
  formatTargetLabel,
  neverWidenLegacyMachineId,
  type HootTarget,
  type ResolvedTargets,
} from '@/lib/hoot/target';
import {
  followupsCollection,
  scheduledTarget,
  watchedMachineId,
  type FollowupDoc,
} from '@/lib/hoot/followupStore.server';
import logger from '@/lib/logger';

/** Turns started per sweep; a backlog drains over the following minutes. */
const MAX_FOLLOWUP_FIRES_PER_SWEEP = 10;

/**
 * How far down the `runAt`-ordered scheduled list one sweep looks. Wider than
 * the fire cap so a full batch of due work still leaves room to notice a
 * watched command that finished ahead of time.
 */
const FOLLOWUP_SCAN_LIMIT = 25;

/**
 * The agent writes a non-terminal `running` marker to `commands/completed` at
 * the START of a command (restart safety), plus progress states. Only these
 * resolve it — mirrors `/api/hoot/provision-key`.
 */
const TERMINAL_COMMAND_STATUSES = new Set(['completed', 'failed', 'error', 'cancelled']);

/** What one sweep did with the follow-ups it decided to fire. */
export interface FollowupSweepCounts {
  /** Follow-ups this sweep took a decision on — time-due plus early fires. */
  due: number;
  fired: number;
  failed: number;
  /** Lost the claim to a concurrent sweep or a cancel. */
  skipped: number;
  /** Left `scheduled` because a live turn owns the chat. */
  turnActive: number;
}

/** Outcome of dispatching one claimed follow-up. */
type DispatchResult =
  | { outcome: 'fired' }
  | { outcome: 'turnActive' }
  | { outcome: 'failed'; turnError: string };

type FireOutcome = 'fired' | 'failed' | 'skipped' | 'turnActive';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The injected turn opener. Wording is the contract Task 4.3's prompt teaches. */
function buildFollowupMessage(followupId: string, note: string): UIMessage {
  return {
    id: `followup_msg_${followupId}`,
    role: 'user',
    parts: [{ type: 'text', text: `[scheduled follow-up] ${note}` }],
  };
}

/**
 * The chat's stored history. The runner persists whatever message array it is
 * handed, so passing the note alone would replace the conversation with it.
 * Entries without a `parts` array are dropped rather than allowed to throw
 * inside the runner's serializer.
 */
function readChatHistory(chat: Record<string, unknown>): UIMessage[] {
  const messages = chat.messages;
  if (!Array.isArray(messages)) return [];
  return messages.filter(
    (message): message is UIMessage =>
      !!message && typeof message === 'object' && Array.isArray((message as UIMessage).parts),
  );
}

/**
 * Has the command this follow-up is watching reached a terminal state? Best
 * effort — a read failure just means no early fire this minute.
 *
 * Only a single-machine follow-up has a command to watch ({@link
 * watchedMachineId}); every other one waits for its `runAt`.
 */
async function watchedCommandFinished(db: Firestore, followup: FollowupDoc): Promise<boolean> {
  // `watchedMachineId` already requires the command id; it is re-read here only
  // so the lookup below narrows to a string.
  const machineId = watchedMachineId(followup);
  const commandId = followup.watchCommandId;
  if (!machineId || !commandId) return false;

  try {
    const snapshot = await db
      .collection('sites')
      .doc(followup.siteId)
      .collection('machines')
      .doc(machineId)
      .collection('commands')
      .doc('completed')
      .get();

    if (!snapshot.exists) return false;
    const entry = (snapshot.data() ?? {})[commandId] as
      | Record<string, unknown>
      | undefined;
    const status = entry?.status;
    return typeof status === 'string' && TERMINAL_COMMAND_STATUSES.has(status);
  } catch {
    return false;
  }
}

/** A follow-up's target as it stands at fire time, or why it can no longer fire. */
type FollowupTargetResolution =
  | { ok: true; target: HootTarget; resolved: ResolvedTargets }
  | { ok: false; turnError: string };

/**
 * Where the follow-up was promised (D-D), re-validated NOW.
 *
 * A machine that has LEFT the site since scheduling — decommissioned, or moved
 * to another site, either way absent from this site's listing — drops out
 * instead of failing the whole follow-up: a promise made about three walls is
 * still worth keeping on the two that remain. Offline and hoot-off machines are
 * the resolver's business and are skipped there (D-A/D-B). Only when nothing
 * survives does the follow-up fail, which beats starting a turn whose tools
 * would queue commands under a machine document that no longer exists.
 *
 * `machineScope` is the owner's machine scope as it stands now. A machine dropped from
 * it reads as one that left the site, so it drops out the same way.
 */
async function resolveFollowupTarget(
  db: Firestore,
  siteId: string,
  target: HootTarget,
  machineScope: readonly string[] | null,
): Promise<FollowupTargetResolution> {
  const outcome = await resolveHootTargets(db, siteId, { requested: target.machineIds, machineScope });
  if (outcome.ok) return { ok: true, target, resolved: outcome.resolved };

  // `unknown_machine` is the one refusal a follow-up outlives, and only for an
  // explicit set: the dynamic "all machines" cannot name one. The resolver says
  // WHICH ids the site could not, so the retry costs one more listing read and
  // can only ever narrow. Every other refusal stands as it is.
  if (outcome.reason !== 'unknown_machine' || target.machineIds === null) {
    return { ok: false, turnError: outcome.reason };
  }

  const gone = new Set(outcome.machineIds);
  const remaining = target.machineIds.filter((id) => !gone.has(id));
  if (remaining.length === 0) {
    return {
      ok: false,
      turnError: `target_machines_gone: ${formatTargetLabel(outcome.machineIds)}`,
    };
  }

  const narrowed: HootTarget = { machineIds: remaining };
  const retry = await resolveHootTargets(db, siteId, { requested: remaining, machineScope });
  return retry.ok
    ? { ok: true, target: narrowed, resolved: retry.resolved }
    : { ok: false, turnError: retry.reason };
}

/**
 * Take ownership of one follow-up. The flip out of `scheduled` IS the claim, so
 * an overlapping sweep re-reads a non-scheduled doc and walks away. `runAt` is
 * not re-checked: it is immutable after creation, and the early-fire path
 * deliberately runs ahead of it.
 *
 * @returns `null` when another sweep (or a cancel) already resolved it.
 */
async function claimFollowup(
  db: Firestore,
  ref: DocumentReference,
  now: Date,
): Promise<FollowupDoc | null> {
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const data = snapshot.exists ? (snapshot.data() as FollowupDoc | undefined) : undefined;
    if (!data || data.status !== 'scheduled') return null;

    transaction.update(ref, { status: 'fired', firedAt: now });
    return data;
  });
}

/**
 * Re-check the world and start the turn. Throws only on an unexpected Firestore
 * failure; every refusal it can name comes back as `failed` with a
 * machine-readable `turnError`.
 */
async function dispatchFollowup(
  db: Firestore,
  followupId: string,
  followup: FollowupDoc,
): Promise<DispatchResult> {
  let access: SiteAccessLevel;
  try {
    access = await verifyUserSiteAccess(db, followup.userId, followup.siteId);
  } catch (error) {
    if (error instanceof SiteAccessError) {
      return { outcome: 'failed', turnError: error.code };
    }
    throw error;
  }

  const chatSnapshot = await db.collection('chats').doc(followup.chatId).get();
  if (!chatSnapshot.exists) {
    return { outcome: 'failed', turnError: 'chat_deleted' };
  }

  const chat = chatSnapshot.data() ?? {};
  // The Admin SDK bypasses rules, so this is the only thing standing between a
  // stale follow-up and a chat that changed hands.
  if (chat.userId !== followup.userId) {
    return { outcome: 'failed', turnError: 'chat_owner_mismatch' };
  }

  const targets = await resolveFollowupTarget(
    db,
    followup.siteId,
    scheduledTarget(followup),
    access.standing.machineIds,
  );
  if (!targets.ok) {
    return { outcome: 'failed', turnError: targets.turnError };
  }

  const messages = [
    ...readChatHistory(chat),
    buildFollowupMessage(followupId, followup.note),
  ];

  // Recorded on the stream doc as this turn's own target. There is deliberately
  // no `chatTarget` beside it: a follow-up fires on the set it was scheduled
  // with, which is not necessarily the chat's current selection, and firing must
  // not move that selection behind the owner's back.
  const turnTarget = {
    machineIds: targets.target.machineIds,
    fanOut: targets.resolved.fanOut,
    source: 'followup' as const,
  };

  const turnId = generateTurnId();
  let prior;
  try {
    prior = await acquireTurnLock(db, followup.chatId, {
      turnId,
      siteId: followup.siteId,
      machineId: neverWidenLegacyMachineId(targets.target),
      target: turnTarget,
      resolvedMachineIds: targets.resolved.ids,
    });
  } catch (error) {
    // A person is mid-conversation in this chat. Superseding them for a
    // reminder is the wrong trade; the next sweep picks it up.
    if (error instanceof TurnActiveError) return { outcome: 'turnActive' };
    return { outcome: 'failed', turnError: `turn_lock_failed: ${errorText(error)}` };
  }

  try {
    const stream = startTurn(db, {
      chatId: followup.chatId,
      turnId,
      siteId: followup.siteId,
      messages,
      userId: followup.userId,
      access,
      resolved: targets.resolved,
      turnTarget,
      // The scheduling turn's ceiling, which `startTurn` then intersects with
      // what access earns now — so the fire is capped by the lower of the two
      // and can never widen. Legacy docs carry none and fire as they always
      // did, on re-resolved access alone.
      ...(followup.maxToolTier ? { maxToolTier: followup.maxToolTier } : {}),
      priorTurn: prior,
      // Nobody is watching the moment a follow-up fires — see the header.
      forceTier3Approval: true,
      source: 'followup',
    });

    // The returned HTTP tee branch has no reader here and would buffer every
    // chunk unbounded. Cancelling drops only that branch; the snapshot pump
    // owns the other and runs the turn to completion.
    void stream.cancel().catch(() => {});
  } catch (error) {
    // `startTurn` never throws by contract; this catches a synchronous stream
    // setup failure.
    return { outcome: 'failed', turnError: `turn_start_failed: ${errorText(error)}` };
  }

  return { outcome: 'fired' };
}

/** Claim one follow-up and act on it, recording the outcome on the doc. */
async function fireFollowup(
  db: Firestore,
  ref: DocumentReference,
  now: Date,
): Promise<FireOutcome> {
  const claimed = await claimFollowup(db, ref, now);
  if (!claimed) return 'skipped';

  let result: DispatchResult;
  try {
    result = await dispatchFollowup(db, ref.id, claimed);
  } catch (error) {
    // Already claimed, so it cannot be left `scheduled` to retry forever —
    // record why it died where the owner can see it.
    result = { outcome: 'failed', turnError: `dispatch_failed: ${errorText(error)}` };
  }

  if (result.outcome === 'turnActive') {
    await ref.update({ status: 'scheduled', firedAt: FieldValue.delete() });
    return 'turnActive';
  }

  if (result.outcome === 'failed') {
    await ref.update({ status: 'failed', turnError: result.turnError });
    return 'failed';
  }

  return 'fired';
}

/**
 * Fire every follow-up that has come due, plus any whose watched command
 * finished early. Backed by the `cortex-followups` index (`status` ASC,
 * `runAt` ASC).
 */
export async function fireDueFollowups(
  db: Firestore,
  now: Date,
  deadline: number,
): Promise<FollowupSweepCounts> {
  const snapshot = await followupsCollection(db)
    .where('status', '==', 'scheduled')
    .orderBy('runAt', 'asc')
    .limit(FOLLOWUP_SCAN_LIMIT)
    .get();

  const counts: FollowupSweepCounts = { due: 0, fired: 0, failed: 0, skipped: 0, turnActive: 0 };

  for (const doc of snapshot.docs) {
    if (counts.due >= MAX_FOLLOWUP_FIRES_PER_SWEEP) break;
    // Leftovers stay `scheduled` with `runAt` untouched — the next sweep sees
    // them at the head of the same ordering.
    if (Date.now() >= deadline) {
      logger.warn('Hoot follow-up pass hit the sweep budget with work left', {
        context: 'cron/talons',
      });
      break;
    }

    const followup = doc.data() as FollowupDoc;
    const runAtMs = timestampToMs(followup.runAt);
    const isDue = runAtMs !== null && runAtMs <= now.getTime();
    if (!isDue && !(await watchedCommandFinished(db, followup))) continue;

    counts.due += 1;
    try {
      const outcome = await fireFollowup(db, doc.ref, now);
      counts[outcome] += 1;
    } catch (error) {
      // One follow-up's failure must not abort the pass.
      logger.error(`Hoot follow-up ${doc.id} failed to fire`, {
        context: 'cron/talons',
        data: { error: String(error) },
      });
    }
  }

  return counts;
}
