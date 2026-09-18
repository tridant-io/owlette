/**
 * browser half of clipboard sync — the slot task 6.3 fills.
 *
 * clipboard traffic rides `swoop-control`, not a channel of its own: the
 * transport caps buffering at 128 KiB across all channels, so five channels is
 * one pacing budget instead of six competing ones. only a viewer whose verified
 * jwt carries `ctl` may push to the host, and the host is what enforces that.
 */

import type { SwoopDetach, SwoopSession } from '@/lib/swoop/features';

export function attach(_session: SwoopSession): SwoopDetach {
  return () => {};
}
