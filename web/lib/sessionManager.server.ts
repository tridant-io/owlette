/**
 * Server-side session management. Cookie is HTTPOnly + Secure + SameSite=lax,
 * encrypted and signed by iron-session. Replaces the XSS-exposed client-side
 * sessionManager.ts.
 *
 * Three MFA fields are cached on the session off ONE `users/{uid}` read so the
 * proxy can gate every request without a Firestore lookup:
 *   - mfaRequired      — always re-derived fresh at create time.
 *   - mfaVerified      — NOT blindly reset at create: preserved when the prior
 *                        session already cleared a challenge, or born verified
 *                        from a device-trust cookie or a passkey-uv ceremony.
 *                        `resolveMfaOnSessionCreate()` is the exact rule.
 *   - requiresMfaSetup — mandatory-enrollment gate; the proxy diverts to
 *                        /setup-2fa, which is what makes "remove your last
 *                        factor" safe instead of leaving the account roaming
 *                        un-enrolled.
 * A fourth field, mfaSatisfiedBy, records HOW `mfaVerified` was earned. Nothing
 * in the proxy reads it; it exists because `mfaCompletedAt` cannot tell a live
 * ceremony from a device-trust grant, and swoop's step-up has to.
 * Proxy: `mfaRequired && !mfaVerified` → /verify-2fa, and setup outranks it.
 * Sessions minted before a field existed are upgraded fail-closed on first
 * proxy hit — see `evaluateSessionMfa()`.
 */

import { getIronSession, IronSession, SessionOptions } from 'iron-session';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  DEVICE_TRUST_COOKIE,
  findValidTrustedDevice,
} from '@/lib/deviceTrust.server';

/**
 * How a session's MFA requirement came to be satisfied. Deliberately a *how*
 * and never a *when*: `challenge` and `passkey-uv` are live ceremonies this
 * session itself ran, `device-trust` is a 30-day cookie being presented.
 */
export type MfaSatisfiedBy = 'challenge' | 'passkey-uv' | 'device-trust';

export interface SessionData {
  userId: string;
  expiresAt: number;
  /**
   * Cached from `users/{uid}.mfaEnrolled` so the proxy needn't read Firestore
   * per request. Optional: older sessions lack it (upgraded by
   * `evaluateSessionMfa()`) and iron-session deserialises missing keys as
   * `undefined`.
   */
  mfaRequired?: boolean;
  /**
   * True at create when MFA isn't required, or after a successful TOTP /
   * backup-code / enrollment challenge.
   */
  mfaVerified?: boolean;
  /** Unix ms timestamp of the last successful MFA verification. */
  mfaCompletedAt?: number;
  /**
   * HOW `mfaVerified` was earned, which is the question `mfaCompletedAt` cannot
   * answer: a device-trust birth stamps it with `now` having run no ceremony.
   * Absent on sessions minted before the field existed and on accounts with no
   * MFA at all; both read as "no ceremony". `sessionPassedMfaCeremony()` is the
   * only intended reader.
   */
  mfaSatisfiedBy?: MfaSatisfiedBy;
  /**
   * Cached from `users/{uid}.requiresMfaSetup` (written by
   * `lib/mfaFactors.server.ts` whenever an account drops to zero factors, and
   * by signup bootstrap). Rides the same single read as `mfaRequired`; same
   * reason for being optional.
   */
  requiresMfaSetup?: boolean;
}

const sessionOptions: SessionOptions = {
  password: process.env.SESSION_SECRET as string,
  cookieName: '__session',
  cookieOptions: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7, // seconds
    path: '/',
  },
};

if (!process.env.SESSION_SECRET) {
  throw new Error(
    'SESSION_SECRET environment variable is required. Generate with: openssl rand -base64 32'
  );
}

if (process.env.SESSION_SECRET.length < 32) {
  throw new Error(
    'SESSION_SECRET must be at least 32 characters long for security'
  );
}

/** Session for Server Components and Route Handlers. */
export async function getSession(): Promise<IronSession<SessionData>> {
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, sessionOptions);
}

/** Session for proxy.ts, which has a NextRequest rather than cookies(). */
export async function getSessionFromRequest(
  req: NextRequest
): Promise<IronSession<SessionData>> {
  const res = NextResponse.next();
  const session = await getIronSession<SessionData>(req, res, sessionOptions);
  return session;
}

/**
 * Derive (mfaRequired, mfaVerified, requiresMfaSetup) from `users/{uid}` for a
 * session about to be created. Enrolled → required but unverified (challenge
 * first). Not enrolled, or no user doc yet (pre-bootstrap), → not required.
 *
 * Throws on Firestore errors — callers decide. Fail-CLOSED by design: an
 * earlier version returned mfaRequired:false here, so anyone who could induce
 * a transient Firestore failure during session creation bypassed MFA.
 */
async function resolveMfaStateForUser(userId: string): Promise<{
  mfaRequired: boolean;
  mfaVerified: boolean;
  requiresMfaSetup: boolean;
}> {
  // Doc-not-exists stays fail-soft on purpose: first-login users can hit this
  // before /api/users/bootstrap runs, and with no doc they cannot have MFA.
  const db = getAdminDb();
  const snap = await db.collection('users').doc(userId).get();
  if (!snap.exists) {
    // Nothing to enforce either way. Diverting a pre-bootstrap user to
    // /setup-2fa would race /api/users/bootstrap for the same page load.
    return { mfaRequired: false, mfaVerified: true, requiresMfaSetup: false };
  }
  const data = snap.data();
  const enrolled = data?.mfaEnrolled === true;
  // `lib/mfaFactors.server.ts` (sole writer) always writes
  // `requiresMfaSetup = !mfaEnrolled`, so both can't legitimately be true.
  // ANDing `!enrolled` is a safety belt: a hand-edited doc must never divert an
  // enrolled user into mandatory setup (setup outranks challenge in the proxy).
  const requiresMfaSetup = data?.requiresMfaSetup === true && !enrolled;
  if (enrolled) {
    return { mfaRequired: true, mfaVerified: false, requiresMfaSetup };
  }
  return { mfaRequired: false, mfaVerified: true, requiresMfaSetup };
}

/**
 * True when the prior session proves a real MFA challenge was cleared for THIS
 * uid and is still live — the precondition for keeping `mfaVerified` across
 * AuthContext's every-load re-POST of /api/auth/session.
 *
 * Demands mfaRequired && mfaVerified because only a real challenge produces
 * that pair; post-disable and no-MFA sessions must not skip a newly-required
 * challenge. Shared by `createSession` (gates the device-trust I/O) and
 * `resolveMfaOnSessionCreate` so the two can't drift.
 */
function canPreserveVerifiedMfa(
  prev: {
    userId?: string;
    expiresAt?: number;
    mfaRequired?: boolean;
    mfaVerified?: boolean;
  },
  userId: string,
  now: number
): boolean {
  return (
    prev.userId === userId &&
    typeof prev.expiresAt === 'number' &&
    prev.expiresAt > now &&
    prev.mfaRequired === true &&
    prev.mfaVerified === true
  );
}

/**
 * Pure decision for the `(mfaVerified, mfaCompletedAt)` a session is born with;
 * `mfaRequired` is taken verbatim from `resolved`. Pure so it unit-tests
 * without iron-session/Firestore mocks.
 *
 * Priority order (do not reorder):
 *   1. not required        → verified, NO mfaCompletedAt (no challenge happened)
 *   2. canPreserveVerifiedMfa → verified, carry prev.mfaCompletedAt AND
 *      prev.mfaSatisfiedBy so the ORIGINAL completion time and the ORIGINAL
 *      way it was earned both survive the every-load re-POST
 *   3. mfaSatisfiedBy==='passkey-uv' → verified, now (one UV ceremony proves
 *      credential + human, so it is both factors)
 *   4. deviceTrusted       → verified, now, satisfied BY the device-trust
 *      cookie — recorded as such, because no ceremony was run
 *   otherwise              → unverified → /verify-2fa
 *
 * 3 and 4 are only consulted inside the required arm, so neither can flip
 * `mfaRequired`. A passkey-born session satisfies `canPreserveVerifiedMfa`, so
 * later re-POSTs (which pass no `mfaSatisfiedBy`) don't re-challenge — and 2
 * carries the satisfier verbatim, so a re-POST cannot launder a device-trust
 * birth into a ceremony either.
 */
export function resolveMfaOnSessionCreate(input: {
  prev: {
    userId?: string;
    expiresAt?: number;
    mfaRequired?: boolean;
    mfaVerified?: boolean;
    mfaCompletedAt?: number;
    mfaSatisfiedBy?: MfaSatisfiedBy;
  };
  resolved: { mfaRequired: boolean; mfaVerified: boolean };
  userId: string;
  now: number;
  deviceTrusted: boolean;
  /**
   * SERVER-SIDE ONLY — see the security note on `createSession`'s parameter of
   * the same name. Set only by a route that itself performed the ceremony.
   */
  mfaSatisfiedBy?: 'passkey-uv';
}): {
  mfaRequired: boolean;
  mfaVerified: boolean;
  mfaCompletedAt?: number;
  mfaSatisfiedBy?: MfaSatisfiedBy;
} {
  const { prev, resolved, userId, now, deviceTrusted, mfaSatisfiedBy } = input;

  if (!resolved.mfaRequired) {
    return { mfaRequired: false, mfaVerified: true };
  }

  // Preserve a prior, genuinely-challenged, still-live session.
  if (canPreserveVerifiedMfa(prev, userId, now)) {
    return {
      mfaRequired: true,
      mfaVerified: true,
      mfaCompletedAt: prev.mfaCompletedAt,
      mfaSatisfiedBy: prev.mfaSatisfiedBy,
    };
  }

  // A UV WebAuthn ceremony completed during THIS request satisfies the
  // challenge outright; the verifying route pins requireUserVerification.
  if (mfaSatisfiedBy === 'passkey-uv') {
    return { mfaRequired: true, mfaVerified: true, mfaCompletedAt: now, mfaSatisfiedBy };
  }

  // Valid device-trust cookie; the grant is itself a fresh verification event.
  if (deviceTrusted) {
    return {
      mfaRequired: true,
      mfaVerified: true,
      mfaCompletedAt: now,
      mfaSatisfiedBy: 'device-trust',
    };
  }

  return { mfaRequired: true, mfaVerified: false };
}

/**
 * Create a session. Reads `users/{uid}` so it is born with fresh `mfaRequired`
 * and `requiresMfaSetup`; `mfaVerified` follows `resolveMfaOnSessionCreate`
 * (preserve → passkey-uv → device trust → challenge). The device-trust cookie
 * is read here rather than passed in so every caller picks the path up.
 *
 * @param mfaSatisfiedBy SERVER-SIDE ONLY. Pass `'passkey-uv'` only when the
 *   calling route itself completed a WebAuthn ceremony with
 *   `requireUserVerification: true`. Never derive it from anything the client
 *   controls — it is the one input that can birth a verified session without a
 *   challenge, so a request-sourced value is a one-word MFA bypass. Only two
 *   call sites: app/api/auth/session/route.ts (never passes it) and
 *   app/api/passkeys/authenticate/verify/route.ts (literal, after
 *   `verification.verified`).
 *
 * Fail-closed: device-trust lookup errors are caught and read as untrusted.
 * `resolveMfaStateForUser`'s throw propagates — a Firestore failure must never
 * silently mint a session.
 */
export async function createSession(
  userId: string,
  durationDays: number = 7,
  mfaSatisfiedBy?: 'passkey-uv'
): Promise<void> {
  const session = await getSession();

  // Snapshot BEFORE overwriting: the preserve rule reads these.
  const prev = {
    userId: session.userId,
    expiresAt: session.expiresAt,
    mfaRequired: session.mfaRequired,
    mfaVerified: session.mfaVerified,
    mfaCompletedAt: session.mfaCompletedAt,
    mfaSatisfiedBy: session.mfaSatisfiedBy,
  };

  const now = Date.now();
  const expiresAt = now + durationDays * 24 * 60 * 60 * 1000;

  // Fresh Firestore truth; never swallow its throw.
  const resolved = await resolveMfaStateForUser(userId);

  // Preserve and passkey-uv are I/O-free, so decide them first and skip the
  // device-trust round-trip when either already settles it (behaviour-neutral:
  // `resolveMfaOnSessionCreate` returns before reading `deviceTrusted`).
  let deviceTrusted = false;
  if (
    resolved.mfaRequired &&
    !canPreserveVerifiedMfa(prev, userId, now) &&
    mfaSatisfiedBy !== 'passkey-uv'
  ) {
    // Fail-CLOSED: any error here means untrusted → challenge, and must never
    // escape createSession.
    try {
      const cookieStore = await cookies();
      const raw = cookieStore.get(DEVICE_TRUST_COOKIE)?.value;
      if (raw) {
        deviceTrusted = await findValidTrustedDevice(userId, raw, now);
      }
    } catch (err) {
      console.error(
        '[Session] device-trust lookup failed for',
        userId,
        '— treating device as untrusted (fail-closed)',
        err
      );
      deviceTrusted = false;
    }
  }

  const mfa = resolveMfaOnSessionCreate({
    prev,
    resolved,
    userId,
    now,
    deviceTrusted,
    mfaSatisfiedBy,
  });

  session.userId = userId;
  session.expiresAt = expiresAt;
  session.mfaRequired = mfa.mfaRequired;
  session.mfaVerified = mfa.mfaVerified;
  // Verbatim fresh Firestore truth — a property of the ACCOUNT, not of this
  // login, so deliberately not routed through `resolveMfaOnSessionCreate`.
  // Re-stamped every create, which is what keeps the proxy's cache honest.
  session.requiresMfaSetup = resolved.requiresMfaSetup;
  if (typeof mfa.mfaCompletedAt === 'number') {
    session.mfaCompletedAt = mfa.mfaCompletedAt;
  } else {
    // Clear any stale value carried over from a reused cookie.
    delete session.mfaCompletedAt;
  }
  if (mfa.mfaSatisfiedBy) {
    session.mfaSatisfiedBy = mfa.mfaSatisfiedBy;
  } else {
    // Same reason, and it matters more here: a stale `challenge` surviving into
    // a session that ran no ceremony is exactly what swoop's step-up must not
    // see. Dropping an account's last factor lands here too (mfaRequired turns
    // false), so it closes the ceremony claim with it.
    delete session.mfaSatisfiedBy;
  }

  await session.save();

  console.log(
    '[Session] Created for user:', userId,
    'expires:', new Date(expiresAt).toISOString(),
    'mfaRequired:', mfa.mfaRequired,
    'mfaVerified:', mfa.mfaVerified,
    'requiresMfaSetup:', resolved.requiresMfaSetup,
    'deviceTrusted:', deviceTrusted,
    'mfaSatisfiedBy:', mfaSatisfiedBy ?? 'none'
  );
}

/** @returns userId if the session is valid and unexpired, else null. */
export async function validateSession(): Promise<string | null> {
  const session = await getSession();

  if (!session.userId || !session.expiresAt) {
    return null;
  }

  if (Date.now() > session.expiresAt) {
    console.warn('[Session] Expired session detected:', session.userId);
    await destroySession();
    return null;
  }

  return session.userId;
}

/** Proxy-side variant of `validateSession`. */
export async function validateSessionFromRequest(
  req: NextRequest
): Promise<string | null> {
  const session = await getSessionFromRequest(req);

  if (!session.userId || !session.expiresAt) {
    return null;
  }

  if (Date.now() > session.expiresAt) {
    console.warn('[Session] Expired session detected in proxy:', session.userId);
    await session.destroy();
    return null;
  }

  return session.userId;
}

/**
 * Proxy-side MFA gate. Returns `pass` | `challenge` (→ /verify-2fa) |
 * `unauthenticated`, plus `requiresSetup` read from the session's cached
 * `requiresMfaSetup` (never a fresh read — this runs on every request).
 *
 * Sessions missing `mfaRequired` or `requiresMfaSetup` are upgraded in place
 * from one Firestore read; the fields are upgraded independently so a
 * `mfaVerified` earned by a real challenge is never clobbered. Never destroys
 * a session — only passes through or redirects.
 */
export async function evaluateSessionMfa(
  req: NextRequest
): Promise<{
  outcome: 'pass' | 'challenge' | 'unauthenticated';
  userId: string | null;
  requiresSetup: boolean;
}> {
  const session = await getSessionFromRequest(req);

  if (!session.userId || !session.expiresAt) {
    return { outcome: 'unauthenticated', userId: null, requiresSetup: false };
  }

  if (Date.now() > session.expiresAt) {
    await session.destroy();
    return { outcome: 'unauthenticated', userId: null, requiresSetup: false };
  }

  // Upgrade sessions predating either field. A throw here caches nothing: we
  // force `challenge` and leave the session alone so a retry can finish the
  // upgrade (fail-CLOSED; the earlier fail-open let a transient Firestore
  // failure bypass MFA).
  const needsChallengeUpgrade = typeof session.mfaRequired !== 'boolean';
  // A session missing ONLY `requiresMfaSetup` needs no read when
  // `mfaRequired === true`: the sole writer keeps
  // `requiresMfaSetup = !mfaEnrolled`, so the answer is provably false. Not a
  // micro-optimisation — the upgrade save below never reaches the browser (see
  // caveat), so an unconditional read would cost one Firestore read per request
  // for every legacy session until its next `createSession`.
  const needsSetupUpgrade =
    typeof session.requiresMfaSetup !== 'boolean' && session.mfaRequired !== true;
  if (needsChallengeUpgrade || needsSetupUpgrade) {
    try {
      const resolved = await resolveMfaStateForUser(session.userId);
      if (needsChallengeUpgrade) {
        // Only when genuinely absent — never clobber an earned `mfaVerified`.
        session.mfaRequired = resolved.mfaRequired;
        session.mfaVerified = resolved.mfaVerified;
      }
      session.requiresMfaSetup = resolved.requiresMfaSetup;
      try {
        // CAVEAT (pre-existing): `getSessionFromRequest` hands iron-session a
        // throwaway `NextResponse.next()`, so this Set-Cookie lands on a
        // response the proxy discards — the upgrade is authoritative for THIS
        // request only; the durable re-cache is the next `createSession`. Keep
        // the save: it makes the values consistent within the request.
        await session.save();
      } catch (err) {
        // Still honour the freshly-evaluated values — better than a no-op.
        console.error(
          '[Session] failed to persist MFA upgrade for',
          session.userId,
          err,
        );
      }
    } catch (err) {
      console.error(
        '[Session] MFA upgrade lookup failed for',
        session.userId,
        '— falling back to the cached session state (fail-closed)',
        err,
      );
      if (needsChallengeUpgrade) {
        // Pre-Wave-2 session with no cached challenge state: force the
        // challenge rather than fail-OPEN. Next request retries the upgrade.
        return {
          outcome: 'challenge',
          userId: session.userId,
          requiresSetup: session.requiresMfaSetup === true,
        };
      }
      // Only the setup flag was missing; the cached challenge state is still
      // authoritative, so evaluate normally (undefined reads as false).
      // Diverting on an unknown flag would shove every enrolled user with an
      // older cookie into mandatory setup for the length of a Firestore blip.
    }
  }

  const requiresSetup = session.requiresMfaSetup === true;

  if (session.mfaRequired && !session.mfaVerified) {
    return { outcome: 'challenge', userId: session.userId, requiresSetup };
  }

  return { outcome: 'pass', userId: session.userId, requiresSetup };
}

/** Destroy the session (sign out). */
export async function destroySession(): Promise<void> {
  const session = await getSession();
  const userId = session.userId;

  session.destroy();

  if (userId) {
    console.log('[Session] Destroyed for user:', userId);
  }
}

/** Sliding expiration; call on each request to keep active users signed in. */
export async function extendSession(durationDays: number = 7): Promise<void> {
  const session = await getSession();

  if (!session.userId) {
    return;
  }

  const expiresAt = Date.now() + durationDays * 24 * 60 * 60 * 1000;
  session.expiresAt = expiresAt;

  await session.save();
}

/**
 * Mark the session as having cleared an MFA challenge. Called by
 * /api/mfa/verify-login and /api/mfa/verify-setup (enrollment counts as a
 * fresh verification). No-op without a `userId`.
 */
export async function markSessionMfaVerified(): Promise<void> {
  const session = await getSession();
  if (!session.userId) {
    return;
  }
  session.mfaRequired = true;
  session.mfaVerified = true;
  session.mfaCompletedAt = Date.now();
  session.mfaSatisfiedBy = 'challenge';
  // Reaching here requires a completed challenge, hence at least one factor —
  // mandatory setup is satisfied. Stamping now (not at the next createSession)
  // stops the proxy diverting to /setup-2fa on the very next request.
  session.requiresMfaSetup = false;
  await session.save();
}

/**
 * Re-mint MFA state after a server-mediated disable: the disable counts as a
 * verification so the user isn't re-challenged immediately, and the cached
 * `requiresMfaSetup` is invalidated because the disable may have re-armed it.
 */
export async function markSessionMfaDisabled(): Promise<void> {
  const session = await getSession();
  if (!session.userId) {
    return;
  }
  session.mfaRequired = false;
  session.mfaVerified = true;
  session.mfaCompletedAt = Date.now();
  // A disable is not a second-factor ceremony, and the account it leaves behind
  // may hold no second factor at all, so the ceremony claim goes with it.
  delete session.mfaSatisfiedBy;
  // A disable can leave zero factors (re-arms `users/{uid}.requiresMfaSetup`)
  // or passkeys still enrolled; this helper can't see the resulting inventory,
  // and a stale cached `false` would walk the account past the /setup-2fa gate.
  // Dropping it makes `evaluateSessionMfa` resolve from Firestore next request
  // (mfaRequired=false here, so its derivation can't short-circuit).
  delete session.requiresMfaSetup;
  await session.save();
}

/**
 * Did THIS session itself pass a live second-factor ceremony?
 *
 * swoop's step-up window is keyed on (user, machine) rather than on one login
 * session, so a reload — which ends the swoop session and starts a new one —
 * can reuse it instead of re-running the ceremony. This is the gate on that
 * reuse: without it a session born from the 30-day device-trust cookie, which
 * ran no ceremony and only carries `mfaCompletedAt = now` to say otherwise,
 * would inherit a window somebody else's ceremony opened. Anything unknown —
 * a session minted before the field existed, an account with no MFA — reads as
 * "no ceremony", so the answer fails closed.
 */
export function sessionPassedMfaCeremony(session: {
  mfaSatisfiedBy?: MfaSatisfiedBy;
}): boolean {
  return session.mfaSatisfiedBy === 'challenge' || session.mfaSatisfiedBy === 'passkey-uv';
}

/**
 * Record that this session has just completed a live second-factor ceremony
 * away from the login flow — swoop's step-up is the only caller, and it reaches
 * here only after `verifyMfaProof` has returned a successful outcome.
 *
 * Deliberately narrow: it stamps the satisfier and nothing else, so it cannot
 * move `mfaRequired`, `mfaVerified` or `requiresMfaSetup` and is not a second
 * way into the login MFA state machine. A no-op unless the cookie names the
 * same user the ceremony was run for — a request authenticated by an ID token
 * must never stamp whatever session cookie happened to ride along with it.
 */
export async function markSessionMfaCeremony(userId: string): Promise<void> {
  const session = await getSession();
  if (!session.userId || session.userId !== userId) {
    return;
  }
  session.mfaSatisfiedBy = 'challenge';
  await session.save();
}

/** Read session data without modifying it (Server Components). */
export async function getSessionData(): Promise<SessionData | null> {
  const session = await getSession();

  if (!session.userId || !session.expiresAt) {
    return null;
  }

  if (Date.now() > session.expiresAt) {
    return null;
  }

  const data: SessionData = {
    userId: session.userId,
    expiresAt: session.expiresAt,
  };
  if (typeof session.mfaRequired === 'boolean') {
    data.mfaRequired = session.mfaRequired;
  }
  if (typeof session.mfaVerified === 'boolean') {
    data.mfaVerified = session.mfaVerified;
  }
  if (typeof session.mfaCompletedAt === 'number') {
    data.mfaCompletedAt = session.mfaCompletedAt;
  }
  if (session.mfaSatisfiedBy) {
    data.mfaSatisfiedBy = session.mfaSatisfiedBy;
  }
  if (typeof session.requiresMfaSetup === 'boolean') {
    data.requiresMfaSetup = session.requiresMfaSetup;
  }
  return data;
}
