/**
 * browser half of the viewer roster — the slot task 6.7 fills.
 *
 * the host publishes who is connected, who holds control and where each
 * controller's cursor is. the roster is the host's, not ours: `ctl` comes from
 * each viewer's verified jwt and nothing a viewer sends can change it.
 */

import type { SwoopDetach, SwoopSession } from '@/lib/swoop/features';

export function attach(_session: SwoopSession): SwoopDetach {
  return () => {};
}
