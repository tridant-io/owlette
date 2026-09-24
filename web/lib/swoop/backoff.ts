/**
 * the one backoff ladder every swoop retry walks, and the one list of what
 * a retry is for.
 *
 * the owner's ruling is that a session stays up indefinitely, at all costs.
 * so nothing in the browser half gives up on a path that may come back: the
 * signaling socket redials forever, ice restarts forever, and a session that
 * ended for a reason that was not a decision is started again. what it never
 * retries is a decision — an authorisation withdrawn, a cap reached, a host
 * that failed its proof — because retrying a decision is a storm, not
 * resilience, and the operator is the one to act on those.
 */

export interface BackoffLadder {
  /** the first delay; every attempt after it doubles, up to `capMs`. */
  baseMs: number;
  capMs: number;
}

/**
 * the delay before `attempt` (1-based), with full jitter in [½, 1] of the
 * rung so a fleet that fails together does not retry together. attempt 0 or
 * less is "now".
 */
export function backoffDelayMs(attempt: number, ladder: BackoffLadder, random: () => number = Math.random): number {
  if (attempt <= 0) return 0;
  const rung = Math.min(ladder.baseMs * 2 ** (attempt - 1), ladder.capMs);
  return Math.round(rung * (0.5 + random() * 0.5));
}

/** why a session ended, as the hook and the features name it. */
export type SwoopEndReason =
  | 'closed'
  | 'unmounted'
  | 'kill'
  | 'lease_expired'
  | 'lease_refused'
  | 'host_gone'
  | 'signal_lost'
  | 'peer_failed'
  | 'start_failed'
  | 'refused';

const TRANSIENT_ENDS: ReadonlySet<string> = new Set<SwoopEndReason>([
  'lease_expired',
  'host_gone',
  'signal_lost',
  'peer_failed',
  'start_failed',
]);

/**
 * whether an end is worth a fresh session on its own. a decision is not:
 * the operator ended it, an admin killed it, the api withdrew the lease or
 * refused the session, or the host failed its proof. everything else that
 * is named is a path that may come back; a reason nobody named is treated
 * as a decision, because a retry nobody asked for is the storm this guards.
 */
export function isTransientEnd(reason: string): boolean {
  return TRANSIENT_ENDS.has(reason);
}
