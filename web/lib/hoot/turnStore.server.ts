/**
 * Hoot turn store — the durable record of an in-flight turn at
 * `chats/{chatId}/stream/current`. A turn runs detached from the HTTP request,
 * so its state must survive a dead stream.
 *
 * One doc per chat; a new turn OVERWRITES the previous one and that overwrite
 * IS the supersede — the old runner's guarded writes then no-op on turnId
 * mismatch and watchers see the new turn immediately.
 *
 * The doc is also the AUTHORITATIVE per-turn target record: which machines the
 * turn asked for and which it resolved to, written inside the claim transaction
 * so a record can never exist without them, plus the approvals it ended waiting
 * on. Resuming an approval re-verifies that binding in the same transaction and
 * inherits the bound target, so an approved tier-3 call can never be re-aimed at
 * machines the person who approved it never saw.
 *
 * Every post-acquire write is guarded by a transactional turnId check and
 * never throws into the runner. Messages are JSON-cloned before write because
 * Firestore rejects nested `undefined` (mirrors `web/hooks/useHoot.ts`).
 *
 * Server-side only — never import this in client components.
 */

import crypto from 'crypto';
import { FieldPath, FieldValue, type Timestamp } from 'firebase-admin/firestore';
import type { UIMessage } from 'ai';
import {
  MAX_TARGET_MACHINES,
  SITE_TARGET_ID,
  isValidMachineId,
  type PriorTurn,
  type TurnTargetRecord,
} from '@/lib/hoot/target';

export type TurnStatus = 'running' | 'complete' | 'error' | 'superseded' | 'cancelled';

export type TerminalTurnStatus = Exclude<TurnStatus, 'running'>;

/** Value at `toolCommands[toolCallId][machineId]`; machineId is the key, so only the commandId is stored. */
export interface TurnToolCommand {
  commandId: string;
}

/**
 * Recovery index `toolCallId → machineId → { commandId }`. Nested so a
 * site-wide tool call (one toolCallId, N machines) records every machine —
 * a flat map would let the last write clobber the rest.
 */
export type TurnToolCommandMap = Record<string, Record<string, TurnToolCommand>>;

/** Shape of `chats/{chatId}/stream/current`. */
export interface TurnStreamDoc {
  status: TurnStatus;
  turnId: string;
  chatId: string;
  siteId: string;
  machineId: string;
  startedAt: Timestamp;
  updatedAt: Timestamp;
  /** Serialized in-progress assistant UIMessage — null until the first snapshot. */
  message: UIMessage | null;
  toolCommands: TurnToolCommandMap;
  /**
   * What this turn ASKED for. Written in the claim transaction, so a record that
   * has it can never disagree with the dispatch. Absent on docs written before
   * per-turn targeting.
   */
  target?: TurnTargetRecord;
  /**
   * The machines this turn dispatches to — always an explicit list for a new
   * record. `null` means "whatever was online", which only a legacy site-wide
   * doc (or a resume that inherited one) can say, because that set was never
   * written down.
   */
  resolvedMachineIds?: string[] | null;
  /**
   * Tool call ids this turn ended waiting on. Stored rather than derived from
   * `message` on read: snapshots are throttled, so the final approval-requested
   * part may never have been persisted.
   */
  pendingApprovals?: string[];
  error?: string;
}

/**
 * Heartbeat ownership signal; tri-state so a Firestore blip can't kill a
 * healthy turn. `owned` = write landed. `lost` = read succeeded and the doc is
 * gone/mismatched/terminal (real supersede or stop) — runner must abort.
 * `error` = the transaction threw, ownership indeterminate — keep going.
 */
export type TurnOwnership = 'owned' | 'lost' | 'error';

/**
 * Binds a resumed turn to the approval the PREVIOUS turn requested: the
 * assistant message that asked, and every tool call the request answers.
 */
export interface TurnResumeBinding {
  messageId: string;
  toolCallIds: string[];
  /**
   * The mode the RESUMED turn dispatches in, resolved from the bound set (never
   * from the request body). The prior's own flag described the set it asked for,
   * and a bound turn that comes down to one machine runs the single path — so
   * inheriting that flag would leave the record claiming a fan-out this turn
   * never ran, and the next turn would recover its tool results wrapped.
   */
  fanOut: boolean;
}

export interface TurnLockMeta {
  turnId: string;
  siteId: string;
  machineId: string;
  /** Claim even while another turn is running fresh (new user message mid-turn). */
  supersede?: boolean;
  /**
   * What this turn asked for, and the machines it dispatches to (resolved before
   * the claim). ONE record in two fields — pass both or neither; half of it is a
   * caller bug and `acquireTurnLock` throws. Ignored in resume mode.
   */
  target?: TurnTargetRecord;
  resolvedMachineIds?: string[];
  /**
   * Resume an approval instead of sending a new turn. The claim re-verifies this
   * binding against the prior record INSIDE the transaction — a non-transactional
   * pre-check alone would be a TOCTOU against an intervening turn — and the new
   * record inherits the prior target, never the request's.
   */
  resume?: TurnResumeBinding;
}

/** A `running` doc whose heartbeat is older than this is a dead runner — claimable. */
export const TURN_STALE_MS = 45_000;

/** Minimum gap between snapshot writes per chat (Firestore write-volume cap). */
export const SNAPSHOT_THROTTLE_MS = 750;

/** Thrown by `acquireTurnLock` when a fresh turn is already running. */
export class TurnActiveError extends Error {
  readonly chatId: string;
  readonly activeTurnId: string;
  constructor(chatId: string, activeTurnId: string) {
    super(`a turn is already running for chat ${chatId}`);
    this.name = 'TurnActiveError';
    this.chatId = chatId;
    this.activeTurnId = activeTurnId;
  }
}

/** Why a resume was refused. Reported for logs and tests, never to the client. */
export type ApprovalStaleReason =
  | 'no_prior_turn'
  | 'site_mismatch'
  | 'message_mismatch'
  | 'approval_missing'
  | 'no_approvals';

/**
 * Thrown by `acquireTurnLock` in resume mode when the approval no longer binds
 * to the record it was requested on — a later turn overwrote it, the site does
 * not match, or the approval is not one this chat is waiting for. The route maps
 * it to 409 `approval_stale`; it is NEVER re-aimed at the current selection.
 */
export class ApprovalStaleError extends Error {
  readonly chatId: string;
  readonly reason: ApprovalStaleReason;
  constructor(chatId: string, reason: ApprovalStaleReason) {
    super(`approval is no longer current for chat ${chatId} (${reason})`);
    this.name = 'ApprovalStaleError';
    this.chatId = chatId;
    this.reason = reason;
  }
}

/** Generate a fresh turnId. Format: `turn_<24 url-safe chars>`. */
export function generateTurnId(): string {
  return `turn_${crypto.randomBytes(18).toString('base64url')}`;
}

export function streamRef(db: FirebaseFirestore.Firestore, chatId: string) {
  return db.collection('chats').doc(chatId).collection('stream').doc('current');
}

/** Firestore rejects nested `undefined`; a JSON round-trip strips it (as useHoot.ts does). */
function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Per-chat timestamp of the last successful snapshot write (throttle state). */
const lastSnapshotWriteAt = new Map<string, number>();

/** Test-only: clear throttle state so suites don't bleed into each other. */
export function _resetThrottleForTests(): void {
  lastSnapshotWriteAt.clear();
}

/**
 * Outcome of a turnId-guarded write. Tri-state, not boolean: collapsing
 * `error` into `not-owned` let one network blip abort a healthy turn.
 * `written` = doc still ours and running. `not-owned` = read succeeded, doc
 * missing/mismatched/terminal. `error` = transaction threw, indeterminate.
 */
type GuardedWriteOutcome = 'written' | 'not-owned' | 'error';

/**
 * Transactionally run `applyWrite` iff the stream doc still belongs to `turnId`
 * AND is still `running`. Never throws — the runner fires these unwrapped.
 * `acquireTurnLock` bypasses this helper (`txn.set`) so a fresh claim over a
 * terminal doc still works; a second terminal write reports `not-owned`.
 */
async function guardedTurnWrite(
  db: FirebaseFirestore.Firestore,
  chatId: string,
  turnId: string,
  applyWrite: (
    txn: FirebaseFirestore.Transaction,
    ref: FirebaseFirestore.DocumentReference,
  ) => void,
): Promise<GuardedWriteOutcome> {
  const ref = streamRef(db, chatId);
  try {
    return await db.runTransaction<GuardedWriteOutcome>(async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists) return 'not-owned';
      const data = snap.data() ?? {};
      if (data.turnId !== turnId) return 'not-owned';
      if (data.status !== 'running') return 'not-owned';
      applyWrite(txn, ref);
      return 'written';
    });
  } catch {
    // `error`, never `not-owned`: a blip must not be read as genuine loss.
    return 'error';
  }
}

/** Object-form guarded update (+ an `updatedAt` bump). See `guardedTurnWrite`. */
function guardedTurnUpdate(
  db: FirebaseFirestore.Firestore,
  chatId: string,
  turnId: string,
  patch: Record<string, unknown>,
): Promise<GuardedWriteOutcome> {
  return guardedTurnWrite(db, chatId, turnId, (txn, ref) => {
    txn.update(ref, { ...patch, updatedAt: FieldValue.serverTimestamp() });
  });
}

/** Minimal structural view of a UIMessage tool part; mirrors `repairMessages.ts`. */
interface ApprovalPartLike {
  type: string;
  state: string;
  toolCallId: string;
}

function isApprovalRequestedPart(part: unknown): part is ApprovalPartLike {
  if (typeof part !== 'object' || part === null) return false;
  const candidate = part as Partial<ApprovalPartLike>;
  return (
    typeof candidate.type === 'string' &&
    (candidate.type === 'dynamic-tool' || candidate.type.startsWith('tool-')) &&
    candidate.state === 'approval-requested' &&
    typeof candidate.toolCallId === 'string' &&
    candidate.toolCallId.length > 0
  );
}

/**
 * Tool call ids an assistant message is waiting on approval for, deduped and in
 * part order. The runner passes these to `finishTurn`; reading a legacy doc
 * derives them from the stored message instead, since it has no stored list.
 *
 * Takes `unknown`: the input is a Firestore document field.
 */
export function approvalRequestedIds(message: unknown): string[] {
  if (typeof message !== 'object' || message === null) return [];
  const parts: unknown = (message as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return [];

  const ids: string[] = [];
  for (const part of parts) {
    if (isApprovalRequestedPart(part) && !ids.includes(part.toolCallId)) {
      ids.push(part.toolCallId);
    }
  }
  return ids;
}

/**
 * Validated, deduped machine-id list; `null` when the value is not one. Local
 * rather than shared with `target.ts`, whose own list reader is private to the
 * chat-doc field shapes — this one reads stream-doc fields.
 */
function readMachineIdList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_TARGET_MACHINES) return null;
  const ids: string[] = [];
  for (const entry of value) {
    if (!isValidMachineId(entry)) return null;
    if (!ids.includes(entry)) ids.push(entry);
  }
  return ids;
}

/** Non-empty strings, deduped, in order. */
function readStringList(value: unknown[]): string[] {
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0 && !out.includes(entry)) out.push(entry);
  }
  return out;
}

/** The doc's `target`, or null when it is absent or unreadable. */
function readTargetRecord(value: unknown): { machineIds: string[] | null; fanOut: boolean } | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as { machineIds?: unknown; fanOut?: unknown };
  if (typeof record.fanOut !== 'boolean') return null;
  if (record.machineIds === null) return { machineIds: null, fanOut: record.fanOut };
  const ids = readMachineIdList(record.machineIds);
  if (ids === null || ids.length === 0) return null;
  return { machineIds: ids, fanOut: record.fanOut };
}

/**
 * The machines a stored record dispatched to, or `null` for "whatever was
 * online". NEVER WIDENS: a present-but-corrupt list reads as the empty set (the
 * next turn then resolves nothing and refuses) rather than falling through to
 * the legacy `machineId`, where a site sentinel would mean every machine.
 */
function readResolvedMachineIds(data: Record<string, unknown>): string[] | null {
  const stored = data.resolvedMachineIds;
  if (stored !== undefined && stored !== null) return readMachineIdList(stored) ?? [];

  // Legacy doc (or a resume that inherited one): all we have is `machineId`.
  if (data.machineId === SITE_TARGET_ID) return null;
  return isValidMachineId(data.machineId) ? [data.machineId] : [];
}

/** Read a stream doc into the shape a following turn needs. */
function toPriorTurn(data: Record<string, unknown>): PriorTurn {
  const toolCommands =
    typeof data.toolCommands === 'object' && data.toolCommands !== null
      ? (data.toolCommands as TurnToolCommandMap)
      : {};

  const resolvedMachineIds = readResolvedMachineIds(data);
  const recordedTarget = readTargetRecord(data.target);
  // Falling back to the resolved list keeps a corrupt `target` from turning a
  // single-machine turn's recovery into a fan-out (and back).
  const fanOut =
    recordedTarget?.fanOut ??
    (resolvedMachineIds === null ? true : resolvedMachineIds.length !== 1);

  const messageId = (data.message as { id?: unknown } | null | undefined)?.id;

  return {
    toolCommands,
    fanOut,
    resolvedMachineIds,
    messageId: typeof messageId === 'string' && messageId.length > 0 ? messageId : null,
    pendingApprovals: Array.isArray(data.pendingApprovals)
      ? readStringList(data.pendingApprovals)
      : approvalRequestedIds(data.message),
  };
}

/**
 * Read `chats/{chatId}/stream/current` outside a transaction, for the route's
 * pre-check: a stale approval is refused BEFORE the ledger claim, so it is not
 * consumed. The claim re-verifies the same binding transactionally, because this
 * read is a TOCTOU on its own. Throws on a Firestore failure — this gates a
 * dispatch, and "read failed" must not read as "no prior turn".
 */
export async function readTurnRecord(
  db: FirebaseFirestore.Firestore,
  chatId: string,
): Promise<PriorTurn | null> {
  const snap = await streamRef(db, chatId).get();
  if (!snap.exists) return null;
  return toPriorTurn(snap.data() ?? {});
}

/**
 * The record a NEW turn writes, or null when the caller records no target at all.
 *
 * The two fields are one fact, so half of them is refused rather than written: a
 * `target` without its resolved list would store `resolvedMachineIds: null`, and
 * `null` is readable only as the legacy "whatever was online" — a recorded subset
 * would come back as the whole site, and a resume would inherit that widening.
 * Throwing surfaces the caller bug here instead (as `target.ts`'s own empty-set
 * assertion does), before anything is claimed.
 */
function newTurnRecord(
  meta: TurnLockMeta,
): { target: TurnTargetRecord; resolvedMachineIds: string[] } | null {
  const { target, resolvedMachineIds } = meta;
  if (target === undefined && resolvedMachineIds === undefined) return null;
  if (target === undefined || resolvedMachineIds === undefined) {
    throw new Error(
      'acquireTurnLock: `target` and `resolvedMachineIds` are one record — pass both or neither',
    );
  }
  return { target, resolvedMachineIds };
}

/** The target a resumed turn inherits, or `ApprovalStaleError` if it no longer binds. */
function resumeTargetRecord(
  chatId: string,
  resume: TurnResumeBinding,
  siteId: string,
  data: Record<string, unknown> | null,
  prior: PriorTurn | null,
): { target: TurnTargetRecord; resolvedMachineIds: string[] | null } {
  if (data === null || prior === null) throw new ApprovalStaleError(chatId, 'no_prior_turn');
  if (data.siteId !== siteId) throw new ApprovalStaleError(chatId, 'site_mismatch');
  if (prior.messageId === null || prior.messageId !== resume.messageId) {
    throw new ApprovalStaleError(chatId, 'message_mismatch');
  }
  // An empty answer set would satisfy the superset test trivially and inherit a
  // target without approving anything. The route only resumes with ids, so this
  // is a bug — refuse it rather than dispatch on it.
  if (resume.toolCallIds.length === 0) throw new ApprovalStaleError(chatId, 'no_approvals');
  for (const toolCallId of resume.toolCallIds) {
    if (!prior.pendingApprovals.includes(toolCallId)) {
      throw new ApprovalStaleError(chatId, 'approval_missing');
    }
  }

  const recorded = readTargetRecord(data.target);
  return {
    // A legacy prior has no `target`, so its inherited set comes from the same
    // `machineId` mapping the rest of this module reads it by. `fanOut` is this
    // turn's own, not the prior's — see {@link TurnResumeBinding}.
    target: {
      machineIds: recorded ? recorded.machineIds : prior.resolvedMachineIds,
      fanOut: resume.fanOut,
      source: 'resume',
    },
    // `null` only when the bound turn was a legacy site-wide one; the caller
    // re-validates against what is online now before dispatching.
    resolvedMachineIds: prior.resolvedMachineIds,
  };
}

/**
 * Claim the per-chat turn lock by (over)writing `stream/current` as a fresh
 * `running` doc. Throws `TurnActiveError` when another turn is running with a
 * fresh heartbeat unless `meta.supersede`. Stale running docs (older than
 * TURN_STALE_MS — runner killed by a deploy) are always claimable.
 *
 * Returns the PRIOR turn record, read in the same transaction: a separate
 * pre-lock `get()` would be a TOCTOU read against this overwrite.
 *
 * In resume mode the same transaction re-verifies the approval binding and
 * throws `ApprovalStaleError` when it no longer holds, before any state is
 * claimed. Half a target record (`newTurnRecord`) throws before the transaction.
 */
export async function acquireTurnLock(
  db: FirebaseFirestore.Firestore,
  chatId: string,
  meta: TurnLockMeta,
): Promise<PriorTurn | null> {
  const ref = streamRef(db, chatId);
  // Validated before the transaction: a caller bug should not cost a claim, and
  // a throw inside would surface once per transaction retry.
  const requestedRecord = newTurnRecord(meta);

  let priorTurn: PriorTurn | null = null;

  await db.runTransaction(async (txn) => {
    // Reset per-retry so a transaction re-run reflects the latest read.
    priorTurn = null;
    const snap = await txn.get(ref);
    const data = snap.exists ? (snap.data() ?? {}) : null;
    if (data !== null) priorTurn = toPriorTurn(data);

    // The binding is checked before the contention check: an intervening turn
    // makes the approval stale, and `approval_stale` is the honest answer —
    // `turn_active` would invite the client's supersede retry.
    const record: { target: TurnTargetRecord; resolvedMachineIds: string[] | null } | null =
      meta.resume
        ? resumeTargetRecord(chatId, meta.resume, meta.siteId, data, priorTurn)
        : requestedRecord;

    if (data !== null && !meta.supersede && data.status === 'running') {
      const updatedAt = data.updatedAt as Timestamp | undefined;
      const updatedMs =
        updatedAt && typeof updatedAt.toMillis === 'function' ? updatedAt.toMillis() : 0;
      if (Date.now() - updatedMs < TURN_STALE_MS) {
        throw new TurnActiveError(
          chatId,
          typeof data.turnId === 'string' ? data.turnId : 'unknown',
        );
      }
    }

    txn.set(ref, {
      status: 'running' satisfies TurnStatus,
      turnId: meta.turnId,
      chatId,
      siteId: meta.siteId,
      machineId: meta.machineId,
      startedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      message: null,
      toolCommands: {},
      // Spread, not `undefined` fields: Firestore rejects those. A caller that
      // passes no target (a legacy body, or a path this feature has not reached)
      // leaves the record legacy-shaped and readers fall back to `machineId`.
      ...(record === null
        ? {}
        : { target: record.target, resolvedMachineIds: record.resolvedMachineIds }),
    });
  });

  // Fresh turn — first snapshot should never be throttled by a prior turn.
  lastSnapshotWriteAt.delete(chatId);

  return priorTurn;
}

/**
 * Narrow the machines this turn dispatches to. The caller resolved them before
 * the claim; the runner re-checks the site listing at turn start and records
 * whatever survived, so the record never names a machine the turn did not reach
 * — a later approval resume binds to exactly this list.
 *
 * Guarded like every other post-claim write, and NEVER called with an empty
 * list: `null`/`[]` would read back as "whatever was online" or as nothing at
 * all. `false` means the write did not land (superseded, or Firestore failed)
 * and the runner must abort before dispatching.
 */
export async function recordResolvedMachines(
  db: FirebaseFirestore.Firestore,
  chatId: string,
  turnId: string,
  machineIds: string[],
): Promise<boolean> {
  if (machineIds.length === 0) {
    throw new Error('recordResolvedMachines: a turn with no machines must not dispatch');
  }
  const outcome = await guardedTurnUpdate(db, chatId, turnId, { resolvedMachineIds: machineIds });
  return outcome === 'written';
}

/**
 * Persist the in-progress assistant UIMessage; at most one write per
 * SNAPSHOT_THROTTLE_MS per chat. Returns `false` (never throws) when
 * throttled, superseded, or unserializable.
 */
export async function writeSnapshot(
  db: FirebaseFirestore.Firestore,
  chatId: string,
  turnId: string,
  message: UIMessage,
): Promise<boolean> {
  const now = Date.now();
  const last = lastSnapshotWriteAt.get(chatId);
  if (last !== undefined && now - last < SNAPSHOT_THROTTLE_MS) return false;

  let cloned: UIMessage;
  try {
    cloned = jsonClone(message);
  } catch {
    // Unserializable snapshot (circular part) — skip rather than kill the turn.
    return false;
  }

  const outcome = await guardedTurnUpdate(db, chatId, turnId, { message: cloned });
  // Snapshots are best-effort; only a landed write moves the throttle window.
  if (outcome === 'written') lastSnapshotWriteAt.set(chatId, now);
  return outcome === 'written';
}

/**
 * Heartbeat: bump `updatedAt` so a long tool poll isn't declared stale. Not
 * throttled — callers pace it. Runner aborts on `lost`, never on `error`.
 */
export async function touch(
  db: FirebaseFirestore.Firestore,
  chatId: string,
  turnId: string,
): Promise<TurnOwnership> {
  const outcome = await guardedTurnUpdate(db, chatId, turnId, {});
  return outcome === 'written' ? 'owned' : outcome === 'not-owned' ? 'lost' : 'error';
}

/**
 * Record `toolCallId → machineId → {commandId}` when a tool command is queued,
 * so a later turn can splice in the real agent result if this runner dies.
 * Called once per machine for a site-wide fan-out.
 */
export async function recordToolCommand(
  db: FirebaseFirestore.Firestore,
  chatId: string,
  turnId: string,
  toolCallId: string,
  commandId: string,
  machineId: string,
): Promise<boolean> {
  const outcome = await guardedTurnWrite(db, chatId, turnId, (txn, ref) => {
    // FieldPath, never a dotted string: machineIds contain hyphens (e.g.
    // 'INF-PROJECTION-WALL'), invalid in Firestore's dotted path syntax and a
    // runtime throw. Segments are literal, and only the [toolCallId][machineId]
    // leaf is replaced, so sibling machines survive a site-wide fan-out.
    txn.update(
      ref,
      new FieldPath('toolCommands', toolCallId, machineId),
      { commandId } satisfies TurnToolCommand,
      'updatedAt',
      FieldValue.serverTimestamp(),
    );
  });
  return outcome === 'written';
}

/**
 * Mark the turn terminal. `error` is only stamped when provided (typically
 * with `status: 'error'`). No-ops when the turn was superseded mid-flight.
 *
 * `pendingApprovals` (`approvalRequestedIds` of the final assistant message)
 * records what the turn ended waiting on, in the SAME guarded write as the
 * terminal status: the two describe one event, and a record that went terminal
 * without its list would refuse every resume of it.
 */
export async function finishTurn(
  db: FirebaseFirestore.Firestore,
  chatId: string,
  turnId: string,
  status: TerminalTurnStatus,
  error?: string,
  pendingApprovals?: string[],
): Promise<boolean> {
  const outcome = await guardedTurnUpdate(db, chatId, turnId, {
    status,
    ...(error !== undefined ? { error } : {}),
    ...(pendingApprovals !== undefined ? { pendingApprovals } : {}),
  });
  // `error` must report false too: the terminal write did not persist, and the
  // runner writing its final message array after a failed finalize corrupts it.
  const written = outcome === 'written';
  // Turn is over — drop throttle state so the map can't leak one entry per chat.
  if (written) lastSnapshotWriteAt.delete(chatId);
  return written;
}
