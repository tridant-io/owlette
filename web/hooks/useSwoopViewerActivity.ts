/**
 * who in a swoop session is moving the pointer or clicking right now, by the
 * roster's viewer id (`lib/swoop/activity.ts`). anyone missing from the map is
 * idle. it changes only when a light goes on or out, never at a move's rate.
 */

import { useSyncExternalStore } from 'react';
import { NO_ACTIVITY, swoopActivity, type SwoopActivityState } from '@/lib/swoop/activity';
import type { SwoopSession } from '@/lib/swoop/features';

const subscribeNever = (): (() => void) => () => {};
const noActivity = (): SwoopActivityState => NO_ACTIVITY;

export function useSwoopViewerActivity(session: SwoopSession | null): SwoopActivityState {
  const store = swoopActivity(session);
  return useSyncExternalStore(store?.subscribe ?? subscribeNever, store?.get ?? noActivity, noActivity);
}
