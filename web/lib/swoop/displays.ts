/**
 * browser half of display selection — the slot task 6.4 fills.
 *
 * the host names outputs by a stable device path, never an index, because a
 * virtual display driver moves indices. the roster arrives on `swoop-control`
 * (`hello-host`) and a switch is a `display` message, which the host gates on
 * `ctl` since the chosen output is shared state across every viewer.
 */

import type { SwoopDetach, SwoopSession } from '@/lib/swoop/features';

export function attach(_session: SwoopSession): SwoopDetach {
  return () => {};
}
