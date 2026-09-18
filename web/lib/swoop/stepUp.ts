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

export type SwoopStepUpProof =
  | { code: string; isBackupCode?: boolean }
  | { credential: AuthenticationResponseJSON; challengeId: string };

/**
 * the step-up dialog's props, frozen at task 4.2 so later waves fill the dialog
 * without touching the page or the hook.
 */
export interface SwoopStepUpProps {
  open: boolean;
  /** false when the account holds no second factor at all — it cannot control. */
  enrolled: boolean;
  /** resolves when the retry has been made; rejects with the reason to show. */
  onProof: (proof: SwoopStepUpProof) => Promise<void>;
  onCancel: () => void;
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
