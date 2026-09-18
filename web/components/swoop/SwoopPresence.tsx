'use client';

/**
 * who else is in this session, who holds control, and where their cursors are.
 * task 6.7 fills it.
 *
 * the roster is the host's: `ctl` comes from each viewer's verified jwt and
 * nothing a viewer sends can change it. other viewers' cursors are overlay
 * elements inside the stage; the local cursor stays a css cursor.
 */

import type { SwoopSession } from '@/lib/swoop/features';

export interface SwoopPresenceProps {
  session: SwoopSession | null;
}

export function SwoopPresence(_props: SwoopPresenceProps) {
  return null;
}
