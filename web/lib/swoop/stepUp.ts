/**
 * the step-up proof the session-create route wants, and the ceremony that
 * produces one.
 *
 * taking control of a machine needs a **live** second-factor proof in the
 * request. a freshness timestamp can never stand in for it: a login session
 * born from the 30-day device-trust cookie carries `mfaCompletedAt = now` with
 * no ceremony behind it. so the page collects a real proof and forwards it
 * verbatim; it never inspects it, never stores it and never logs it.
 *
 * the two shapes below are exactly the bodies `parseMfaProof` accepts
 * (`web/lib/mfaProof.server.ts`) — a totp or backup code, or a passkey
 * assertion with the challenge id it was issued against. keeping them
 * structurally identical is the contract: the hook puts this object straight
 * into the request body as `mfaProof`.
 */

import { startAuthentication } from '@simplewebauthn/browser';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
// type-only: mfaFactors.server.ts is Admin-SDK code that must never reach the client bundle
import type { MfaFactorInventory } from '@/lib/mfaFactors.server';

export type SwoopStepUpProof =
  | { code: string; isBackupCode?: boolean }
  | { credential: AuthenticationResponseJSON; challengeId: string };

/**
 * the step-up was passed somewhere else — owlette swoop's "verify in your
 * browser" — and the window is open on the server, so the retry carries no
 * proof. never a request body: the hook sends nothing for it.
 */
export const STEP_UP_WINDOW_OPEN = { kind: 'window' } as const;

export type SwoopStepUpAnswer = SwoopStepUpProof | typeof STEP_UP_WINDOW_OPEN;

/** the step-up dialog's props, as the page passes them through from the hook. */
export interface SwoopStepUpProps {
  open: boolean;
  /** the account's second factors; none at all means it cannot control. */
  factors: MfaFactorInventory;
  /** resolves when the retry has been made; rejects with the reason to show. */
  onProof: (answer: SwoopStepUpAnswer) => Promise<void>;
  onCancel: () => void;
}

function stepUpRoute(siteId: string, machineId: string): string {
  return `/api/sites/${encodeURIComponent(siteId)}/machines/${encodeURIComponent(machineId)}/swoop/step-up`;
}

/** the browser page where owlette swoop's step-up is passed, absolute so the app hands it to the system browser. */
export function stepUpVerifyUrl(siteId: string, machineId: string, origin = window.location.origin): string {
  return new URL(`/swoop/${encodeURIComponent(siteId)}/${encodeURIComponent(machineId)}/verify`, origin).toString();
}

/**
 * is the caller's window on this machine open for this sign-in, and could it
 * ever be? `sessionPassedCeremony: false` means this sign-in skipped the second
 * factor, so a check passed elsewhere never reaches it. throws on any non-2xx.
 */
export async function readStepUpWindow(
  siteId: string,
  machineId: string,
): Promise<{ open: boolean; sessionPassedCeremony: boolean }> {
  const res = await fetch(stepUpRoute(siteId, machineId));
  if (!res.ok) throw new Error(`step-up status failed (${res.status})`);
  const { data } = (await res.json()) as { data: { open: boolean; sessionPassedCeremony: boolean } };
  return data;
}

const TRY_AGAIN = "that didn't go through. try again.";
const TOO_MANY_TRIES = 'too many tries. wait a minute, then try again.';
const PASSKEY_FAILED = "that passkey didn't check out. try again.";

// every refusal of a proof (`lib/mfaProof.server.ts`), in plain words
const PROOF_REFUSALS = new Map<string, string>([
  ['invalid_mfa_proof', "that code didn't work. try again."],
  ['invalid_totp_code', 'an authenticator code is 6 digits.'],
  ['totp_not_enrolled', 'this account has no authenticator app. use a passkey or a backup code.'],
  ['challenge_not_found', 'the passkey check expired. try again.'],
  ['assertion_failed', PASSKEY_FAILED],
  ['invalid_challenge_type', PASSKEY_FAILED],
  ['challenge_user_mismatch', PASSKEY_FAILED],
  ['passkey_not_found', "that passkey isn't on this account."],
  ['mfa_attempts_exceeded', TOO_MANY_TRIES],
  ['invalid_passkey_proof', TRY_AGAIN],
  ['mfa_proof_required', TRY_AGAIN],
  ['encryption_not_configured', TRY_AGAIN],
  ['user_not_found', TRY_AGAIN],
]);

/**
 * what a refused step-up says when the refusal is the ceremony's own: a proof
 * the server would not take, too many tries, or a step-up still owed. null for
 * any other refusal (a policy, a machine that left), which the dialog does not
 * answer for.
 */
export function stepUpRefusal(status: number, body: { code?: unknown; detail?: unknown }): string | null {
  const code = typeof body.code === 'string' ? body.code : null;
  if (status === 429) return TOO_MANY_TRIES;
  if (code !== null && PROOF_REFUSALS.has(code)) return PROOF_REFUSALS.get(code)!;
  if (code === 'step_up_required') return typeof body.detail === 'string' && body.detail ? body.detail : TRY_AGAIN;
  return null;
}

/** the browser half: post a proof, which opens the caller's window on the machine. */
export async function submitStepUpProof(
  siteId: string,
  machineId: string,
  proof: SwoopStepUpProof,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(stepUpRoute(siteId, machineId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mfaProof: proof }),
    });
  } catch {
    throw new SwoopStepUpError("that didn't go through. check your connection and try again.");
  }
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as { code?: unknown; detail?: unknown };
  // the route's own detail covers the policy refusals
  const detail = typeof body.detail === 'string' && body.detail ? body.detail : null;
  throw new SwoopStepUpError(stepUpRefusal(res.status, body) ?? detail ?? TRY_AGAIN);
}

/**
 * a ceremony failure the dialog may show verbatim. anything else is reported as
 * a generic failure: an unexpected error's message is not written for an
 * operator and has no business on screen.
 */
export class SwoopStepUpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwoopStepUpError';
  }
}

/**
 * package an entered code. the shape checks mirror `parseMfaProof` so a
 * typo costs no round trip; the code itself is never inspected further.
 */
export function codeStepUpProof(entered: string, isBackupCode: boolean): SwoopStepUpProof {
  const code = entered.trim();
  if (!code) {
    throw new SwoopStepUpError(
      isBackupCode ? 'enter a backup code.' : 'enter the code from your authenticator app.',
    );
  }
  if (!isBackupCode && !/^\d{6}$/.test(code)) {
    throw new SwoopStepUpError('an authenticator code is 6 digits.');
  }
  return isBackupCode ? { code, isBackupCode: true } : { code };
}

/**
 * run the passkey ceremony and hand back the assertion.
 *
 * the assertion is NOT verified here — the session-create route verifies it
 * in-process (`verifyPasskeyStepUpAssertion`), which is what makes it a live
 * proof rather than a claim the browser makes about itself. so this never calls
 * `/api/passkeys/step-up/verify`: that sibling flips the login session's mfa
 * gate, which is a different thing entirely.
 */
export async function passkeyStepUpProof(): Promise<SwoopStepUpProof> {
  const res = await fetch('/api/passkeys/step-up/options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const data = (await res.json().catch(() => ({}))) as {
    options?: PublicKeyCredentialRequestOptionsJSON;
    challengeId?: string;
    code?: string;
  };

  if (!res.ok || !data.options || !data.challengeId) {
    throw new SwoopStepUpError(
      data.code === 'no_passkeys'
        ? 'no passkeys are registered on this account — use your authenticator app instead.'
        : 'the passkey prompt could not be started.',
    );
  }

  let credential: AuthenticationResponseJSON;
  try {
    credential = await startAuthentication({ optionsJSON: data.options });
  } catch (error) {
    // a cancelled or timed-out prompt is an operator action, not a fault, and
    // the raw DOMException is no use to anyone reading it.
    throw new SwoopStepUpError(
      error instanceof Error && error.name === 'NotAllowedError'
        ? 'the passkey prompt was cancelled.'
        : 'the passkey prompt failed.',
    );
  }

  return { credential, challengeId: data.challengeId };
}
