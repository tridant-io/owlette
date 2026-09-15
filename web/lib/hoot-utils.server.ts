/**
 * Shared utilities for Hoot endpoints (user chat + autonomous).
 * Server-side only — never import this from a client component.
 */

import { tool, jsonSchema } from 'ai';
import { decryptApiKey } from '@/lib/llm-encryption.server';
import { resolveSiteAccess, type MembershipRole } from '@/lib/sitePolicy.server';
import {
  EXISTING_COMMAND_MAPPINGS,
  type McpToolDefinition,
  type ToolTier,
} from '@/lib/mcp-tools';
import type { LlmConfig } from '@/lib/llm';
import { createProcess, ActionInputError, type ActionContext } from '@/lib/actions/createProcess.server';
import { updateProcess } from '@/lib/actions/updateProcess.server';
import { deleteProcess } from '@/lib/actions/deleteProcess.server';
import { ProcessConfigError, type PublicProcessConfig } from '@/lib/processConfig.server';
import { Capability, hasCapability, type Actor, type Role, type SystemActorName } from '@/lib/capabilities';
import { timestampToIso } from '@/lib/firestoreTime.server';
import {
  cancelFollowup,
  scheduleFollowup,
  type CancelFollowupOutcome,
} from '@/lib/hoot/followupStore.server';
import {
  MAX_TARGET_MACHINES,
  SITE_TARGET_ID,
  effectiveFanOut,
  isValidMachineId,
  type HootTarget,
  type ResolvedTargets,
} from '@/lib/hoot/target';
import type { TalonStoreContext } from '@/lib/talons/store.server';

/**
 * Tools executed server-side (Firestore directly, never relayed to an agent).
 * None have a handler in agent/src/mcp_tools.py `handlers`, so relaying one
 * returns `{'error': 'Unknown tool: …'}` — branch on this set before dispatch.
 */
export const SERVER_SIDE_TOOLS: ReadonlySet<string> = new Set([
  'get_site_logs',
  'get_system_presets',
  'deploy_software',
  'update_process',
  'add_process',
  'delete_process',
  // Talons are site-level records, not machine state — they are never relayed.
  'create_talon',
  'list_talons',
  'set_talon_enabled',
  // Follow-ups are chat records; the cron sweep acts on them, never an agent.
  'schedule_followup',
  'cancel_followup',
]);

export const COMMAND_POLL_INTERVAL_MS = 1500;
export const COMMAND_TIMEOUT_MS = 30000;

/**
 * Cap for tool-provided `timeout_seconds` (55 min). Mirrors the agent-side
 * clamp (mcp_tools.py `MAX_SCRIPT_TIMEOUT`) and stays under the agent's 1h
 * pending-entry GC so a command can never outlive its pending entry.
 */
export const MAX_TOOL_TIMEOUT_SECONDS = 3300;

/**
 * `schedule_followup` horizon — one minute to seven days. Enforced here rather
 * than in the store, which stores whatever `runAt` it is handed; the tool
 * description quotes the same numbers.
 */
export const MIN_FOLLOWUP_DELAY_MINUTES = 1;
export const MAX_FOLLOWUP_DELAY_MINUTES = 10080;

/** A follow-up note is an instruction to one future turn, not a document. */
export const MAX_FOLLOWUP_NOTE_LENGTH = 1000;

/**
 * Dispatch/poll hooks: the turn runner records `toolCallId → commandId` for
 * recovery and keeps the stream doc's heartbeat fresh during long tool waits.
 */
export interface AgentCommandHooks {
  /** Fires synchronously right after the pending-command write. */
  onCommandQueued?: (commandId: string) => void;
  onPollTick?: () => void;
  /** Turn superseded/stopped: the poll loop deletes the pending command (best
   *  effort) and returns cancelled rather than blocking for the full timeout. */
  abortSignal?: AbortSignal;
}

const RESERVED_EXISTING_COMMAND_KEYS: ReadonlySet<string> = new Set<string>([
  'type',
  'process_name',
  'timestamp',
  'status',
]);

function stripReservedExistingCommandKeys(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (RESERVED_EXISTING_COMMAND_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

export interface BuildExecutableToolsOptions {
  userId?: string;
  /** GLOBAL role. Grants nothing on a site; kept for audit attribution. */
  userRole?: string | null;
  /** PER-SITE standing. Omit it and every site-scoped tool denies. */
  userSiteRole?: MembershipRole;
  /** Unattended attribution for the autonomous Hoot path (no session). Wins over
   *  userId/userRole so the audit row reads `system:<name>`, not a phantom user. */
  systemActor?: SystemActorName;
  /** Chat this tool loop belongs to; defaulted from the positional `chatId` so
   *  server-side tools can stamp provenance (talon `createdVia` + `chatId`). */
  chatId?: string;
  /** The chat's target the way the follow-up store records it: a machine id, or
   *  `__site__` for a site-wide chat. Defaulted from `buildExecutableTools`'
   *  positional args — `machineIds` cannot supply it, because site mode passes
   *  the fanned-out online machines rather than the sentinel. Read only by
   *  `schedule_followup`, and only when `followupTarget` is absent. */
  chatMachineId?: string;
  /** This turn's target, recorded on whatever `schedule_followup` writes so the
   *  follow-up fires where it was promised (D-D). Wins over `chatMachineId`,
   *  which can only say "one machine" or "the whole site": without it a subset
   *  turn would schedule a SITE-WIDE follow-up, since fan-out defaults to the
   *  sentinel. */
  followupTarget?: HootTarget;
  /** This turn's effective tool-tier ceiling — what `access` earns, already
   *  intersected with any caller cap. Recorded by `schedule_followup` on the
   *  follow-up doc so the turn it fires later cannot out-reach the turn that
   *  promised it; nothing else reads it. */
  maxToolTier?: ToolTier;
  /** Tier-3 in-chat approval gate; defaults true. Off means tier-3 auto-runs on
   *  the server-side and site-wide paths too, not just local Hoot. */
  requireTier3Approval?: boolean;
  /** Per-tool-call dispatch hooks; site-wide fan-out fires onCommandQueued once
   *  per machine. SERVER_SIDE_TOOLS never dispatch, so they never fire these. */
  toolCallbacks?: {
    onCommandQueued?: (toolCallId: string, commandId: string, machineId: string) => void;
    onPollTick?: () => void;
    /** Per-turn abort signal — fans out to every dispatch's poll loop so a
     * superseded/stopped turn stops waiting on in-flight tool commands. */
    abortSignal?: AbortSignal;
  };
}

type ProcessToolResult = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeActorRole(role: string | null | undefined): Role {
  // Unknown values, `'user'` included, are the same tier as `'member'`: no
  // global privilege. See normaliseRole in lib/sitePolicy.server.ts.
  return role === 'member' || role === 'admin' || role === 'superadmin' ? role : 'member';
}

function actionContextForHoot(
  siteId: string,
  options: BuildExecutableToolsOptions,
): ActionContext {
  // Unattended callers have no user identity — attribute to the system actor so
  // the audit trail matches lib/hoot/dispatch.server.ts `actionContextFor`.
  if (options.systemActor) {
    return {
      siteId,
      actor: { type: 'system', name: options.systemActor, siteId },
      auditActor: `system:${options.systemActor}`,
    };
  }

  const userId = options.userId || 'unknown';
  const actor: Actor = {
    type: 'user',
    userId,
    role: normalizeActorRole(options.userRole),
    // Was `sites: [siteId]` — a fabricated membership that asserted the caller
    // belonged to the site without ever checking, so the global role alone
    // decided what the tools could do. The real standing is resolved by
    // `verifyUserSiteAccess` and threaded in; absent, nothing site-scoped runs.
    siteRoles: options.userSiteRole ? { [siteId]: options.userSiteRole } : {},
  };
  return {
    siteId,
    actor,
    auditActor: `cortex:user_${userId}`,
  };
}

function actionErrorResult(error: unknown): ProcessToolResult {
  if (error instanceof ActionInputError) {
    return {
      ok: false,
      error: error.code,
      detail: error.message,
      status: error.status,
    };
  }
  if (error instanceof ProcessConfigError) {
    return {
      ok: false,
      error: error.code || 'process_config_error',
      detail: error.message,
      status: error.status,
    };
  }
  return {
    ok: false,
    error: 'internal_error',
    detail: error instanceof Error ? error.message : 'Unknown error',
  };
}

/**
 * Resolve the LLM config belonging to ONE named user.
 *
 * Keys live in exactly one place: `users/{uid}/settings/llm`. The old
 * `sites/{siteId}/settings/llm` scope is gone — nothing could create one, so
 * every unattended feature that required it was un-runnable.
 *
 * `userId` is non-nullable with no site fallback, so unattended callers must
 * decide whose key they spend: talons resolve their author
 * (`lib/talons/author.server.ts`), autonomous runs the site owner
 * (`resolveSiteKeyOwner`). No `autonomousModel` override any more.
 *
 * @throws {Error} operator-actionable copy when no key is saved or the stored
 *                 key no longer decrypts.
 */
export async function resolveLlmConfig(
  db: FirebaseFirestore.Firestore,
  userId: string
): Promise<LlmConfig> {
  const userDoc = await db
    .collection('users')
    .doc(userId)
    .collection('settings')
    .doc('llm')
    .get();

  if (!userDoc.exists) {
    throw new Error(
      'No LLM API key configured. Add one in Account Settings → hoot.'
    );
  }

  const data = userDoc.data()!;
  let apiKey: string;
  try {
    apiKey = decryptApiKey(data.apiKeyEncrypted);
  } catch {
    throw new Error(
      'Failed to decrypt the stored LLM API key. This usually means the server encryption key has changed since the key was saved. Re-enter the API key in Account Settings → hoot.'
    );
  }

  return {
    provider: data.provider,
    apiKey,
    model: data.model || undefined,
  };
}

/**
 * Assert `userId` has a usable llm key without handing the key back, so the
 * decrypted key never enters a scope that could log, store, or forward it.
 */
export async function assertLlmKeyAvailable(
  db: FirebaseFirestore.Firestore,
  userId: string
): Promise<void> {
  await resolveLlmConfig(db, userId);
}

/**
 * The uid whose llm key a site-wide unattended run spends: the site owner — the
 * one uid durable for the life of the site that always passes
 * `verifyUserSiteAccess`. Machine-triggered runs have no author.
 *
 * @throws {Error} when the site is gone or has no owner recorded.
 */
export async function resolveSiteKeyOwner(
  db: FirebaseFirestore.Firestore,
  siteId: string
): Promise<string> {
  // The owner MEMBER ROW is authoritative. `sites/{siteId}.owner` is legacy and
  // wave 6.1 deletes it — reading only that would make every unattended run
  // throw "site has no owner" the moment the migration ran.
  const ownerRows = await db
    .collection('sites')
    .doc(siteId)
    .collection('members')
    .where('role', '==', 'owner')
    .limit(1)
    .get();

  const ownerRow = ownerRows.docs[0];
  if (ownerRow) {
    const data = ownerRow.data() ?? {};
    if (data.status === 'active') {
      return typeof data.uid === 'string' && data.uid.length > 0
        ? data.uid
        : ownerRow.id;
    }
  }

  // Transitional fallback: an environment where the membership backfill has not
  // run yet has an owner field but no owner row. Remove once prod is migrated —
  // after 6.1 this branch can only ever return undefined.
  const siteDoc = await db.collection('sites').doc(siteId).get();
  const owner = siteDoc.data()?.owner;
  if (typeof owner !== 'string' || owner.length === 0) {
    throw new Error(
      `Site ${siteId} has no owner, so there is no LLM API key for an unattended run to use.`
    );
  }
  return owner;
}

/**
 * A user's access level against a site; picks the Hoot tool tier they may drive.
 * `isSiteAdmin` mirrors AuthContext's `isSiteAdmin(siteId)`.
 */
export interface SiteAccessLevel {
  /** GLOBAL `users/{uid}.role`, unnormalised. Carries no site privilege. */
  role: string | null;
  /**
   * PER-SITE standing from `sites/{siteId}/members/{uid}`, or null for none.
   * This is what grants; `role` above does not. Callers building a `UserActor`
   * must pass this through, or every site-scoped capability denies.
   */
  siteRole: MembershipRole;
  isSuperadmin: boolean;
  isSiteAdmin: boolean;
  isSiteOwner: boolean;
}

/**
 * Why {@link verifyUserSiteAccess} said no. All four are deterministic — a retry
 * gives the same answer, unlike a Firestore outage (a different error class).
 */
export type SiteAccessErrorCode =
  | 'user_not_found'
  | 'user_deleted'
  | 'site_not_found'
  | 'no_site_access';

/**
 * A refusal from {@link verifyUserSiteAccess}, tagged with which one. Unattended
 * talon runs disable the talon on this class but must NOT on a Firestore outage,
 * which throws some other type. Messages kept verbatim for `.message` loggers.
 */
export class SiteAccessError extends Error {
  readonly code: SiteAccessErrorCode;

  constructor(code: SiteAccessErrorCode, message: string) {
    super(message);
    this.name = 'SiteAccessError';
    this.code = code;
  }
}

/**
 * Verify site access and return the caller's access level; throws on no-access.
 *
 * A thin adapter over `resolveSiteAccess` (lib/sitePolicy.server.ts) since Wave 1
 * task 1.5. This was the THIRD independent membership derivation in the codebase
 * and the one every unattended talon run goes through.
 *
 * The core's precedence differs from the one this function has always reported,
 * so the codes are re-derived from `facts` rather than taken from `reason`:
 * the core checks the SITE first and collapses "no user document" and
 * "soft-deleted" into a single `user_inactive`, while this reports
 * user_not_found > site_not_found > user_deleted > no_site_access. The facts
 * carry `userExists`, `siteExists` and `deletedAt` on the denial branch too, so
 * the original order is reproducible exactly.
 *
 * Preserving the codes is not cosmetic. `resolveTalonAuthor` maps them to decide
 * whether to DISABLE a talon, and `followupSweep` persists the raw code string as
 * `turnError` — a renamed code is stored-data drift.
 */
export async function verifyUserSiteAccess(
  db: FirebaseFirestore.Firestore,
  userId: string,
  siteId: string
): Promise<SiteAccessLevel> {
  const outcome = await resolveSiteAccess(userId, siteId, db);
  const { facts } = outcome;

  // This function's own precedence, not the core's.
  if (!facts.userExists) {
    throw new SiteAccessError('user_not_found', 'User not found');
  }
  if (!facts.siteExists) {
    throw new SiteAccessError('site_not_found', 'Site not found');
  }
  // Soft-delete does not invalidate the iron-session cookie, so without this a
  // deleted superadmin (granted by role, not sites[]) keeps driving tier-3 Hoot
  // until the cookie lapses.
  if (facts.deletedAt !== null) {
    throw new SiteAccessError('user_deleted', 'User is deleted or inactive');
  }
  if (!outcome.ok) {
    throw new SiteAccessError('no_site_access', 'You do not have access to this site');
  }

  const isSuperadmin = facts.globalRole === 'superadmin';
  const isSiteOwner = facts.membershipRole === 'owner';
  // Mirrors AuthContext.computeIsSiteAdmin: per-site standing decides, and the
  // global role contributes nothing but superadmin. This previously read
  // `globalRole === 'admin' && membershipRole !== null`, which is how one global
  // admin held tier-3 Hoot on every site it was assigned to.
  const isSiteAdmin =
    isSuperadmin || facts.membershipRole === 'owner' || facts.membershipRole === 'admin';

  // `rawRole`, not `globalRole`: this returns the unnormalised value, so a user
  // doc with no role stays `null` rather than becoming 'member'.
  return {
    role: facts.rawRole,
    siteRole: facts.membershipRole,
    isSuperadmin,
    isSiteAdmin,
    isSiteOwner,
  };
}

/**
 * Max Hoot tool tier for an access level: site admins → 3 (full), everyone else
 * → 1 (read-only). Members must never reach tier 2 (registry writes, installs,
 * disk cleans) or tier 3 (run_powershell, deploy_software, reboot).
 */
export function resolveHootMaxTier(access: SiteAccessLevel): ToolTier {
  return access.isSiteAdmin ? 3 : 1;
}

/** Reads the machine's presence document. */
export async function isMachineOnline(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineId: string
): Promise<boolean> {
  const presenceDoc = await db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .get();

  if (!presenceDoc.exists) return false;

  const data = presenceDoc.data()!;
  const online = data.online ?? false;
  return !!online;
}

/**
 * Check whether Hoot tool-call delivery is enabled for a machine.
 * Defaults to true when the field is absent (backwards-compatible).
 */
export async function isHootEnabled(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineId: string
): Promise<boolean> {
  const machineDoc = await db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .get();

  if (!machineDoc.exists) return true;

  return machineDoc.data()?.cortexEnabled !== false;
}

/**
 * Per-site tier-3 in-chat approval gate, at
 * `sites/{siteId}/settings/cortex.requireTier3Approval`; absent = true (fail safe).
 * True forces single-machine admin chats through the server-side LLM path so the
 * AI SDK `needsApproval` gate can fire; false allows local Hoot, which cannot
 * enforce it (the agent runs tools itself).
 */
export async function getHootRequireTier3Approval(
  db: FirebaseFirestore.Firestore,
  siteId: string,
): Promise<boolean> {
  try {
    const settingsDoc = await db
      .collection('sites')
      .doc(siteId)
      .collection('settings')
      .doc('cortex')
      .get();

    if (!settingsDoc.exists) return true;

    return settingsDoc.data()?.requireTier3Approval !== false;
  } catch {
    // Fail safe: if we can't read the setting, keep the gate on.
    return true;
  }
}

/** One machine of a site, with the two facts a dispatch turns on. */
export interface SiteMachineSummary {
  id: string;
  online: boolean;
  /** `cortexEnabled !== false` — absent means on, mirroring {@link isHootEnabled}. */
  hootEnabled: boolean;
}

/**
 * Every machine in a site, in ONE collection read.
 *
 * Resolving a SET through `isMachineOnline` + `isHootEnabled` would cost two
 * document reads per machine. Those two stay for the single-machine callers that
 * are not on this path: hootStream's machine mode and the talon runner's
 * per-machine pre-flight each check one named machine.
 */
export async function listSiteMachines(
  db: FirebaseFirestore.Firestore,
  siteId: string,
): Promise<SiteMachineSummary[]> {
  const snapshot = await db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .get();

  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      online: !!data.online,
      hootEnabled: data.cortexEnabled !== false,
    };
  });
}

/** What a turn asks to target, before the site has been consulted. */
export interface ResolveHootTargetsRequest {
  /** The chat's selection: `null` = every machine in the site, dynamically. */
  requested: string[] | null;
  /** `@machine` ids parsed from THIS turn's message. They REPLACE `requested`
   *  for this turn only (D-3), so a mention can name an unticked machine. */
  mentions?: string[];
}

/**
 * Why {@link resolveHootTargets} refused. Each reason is paired with the status
 * the caller returns, and `machineIds` names the machines that caused it so the
 * refusal can say which — never a second read to find out.
 */
export type ResolveTargetsFailure =
  | { ok: false; status: 400; reason: 'invalid_target' | 'unknown_machine'; machineIds: string[] }
  | { ok: false; status: 423; reason: 'hoot_disabled'; machineIds: string[] }
  | { ok: false; status: 503; reason: 'machine_offline' | 'no_machines'; machineIds: string[] };

export type ResolveTargetsResult =
  | { ok: true; resolved: ResolvedTargets }
  | ResolveTargetsFailure;

/** Validated, deduped, capped id list — or null when the list is unusable. */
function readTargetIds(value: unknown): string[] | null {
  // `[]` is never a valid target (see target.ts): it has no legacy encoding, and
  // an empty set reaching dispatch would read as "all machines" downstream.
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TARGET_MACHINES) {
    return null;
  }
  const ids: string[] = [];
  for (const entry of value) {
    if (!isValidMachineId(entry)) return null;
    if (!ids.includes(entry)) ids.push(entry);
  }
  return ids;
}

/**
 * The machines a turn dispatches to, resolved once against the site's listing.
 *
 * The single decision point: the route, follow-ups and talons all come through
 * here, so the kill switch (D-A) and the offline rules (D-B) cannot drift apart
 * between paths. It only ever NARROWS — an id this site cannot name is a 400,
 * never a fallback to "all machines".
 *
 * Skipped machines are reported rather than refused, unless nothing is left:
 * 423 when the kill switch is the whole reason, 503 otherwise. A machine the
 * user NAMED with `@` is refused outright, since silently dropping it would
 * answer a question about a different machine.
 */
export async function resolveHootTargets(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  request: ResolveHootTargetsRequest,
): Promise<ResolveTargetsResult> {
  // `null` is the one widening value and it is not a list, so it skips the id
  // validation rather than failing it.
  const wantsAll = request.requested === null;
  const requested = wantsAll ? null : readTargetIds(request.requested);
  const mentionsGiven = Array.isArray(request.mentions) && request.mentions.length > 0;
  const mentions = mentionsGiven ? readTargetIds(request.mentions) : null;
  if ((!wantsAll && requested === null) || (mentionsGiven && mentions === null)) {
    // Malformed before any read: a `/` in an id would be a path traversal
    // against `sites/{siteId}/machines`, so it never reaches Firestore.
    return { ok: false, status: 400, reason: 'invalid_target', machineIds: [] };
  }

  const machines = await listSiteMachines(db, siteId);
  const byId = new Map(machines.map((machine) => [machine.id, machine]));

  if (mentions) {
    const unknown = mentions.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      return { ok: false, status: 400, reason: 'unknown_machine', machineIds: unknown };
    }
    // Offline before the kill switch — the order `/api/hoot` has always checked
    // a single machine in, so a machine that is both keeps its 503.
    const offline = mentions.filter((id) => !byId.get(id)!.online);
    if (offline.length > 0) {
      return { ok: false, status: 503, reason: 'machine_offline', machineIds: offline };
    }
    const disabled = mentions.filter((id) => !byId.get(id)!.hootEnabled);
    if (disabled.length > 0) {
      return { ok: false, status: 423, reason: 'hoot_disabled', machineIds: disabled };
    }
    return {
      ok: true,
      resolved: {
        ids: mentions,
        fanOut: effectiveFanOut({ machineIds: mentions }, machines.length),
        skipped: { offline: [], disabled: [] },
      },
    };
  }

  if (requested !== null) {
    const unknown = requested.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      // Includes another site's machine: the listing is this site's, so a
      // foreign id is simply absent. Refusing beats quietly dropping it.
      return { ok: false, status: 400, reason: 'unknown_machine', machineIds: unknown };
    }
  }

  // A ticked machine that is offline or hoot-off is SKIPPED and reported (D-B),
  // so one dead wall doesn't cost the user the rest of the fleet. Offline is
  // classified first, keeping the status `/api/hoot` returns for a machine that
  // is both.
  const ids: string[] = [];
  const offline: string[] = [];
  const disabled: string[] = [];
  for (const id of requested ?? machines.map((machine) => machine.id)) {
    const machine = byId.get(id)!;
    if (!machine.online) offline.push(id);
    else if (!machine.hootEnabled) disabled.push(id);
    else ids.push(id);
  }

  if (ids.length === 0) {
    // Nothing left: 423 only when the kill switch is the WHOLE reason, so a
    // half-offline set still reads as "nothing is online".
    if (offline.length === 0 && disabled.length > 0) {
      return { ok: false, status: 423, reason: 'hoot_disabled', machineIds: disabled };
    }
    return offline.length > 0
      ? { ok: false, status: 503, reason: 'machine_offline', machineIds: offline }
      : { ok: false, status: 503, reason: 'no_machines', machineIds: [] };
  }

  return {
    ok: true,
    resolved: {
      ids,
      // fanOut follows what was REQUESTED, not what survived: a two-machine turn
      // with one machine offline still reports per machine, and a one-machine
      // site asking for "all" stays on the single path.
      fanOut: effectiveFanOut({ machineIds: requested }, machines.length),
      skipped: { offline, disabled },
    },
  };
}

/** Queue an MCP tool call for an agent via Firestore and wait for the result. */
export async function executeToolOnAgent(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineId: string,
  toolName: string,
  toolParams: Record<string, unknown>,
  chatId: string,
  opts?: AgentCommandHooks
): Promise<unknown> {
  const commandId = `mcp_${Date.now()}_${toolName}`;

  // Tool-provided timeout, clamped to MAX_TOOL_TIMEOUT_SECONDS.
  const toolTimeout = typeof toolParams.timeout_seconds === 'number'
    ? Math.min(toolParams.timeout_seconds, MAX_TOOL_TIMEOUT_SECONDS) * 1000
    : COMMAND_TIMEOUT_MS;
  // Add buffer for agent-side overhead (startup, serialization)
  const pollTimeoutMs = toolTimeout + 10000;

  const pendingRef = db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('commands')
    .doc('pending');

  await pendingRef.set(
    {
      [commandId]: {
        type: 'mcp_tool_call',
        tool_name: toolName,
        tool_params: toolParams,
        chat_id: chatId,
        timestamp: Date.now(),
        status: 'pending',
        timeout_seconds: toolTimeout / 1000,
      },
    },
    { merge: true }
  );

  opts?.onCommandQueued?.(commandId);

  const completedRef = db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('commands')
    .doc('completed');

  const startTime = Date.now();

  while (Date.now() - startTime < pollTimeoutMs) {
    // Owning turn superseded/stopped: stop waiting, drop the pending command
    // (best effort — the agent may already be running it), and unwind.
    if (opts?.abortSignal?.aborted) {
      try {
        const { FieldValue } = await import('firebase-admin/firestore');
        await pendingRef.update({ [commandId]: FieldValue.delete() });
      } catch {
        // Best effort cleanup
      }
      return { error: 'cancelled by user' };
    }

    await new Promise((resolve) => setTimeout(resolve, COMMAND_POLL_INTERVAL_MS));
    opts?.onPollTick?.();

    const completedDoc = await completedRef.get();
    if (!completedDoc.exists) continue;

    const data = completedDoc.data();
    const cmdResult = data?.[commandId];

    if (cmdResult) {
      // `running` entries are non-terminal progress markers written by
      // firebase_client.py `_mark_command_running` — skip, never delete.
      if (cmdResult.status === 'running') continue;

      const { FieldValue } = await import('firebase-admin/firestore');
      await completedRef.update({ [commandId]: FieldValue.delete() });

      if (cmdResult.status === 'failed') {
        return { error: cmdResult.error || 'Tool execution failed' };
      }
      // /api/hoot/cancel-tool writes a terminal `cancelled` entry; surface it as
      // an error so the model reacts instead of returning undefined.
      if (cmdResult.status === 'cancelled') {
        return { error: cmdResult.error || 'cancelled by user' };
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
  }

  // Timeout — clean up pending command
  try {
    const { FieldValue } = await import('firebase-admin/firestore');
    await pendingRef.update({ [commandId]: FieldValue.delete() });
  } catch {
    // Best effort cleanup
  }

  return { error: `Tool '${toolName}' timed out after ${Math.round(pollTimeoutMs / 1000)} seconds. The machine may be slow to respond or offline.` };
}

/**
 * Send an existing command type (Tier 2) to the agent.
 */
export async function executeExistingCommand(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineId: string,
  commandType: string,
  processName: string,
  extraParams: Record<string, unknown> = {},
  opts?: AgentCommandHooks
): Promise<unknown> {
  const commandId = `${commandType}_${Date.now()}`;
  const safeExtraParams = stripReservedExistingCommandKeys(extraParams);

  const pendingRef = db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('commands')
    .doc('pending');

  await pendingRef.set(
    {
      [commandId]: {
        ...safeExtraParams,
        type: commandType,
        process_name: processName,
        timestamp: Date.now(),
        status: 'pending',
      },
    },
    { merge: true }
  );

  opts?.onCommandQueued?.(commandId);

  const completedRef = db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('commands')
    .doc('completed');

  const startTime = Date.now();

  while (Date.now() - startTime < COMMAND_TIMEOUT_MS) {
    // Owning turn superseded/stopped: drop the pending command and unwind.
    if (opts?.abortSignal?.aborted) {
      try {
        const { FieldValue } = await import('firebase-admin/firestore');
        await pendingRef.update({ [commandId]: FieldValue.delete() });
      } catch {
        // Best effort cleanup
      }
      return { error: 'cancelled by user' };
    }

    await new Promise((resolve) => setTimeout(resolve, COMMAND_POLL_INTERVAL_MS));
    opts?.onPollTick?.();

    const completedDoc = await completedRef.get();
    const cmdResult = completedDoc.data()?.[commandId];

    if (cmdResult) {
      // `running` entries are non-terminal progress markers written by
      // firebase_client.py `_mark_command_running` — skip, never delete.
      if (cmdResult.status === 'running') continue;

      const { FieldValue } = await import('firebase-admin/firestore');
      await completedRef.update({ [commandId]: FieldValue.delete() });

      return {
        status: cmdResult.status,
        result: cmdResult.result || cmdResult.error || 'Command completed',
      };
    }
  }

  return { error: `Command '${commandType}' timed out` };
}

/**
 * get_site_logs, server-side. Over-fetches and filters level/action in memory to
 * avoid a composite index per filter combination.
 */
async function executeSiteLogs(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const level = params.level as string | undefined;
  const hours = typeof params.hours === 'number' ? params.hours : 24;
  const limit = typeof params.limit === 'number' ? Math.min(params.limit, 200) : 50;
  const action = params.action as string | undefined;

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

  const fetchLimit = (level || action) ? limit * 4 : limit;

  const logsQuery = db
    .collection('sites')
    .doc(siteId)
    .collection('logs')
    .where('timestamp', '>=', cutoff)
    .orderBy('timestamp', 'desc')
    .limit(Math.min(fetchLimit, 500));

  const snapshot = await logsQuery.get();

  let logs = snapshot.docs.map((doc) => {
    const data = doc.data();
    const ts = data.timestamp?.toDate
      ? data.timestamp.toDate().toISOString()
      : data.timestamp;
    return {
      timestamp: ts,
      machine: data.machineId || data.machine || 'unknown',
      action: data.action || '',
      level: data.level || 'info',
      process: data.processName || data.process || '',
      details: data.details || '',
    };
  });

  if (level) {
    logs = logs.filter((l) => l.level === level);
  }
  if (action) {
    logs = logs.filter((l) => l.action === action);
  }

  logs = logs.slice(0, limit);

  return { logs, count: logs.length, hours, siteId };
}

/** get_system_presets, server-side. */
async function executeGetSystemPresets(
  db: FirebaseFirestore.Firestore,
  params: Record<string, unknown>
): Promise<unknown> {
  const softwareNameFilter = params.software_name as string | undefined;
  const categoryFilter = params.category as string | undefined;

  const snapshot = await db.collection('system_presets').get();

  let presets = snapshot.docs
    .map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        name: data.name || '',
        software_name: data.software_name || '',
        category: data.category || '',
        description: data.description || '',
        installer_name: data.installer_name || '',
        installer_url: data.installer_url || '',
        silent_flags: data.silent_flags || '',
        verify_path: data.verify_path || undefined,
        close_processes: data.close_processes || [],
        timeout_seconds: data.timeout_seconds || undefined,
      };
    })
    // Exclude Owlette self-update presets
    .filter((p) => !snapshot.docs.find((d) => d.id === p.id)?.data().is_owlette_agent);

  if (softwareNameFilter) {
    const filter = softwareNameFilter.toLowerCase();
    presets = presets.filter(
      (p) =>
        p.software_name.toLowerCase().includes(filter) ||
        p.name.toLowerCase().includes(filter)
    );
  }

  if (categoryFilter) {
    const filter = categoryFilter.toLowerCase();
    presets = presets.filter((p) => p.category.toLowerCase().includes(filter));
  }

  return { presets, count: presets.length };
}

/**
 * deploy_software, server-side: resolve preset + params, create a deployment doc,
 * write install_software commands. Returns immediately; installs run async.
 */
async function executeDeploySoftware(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineIds: string[],
  params: Record<string, unknown>
): Promise<unknown> {
  const softwareName = params.software_name as string;
  const version = params.version as string | undefined;
  const presetId = params.preset_id as string | undefined;
  const timeoutMinutes = typeof params.timeout_minutes === 'number' ? params.timeout_minutes : 40;

  if (!softwareName) {
    return { error: 'software_name is required' };
  }

  if (machineIds.length === 0) {
    return { error: 'No target machines available. The machine may be offline.' };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let preset: Record<string, any> | null = null;

  if (presetId) {
    const presetDoc = await db.collection('system_presets').doc(presetId).get();
    if (presetDoc.exists) {
      preset = presetDoc.data()!;
    } else {
      return { error: `Preset '${presetId}' not found` };
    }
  } else {
    // Find best match by software_name
    const snapshot = await db.collection('system_presets').get();
    const filter = softwareName.toLowerCase();
    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (data.is_owlette_agent) continue;
      if (
        (data.software_name || '').toLowerCase().includes(filter) ||
        (data.name || '').toLowerCase().includes(filter)
      ) {
        preset = { id: doc.id, ...data };
        break;
      }
    }
  }

  // Merge preset with explicit overrides.
  let installerUrl = (params.installer_url as string) || preset?.installer_url || '';
  let installerName = (params.installer_name as string) || preset?.installer_name || '';
  let silentFlags = (params.silent_flags as string) || preset?.silent_flags || '';
  const verifyPath = (params.verify_path as string) || preset?.verify_path || '';
  const closeProcesses = (params.close_processes as string[]) || preset?.close_processes || [];
  const timeoutSeconds = timeoutMinutes * 60;

  // TouchDesigner version-aware overrides.
  const isTD = softwareName.toLowerCase().includes('touchdesigner');
  // Auto-enable parallel install for TouchDesigner; explicit param overrides
  const parallelInstall = params.parallel_install !== undefined
    ? Boolean(params.parallel_install)
    : (isTD || Boolean(preset?.parallel_install));
  if (version && isTD) {
    // Auto-resolve URL if not explicitly provided
    if (!params.installer_url) {
      installerUrl = `https://download.derivative.ca/TouchDesigner.${version}.exe`;
      installerName = `TouchDesigner.${version}.exe`;
    }

    // CRITICAL: Replace /DIR in silent flags to match the target version.
    // Presets may have an old version path hardcoded — never install to wrong dir.
    if (!params.silent_flags) {
      const correctDir = `C:\\Program Files\\Derivative\\TouchDesigner.${version}`;
      silentFlags = silentFlags.replace(
        /\/DIR="[^"]*"/i,
        `/DIR="${correctDir}"`
      );
      // If no /DIR was present, add it
      if (!/\/DIR=/i.test(silentFlags)) {
        silentFlags = `${silentFlags} /DIR="${correctDir}"`;
      }
    }
  }

  let resolvedVerifyPath = verifyPath;
  if (version && isTD && !params.verify_path) {
    resolvedVerifyPath = `C:\\Program Files\\Derivative\\TouchDesigner.${version}`;
  }

  if (!installerUrl) {
    return {
      error: `No installer URL available for "${softwareName}". Provide an installer_url or ensure a matching system preset exists with the URL configured.`,
    };
  }
  if (!installerUrl.startsWith('https://')) {
    return { error: 'installer_url must use HTTPS for security' };
  }
  if (!installerName) {
    // Derive from URL as fallback
    installerName = installerUrl.split('/').pop() || 'installer.exe';
  }
  if (!silentFlags) {
    return {
      error: `No silent installation flags configured for "${softwareName}". Provide silent_flags or ensure the system preset has them configured.`,
    };
  }

  // Mirrors useDeployments.createDeployment.
  const deploymentId = `deploy-${Date.now()}`;
  const deploymentRef = db
    .collection('sites')
    .doc(siteId)
    .collection('deployments')
    .doc(deploymentId);

  const targets = machineIds.map((mid) => ({
    machineId: mid,
    status: 'pending',
  }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deploymentData: Record<string, any> = {
    name: version ? `${softwareName} ${version}` : softwareName,
    installer_name: installerName,
    installer_url: installerUrl,
    silent_flags: silentFlags,
    targets,
    createdAt: Date.now(),
    status: 'pending',
    source: 'cortex',
  };

  if (resolvedVerifyPath) {
    deploymentData.verify_path = resolvedVerifyPath;
  }
  if (closeProcesses.length > 0) {
    deploymentData.close_processes = closeProcesses;
  }
  if (parallelInstall) {
    deploymentData.parallel_install = true;
  }

  await deploymentRef.set(deploymentData);

  const commandPromises = machineIds.map(async (mid) => {
    const sanitizedDeploymentId = deploymentId.replace(/-/g, '_');
    const sanitizedMachineId = mid.replace(/-/g, '_');
    const commandId = `install_${sanitizedDeploymentId}_${sanitizedMachineId}_${Date.now()}`;

    const pendingRef = db
      .collection('sites')
      .doc(siteId)
      .collection('machines')
      .doc(mid)
      .collection('commands')
      .doc('pending');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const commandData: Record<string, any> = {
      type: 'install_software',
      installer_url: installerUrl,
      installer_name: installerName,
      silent_flags: silentFlags,
      deployment_id: deploymentId,
      timestamp: Date.now(),
      status: 'pending',
      timeout_seconds: timeoutSeconds,
    };

    if (resolvedVerifyPath) {
      commandData.verify_path = resolvedVerifyPath;
    }
    if (closeProcesses.length > 0) {
      commandData.close_processes = closeProcesses;
    }
    if (parallelInstall) {
      commandData.parallel_install = true;
    }

    await pendingRef.set({ [commandId]: commandData }, { merge: true });
  });

  await Promise.all(commandPromises);

  await deploymentRef.set({ status: 'in_progress' }, { merge: true });

  return {
    status: 'deployment_started',
    deployment_id: deploymentId,
    software_name: softwareName,
    version: version || null,
    installer_url: installerUrl,
    target_machines: machineIds.length,
    message: `Deployment started: ${version ? `${softwareName} ${version}` : softwareName} is being downloaded and installed on ${machineIds.length} machine${machineIds.length > 1 ? 's' : ''}. Track progress on the [Deployments page](/deployments).`,
  };
}

async function resolveProcessIdByName(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineId: string,
  params: Record<string, unknown>,
): Promise<{ ok: true; processId: string; processName: string } | { ok: false; result: ProcessToolResult }> {
  const processName = params.process_name;
  if (typeof processName !== 'string' || processName.trim().length === 0) {
    return {
      ok: false,
      result: {
        ok: false,
        error: 'missing_process_name',
        detail: 'process_name is required.',
        status: 400,
      },
    };
  }

  let configDoc: FirebaseFirestore.DocumentSnapshot;
  try {
    configDoc = await db
      .collection('config')
      .doc(siteId)
      .collection('machines')
      .doc(machineId)
      .get();
  } catch (error) {
    return {
      ok: false,
      result: {
        ok: false,
        error: 'config_lookup_failed',
        detail: error instanceof Error ? error.message : 'Failed to read process configuration.',
        status: 500,
      },
    };
  }

  if (!configDoc.exists) {
    return {
      ok: false,
      result: {
        ok: false,
        error: 'config_not_found',
        detail: `Configuration not found for machine ${machineId}.`,
        status: 404,
      },
    };
  }

  const processes = configDoc.data()?.processes;
  if (!Array.isArray(processes)) {
    return {
      ok: false,
      result: {
        ok: false,
        error: 'invalid_config',
        detail: `Configuration for machine ${machineId} does not contain a valid processes array.`,
        status: 500,
      },
    };
  }

  const process = processes.find((candidate: unknown) =>
    isRecord(candidate) && candidate.name === processName
  );
  if (!isRecord(process)) {
    return {
      ok: false,
      result: {
        ok: false,
        error: 'process_not_found',
        detail: `Process "${processName}" was not found on machine ${machineId}.`,
        status: 404,
      },
    };
  }

  const processId =
    typeof process.processId === 'string'
      ? process.processId
      : typeof process.id === 'string'
        ? process.id
        : '';
  if (!processId) {
    return {
      ok: false,
      result: {
        ok: false,
        error: 'process_id_missing',
        detail: `Process "${processName}" does not have a processId or legacy id.`,
        status: 500,
      },
    };
  }

  return { ok: true, processId, processName };
}

function patchFromProcessParams(params: Record<string, unknown>): Partial<PublicProcessConfig> {
  const patch: Record<string, unknown> = { ...params };
  delete patch.process_name;
  return patch as Partial<PublicProcessConfig>;
}

async function executeProcessToolForMachines(
  machineIds: string[],
  handler: (machineId: string) => Promise<ProcessToolResult>,
): Promise<unknown> {
  if (machineIds.length === 0) {
    return {
      ok: false,
      error: 'no_target_machines',
      detail: 'No target machines available.',
      status: 404,
    };
  }

  if (machineIds.length === 1) {
    return handler(machineIds[0]);
  }

  const machines = await Promise.all(
    machineIds.map(async (machineId) => ({
      machine: machineId,
      ...(await handler(machineId)),
    })),
  );
  return { machines };
}

async function executeUpdateProcessTool(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineIds: string[],
  params: Record<string, unknown>,
  options: BuildExecutableToolsOptions,
): Promise<unknown> {
  return executeProcessToolForMachines(machineIds, async (machineId) => {
    const lookup = await resolveProcessIdByName(db, siteId, machineId, params);
    if (!lookup.ok) return lookup.result;

    try {
      const result = await updateProcess(
        actionContextForHoot(siteId, options),
        {
          machineId,
          processId: lookup.processId,
          patch: patchFromProcessParams(params),
        },
      );
      return {
        ok: true,
        processId: result.processId,
        process_name: lookup.processName,
      };
    } catch (error) {
      return actionErrorResult(error);
    }
  });
}

async function executeAddProcessTool(
  siteId: string,
  machineIds: string[],
  params: Record<string, unknown>,
  options: BuildExecutableToolsOptions,
): Promise<unknown> {
  return executeProcessToolForMachines(machineIds, async (machineId) => {
    try {
      const result = await createProcess(
        actionContextForHoot(siteId, options),
        {
          machineId,
          ...params,
        } as Parameters<typeof createProcess>[1],
      );
      return {
        ok: true,
        processId: result.processId,
        name: params.name ?? null,
      };
    } catch (error) {
      return actionErrorResult(error);
    }
  });
}

async function executeDeleteProcessTool(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineIds: string[],
  params: Record<string, unknown>,
  options: BuildExecutableToolsOptions,
): Promise<unknown> {
  return executeProcessToolForMachines(machineIds, async (machineId) => {
    const lookup = await resolveProcessIdByName(db, siteId, machineId, params);
    if (!lookup.ok) return lookup.result;

    try {
      const result = await deleteProcess(
        actionContextForHoot(siteId, options),
        {
          machineId,
          processId: lookup.processId,
        },
      );
      return {
        ok: true,
        processId: result.processId,
        process_name: lookup.processName,
        alreadyDeleted: result.alreadyDeleted,
      };
    } catch (error) {
      return actionErrorResult(error);
    }
  });
}

/**
 * Talon store is loaded at call time: `@/lib/talons/store.server` imports
 * `resolveLlmConfig` from this module, so a static import would be circular.
 * Also keeps the store, schedule maths and billing gate out of every importer's
 * module graph.
 */
type TalonStoreModule = typeof import('@/lib/talons/store.server');

function loadTalonStore(): Promise<TalonStoreModule> {
  return import('@/lib/talons/store.server');
}

/**
 * Store context for a talon authored from a chat. The actor is the human driving
 * the conversation (never a system actor) so the store's command-output privilege
 * gate resolves against their own role.
 */
function talonStoreContextForHoot(
  siteId: string,
  options: BuildExecutableToolsOptions,
): TalonStoreContext {
  const { actor, auditActor } = actionContextForHoot(siteId, options);
  return {
    siteId,
    actor,
    auditActor,
    via: 'cortex',
    ...(options.chatId ? { chatId: options.chatId } : {}),
  };
}

function hasCommandOutput(params: Record<string, unknown>): boolean {
  return (
    Array.isArray(params.outputs) &&
    params.outputs.some((output) => isRecord(output) && output.type === 'command')
  );
}

/**
 * Render a store rejection as a tool result — a throw takes the whole turn down,
 * a result lets the model propose a corrected talon.
 */
function talonErrorResult(store: TalonStoreModule, error: unknown): ProcessToolResult {
  if (error instanceof store.TalonStoreError) {
    return {
      ok: false,
      error: error.code,
      detail: error.message,
      status: error.status,
      ...(error.fieldErrors ? { field_errors: error.fieldErrors } : {}),
    };
  }
  return {
    ok: false,
    error: 'internal_error',
    detail: error instanceof Error ? error.message : 'unknown error',
  };
}

async function executeCreateTalonTool(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  params: Record<string, unknown>,
  options: BuildExecutableToolsOptions,
): Promise<unknown> {
  const ctx = talonStoreContextForHoot(siteId, options);

  // A `command` output queues real process control, so authoring one takes the
  // same privilege as issuing it by hand. The store re-checks the same actor;
  // refusing here costs no reads.
  if (hasCommandOutput(params) && !hasCapability(ctx.actor, Capability.MACHINE_EXEC_COMMAND, siteId)) {
    return {
      ok: false,
      error: 'command_output_forbidden',
      detail:
        'only site admins can give a talon a command output — an email, webhook, or hoot directive output is available instead.',
      status: 403,
    };
  }

  const store = await loadTalonStore();
  try {
    // `params` passed as-is; the validator must keep rejecting unknown top-level
    // fields so a model can never stamp a server-owned field onto the document.
    const talon = await store.createTalon(db, ctx, params);
    return {
      ok: true,
      talon_id: talon.id,
      name: talon.name,
      enabled: talon.enabled,
      next_run_at: timestampToIso(talon.nextRunAt),
      message: `created talon "${talon.name}"${talon.enabled ? '' : ', left disabled'}.`,
    };
  } catch (error) {
    return talonErrorResult(store, error);
  }
}

async function executeListTalonsTool(
  db: FirebaseFirestore.Firestore,
  siteId: string,
): Promise<unknown> {
  const store = await loadTalonStore();
  try {
    const talons = await store.listTalons(db, siteId);
    return {
      ok: true,
      count: talons.length,
      talons: talons.map((talon) => ({
        talon_id: talon.id,
        name: talon.name,
        enabled: talon.enabled,
        // Normalized object, not a prose summary — the model needs the exact
        // metric/interval/event values for follow-ups.
        trigger: talon.trigger,
        outputs: talon.outputs.map((output) => output.type),
        last_run_status: talon.lastRunStatus ?? null,
        last_run_at: timestampToIso(talon.lastRunAt),
        next_run_at: timestampToIso(talon.nextRunAt),
      })),
    };
  } catch (error) {
    return talonErrorResult(store, error);
  }
}

async function executeSetTalonEnabledTool(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  params: Record<string, unknown>,
  options: BuildExecutableToolsOptions,
): Promise<unknown> {
  const talonId = typeof params.talon_id === 'string' ? params.talon_id.trim() : '';
  if (!talonId) {
    return {
      ok: false,
      error: 'missing_talon_id',
      detail: 'talon_id is required — call list_talons to look it up.',
      status: 400,
    };
  }
  if (typeof params.enabled !== 'boolean') {
    return {
      ok: false,
      error: 'invalid_enabled',
      detail: 'enabled must be true or false.',
      status: 400,
    };
  }

  const store = await loadTalonStore();
  try {
    const talon = await store.setTalonEnabled(
      db,
      talonStoreContextForHoot(siteId, options),
      talonId,
      params.enabled,
    );
    return {
      ok: true,
      talon_id: talon.id,
      name: talon.name,
      enabled: talon.enabled,
      next_run_at: timestampToIso(talon.nextRunAt),
      message: `${talon.enabled ? 'enabled' : 'disabled'} talon "${talon.name}".`,
    };
  } catch (error) {
    return talonErrorResult(store, error);
  }
}

/**
 * Refusal for a caller with no chat identity. Unattended hoot (autonomous
 * dispatch, talon directives) runs as a system actor: there is no chat to
 * re-open and no user whose access could be re-resolved at fire time, so a
 * follow-up scheduled there could never legitimately run.
 */
function followupUnavailableResult(): ProcessToolResult {
  return {
    ok: false,
    error: 'followup_unavailable',
    detail: 'follow-ups are only available inside a user chat.',
    status: 400,
  };
}

type FollowupRunAtResult = { ok: true; runAt: Date } | { ok: false; result: ProcessToolResult };

function followupInputError(code: string, detail: string): FollowupRunAtResult {
  return { ok: false, result: { ok: false, error: code, detail, status: 400 } };
}

/**
 * `delay_minutes` or `at` → the absolute fire time. Exactly one of the two:
 * accepting both would mean silently picking a winner, and accepting neither
 * would mean inventing a schedule the model did not ask for.
 */
function resolveFollowupRunAt(params: Record<string, unknown>, now: number): FollowupRunAtResult {
  const delay = params.delay_minutes;
  const hasDelay = delay !== undefined && delay !== null;
  const at = typeof params.at === 'string' ? params.at.trim() : params.at;
  const hasAt = at !== undefined && at !== null && at !== '';

  if (hasDelay && hasAt) {
    return followupInputError(
      'invalid_schedule',
      'pass exactly one of delay_minutes or at — both were given.',
    );
  }
  if (!hasDelay && !hasAt) {
    return followupInputError(
      'invalid_schedule',
      'pass exactly one of delay_minutes or at — neither was given.',
    );
  }

  if (hasDelay) {
    if (typeof delay !== 'number' || !Number.isFinite(delay)) {
      return followupInputError('invalid_delay_minutes', 'delay_minutes must be a number of minutes.');
    }
    if (delay < MIN_FOLLOWUP_DELAY_MINUTES || delay > MAX_FOLLOWUP_DELAY_MINUTES) {
      return followupInputError(
        'invalid_delay_minutes',
        `delay_minutes must be between ${MIN_FOLLOWUP_DELAY_MINUTES} and ${MAX_FOLLOWUP_DELAY_MINUTES} (seven days).`,
      );
    }
    return { ok: true, runAt: new Date(now + delay * 60_000) };
  }

  if (typeof at !== 'string') {
    return followupInputError('invalid_at', 'at must be an ISO 8601 timestamp string, e.g. 2026-01-31T14:00:00Z.');
  }
  const parsed = Date.parse(at);
  if (Number.isNaN(parsed)) {
    return followupInputError('invalid_at', `"${at}" is not a timestamp — use ISO 8601, e.g. 2026-01-31T14:00:00Z.`);
  }
  if (parsed <= now) {
    return followupInputError(
      'at_in_the_past',
      'at is in the past — pass a future timestamp, or use delay_minutes for a relative time.',
    );
  }
  if (parsed > now + MAX_FOLLOWUP_DELAY_MINUTES * 60_000) {
    return followupInputError('at_too_far_out', 'at must be within seven days from now.');
  }
  return { ok: true, runAt: new Date(parsed) };
}

/**
 * The target a follow-up is filed against: this turn's own, when the caller
 * threaded one, else the legacy single-`machineId` view (`__site__`, or one id).
 * An empty explicit set is a caller bug with no safe encoding, so it reads as
 * "no target" — the tool refuses — rather than widening to the whole site.
 */
function followupTargetFor(options: BuildExecutableToolsOptions): HootTarget | null {
  const target = options.followupTarget;
  if (target) {
    if (target.machineIds === null) return { machineIds: null };
    return target.machineIds.length > 0 ? { machineIds: [...target.machineIds] } : null;
  }

  const machineId = options.chatMachineId?.trim();
  if (!machineId) return null;
  return machineId === SITE_TARGET_ID ? { machineIds: null } : { machineIds: [machineId] };
}

async function executeScheduleFollowupTool(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  params: Record<string, unknown>,
  options: BuildExecutableToolsOptions,
): Promise<unknown> {
  const chatId = options.chatId?.trim();
  const userId = options.userId?.trim();
  const target = followupTargetFor(options);
  if (!chatId || !userId || !target) return followupUnavailableResult();

  const note = typeof params.note === 'string' ? params.note.trim() : '';
  if (!note) {
    return {
      ok: false,
      error: 'missing_note',
      detail: 'note is required — say what the follow-up turn should do.',
      status: 400,
    };
  }
  if (note.length > MAX_FOLLOWUP_NOTE_LENGTH) {
    return {
      ok: false,
      error: 'note_too_long',
      detail: `note must be ${MAX_FOLLOWUP_NOTE_LENGTH} characters or fewer.`,
      status: 400,
    };
  }

  const schedule = resolveFollowupRunAt(params, Date.now());
  if (!schedule.ok) return schedule.result;

  const watchCommandId =
    typeof params.watch_command_id === 'string' ? params.watch_command_id.trim() : '';

  try {
    const scheduled = await scheduleFollowup(db, {
      chatId,
      siteId,
      target,
      userId,
      note,
      runAt: schedule.runAt,
      ...(watchCommandId ? { watchCommandId } : {}),
      // The ceiling travels with the promise: without it the fired turn would
      // earn the OWNER's tier, so a chat-scoped API key held to tier 1 could
      // schedule itself tier-2 reach with no approval gate.
      ...(options.maxToolTier ? { maxToolTier: options.maxToolTier } : {}),
    });
    const firesAt = scheduled.runAt.toISOString();
    return {
      ok: true,
      followup_id: scheduled.id,
      fires_at: firesAt,
      ...(watchCommandId ? { watch_command_id: watchCommandId } : {}),
      message: `scheduled a follow-up for ${firesAt}.`,
    };
  } catch (error) {
    return {
      ok: false,
      error: 'internal_error',
      detail: error instanceof Error ? error.message : 'unknown error',
    };
  }
}

/** Every non-success {@link cancelFollowup} outcome, as something the model can read. */
const CANCEL_FOLLOWUP_FAILURES: Record<
  Exclude<CancelFollowupOutcome, 'cancelled'>,
  { error: string; detail: string; status: number }
> = {
  not_found: {
    error: 'followup_not_found',
    detail: 'no follow-up has that id — use the followup_id schedule_followup returned.',
    status: 404,
  },
  forbidden: {
    error: 'followup_forbidden',
    detail: 'that follow-up belongs to another user.',
    status: 403,
  },
  not_scheduled: {
    error: 'followup_not_scheduled',
    detail: 'that follow-up already fired or was cancelled — there is nothing left to cancel.',
    status: 409,
  },
};

async function executeCancelFollowupTool(
  db: FirebaseFirestore.Firestore,
  params: Record<string, unknown>,
  options: BuildExecutableToolsOptions,
): Promise<unknown> {
  // Ownership is the only thing that gates a cancel, and the store enforces it
  // against this userId — an unattended caller has none.
  const userId = options.userId?.trim();
  if (!userId) return followupUnavailableResult();

  const followupId = typeof params.followup_id === 'string' ? params.followup_id.trim() : '';
  if (!followupId) {
    return {
      ok: false,
      error: 'missing_followup_id',
      detail: 'followup_id is required — schedule_followup returns it.',
      status: 400,
    };
  }

  try {
    const outcome = await cancelFollowup(db, followupId, { userId });
    if (outcome === 'cancelled') {
      return {
        ok: true,
        followup_id: followupId,
        message: `cancelled follow-up ${followupId}.`,
      };
    }
    return { ok: false, followup_id: followupId, ...CANCEL_FOLLOWUP_FAILURES[outcome] };
  } catch (error) {
    return {
      ok: false,
      error: 'internal_error',
      detail: error instanceof Error ? error.message : 'unknown error',
    };
  }
}

/** Execute a server-side tool (never relayed to an agent). */
export async function executeServerSideTool(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineIds: string[],
  toolName: string,
  params: Record<string, unknown>,
  options: BuildExecutableToolsOptions,
): Promise<unknown> {
  switch (toolName) {
    case 'get_site_logs':
      return executeSiteLogs(db, siteId, params);
    case 'get_system_presets':
      return executeGetSystemPresets(db, params);
    case 'deploy_software':
      return executeDeploySoftware(db, siteId, machineIds, params);
    case 'update_process':
      return executeUpdateProcessTool(db, siteId, machineIds, params, options);
    case 'add_process':
      return executeAddProcessTool(siteId, machineIds, params, options);
    case 'delete_process':
      return executeDeleteProcessTool(db, siteId, machineIds, params, options);
    case 'create_talon':
      return executeCreateTalonTool(db, siteId, params, options);
    case 'list_talons':
      return executeListTalonsTool(db, siteId);
    case 'set_talon_enabled':
      return executeSetTalonEnabledTool(db, siteId, params, options);
    case 'schedule_followup':
      return executeScheduleFollowupTool(db, siteId, params, options);
    case 'cancel_followup':
      return executeCancelFollowupTool(db, params, options);
    default:
      return { error: `Unknown server-side tool: ${toolName}` };
  }
}

/**
 * Build AI SDK tools whose execute relays to agents. Site mode fans each call
 * out to all online machines and aggregates the results.
 */
export function buildExecutableTools(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineId: string,
  chatId: string,
  toolDefs: McpToolDefinition[],
  siteMode: boolean = false,
  onlineMachines: string[] = [],
  options: BuildExecutableToolsOptions = {},
) {
  // Server-side tools only see `options`, so fold the positional chatId in. An
  // explicit `options.chatId` wins, attributing the loop to a different chat.
  // `chatMachineId` is the one-machine-or-whole-site view of the target — the
  // sentinel in site mode, where the positional machineId may be blank. A caller
  // that knows the real set passes `followupTarget`, which wins over it.
  const serverSideOptions: BuildExecutableToolsOptions = {
    ...options,
    chatId: options.chatId ?? chatId,
    chatMachineId: options.chatMachineId ?? (siteMode ? SITE_TARGET_ID : machineId),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {};

  for (const def of toolDefs) {
    const toolName = def.name;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolConfig: any = {
      description: def.description,
      inputSchema: jsonSchema(def.parameters as Record<string, unknown>),
      // Tier-3 pauses for in-chat approval: the AI SDK emits
      // `tool-approval-request` instead of calling `execute`. Chat-only —
      // autonomous Hoot uses buildAutonomousTools (no human to approve).
      needsApproval: def.tier >= 3 && options.requireTier3Approval !== false,
      execute: async (params: unknown, execOptions?: { toolCallId?: string }) => {
        // Bridge per-turn toolCallbacks into per-dispatch hooks: the SDK passes
        // { toolCallId } as execute's 2nd arg; pair it with commandId + machineId.
        const toolCallbacks = options.toolCallbacks;
        const hooksFor = (targetMachineId: string): AgentCommandHooks | undefined =>
          toolCallbacks
            ? {
                onCommandQueued: (commandId) =>
                  toolCallbacks.onCommandQueued?.(execOptions?.toolCallId ?? '', commandId, targetMachineId),
                onPollTick: toolCallbacks.onPollTick,
                abortSignal: toolCallbacks.abortSignal,
              }
            : undefined;

        // Run on the web server: no agent relay, so toolCallbacks never fire.
        if (SERVER_SIDE_TOOLS.has(toolName)) {
          const targetMachineIds = siteMode ? onlineMachines : [machineId];
          return executeServerSideTool(
            db,
            siteId,
            targetMachineIds,
            toolName,
            params as Record<string, unknown>,
            serverSideOptions,
          );
        }

        if (siteMode) {
          const results = await Promise.all(
            onlineMachines.map(async (mid) => {
              try {
                const existingCmd = EXISTING_COMMAND_MAPPINGS[toolName];
                if (existingCmd) {
                  const toolParams = params as Record<string, unknown>;
                  const processName = toolParams.process_name as string;
                  const result = await executeExistingCommand(db, siteId, mid, existingCmd, processName, toolParams, hooksFor(mid));
                  return { machine: mid, ...result as Record<string, unknown> };
                }
                const result = await executeToolOnAgent(db, siteId, mid, toolName, params as Record<string, unknown>, chatId, hooksFor(mid));
                return { machine: mid, ...(typeof result === 'object' && result !== null ? result as Record<string, unknown> : { result }) };
              } catch (err) {
                return { machine: mid, error: err instanceof Error ? err.message : 'Unknown error' };
              }
            })
          );
          return { machines: results };
        }

        const existingCmd = EXISTING_COMMAND_MAPPINGS[toolName];
        if (existingCmd) {
          const toolParams = params as Record<string, unknown>;
          const processName = toolParams.process_name as string;
          return executeExistingCommand(db, siteId, machineId, existingCmd, processName, toolParams, hooksFor(machineId));
        }

        return executeToolOnAgent(db, siteId, machineId, toolName, params as Record<string, unknown>, chatId, hooksFor(machineId));
      },
    };

    // capture_screenshot: inject the image as a vision block, not a URL string.
    if (toolName === 'capture_screenshot') {
      type ScreenshotBlock = { type: 'text'; text: string } | { type: 'image-url'; url: string };
      toolConfig.toModelOutput = ({ output }: { output: unknown }) => {
        const result = output as Record<string, unknown> | null;

        // Site-wide results are { machines: [...] } — one image block each; a
        // top-level `url` only exists in single-machine mode.
        const machines = Array.isArray(result?.machines)
          ? (result!.machines as Array<Record<string, unknown>>)
          : null;
        if (machines) {
          const blocks: ScreenshotBlock[] = [];
          for (const m of machines) {
            const mid = (m.machine as string) || 'machine';
            const murl = m.url as string | undefined;
            if (murl) {
              blocks.push({ type: 'text' as const, text: `${mid}:` });
              blocks.push({ type: 'image-url' as const, url: murl });
            } else {
              const note = (m.message as string) || (m.error as string) || 'no screenshot';
              blocks.push({ type: 'text' as const, text: `${mid}: ${note}` });
            }
          }
          if (blocks.length > 0) {
            return { type: 'content' as const, value: blocks };
          }
        }

        const url = result?.url as string | undefined;
        const message = (result?.message as string) || (result?.error as string) || 'Screenshot captured';

        if (url) {
          return {
            type: 'content' as const,
            value: [
              { type: 'text' as const, text: message },
              { type: 'image-url' as const, url },
            ],
          };
        }
        return { type: 'text' as const, value: message };
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools[toolName] = tool<any, any, any>(toolConfig);
  }

  return tools;
}
