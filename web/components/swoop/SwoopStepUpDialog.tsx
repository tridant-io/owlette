'use client';

/**
 * the live second-factor ceremony that unlocks control. task 5.5 fills it.
 *
 * **these props are frozen.** the page mounts this component today with exactly
 * this contract so the ceremony can land without the page or the hook being
 * touched: `onProof` receives the body `parseMfaProof` accepts and the hook
 * forwards it verbatim into the session-create request. a proof is never
 * logged, never stored and never inspected on the way through.
 *
 * `enrolled: false` means the account holds no second factor at all — the
 * dialog shows an enrol hint pointing at the security settings rather than a
 * code field, because such an account cannot take control at all.
 */

import type { SwoopStepUpProps } from '@/lib/swoop/stepUp';

export function SwoopStepUpDialog(_props: SwoopStepUpProps) {
  return null;
}
