'use client';

import { useEffect } from 'react';
import { auth } from '@/lib/firebase';

/**
 * while `active`, re-reads the signed-in user whenever this tab comes back,
 * since the verification link usually opens in another one, and calls
 * `onVerified` once the email reads verified.
 */
export function useEmailVerifiedOnReturn(active: boolean, onVerified: () => unknown): void {
  useEffect(() => {
    if (!active) return;
    // focus and visibilitychange both fire on the way back. one check at a time, `onVerified`
    // included: two plan reads would race to start the trial.
    let checking = false;
    const recheck = () => {
      const current = auth?.currentUser;
      if (checking || !current || document.visibilityState !== 'visible') return;
      checking = true;
      current
        .reload()
        .then(() => (current.emailVerified ? onVerified() : undefined))
        // offline or signed out mid-flight; the next focus tries again
        .catch(() => undefined)
        .finally(() => {
          checking = false;
        });
    };
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
    return () => {
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', recheck);
    };
  }, [active, onVerified]);
}
