'use client';

/**
 * the per-stage latency breakdown — capture, encode, send, arrive, decode,
 * present — plus app-level rtt and the path profile. tasks 5.2 and 7.6 fill it.
 *
 * every number it will show already arrives through `FrameObservation`: it must
 * read them, never arm a second `requestVideoFrameCallback` chain on the video
 * element to get its own, which would double-count every presented frame.
 */

import type { SwoopSession } from '@/lib/swoop/features';
import type { SwoopStats } from '@/hooks/useSwoopSession';

export interface SwoopStatsOverlayProps {
  session: SwoopSession | null;
  stats: SwoopStats;
}

export function SwoopStatsOverlay(_props: SwoopStatsOverlayProps) {
  return null;
}
