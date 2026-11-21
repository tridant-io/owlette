/**
 * MFA factor inventory — the SINGLE WRITER of `mfaEnrolled` and
 * `requiresMfaSetup`.
 *
 * `mfaEnrolled` means "has at least one second factor" — passkeys count. The
 * session gate reads that one boolean on a hot path (AuthContext re-POSTs
 * `/api/auth/session` every page load), so writers keep a denormalized tally
 * instead of querying `users/{uid}/passkeys` at session time:
 *
 *   users/{uid}.mfaFactors  = { totp: boolean, passkeys: number }
 *   users/{uid}.mfaEnrolled = mfaFactors.totp || mfaFactors.passkeys > 0
 *
 * Rules:
 * - Only `applyMfaFactorChange` may write these fields; a second writer
 *   re-opens the drift this denormalization contains.
 * - It owns `requiresMfaSetup` in BOTH directions. Re-arming on zero factors
 *   puts an account back into mandatory setup; clearing it is equally
 *   mandatory, or a passkey-only signup is bounced to `/setup-2fa` forever.
 * - With `ctx.tx`, call this BEFORE any write on that transaction — Firestore
 *   forbids reads after writes, and this reads the user doc first.
 * - Emits no audit event: callers own `emitMutation` so the verb names the
 *   user-visible action, not the bookkeeping.
 */

import { getAdminDb } from '@/lib/firebase-admin';

/** Denormalized tally of the second factors an account holds. */
export interface MfaFactorInventory {
  totp: boolean;
  passkeys: number;
}

/** The inventory of an account with no second factor at all. */
export const EMPTY_MFA_FACTORS: Readonly<MfaFactorInventory> = Object.freeze({
  totp: false,
  passkeys: 0,
});

/** Context shared by both entry points. Every field is optional. */
export interface MfaFactorContext {
  /** Inject a Firestore instance — tests pass a mock; production omits. */
  db?: FirebaseFirestore.Firestore;
  /** Fold the recompute into the caller's transaction instead of opening one. */
  tx?: FirebaseFirestore.Transaction;
  /** Extra user-doc fields merged into the SAME write as the inventory. */
  extraUpdate?: Record<string, unknown>;
}

/**
 * A factor delta. Omitted legs keep their current value.
 *
 * `passkeys` and `recountPasskeys` are mutually exclusive — passing both is
 * ambiguous, and silently picking one would corrupt the inventory.
 */
export interface MfaFactorChange {
  totp?: boolean;
  /** Explicit count — opt out of recounting when the caller already knows it. */
  passkeys?: number;
  /** Recount from the `passkeys` subcollection inside the transaction. */
  recountPasskeys?: boolean;
}

export interface MfaFactorResult {
  factors: MfaFactorInventory;
  mfaEnrolled: boolean;
  requiresMfaSetup: boolean;
}

/** Subcollection holding one document per registered WebAuthn credential. */
const PASSKEYS_SUBCOLLECTION = 'passkeys';

/** The derived gate: any factor at all satisfies MFA. */
export function deriveMfaEnrolled(inv: MfaFactorInventory): boolean {
  return inv.totp || inv.passkeys > 0;
}

/** A stored passkey count is only trustworthy as a non-negative integer. */
function isValidPasskeyCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Clamp any recounted or caller-supplied total to a non-negative integer. */
function clampPasskeys(value: number): number {
  return Math.max(0, Math.trunc(value));
}

/** Firestore handle: injected for tests, the admin singleton in production. */
function resolveDb(ctx?: MfaFactorContext): FirebaseFirestore.Firestore {
  return ctx?.db ?? getAdminDb();
}

/**
 * BOTH legs well-formed = trust the inventory without reading the passkeys
 * subcollection. This is what keeps `readMfaFactors` to one document read.
 */
function hasWellFormedFactors(
  userData: FirebaseFirestore.DocumentData | undefined,
): boolean {
  const stored = userData?.mfaFactors;
  if (typeof stored !== 'object' || stored === null) return false;
  const rec = stored as Record<string, unknown>;
  return typeof rec.totp === 'boolean' && isValidPasskeyCount(rec.passkeys);
}

/**
 * Read the inventory, healing each leg independently so a half-written doc
 * self-heals. Pre-`mfaFactors` accounts have neither leg: `totp` falls back to
 * `mfaEnrolled === true` (only TOTP ever set it), `passkeys` to the caller's
 * resolved subcollection size.
 *
 * `mfaSecret` is deliberately ignored — an in-flight TOTP setup parks its
 * secret on the user doc, so its presence is not proof of enrollment.
 */
export function normalizeMfaFactors(
  userData: FirebaseFirestore.DocumentData | undefined,
  passkeyCount: number,
): MfaFactorInventory {
  const stored = userData?.mfaFactors;
  const rec =
    typeof stored === 'object' && stored !== null
      ? (stored as Record<string, unknown>)
      : undefined;

  const totp =
    typeof rec?.totp === 'boolean' ? rec.totp : userData?.mfaEnrolled === true;

  const passkeys = isValidPasskeyCount(rec?.passkeys)
    ? rec.passkeys
    : clampPasskeys(Number.isFinite(passkeyCount) ? passkeyCount : 0);

  return { totp, passkeys };
}

/**
 * Current inventory, healing legacy/malformed docs. HOT PATH: exactly one
 * document read when the stored `mfaFactors` is well-formed; only a bad leg
 * falls through to counting the subcollection. A missing user doc yields the
 * empty inventory rather than throwing.
 */
export async function readMfaFactors(
  userId: string,
  ctx?: MfaFactorContext,
): Promise<MfaFactorInventory> {
  const userRef = resolveDb(ctx).collection('users').doc(userId);
  const tx = ctx?.tx;

  const snap = tx ? await tx.get(userRef) : await userRef.get();
  if (!snap.exists) return { ...EMPTY_MFA_FACTORS };

  const data = snap.data();
  if (hasWellFormedFactors(data)) {
    // Trusted inventory — return it without touching the subcollection.
    return normalizeMfaFactors(data, 0);
  }

  const passkeysCol = userRef.collection(PASSKEYS_SUBCOLLECTION);
  const countSnap = tx ? await tx.get(passkeysCol) : await passkeysCol.get();
  return normalizeMfaFactors(data, countSnap.size);
}

/**
 * Shared transaction body for both entry paths, so there is one ordering to
 * reason about: every read happens before the single write.
 */
async function applyInTx(
  tx: FirebaseFirestore.Transaction,
  userRef: FirebaseFirestore.DocumentReference,
  change: MfaFactorChange,
  extraUpdate?: Record<string, unknown>,
): Promise<MfaFactorResult> {
  // (1) Read the user doc. Never created here — an unbootstrapped user is a
  // caller bug we must not paper over.
  const snap = await tx.get(userRef);
  if (!snap.exists) {
    throw new Error(`mfaFactors: user ${userRef.id} not found`);
  }

  // (2) Recount on request, and also whenever the stored leg is untrustworthy
  // and no explicit total was given. The second condition is load-bearing: a
  // legacy doc (every account until the backfill runs) would heal from
  // passkeyCount=0, so a TOTP-only change writes `passkeys: 0` over real
  // credentials and the gate fails OPEN once TOTP is removed.
  const data = snap.data();
  const storedPasskeysTrustworthy = isValidPasskeyCount(
    (data?.mfaFactors as Record<string, unknown> | undefined)?.passkeys,
  );
  const mustRecount =
    change.recountPasskeys === true ||
    (change.passkeys === undefined && !storedPasskeysTrustworthy);

  let passkeyCount = 0;
  if (mustRecount) {
    const countSnap = await tx.get(userRef.collection(PASSKEYS_SUBCOLLECTION));
    passkeyCount = countSnap.size;
  }

  // (3) Current state, healed.
  const current = normalizeMfaFactors(data, passkeyCount);

  // (4) Recount or explicit count overrides the stored copy; omitted legs carry.
  const nextPasskeys = change.recountPasskeys
    ? passkeyCount
    : change.passkeys !== undefined
      ? change.passkeys
      : current.passkeys;

  const next: MfaFactorInventory = {
    totp: change.totp !== undefined ? change.totp : current.totp,
    passkeys: clampPasskeys(nextPasskeys),
  };

  // (5) `extraUpdate` is spread last so a caller can pair an atomic cleanup
  // (`mfaSecret`, `backupCodes`, …) — it must never carry the fields we own.
  const mfaEnrolled = deriveMfaEnrolled(next);
  const requiresMfaSetup = !mfaEnrolled;
  const payload: Record<string, unknown> = {
    mfaFactors: next,
    mfaEnrolled,
    requiresMfaSetup,
    // a factor change ends every login session minted before it (lib/sessionCutoff.server.ts);
    // the route that made the change re-stamps its own
    sessionsValidAfter: Date.now(),
    ...extraUpdate,
  };

  // (6) The single write.
  tx.set(userRef, payload, { merge: true });

  return { factors: next, mfaEnrolled, requiresMfaSetup };
}

/**
 * Recompute and persist the inventory, `mfaEnrolled` and `requiresMfaSetup`.
 * Pass `ctx.tx` to fold into a caller's transaction (before any write on it).
 */
export async function applyMfaFactorChange(
  userId: string,
  change: MfaFactorChange,
  ctx?: MfaFactorContext,
): Promise<MfaFactorResult> {
  if (!userId) throw new Error('mfaFactors: userId is required');
  if (change.passkeys !== undefined && change.recountPasskeys) {
    throw new Error(
      'mfaFactors: pass either passkeys or recountPasskeys, not both',
    );
  }
  if (change.passkeys !== undefined && !Number.isFinite(change.passkeys)) {
    throw new Error('mfaFactors: passkeys must be a finite number');
  }

  const db = resolveDb(ctx);
  const userRef = db.collection('users').doc(userId);

  if (ctx?.tx) {
    return applyInTx(ctx.tx, userRef, change, ctx.extraUpdate);
  }
  return db.runTransaction((tx) =>
    applyInTx(tx, userRef, change, ctx?.extraUpdate),
  );
}
