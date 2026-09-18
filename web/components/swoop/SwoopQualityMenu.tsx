'use client';

/**
 * the quality ceiling — bandwidth, resolution, fps and codec preference. task
 * 6.5 fills it, writing through the session's existing control channel.
 *
 * a preset is a ceiling, not a setting: the host's governor still adapts below
 * it, so the menu must never promise a rate the session will actually hold.
 */

import type { SwoopSession } from '@/lib/swoop/features';

export interface SwoopQualityMenuProps {
  session: SwoopSession | null;
}

export function SwoopQualityMenu(_props: SwoopQualityMenuProps) {
  return null;
}
