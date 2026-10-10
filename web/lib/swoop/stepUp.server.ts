/**
 * the step-up ceremony on the server, shared by the two routes that run one:
 * `swoop/sessions` (a proof in the same request as the session) and
 * `swoop/step-up` (a proof on its own, from the browser half of owlette swoop's
 * "verify in your browser"). one implementation, so the two can never disagree
 * about what opens a window or which login session may read one back.
 */

import type { NextRequest, NextResponse } from 'next/server';
import { problem, ProblemType } from '@/lib/apiErrors';
import { assertActiveUser } from '@/lib/apiAuth.server';
import logger from '@/lib/logger';
import {
  mfaProofErrorResponse,
  parseMfaProof,
  verifyMfaProof,
} from '@/lib/mfaProof.server';
import {
  getSessionFromRequest,
  markSessionMfaCeremony,
  sessionPassedMfaCeremony,
} from '@/lib/sessionManager.server';
import { hasEnrolledFactor, openStepUpWindow } from '@/lib/swoop/policy.server';

/** `reason` is the audit code for the refusal, never the ceremony's detail. */
export type StepUpResult =
  | { ok: true }
  | { ok: false; response: NextResponse; reason: string };

/**
 * Run a live second-factor ceremony, open the 12-hour window for this
 * (user, machine) pair, and record on the login session that it has now itself
 * proved a second factor — which is what lets this operator's reloads reuse the
 * window for the rest of those 12 hours.
 *
 * A timestamp can never stand in for any of it: a session born from the 30-day
 * device-trust cookie carries `mfaCompletedAt = now` with no ceremony behind it
 * (`lib/sessionManager.server.ts`, the `deviceTrusted` arm of
 * `resolveMfaOnSessionCreate`).
 */
export async function openStepUpFromProof(args: {
  userId: string;
  siteId: string;
  machineId: string;
  proof: unknown;
}): Promise<StepUpResult> {
  const parsed = parseMfaProof(args.proof);
  if (!parsed.ok) {
    return { ok: false, reason: 'proof_malformed', response: mfaProofErrorResponse(parsed) };
  }

  // An account with no enrolled factor cannot have produced a live proof, so a
  // proof that "verifies" for one means the ceremony was bypassed. Refused
  // before the verification rather than after it.
  if (!(await hasEnrolledFactor(args.userId))) {
    return {
      ok: false,
      reason: 'no_enrolled_factor',
      response: problem({
        type: ProblemType.Unauthorized,
        title: 'step-up required',
        status: 401,
        detail:
          'enroll a passkey or an authenticator app before taking control of a machine. signing in with google or a password is not a second factor.',
        code: 'step_up_required',
      }),
    };
  }

  const userData = await assertActiveUser(args.userId);
  const outcome = await verifyMfaProof(args.userId, parsed.proof, userData);
  if (!outcome.ok) {
    return { ok: false, reason: 'proof_rejected', response: mfaProofErrorResponse(outcome) };
  }

  await openStepUpWindow({
    userId: args.userId,
    siteId: args.siteId,
    machineId: args.machineId,
    proof: outcome,
  });

  // Best effort, and deliberately after the window: the ceremony has already
  // happened and this request is already authorised, so a cookie that cannot be
  // written costs the operator a prompt on their next reload and nothing more.
  // Refusing control here would refuse someone who just proved a second factor.
  try {
    await markSessionMfaCeremony(args.userId);
  } catch (err) {
    logger.warn('[swoop/step-up] could not record the ceremony on the login session', {
      context: 'swoop/step-up',
      data: {
        siteId: args.siteId,
        machineId: args.machineId,
        err: err instanceof Error ? err.message : String(err),
      },
    });
  }
  return { ok: true };
}

/**
 * Did the LOGIN session behind this request pass a live ceremony of its own?
 *
 * Read off the server's encrypted, signed session cookie — the browser has no
 * field it can set to claim this — and only when that cookie names the caller
 * and is still live, so a request authenticated by an ID token rides on no
 * cookie it did not earn. Anything short of that reads as "no ceremony".
 */
export async function requestPassedMfaCeremony(
  request: NextRequest,
  userId: string,
): Promise<boolean> {
  const login = await getSessionFromRequest(request);
  return (
    login.userId === userId &&
    typeof login.expiresAt === 'number' &&
    login.expiresAt > Date.now() &&
    sessionPassedMfaCeremony(login)
  );
}
