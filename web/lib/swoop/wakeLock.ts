/**
 * keeps the screen awake for the life of a session.
 *
 * a viewer that walks away for an hour comes back to a live picture rather
 * than a sleeping display and a reconnect (owner ruling: a session holds as
 * long as the tab does). the screen wake lock is the one lever a page has:
 * it stops the display from dimming and sleeping while the tab is visible,
 * and the browser releases it the moment the tab is hidden — so it is taken
 * again every time the tab comes back. a closed lid is the os's decision and
 * out of reach; the lease renewer and the reconnect ladder cover that case.
 *
 * a browser without the api, an insecure context, or a refusal (low battery,
 * a policy) all mean the same thing: the session runs without it.
 */

import type { SwoopDetach, SwoopSession } from '@/lib/swoop/features';

export function attach(_session: SwoopSession): SwoopDetach {
  const wakeLock = typeof navigator === 'undefined' ? undefined : navigator.wakeLock;
  if (!wakeLock) return () => {};

  let sentinel: WakeLockSentinel | null = null;
  let stopped = false;

  const acquire = async (): Promise<void> => {
    if (stopped || sentinel || document.visibilityState !== 'visible') return;
    try {
      const taken = await wakeLock.request('screen');
      if (stopped) {
        await taken.release();
        return;
      }
      sentinel = taken;
      // the browser releases it on its own when the tab is hidden; the next
      // visibility change takes it again.
      taken.addEventListener('release', () => {
        if (sentinel === taken) sentinel = null;
      });
    } catch {
      // refused: the session does not depend on it.
    }
  };

  const onVisibility = () => {
    if (document.visibilityState === 'visible') void acquire();
  };
  document.addEventListener('visibilitychange', onVisibility);
  void acquire();

  return () => {
    stopped = true;
    document.removeEventListener('visibilitychange', onVisibility);
    const held = sentinel;
    sentinel = null;
    void held?.release();
  };
}
