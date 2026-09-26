/**
 * browser half of the 5-minute lease (PROTOCOL.md §10).
 *
 * the point of the lease is that authorisation is re-checked while the session
 * runs: a removed member, a site that turns swoop off, an excluded machine or a
 * revoked capability all take effect within one lease. renewal goes through
 * `session.renewLease()`, which is the hook's single code path to the lease
 * route — never a hand-rolled fetch, and never a token in a url.
 *
 * three decisions that are not obvious from the contract:
 *
 * 1. **renewal is timed from the expiry the server returned, not from a fixed
 *    interval.** the server owns `leaseSeconds`; a hard-coded 180 s here would
 *    silently stop renewing the day the default moves.
 * 2. **~60 % of the remaining life.** at 300 s that leaves two minutes and a
 *    second attempt before the host's `expiry + 30 s` grace runs out, so one
 *    lost request costs nothing. renewing at 90 % would make every retry a
 *    coin toss against the grace.
 * 3. **a withdrawal is terminal; nothing else is.** the api's policy refusal
 *    is the authorisation going away — exactly what the lease is for — and the
 *    session ends immediately. anything else, a lapsed login and a 403 from an
 *    edge in front of the app included, is retried until the host's grace
 *    would have run out anyway, and the next session's mint re-checks it all:
 *    a flaky minute should not cost the operator the machine they are in the
 *    middle of fixing.
 */

import { isWithdrawal } from '@/lib/swoop/backoff';
import type { SwoopDetach, SwoopSession } from '@/lib/swoop/features';

/** renew this far into the lease's remaining life. */
const RENEW_AT = 0.6;

/** never sooner than this, however short a lease the server hands back. */
const MIN_DELAY_MS = 1_000;

/** the gap between retries after a renewal that failed for a reason that is not a refusal. */
const RETRY_DELAY_MS = 5_000;

/** the host drops a viewer at `expiry + 30 s` (§10); stop retrying before that. */
const GRACE_MS = 30_000;

/**
 * a refusal the browser must not retry. `leaseFailure` makes one for the api's
 * policy answer only, so this module can tell "you are no longer allowed in"
 * from everything else that can go wrong on the way to the lease route.
 */
export class SwoopLeaseRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SwoopLeaseRefused';
  }
}

/** what a renewal throws when the lease route answers with a failure. */
export function leaseFailure(status: number, problem: { code?: unknown; detail?: unknown; error?: unknown }): Error {
  const code = typeof problem.code === 'string' ? problem.code : null;
  const detail =
    (typeof problem.detail === 'string' && problem.detail) ||
    (typeof problem.error === 'string' && problem.error) ||
    'the session lease could not be renewed.';
  return isWithdrawal(status, code) ? new SwoopLeaseRefused(status, detail) : new Error(detail);
}

function delayFor(expiresAt: number, now: number): number {
  return Math.max(MIN_DELAY_MS, (expiresAt - now) * RENEW_AT);
}

export function attach(session: SwoopSession): SwoopDetach {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const arm = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      void renew();
    }, ms);
  };

  // a refusal is a decision and ends the session for good; a lease lost to a
  // dropped path is an end the hook starts over from. the page says which.
  const stop = (message: string, reason: 'lease_refused' | 'lease_expired') => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    session.end(reason, message);
  };

  const renew = async () => {
    if (stopped) return;
    try {
      const lease = await session.renewLease();
      // the api's answer is half of a renewal: the host keeps its own ledger
      // and drops a viewer whose lease lapses past its grace, so the token is
      // presented down the control channel too. left out, every session
      // ended at 5 min 30 s however often the api was asked (b4a, 2026-09-24).
      await session.peer.presentLease(lease.viewerJwt);
      arm(delayFor(lease.expiresAt, Date.now()));
    } catch (err) {
      if (stopped) return;
      if (err instanceof SwoopLeaseRefused) {
        // the api states the withdrawal in its own sentence, which is the one
        // to show.
        stop(err.message, 'lease_refused');
        return;
      }
      // past the grace the host has already dropped us, so a retry would only
      // renew a lease for a session that no longer exists.
      if (Date.now() + RETRY_DELAY_MS >= session.leaseExpiresAt() + GRACE_MS) {
        stop('this session lost its lease and ended.', 'lease_expired');
        return;
      }
      arm(RETRY_DELAY_MS);
    }
  };

  arm(delayFor(session.leaseExpiresAt(), Date.now()));

  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
