/**
 * the step-up proof the session-create route wants, and nothing else yet — the
 * ceremony that produces one is the slot task 5.5 fills.
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

import type { AuthenticationResponseJSON } from '@simplewebauthn/browser';

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
