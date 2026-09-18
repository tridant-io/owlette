'use client';

/**
 * the session bar: connection state, the fullscreen / keyboard-lock controls
 * and whatever menus the page hands it as children. task 5.2 fills it.
 *
 * it renders nothing today so the stage is the whole window while the rest of
 * the wave lands.
 */

import type { SwoopSession } from '@/lib/swoop/features';
import type { SwoopSessionState } from '@/hooks/useSwoopSession';

export interface SwoopToolbarProps {
  session: SwoopSession | null;
  state: SwoopSessionState;
  error: string | null;
  onEnd: () => void;
  children?: React.ReactNode;
}

export function SwoopToolbar(_props: SwoopToolbarProps) {
  return null;
}
