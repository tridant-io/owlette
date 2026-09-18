'use client';

/**
 * which output the host captures. task 6.4 fills it.
 *
 * outputs are named by a stable device path, never an index — a virtual display
 * driver moves indices. a machine with no usable output shows the lowercase
 * dummy-plug message rather than an empty list, and swoop never changes the
 * machine's display configuration to produce one.
 */

import type { SwoopSession } from '@/lib/swoop/features';

export interface SwoopDisplayPickerProps {
  session: SwoopSession | null;
}

export function SwoopDisplayPicker(_props: SwoopDisplayPickerProps) {
  return null;
}
