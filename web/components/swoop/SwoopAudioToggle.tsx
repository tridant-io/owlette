'use client';

/**
 * host audio on or off.
 *
 * audio starts muted and needs a user gesture of its own to unmute — the video
 * element is muted so it can autoplay, and that is `video/receiver.ts`'s, not
 * this toggle's, to undo. a machine with no render endpoint gets the disabled
 * state, never a toggle that silently does nothing.
 *
 * the click handler is the gesture, so it calls `toggle()` synchronously. an
 * `await` before it — even a resolved one — spends the transient activation
 * and the browser refuses the unmute.
 */

import { useCallback, useSyncExternalStore } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { swoopAudio, type SwoopAudioState } from '@/lib/swoop/audio';
import type { SwoopSession } from '@/lib/swoop/features';

export interface SwoopAudioToggleProps {
  session: SwoopSession | null;
}

const LABEL: Record<SwoopAudioState, string> = {
  unavailable: 'no audio endpoint',
  muted: 'unmute this machine',
  playing: 'mute this machine',
};

const noop = (): (() => void) => () => {};

export function SwoopAudioToggle({ session }: SwoopAudioToggleProps) {
  const audio = swoopAudio(session);
  const state = useSyncExternalStore(
    audio ? audio.subscribe : noop,
    // the server has no peer connection and no audio element, so both the
    // server snapshot and the pre-attach one are the same: nothing to play.
    () => audio?.state() ?? 'unavailable',
    () => 'unavailable' as SwoopAudioState,
  );

  const onClick = useCallback(() => audio?.toggle(), [audio]);

  const unavailable = state === 'unavailable';
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      disabled={unavailable}
      title={LABEL[state]}
      aria-label={LABEL[state]}
      aria-pressed={state === 'playing'}
      onClick={onClick}
    >
      {state === 'playing' ? <Volume2 aria-hidden /> : <VolumeX aria-hidden />}
    </Button>
  );
}
