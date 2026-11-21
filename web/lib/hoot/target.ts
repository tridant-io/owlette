/**
 * The shared vocabulary for "which machines does this hoot turn talk to".
 *
 * A chat used to target ONE machine or the whole site, and the client plus five
 * server paths each carried their own `'__site__'` copy and their own reading of
 * the chat doc. Targeting a SET makes that spread unsafe: the same selection has
 * to be written to the chat doc, mirrored into the legacy fields an old tab still
 * reads, resolved per turn, recorded on the stream doc and rendered in the
 * transcript — and every one of those must NARROW, never widen, when they
 * disagree. So the rules live here, once, in a module that is pure and safe on
 * both sides (no firebase, no server imports, no I/O).
 *
 * Two invariants the rest of the feature leans on:
 *
 * - **Never widen.** A target that cannot be read, or cannot be encoded in the
 *   legacy fields, resolves to fewer machines or to none — never to "all". The
 *   behavior this replaces did the opposite: `useHoot.ts` defaulted an unreadable
 *   target to the whole site, so a corrupt chat doc dispatched site-wide.
 * - **`machineIds: null` means every machine in the site, DYNAMICALLY** — a
 *   machine added later joins it (the `TalonScope` precedent, `lib/talons/types.ts`).
 *   An explicit `string[]` is a fixed set, and `[]` is never a valid target: the
 *   picker allows it transiently with send disabled, but it is never persisted
 *   and never dispatched.
 */

/** Sentinel `machineId` for a site-wide chat — the one definition in `web/`. */
export const SITE_TARGET_ID = '__site__';

/**
 * Cap on an explicit target set. Each machine in a fan-out costs one command
 * document and one `recordToolCommand` transaction on a single stream doc, so
 * the set is bounded rather than trusted.
 */
export const MAX_TARGET_MACHINES = 64;

/**
 * Windows hostname charset: a `machineId` is `socket.gethostname()`
 * (`agent/src/shared_utils.py`) and doubles as a Firestore document id under
 * `sites/{siteId}/machines`, so `/` and path traversal are out.
 */
export const MACHINE_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** Firestore reserves `__…__` document ids — and `SITE_TARGET_ID` is one. */
const RESERVED_ID_RE = /^__.*__$/;

export function isValidMachineId(value: unknown): value is string {
  if (typeof value !== 'string' || !MACHINE_ID_RE.test(value)) return false;
  // `.`, `..` and `__x__` can't be document ids, so no machine is named them.
  // Rejecting them here also stops the site sentinel validating as a machine.
  return value !== '.' && value !== '..' && !RESERVED_ID_RE.test(value);
}

/** `null` = every machine in the site, dynamically. `[]` is never valid. */
export interface HootTarget {
  machineIds: string[] | null;
}

/**
 * `[]` has no safe encoding: the legacy `targetMachineId` would be null, which
 * every old reader maps to the site sentinel — exactly the widening this module
 * exists to prevent. Reaching a write path with an empty set is a bug, and
 * throwing surfaces it here instead of as a site-wide dispatch.
 */
function assertNonEmpty(ids: string[], caller: string): void {
  if (ids.length === 0) {
    throw new Error(`${caller}: an empty machine set is not a valid hoot target`);
  }
}

/** Validated, deduped id list in first-appearance order; null when unreadable. */
function readIdList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_TARGET_MACHINES) return null;
  const ids: string[] = [];
  for (const entry of value) {
    if (!isValidMachineId(entry)) return null;
    if (!ids.includes(entry)) ids.push(entry);
  }
  return ids;
}

export type ReadChatTargetResult = { ok: true; target: HootTarget } | { ok: false };

/**
 * A FRESH `{ok:false}` each time, never a shared constant: a caller that mutated
 * one result would otherwise poison every later fail-closed read in the process,
 * and the poisoned value would still typecheck as `{ok:true}` with no `target`.
 */
function unreadable(): ReadChatTargetResult {
  return { ok: false };
}

/**
 * Read a chat document's stored selection. FAILS CLOSED: an unreadable target is
 * `{ok:false}`, which the caller must turn into "pick machines for this chat"
 * with send disabled — never into an implicit site-wide send.
 *
 * Takes the document DATA (`chatDoc.data()`), and `unknown` because it is the
 * first thing to touch it.
 */
export function readChatTarget(doc: unknown): ReadChatTargetResult {
  if (typeof doc !== 'object' || doc === null) return unreadable();
  const data = doc as Record<string, unknown>;

  // The new field wins whenever it is present at all. A present-but-corrupt value
  // must NOT fall through to the legacy fields: a broken subset beside a stale
  // `targetType:'site'` would read back as the entire site.
  if (data.targetMachineIds !== undefined) {
    if (data.targetMachineIds === null) {
      // `null` is the widest value there is, so it is the one case where the
      // legacy field still gets a say. A doc that says "all machines" while also
      // naming a single one contradicts itself — an old tab wrote the legacy trio
      // over a new-field doc during a deploy or a rollback — and never-widen means
      // taking the narrower half. A consistent site doc leaves `targetMachineId`
      // null, so this only fires on the skewed shape.
      return isValidMachineId(data.targetMachineId)
        ? { ok: true, target: { machineIds: [data.targetMachineId] } }
        : { ok: true, target: { machineIds: null } };
    }
    const ids = readIdList(data.targetMachineIds);
    return ids === null || ids.length === 0
      ? unreadable()
      : { ok: true, target: { machineIds: ids } };
  }

  // Legacy docs (machine / site / autonomous / talon) predate the new field.
  if (data.targetType === 'site') return { ok: true, target: { machineIds: null } };
  if (data.targetType === 'machine' && isValidMachineId(data.targetMachineId)) {
    return { ok: true, target: { machineIds: [data.targetMachineId] } };
  }
  return unreadable();
}

export type ChatTargetType = 'site' | 'machine' | 'machines';

/** The chat doc's target fields — the new list plus the legacy trio. */
export interface ChatTargetFields {
  targetType: ChatTargetType;
  targetMachineIds: string[] | null;
  targetMachineId: string | null;
  machineName: string;
}

export interface ChatTargetFieldsOptions {
  /** Friendly display name for a single-machine chat (talons pass the machine's label). */
  label?: string;
}

/**
 * The fields to write for a selection, under the NEVER-WIDEN rule: an old tab
 * maps `targetMachineId || '__site__'` (`useHoot.ts`), so a subset always leaves
 * its first id there and the old tab narrows to one machine instead of widening
 * to the site.
 */
export function chatTargetFields(
  target: HootTarget,
  opts?: ChatTargetFieldsOptions,
): ChatTargetFields {
  const ids = target.machineIds;

  if (ids === null) {
    // 'All Machines' is the stored label of every site chat ever written, and the
    // share snapshot reads it back on both sides — so it keeps its casing.
    return {
      targetType: 'site',
      targetMachineIds: null,
      targetMachineId: null,
      machineName: 'All Machines',
    };
  }

  assertNonEmpty(ids, 'chatTargetFields');

  if (ids.length === 1) {
    return {
      targetType: 'machine',
      targetMachineIds: [ids[0]],
      targetMachineId: ids[0],
      machineName: opts?.label ?? ids[0],
    };
  }

  return {
    targetType: 'machines',
    targetMachineIds: [...ids],
    targetMachineId: ids[0],
    machineName: formatTargetLabel(ids),
  };
}

/**
 * The legacy single-`machineId` field for a target — for follow-up docs, whose
 * sweep may run on an older instance during a rollback. A subset narrows to its
 * first id so that old code can never fire it site-wide.
 */
export function neverWidenLegacyMachineId(target: HootTarget): string {
  const ids = target.machineIds;
  if (ids === null) return SITE_TARGET_ID;
  assertNonEmpty(ids, 'neverWidenLegacyMachineId');
  return ids[0];
}

/** How many ids a label spells out before collapsing the rest into `+N`. */
const LABEL_IDS_SHOWN = 2;

/** Display label for a selection: `all machines` | `a` | `a, b` | `a, b +3`. */
export function formatTargetLabel(machineIds: string[] | null): string {
  if (machineIds === null) return 'all machines';
  if (machineIds.length === 0) return 'no machines';
  if (machineIds.length <= LABEL_IDS_SHOWN) return machineIds.join(', ');
  const shown = machineIds.slice(0, LABEL_IDS_SHOWN).join(', ');
  return `${shown} +${machineIds.length - LABEL_IDS_SHOWN}`;
}

/**
 * Whether a turn runs in fan-out mode. A target that EFFECTIVELY names one
 * machine keeps today's single path — process context in the prompt, unwrapped
 * tool output, the power toggle and the exact offline copy e2e pins — which
 * covers a one-machine site that has "all machines" ticked.
 */
export function effectiveFanOut(target: HootTarget, siteMachineCount: number): boolean {
  const ids = target.machineIds;
  if (ids !== null) return ids.length !== 1;
  return siteMachineCount !== 1;
}

/**
 * Prune a selection against the site's current machines and collapse a set that
 * covers all of them back to the dynamic "all".
 *
 * `loaded` is the machine listing's load state, not a convenience: before it
 * arrives, "not in this site" is indistinguishable from "the list hasn't come
 * back yet", and pruning then would silently empty a valid selection.
 */
export function normalizeSelection(
  selection: HootTarget,
  siteMachineIds: readonly string[],
  loaded: boolean,
): HootTarget {
  if (!loaded) return selection;

  const ids = selection.machineIds;
  if (ids === null) return selection;

  const known = new Set(siteMachineIds);
  const pruned: string[] = [];
  for (const id of ids) {
    if (known.has(id) && !pruned.includes(id)) pruned.push(id);
  }

  // Guarded on a non-empty site: with no machines known, `[]` trivially "covers"
  // the site and would widen an empty selection to every machine.
  if (known.size > 0 && pruned.length === known.size) return { machineIds: null };

  // Same array contents come back as the same object, so callers can memoize.
  return pruned.length === ids.length ? selection : { machineIds: pruned };
}

/** Tick or untick one machine. "all" is dynamic, so unticking spells out the rest. */
export function toggleMachine(
  selection: HootTarget,
  machineId: string,
  siteMachineIds: readonly string[],
): HootTarget {
  const current = selection.machineIds ?? [...siteMachineIds];
  const next = current.includes(machineId)
    ? current.filter((id) => id !== machineId)
    : [...current, machineId];
  return normalizeSelection({ machineIds: next }, siteMachineIds, true);
}

/** The tri-state master row: everything ticked clears; anything less ticks all. */
export function toggleAll(selection: HootTarget, siteMachineIds: readonly string[]): HootTarget {
  const normalized = normalizeSelection(selection, siteMachineIds, true);
  return normalized.machineIds === null ? { machineIds: [] } : { machineIds: null };
}

/** Minimal structural view of a UIMessage tool part; mirrors `repairMessages.ts`. */
interface ToolPartLike {
  type: string;
  state: string;
  toolCallId: string;
}

function isApprovalRespondedPart(part: unknown): part is ToolPartLike {
  if (typeof part !== 'object' || part === null) return false;
  const candidate = part as Partial<ToolPartLike>;
  return (
    typeof candidate.type === 'string' &&
    (candidate.type === 'dynamic-tool' || candidate.type.startsWith('tool-')) &&
    candidate.state === 'approval-responded' &&
    typeof candidate.toolCallId === 'string' &&
    candidate.toolCallId.length > 0
  );
}

function isAssistantMessage(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && (value as { role?: unknown }).role === 'assistant'
  );
}

/** Last index whose role is 'user' (mirrors `findLastUserIndex`, repairMessages.ts). */
function lastUserIndex(messages: unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const value = messages[i];
    if (typeof value === 'object' && value !== null) {
      if ((value as { role?: unknown }).role === 'user') return i;
    }
  }
  return -1;
}

/**
 * Tool call ids the in-flight assistant turn is answering an approval for.
 * Approvals AND denials both count: each consumes the one-shot ledger claim
 * (`applyApprovalConsumption`, `repairMessages.ts`), so each binds the resumed
 * turn to the machines the approval was requested on.
 *
 * Scans every assistant message AFTER THE LAST USER ONE, because that is exactly
 * the span `applyApprovalConsumption` claims and dispatches. Reading a narrower
 * span — the final message, or the trailing run up to the first non-assistant
 * message — would leave an approval that still gets claimed and executed
 * unchecked by the binding test, which is the re-aiming this binding stops.
 *
 * Takes `unknown` so the route can call it on a parsed body before trusting it.
 */
export function approvalResponseIds(messages: unknown): string[] {
  if (!Array.isArray(messages)) return [];

  // Everything after the last user message, skipping the messages that are not
  // assistant ones rather than STOPPING at them. `applyApprovalConsumption`
  // claims exactly that span, so a trailing `system` message (a legal UIMessage
  // role) would otherwise end the scan while the approval behind it still got
  // claimed and executed — on whatever machines the request named.
  const ids: string[] = [];
  for (let i = lastUserIndex(messages) + 1; i < messages.length; i++) {
    if (!isAssistantMessage(messages[i])) continue;
    const parts: unknown = (messages[i] as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (isApprovalRespondedPart(part) && !ids.includes(part.toolCallId)) {
        ids.push(part.toolCallId);
      }
    }
  }
  return ids;
}

/** True when a request resumes an approval rather than sending a new turn. */
export function isApprovalResume(messages: unknown): boolean {
  return approvalResponseIds(messages).length > 0;
}

/**
 * Where a turn's target came from. Recorded on the stream doc and in metadata.
 * `machine` is a task a granted machine handed hoot (ADR 0017).
 */
export type TurnTargetSource = 'chat' | 'mention' | 'resume' | 'followup' | 'talon' | 'machine';

/** What a turn ASKED for — written into the stream doc inside the claim transaction. */
export interface TurnTargetRecord {
  machineIds: string[] | null;
  fanOut: boolean;
  source: TurnTargetSource;
}

/**
 * What a request RESOLVED to: an explicit list, always, plus what fell out of it
 * so the model can be told. The runner may narrow `ids` further at turn start but
 * never re-derives them from the request.
 */
export interface ResolvedTargets {
  ids: string[];
  fanOut: boolean;
  skipped: { offline: string[]; disabled: string[] };
}

/**
 * Structural mirror of `TurnToolCommandMap` (`turnStore.server.ts`), restated so
 * this module stays free of server imports: `toolCallId → machineId → commandId`.
 */
export type TurnToolCommandIndex = Record<string, Record<string, { commandId: string }>>;

/** The previous turn as read from `chats/{id}/stream/current`. */
export interface PriorTurn {
  toolCommands: TurnToolCommandIndex;
  fanOut: boolean;
  /**
   * `null` means "whatever was online" and can ONLY come from a legacy site-wide
   * doc — a record written by the new lock always carries its explicit list.
   */
  resolvedMachineIds: string[] | null;
  messageId: string | null;
  pendingApprovals: string[];
}

/** Per-turn display context stamped onto the assistant message. */
export interface HootTurnMetadata {
  turnId: string;
  machineIds: string[];
  via: TurnTargetSource;
  skipped: { offline: string[]; disabled: string[] };
  /**
   * The turn asked for the DYNAMIC "all machines" (`machineIds: null`) rather
   * than a list that happens to cover the site. `machineIds` above is the
   * resolved list either way, so without this the two are indistinguishable
   * once a turn is stamped — and an approval prompt cannot tell the reader
   * whether it is about to run on a chosen seven or on everything.
   *
   * Optional because it is additive: turns stamped before it read as absent,
   * and their labels stay exactly as they were.
   */
  dynamic?: boolean;
}

const TURN_TARGET_SOURCES: ReadonlySet<string> = new Set<TurnTargetSource>([
  'chat',
  'mention',
  'resume',
  'followup',
  'talon',
  'machine',
]);

/**
 * Read `message.metadata.hoot`. The client re-sends assistant messages verbatim,
 * so this value is UNTRUSTED — it labels the transcript and nothing else, never a
 * dispatch input. Anything malformed reads as null and the caller falls back to
 * its own label.
 */
export function readHootTurnMetadata(metadata: unknown): HootTurnMetadata | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  const hoot = (metadata as { hoot?: unknown }).hoot;
  if (typeof hoot !== 'object' || hoot === null) return null;

  const value = hoot as {
    turnId?: unknown;
    machineIds?: unknown;
    via?: unknown;
    skipped?: unknown;
    dynamic?: unknown;
  };

  if (typeof value.turnId !== 'string' || value.turnId.length === 0) return null;
  if (typeof value.via !== 'string' || !TURN_TARGET_SOURCES.has(value.via)) return null;

  const machineIds = readIdList(value.machineIds);
  if (machineIds === null || machineIds.length === 0) return null;

  // `skipped` is decoration on decoration — a malformed list reads as empty
  // rather than costing the whole label.
  const skipped =
    typeof value.skipped === 'object' && value.skipped !== null
      ? (value.skipped as { offline?: unknown; disabled?: unknown })
      : {};

  return {
    turnId: value.turnId,
    machineIds,
    via: value.via as TurnTargetSource,
    skipped: {
      offline: readIdList(skipped.offline) ?? [],
      disabled: readIdList(skipped.disabled) ?? [],
    },
    // Strictly `=== true`: this widens what the label CLAIMS ("every online
    // machine" rather than a named few), and the value arrives from a client
    // re-send, so anything truthy-but-not-true reads as the narrower form.
    dynamic: value.dynamic === true,
  };
}
