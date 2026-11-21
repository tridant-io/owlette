/**
 * sign-in and second-factor rows for the superadmin activity feed.
 *
 * written into the platform audit sink (`global/audit_log/entries`) in the decision-row
 * layout, so the existing index and the feed read them like any other row. the
 * capabilities are plain strings, not `Capability`: that union keys the rate-limit and
 * matrix tables, and a sign-in is not a capability decision.
 *
 * all writers are fire-and-forget and never throw: a failed audit write must not fail
 * a login.
 */

import type { NextRequest } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { generateCorrelationId, type Role } from '@/lib/auditLog.server';
import { requestNetwork } from '@/lib/network.server';
import logger from '@/lib/logger';

type AuthCapability = 'AUTH_SIGN_IN' | 'AUTH_SECOND_FACTOR';

/** `/api/auth/session` runs on every page load and `auth_time` survives token refresh. */
const SIGN_IN_WINDOW_SECONDS = 10 * 60;

const ALREADY_EXISTS = 6;

export interface SignInInput {
  userId: string;
  role: Role;
  method: string;
  /** the id token's `auth_time`, epoch seconds. */
  authTime: number;
}

export interface AuthFailureInput {
  userId: string;
  capability: AuthCapability;
  event: 'sign_in_failed' | 'second_factor_failed';
  reason: string;
  method?: string;
  /** failure sites that have not read the user doc leave it out. */
  role?: Role;
}

export interface SecondFactorInput {
  userId: string;
  method: 'totp' | 'backup_code' | 'passkey';
  role?: Role;
}

function entry(
  request: NextRequest,
  userId: string,
  role: Role,
  capability: AuthCapability,
  outcome: 'allow' | 'deny',
  event: string,
  method: string | undefined,
  denyReason?: string,
) {
  const { key, prefix, viaEdge } = requestNetwork(request);
  return {
    correlationId: generateCorrelationId(),
    actor: { type: 'user', userId, role },
    capability,
    target: { kind: 'user', id: userId },
    outcome,
    ...(denyReason !== undefined ? { denyReason } : {}),
    metadata: {
      event,
      ...(method !== undefined ? { method } : {}),
      network: { key, prefix, viaEdge },
    },
    timestamp: FieldValue.serverTimestamp(),
  };
}

function entries() {
  return getAdminDb().collection('global').doc('audit_log').collection('entries');
}

function logFailure(what: string, userId: string, err: unknown): void {
  logger.error(`${what} audit write failed`, {
    context: 'authEvents',
    data: { userIdPrefix: userId.slice(0, 6), error: err instanceof Error ? err.message : String(err) },
  });
}

export function recordSignIn(request: NextRequest, input: SignInInput): void {
  const { userId, role, method, authTime } = input;
  // a missing or non-numeric auth_time fails the comparison too
  if (!(Date.now() / 1000 - authTime <= SIGN_IN_WINDOW_SECONDS)) return;

  void (async () => {
    await entries()
      .doc(`signin_${userId}_${authTime}`)
      .create(entry(request, userId, role, 'AUTH_SIGN_IN', 'allow', 'sign_in', method));
  })().catch((err) => {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === ALREADY_EXISTS || code === 'already-exists') return;
    logFailure('sign-in', userId, err);
  });
}

export function recordSecondFactorPassed(request: NextRequest, input: SecondFactorInput): void {
  const { userId, method, role = 'member' } = input;

  void (async () => {
    await entries().add(entry(request, userId, role, 'AUTH_SECOND_FACTOR', 'allow', 'second_factor_passed', method));
  })().catch((err) => logFailure('second_factor_passed', userId, err));
}

export function recordAuthFailure(request: NextRequest, input: AuthFailureInput): void {
  const { userId, capability, event, reason, method, role = 'member' } = input;

  void (async () => {
    await entries().add(entry(request, userId, role, capability, 'deny', event, method, reason));
  })().catch((err) => logFailure(event, userId, err));
}
