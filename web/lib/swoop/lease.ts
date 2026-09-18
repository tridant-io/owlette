/**
 * browser half of the 5-minute lease — the slot task 6.6 fills.
 *
 * the point of the lease is that authorisation is re-checked while the session
 * runs: a removed member, a site that turns swoop off, an excluded machine or a
 * revoked capability all take effect within one lease. renewal goes through
 * `session.renewLease()`, which is the hook's single code path to the lease
 * route — never a hand-rolled fetch, and never a token in a url.
 */

import type { SwoopDetach, SwoopSession } from '@/lib/swoop/features';

export function attach(_session: SwoopSession): SwoopDetach {
  return () => {};
}
