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
 * no ceremony performed (`lib/sessionManager.server.ts`, the `deviceTrusted`
 * arm of `resolveMfaOnSessionCreate`), so any freshness check against it passes
 * for a stolen cookie. `openStepUpWindow` therefore takes the OUTCOME of
 * `verifyMfaProof` / `verifyPasskeyStepUpAssertion` and validates it at runtime
 * as well as in the types.
 *
 * The window is stored against the (user, machine) pair, NOT against one login
 * session. A page reload ends a swoop session and starts a new one, and a
 * session-bound window could never be inherited by the next one — so every
 * reload demanded a fresh ceremony.
 *
 * Reuse is not free, though, and this is the half that keeps the same
 * device-trust cookie out: a window may only be read back by a login session
 * that ITSELF passed a live ceremony (`sessionPassedMfaCeremony`). A
 * device-trust-born session is refused the window however live it is, and is
 * sent through the ceremony — which then stamps that session, so ITS reloads
 * cost nothing. The claim the window makes is therefore unchanged: "this user
 * proved possession of a second factor within the last 12 hours, for this
 * machine, and the session asking also proved one". It is never "proved once,
 * trusted forever" — the 12 hours run from the ceremony, reuse does not
 * extend them, and the window is a NECESSARY condition that
 * `evaluateSwoopAccess` consults only after site enablement, the machine
 * exclusion list and the capability have all already passed.
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

/**
 * How long one live ceremony authorises control for, measured from the
 * ceremony. A working day: 10 minutes made every fresh tab a passkey prompt
 * (owner, 2026-09-25), and the same-tab case is covered separately by
 * continuity (`continuity.server.ts`). Matches the session cap.
 */
export const SWOOP_STEP_UP_WINDOW_MS = 12 * 60 * 60 * 1000;

const STEP_UP_COLLECTION = 'swoop_step_up';
const STEP_UP_REVOCATION_COLLECTION = 'swoop_step_up_revocations';
const STEP_UP_REVOCATION_DOC = 'current';

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

/** The (user, machine) pair one window covers. */
export interface StepUpTarget {
  userId: string;
  siteId: string;
  machineId: string;
}

/**
 * Binds a window to ONE (user, machine) pair. Every part is a Firestore
 * document id and so cannot contain `/`, which makes the join injective: no two
 * different triples share a binding, so a window can be read back for the
 * machine it was opened for and for no other. Hashed so the stored document id
 * carries nothing about which machine it names.
 */
export function stepUpMachineBinding(target: StepUpTarget): string {
  return createHash('sha256')
    .update(`${target.userId}/${target.siteId}/${target.machineId}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

/**
 * `users/{uid}/swoop_step_up/{binding}` and
 * `sites/{siteId}/machines/{machineId}/swoop_step_up_revocations/current`.
 *
 * Neither has a `firestore.rules` match, so the catch-all denies every client:
 * the window is server-side state that no browser can read, forge or extend.
 */
function stepUpRef(userId: string, binding: string) {
  return getAdminDb()
    .collection('users')
    .doc(userId)
    .collection(STEP_UP_COLLECTION)
    .doc(binding);
}

function stepUpRevocationRef(siteId: string, machineId: string) {
  return getAdminDb()
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection(STEP_UP_REVOCATION_COLLECTION)
    .doc(STEP_UP_REVOCATION_DOC);
}

const STEP_UP_FACTORS: ReadonlySet<string> = new Set(['totp', 'backup_code', 'passkey']);

/**
 * Open the window. `proof` must be the return value of a live
 * `verifyMfaProof` / `verifyPasskeyStepUpAssertion` call: anything else — a
 * timestamp, a truthy object, a failed outcome — is refused here rather than
 * only by the type checker, because the type checker is not what an attacker
 * goes through.
 */
export async function openStepUpWindow(args: StepUpTarget & {
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
  // A plain `set`, so a second ceremony replaces the window rather than
  // extending one: `openedAt` always names the ceremony the window rests on.
  await stepUpRef(args.userId, stepUpMachineBinding(args)).set({
    openedAt: now,
    expiresAt,
    factorUsed: proof.factorUsed,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return expiresAt;
}

/**
 * Close every open window on this machine, for every user, from `nowMs` back.
 *
 * The kill switch is the "stop now" lever, and it would mean very little if the
 * operator it just cut off could reconnect into control a second later on a
 * window they opened before it. A ceremony run AFTER this still opens a window,
 * because it is `openedAt` that is compared.
 */
export async function revokeStepUpWindows(args: {
  siteId: string;
  machineId: string;
  nowMs?: number;
}): Promise<void> {
  await stepUpRevocationRef(args.siteId, args.machineId).set({
    revokedAt: args.nowMs ?? Date.now(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

async function stepUpRevokedAt(siteId: string, machineId: string): Promise<number> {
  const snap = await stepUpRevocationRef(siteId, machineId).get();
  const revokedAt = snap.exists ? snap.data()?.revokedAt : undefined;
  return typeof revokedAt === 'number' ? revokedAt : 0;
}

/**
 * May this request take control on a window already open for this user on this
 * machine?
 *
 * `sessionPassedCeremony` is `sessionPassedMfaCeremony()` for the login session
 * behind the request, and it is a required argument so that no call site can
 * reach the window without answering the question. It is not something the
 * browser asserts: the value comes off the server's own encrypted, signed
 * session cookie, and the client has no field it can set to change it.
 *
 * Four things can close a window, and all four are read here rather than
 * trusted to have deleted the document: the asking session not having run a
 * ceremony, the 12 hours lapsing, a kill on the machine, and the account
 * losing its last second factor. A missing or malformed field reads as closed.
 */
export async function hasOpenStepUpWindow(
  args: StepUpTarget & { sessionPassedCeremony: boolean; nowMs?: number },
): Promise<boolean> {
  // First, and before any read: a session born from the 30-day device-trust
  // cookie ran no ceremony, so it inherits nothing — plan.md D10. It costs that
  // session no Firestore round trip either.
  if (!args.sessionPassedCeremony) return false;

  const [snap, revokedAt, enrolled] = await Promise.all([
    stepUpRef(args.userId, stepUpMachineBinding(args)).get(),
    stepUpRevokedAt(args.siteId, args.machineId),
    hasEnrolledFactor(args.userId),
  ]);
  // A window opened before the last factor was removed must not outlive it —
  // an account with zero factors cannot control, window or not.
  if (!enrolled || !snap.exists) return false;

  const data = snap.data() ?? {};
  const openedAt = data.openedAt;
  const expiresAt = data.expiresAt;
  if (typeof openedAt !== 'number' || typeof expiresAt !== 'number') return false;
  if (openedAt <= revokedAt) return false;

  // The window's length is the READER's constant: whatever is stored can only
  // shorten it, never stretch it past 12 hours from the ceremony.
  return Math.min(expiresAt, openedAt + SWOOP_STEP_UP_WINDOW_MS) > (args.nowMs ?? Date.now());
}

/**
 * Zero-factor accounts cannot control. Read before offering the ceremony, and
 * again on every window check, so losing the last factor closes the window.
 */
export async function hasEnrolledFactor(userId: string): Promise<boolean> {
  return deriveMfaEnrolled(await readMfaFactors(userId));
}
