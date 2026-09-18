'use client';

/**
 * host audio on or off. task 6.4 fills it.
 *
 * audio starts muted and needs a user gesture of its own to unmute — the video
 * element is muted so it can autoplay, and that is `video/receiver.ts`'s, not
 * this toggle's, to undo. a machine with no render endpoint gets the disabled
 * state, never a toggle that silently does nothing.
 */

import type { SwoopSession } from '@/lib/swoop/features';

export interface SwoopAudioToggleProps {
  session: SwoopSession | null;
}

export function SwoopAudioToggle(_props: SwoopAudioToggleProps) {
  return null;
}
