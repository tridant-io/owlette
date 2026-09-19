'use client';

/**
 * the key combinations the browser swallows — ctrl+alt+del, win, alt+tab and
 * esc. task 6.1 fills it.
 *
 * they travel on the same input channel as every other key; ctrl+alt+del is the
 * one the host turns into a real secure-attention sequence, and only for a
 * viewer whose verified jwt carries `ctl`.
 */

import type { SwoopSession } from '@/lib/swoop/features';

export interface SwoopSpecialKeysProps {
  session: SwoopSession | null;
}

export function SwoopSpecialKeys(_props: SwoopSpecialKeysProps) {
  return null;
}
