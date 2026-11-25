/**
 * how a person in a swoop session is named, on the bar's pills and the
 * picker's cards alike: first name and last initial, the full name on hover,
 * `viewer` until the record names them. one rule, so the two cannot drift.
 */

import { getUserShortName } from '@/lib/userUtils';

export const UNNAMED_VIEWER = 'viewer';

export interface ViewerLabel {
  /** first name and last initial. */
  short: string;
  /** the full name, as far as it is known. */
  full: string;
}

export function viewerLabel(name: { displayName: string | null; email: string | null } | null): ViewerLabel {
  const named = name?.displayName || name?.email ? name : null;
  return {
    short: named ? getUserShortName(named) : UNNAMED_VIEWER,
    full: named?.displayName ?? named?.email ?? UNNAMED_VIEWER,
  };
}
