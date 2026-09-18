/**
 * browser half of host audio — the slot task 6.4 fills.
 *
 * audio arrives on its own `MediaStream`, never the video one, so the browser
 * cannot a/v-sync and hold the picture back. it starts muted and unmutes on a
 * user gesture of its own; `video/receiver.ts` mutes the video element so it
 * can autoplay, and that is not this feature's to undo.
 */

import type { SwoopDetach, SwoopSession } from '@/lib/swoop/features';

export function attach(_session: SwoopSession): SwoopDetach {
  return () => {};
}
