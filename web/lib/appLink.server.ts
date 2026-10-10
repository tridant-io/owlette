/**
 * app-link: hands a signed-in browser's session to owlette swoop, whose webview keeps its own
 * cookie jar (dev/active/swoop-viewer/context.md decision 17). Records live in the admin-only
 * `app_links` collection under id = sha256(code), so nothing at rest can be replayed.
 *
 *   website → app   POST /api/auth/app-link mints an APPROVED record for the caller (60 s). the
 *                   code rides the owlette-swoop:// deep link; the app's /app-link page exchanges it.
 *   cold app start  POST /api/auth/app-link/start mints a PENDING record plus a poll secret
 *                   (10 min). the user approves it at /app-link/approve in a browser; the app polls
 *                   exchange with code + secret.
 *
 * exchange answers a firebase custom token whose `appLinkMfa` developer claim carries the
 * approver's `mfaSatisfiedBy`; /api/auth/session reads it back through `appLinkMfaFromIdToken`.
 *
 * security
 * - leaked approved code. actor: anyone who reads the deep link inside its 60 s (another process on
 *   the machine, a launcher that logs urls). mechanism: POST exchange { code }. outcome: a dashboard
 *   session as the approver, carrying the approver's mfa state. bounded by: single use (approved →
 *   used flips in a transaction), the 60 s ttl, 256-bit codes stored only as sha256 and never
 *   logged, and no response that names the uid.
 * - pending code. it sits in a browser's address bar and history, so it is not a secret: exchange
 *   demands the poll secret, which only the app that started it holds, in every state including
 *   approved. actor: a phisher who sends someone their own approve link. mechanism: the victim
 *   approves. outcome: the phisher's app signs in as the victim. that is the device-code risk; the
 *   approve page shows the account and says to approve only a sign-in you just started, and
 *   approving needs a browser session that has completed mfa. pending records die after 10 min.
 * - control. swoop control still needs an open per-machine step-up window
 *   (lib/swoop/policy.server.ts). the claim carries the approver's satisfier verbatim, so a
 *   device-trust approver yields a device-trust session, which may not reuse a window.
 * - the claim counts only at the sign-in it was minted for: refreshed id tokens keep developer
 *   claims, so `appLinkMfaFromIdToken` also requires a fresh `auth_time`.
 */

import crypto from 'crypto';
import type { NextRequest } from 'next/server';
import { Timestamp } from 'firebase-admin/firestore';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import { ApiAuthError, assertActiveUser } from '@/lib/apiAuth.server';
import { MFA_CHALLENGE_REQUIRED } from '@/lib/mfaEnrollmentGate.server';
import { getSessionFromRequest, type MfaSatisfiedBy } from '@/lib/sessionManager.server';

export const APP_LINKS_COLLECTION = 'app_links';
export const APP_LINK_APPROVED_TTL_MS = 60 * 1000;
export const APP_LINK_PENDING_TTL_MS = 10 * 60 * 1000;
/** how long after the custom-token sign-in /api/auth/session still honours `appLinkMfa`. */
export const APP_LINK_CLAIM_MAX_AGE_MS = 5 * 60 * 1000;

const MFA_SATISFIERS: readonly MfaSatisfiedBy[] = ['challenge', 'passkey-uv', 'device-trust'];

function isMfaSatisfiedBy(value: unknown): value is MfaSatisfiedBy {
  return MFA_SATISFIERS.includes(value as MfaSatisfiedBy);
}

function randomToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function recordRef(code: string) {
  return getAdminDb().collection(APP_LINKS_COLLECTION).doc(sha256(code));
}

function isExpired(data: FirebaseFirestore.DocumentData, nowMs: number): boolean {
  const expiresAtMs = data.expiresAt?.toMillis?.() ?? 0;
  return nowMs >= expiresAtMs;
}

function secretMatches(secretHash: string, secret: string | undefined): boolean {
  if (!secret) return false;
  const expected = Buffer.from(secretHash, 'hex');
  const actual = Buffer.from(sha256(secret), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export interface AppLinkApprover {
  uid: string;
  mfaSatisfiedBy?: MfaSatisfiedBy;
}

/**
 * the login cookie, live, with its mfa challenge complete. cookie only: an id token carries no
 * mfa state, so it cannot vouch for one.
 */
export async function requireAppLinkApprover(request: NextRequest): Promise<AppLinkApprover> {
  const session = await getSessionFromRequest(request);
  if (!session.userId || typeof session.expiresAt !== 'number' || session.expiresAt <= Date.now()) {
    throw new ApiAuthError(401, 'Unauthorized: No valid session');
  }
  if (session.mfaVerified !== true) {
    throw new ApiAuthError(403, 'complete two-factor verification first', {
      code: MFA_CHALLENGE_REQUIRED,
    });
  }
  await assertActiveUser(session.userId);
  return {
    uid: session.userId,
    mfaSatisfiedBy: isMfaSatisfiedBy(session.mfaSatisfiedBy) ? session.mfaSatisfiedBy : undefined,
  };
}

function approvalFields(approver: AppLinkApprover) {
  return {
    uid: approver.uid,
    ...(approver.mfaSatisfiedBy ? { mfaSatisfiedBy: approver.mfaSatisfiedBy } : {}),
  };
}

/** website → app: an approved, single-use code for the caller. */
export async function mintApprovedAppLink(
  approver: AppLinkApprover,
): Promise<{ code: string; expiresAt: number }> {
  const code = randomToken();
  const now = Date.now();
  const expiresAt = now + APP_LINK_APPROVED_TTL_MS;
  await recordRef(code).create({
    status: 'approved',
    ...approvalFields(approver),
    createdAt: Timestamp.fromMillis(now),
    expiresAt: Timestamp.fromMillis(expiresAt),
  });
  return { code, expiresAt };
}

/** cold app start: a pending code to approve in a browser, and the secret that polls it. */
export async function startPendingAppLink(): Promise<{
  code: string;
  secret: string;
  approveUrl: string;
  expiresAt: number;
}> {
  const code = randomToken();
  const secret = randomToken();
  const now = Date.now();
  const expiresAt = now + APP_LINK_PENDING_TTL_MS;
  await recordRef(code).create({
    status: 'pending',
    secretHash: sha256(secret),
    createdAt: Timestamp.fromMillis(now),
    expiresAt: Timestamp.fromMillis(expiresAt),
  });
  // base64url needs no escaping in a query string.
  return { code, secret, approveUrl: `/app-link/approve?code=${code}`, expiresAt };
}

export type ApproveAppLinkOutcome = 'approved' | 'not_found' | 'not_pending';

export async function approveAppLink(
  code: string,
  approver: AppLinkApprover,
): Promise<ApproveAppLinkOutcome> {
  const ref = recordRef(code);
  return getAdminDb().runTransaction(async (tx): Promise<ApproveAppLinkOutcome> => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : undefined;
    if (!data || isExpired(data, Date.now())) return 'not_found';
    if (data.status !== 'pending') return 'not_pending';
    tx.update(ref, { status: 'approved', ...approvalFields(approver) });
    return 'approved';
  });
}

export type ExchangeAppLinkOutcome =
  | { kind: 'pending' }
  | { kind: 'token'; customToken: string }
  /** expired or already used. */
  | { kind: 'gone' }
  /** unknown code, or a started code without its secret. */
  | { kind: 'not_found' };

export async function exchangeAppLink(
  code: string,
  secret: string | undefined,
): Promise<ExchangeAppLinkOutcome> {
  const ref = recordRef(code);
  const result = await getAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : undefined;
    if (!data) return { kind: 'not_found' } as const;
    if (typeof data.secretHash === 'string' && !secretMatches(data.secretHash, secret)) {
      return { kind: 'not_found' } as const;
    }
    if (isExpired(data, Date.now())) {
      tx.delete(ref);
      return { kind: 'gone' } as const;
    }
    if (data.status === 'pending') return { kind: 'pending' } as const;
    if (data.status !== 'approved' || typeof data.uid !== 'string') return { kind: 'gone' } as const;
    tx.update(ref, { status: 'used', usedAt: Timestamp.now() });
    return {
      kind: 'approved',
      uid: data.uid,
      mfaSatisfiedBy: isMfaSatisfiedBy(data.mfaSatisfiedBy) ? data.mfaSatisfiedBy : undefined,
    } as const;
  });
  if (result.kind !== 'approved') return result;

  const customToken = await getAdminAuth().createCustomToken(
    result.uid,
    result.mfaSatisfiedBy ? { appLinkMfa: result.mfaSatisfiedBy } : undefined,
  );
  return { kind: 'token', customToken };
}

/**
 * the `appLinkMfa` claim of a verified id token, when /api/auth/session may honour it: a
 * custom-token sign-in, a known satisfier, and the sign-in itself rather than a later refresh.
 * without the `auth_time` bound, a firebase sign-in that outlived its 7-day cookie would keep
 * re-minting a verified session from the every-load re-POST.
 */
export function appLinkMfaFromIdToken(
  decoded: DecodedIdToken,
  nowMs: number = Date.now(),
): MfaSatisfiedBy | undefined {
  if (decoded.firebase?.sign_in_provider !== 'custom') return undefined;
  const claim: unknown = decoded.appLinkMfa;
  if (!isMfaSatisfiedBy(claim)) return undefined;
  if (typeof decoded.auth_time !== 'number') return undefined;
  if (nowMs - decoded.auth_time * 1000 > APP_LINK_CLAIM_MAX_AGE_MS) return undefined;
  return claim;
}
