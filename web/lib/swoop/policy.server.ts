/**
 * Who may swoop into a machine, and for how long.
 *
 * Three layers, and they are deliberately separate:
 *   - the capability matrix (`lib/capabilities.ts`) says which ROLE may watch
 *     or control at all;
 *   - the site's `sites/{siteId}/settings/swoop` document says whether the
 *     feature is on here, which machines are excluded, and whether plain
 *     members may watch — `membersMayWatch` is enforced HERE and never in the
 *     matrix, so the matrix stays a statement about roles;
 *   - the step-up window says whether a live second-factor ceremony has
 *     happened recently enough to control.
 *
 * The step-up window CANNOT be opened from a timestamp. `session.mfaCompletedAt`
 * is set to `now` when a session is born from a 30-day device-trust cookie with
 * no ceremony performed (`lib/sessionManager.server.ts:219-221`), so any
 * freshness check against it passes for a stolen cookie. `openStepUpWindow`
 * therefore takes the OUTCOME of `verifyMfaProof` / `verifyPasskeyStepUpAssertion`
 * and validates it at runtime as well as in the types.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { Capability, hasCapability, type Actor, type SiteRole } from '@/lib/capabilities';
import { deriveMfaEnrolled, readMfaFactors } from '@/lib/mfaFactors.server';
import type { MfaProofOutcome } from '@/lib/mfaProof.server';
import { createHash } from 'crypto';

/** `sites/{siteId}/settings/swoop`. */
export const SWOOP_SETTINGS_DOC = 'swoop';

/** A live session's lease. The browser renews it silently (PROTOCOL.md §10). */
export const SWOOP_LEASE_SECONDS = 300;

/** Absolute cap from `ready`, a hard stop rather than a renewal ceiling. */
export const SWOOP_SESSION_CAP_SECONDS = 12 * 60 * 60;

/** How long one live ceremony authorises control for. */
export const SWOOP_STEP_UP_WINDOW_MS = 10 * 60 * 1000;

const STEP_UP_COLLECTION = 'swoop_step_up';

export type SwoopIndicator = 'banner' | 'tray' | 'none';

export interface SwoopSiteSettings {
  enabled: boolean;
  excludedMachineIds: string[];
  membersMayWatch: boolean;
  indicator: SwoopIndicator;
}

/**
 * Off until a site turns it on (owner ruling), but members may watch once it
 * IS on — the site opted in as a whole, and a second off-by-default switch
 * inside it only trains operators to flip both.
 */
export const SWOOP_SETTINGS_DEFAULTS: Readonly<SwoopSiteSettings> = Object.freeze({
  enabled: false,
  excludedMachineIds: [],
  membersMayWatch: true,
  indicator: 'banner' as SwoopIndicator,
});

export type SwoopIntent = 'view' | 'control';

export type SwoopDenyCode =
  | 'api_key_not_permitted'
  | 'swoop_disabled'
  | 'machine_excluded'
  | 'capability_missing'
  | 'members_may_not_watch'
  | 'step_up_required'
  | 'session_cap_reached';

export type SwoopDecision =
  | { ok: true; ctl: boolean }
  | { ok: false; status: number; code: SwoopDenyCode; error: string };

/** Policy refusal raised from the async paths. */
export class SwoopPolicyError extends Error {
  constructor(public readonly code: string) {
    super(`swoop policy: ${code}`);
    this.name = 'SwoopPolicyError';
  }
}

// ------------------------------------------------------------ site enablement

export function parseSwoopSettings(data: unknown): SwoopSiteSettings {
  const d = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  const excluded = Array.isArray(d.excludedMachineIds)
    ? d.excludedMachineIds.filter((v): v is string => typeof v === 'string')
    : SWOOP_SETTINGS_DEFAULTS.excludedMachineIds;
  const indicator =
    d.indicator === 'banner' || d.indicator === 'tray' || d.indicator === 'none'
      ? d.indicator
      : SWOOP_SETTINGS_DEFAULTS.indicator;
  return {
    // Only the literal booleans move these off their defaults — a string
    // "false" left by a hand-edited document must not read as a grant.
    enabled: d.enabled === true,
    excludedMachineIds: excluded,
    membersMayWatch: d.membersMayWatch === false ? false : SWOOP_SETTINGS_DEFAULTS.membersMayWatch,
    indicator,
  };
}

export async function loadSwoopSettings(siteId: string): Promise<SwoopSiteSettings> {
  const snap = await getAdminDb()
    .collection('sites')
    .doc(siteId)
    .collection('settings')
    .doc(SWOOP_SETTINGS_DOC)
    .get();
  return parseSwoopSettings(snap.exists ? snap.data() : null);
}

// ------------------------------------------------------------------- decision

function deny(status: number, code: SwoopDenyCode, error: string): SwoopDecision {
  return { ok: false, status, code, error };
}

function siteRoleOf(actor: Actor, siteId: string): SiteRole | null {
  if (actor.type !== 'user') return null;
  return actor.siteRoles[siteId] ?? null;
}

export interface SwoopAccessInput {
  actor: Actor;
  siteId: string;
  machineId: string;
  intent: SwoopIntent;
  /** `ctx.auth.keyContext !== null` — an api-key caller. */
  viaApiKey: boolean;
  settings: SwoopSiteSettings;
  /** Result of `hasOpenStepUpWindow`. Only consulted for control. */
  stepUpOpen?: boolean;
}

/**
 * The ordered refusal list. Order matters for the message the caller sees: an
 * api-key holder is told the mechanism does not apply to them rather than
 * being sent to enable a setting.
 */
export function evaluateSwoopAccess(input: SwoopAccessInput): SwoopDecision {
  // Step-up is structurally inapplicable to a key, and SCOPE_PRESETS already
  // hands out wildcard machine writes for a year — a scope gate would admit
  // thousands of existing keys.
  if (input.viaApiKey) {
    return deny(403, 'api_key_not_permitted', 'swoop sessions cannot be started with an api key.');
  }

  if (!input.settings.enabled) {
    return deny(403, 'swoop_disabled', 'swoop is not enabled for this site.');
  }

  if (input.settings.excludedMachineIds.includes(input.machineId)) {
    return deny(403, 'machine_excluded', 'swoop is excluded on this machine.');
  }

  const capability =
    input.intent === 'control' ? Capability.MACHINE_REMOTE_CONTROL : Capability.MACHINE_REMOTE_VIEW;
  if (!hasCapability(input.actor, capability, input.siteId)) {
    return deny(403, 'capability_missing', 'you do not have permission to do this.');
  }

  // The site-level gate the capability matrix deliberately does not carry.
  if (siteRoleOf(input.actor, input.siteId) === 'member' && !input.settings.membersMayWatch) {
    return deny(403, 'members_may_not_watch', 'this site does not allow members to watch.');
  }

  if (input.intent === 'control' && input.stepUpOpen !== true) {
    return deny(401, 'step_up_required', 'confirm your identity to take control.');
  }

  return { ok: true, ctl: input.intent === 'control' };
}

/**
 * A lease renewal is the same decision plus the absolute cap — the point of
 * the lease is that a removed member, a disabled site, an excluded machine or
 * a revoked capability takes effect within one lease rather than at the next
 * reconnect. Step-up is NOT re-run: the window covers it, and a 5-minute
 * ceremony prompt is how operators end up disabling the feature.
 */
export function evaluateLeaseRenewal(
  input: SwoopAccessInput & { startedAt: number; nowMs?: number },
): SwoopDecision {
  const now = input.nowMs ?? Date.now();
  if (now >= input.startedAt + SWOOP_SESSION_CAP_SECONDS * 1000) {
    return deny(403, 'session_cap_reached', 'this session reached its 12 hour limit.');
  }
  return evaluateSwoopAccess({ ...input, stepUpOpen: true });
}

// -------------------------------------------------------------- step-up window

/**
 * Binds a window to ONE login session. `expiresAt` is fixed when the session is
 * created, so a fresh login — including one born from a device-trust cookie —
 * produces a different binding and inherits no window. Hashed so the stored
 * document id carries nothing about the session.
 */
export function stepUpSessionBinding(session: { userId: string; expiresAt: number }): string {
  return createHash('sha256')
    .update(`${session.userId}:${session.expiresAt}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

function stepUpRef(userId: string, binding: string) {
  return getAdminDb()
    .collection('users')
    .doc(userId)
    .collection(STEP_UP_COLLECTION)
    .doc(binding);
}

const STEP_UP_FACTORS: ReadonlySet<string> = new Set(['totp', 'backup_code', 'passkey']);

/**
 * Open the window. `proof` must be the return value of a live
 * `verifyMfaProof` / `verifyPasskeyStepUpAssertion` call: anything else — a
 * timestamp, a truthy object, a failed outcome — is refused here rather than
 * only by the type checker, because the type checker is not what an attacker
 * goes through.
 */
export async function openStepUpWindow(args: {
  userId: string;
  binding: string;
  proof: MfaProofOutcome;
  nowMs?: number;
}): Promise<number> {
  const proof = args.proof as { ok?: unknown; factorUsed?: unknown } | null | undefined;
  if (!proof || proof.ok !== true || typeof proof.factorUsed !== 'string') {
    throw new SwoopPolicyError('step_up_proof_invalid');
  }
  if (!STEP_UP_FACTORS.has(proof.factorUsed)) {
    throw new SwoopPolicyError('step_up_proof_invalid');
  }

  // An account with no second factor cannot have produced a live proof, so this
  // can only mean the ceremony was bypassed. Refuse rather than wave through.
  const factors = await readMfaFactors(args.userId);
  if (!deriveMfaEnrolled(factors)) {
    throw new SwoopPolicyError('no_mfa_factors');
  }

  const now = args.nowMs ?? Date.now();
  const expiresAt = now + SWOOP_STEP_UP_WINDOW_MS;
  await stepUpRef(args.userId, args.binding).set({
    openedAt: now,
    expiresAt,
    factorUsed: proof.factorUsed,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return expiresAt;
}

export async function hasOpenStepUpWindow(args: {
  userId: string;
  binding: string;
  nowMs?: number;
}): Promise<boolean> {
  const snap = await stepUpRef(args.userId, args.binding).get();
  if (!snap.exists) return false;
  const expiresAt = snap.data()?.expiresAt;
  if (typeof expiresAt !== 'number') return false;
  return expiresAt > (args.nowMs ?? Date.now());
}

/** Zero-factor accounts cannot control. Read before offering the ceremony. */
export async function hasEnrolledFactor(userId: string): Promise<boolean> {
  return deriveMfaEnrolled(await readMfaFactors(userId));
}
