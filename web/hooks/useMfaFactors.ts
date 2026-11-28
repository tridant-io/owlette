'use client';

import { useCallback, useEffect, useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import type { PasskeyInfo } from '@/lib/webauthn.server';

/**
 * Single client-side owner of the account's second-factor inventory.
 *
 * Fetch-based, never a direct Firestore read — it cannot be otherwise:
 * `firestore.rules` keeps `mfaFactors`/`mfaEnrolledAt` Admin-SDK-only, so
 * `/api/mfa/factors` is the only route this state travels.
 *
 * Passkey register/delete/rename deliberately stay in `usePasskeys`; this hook
 * reports the inventory and owns the two mutations that had no client before —
 * removing TOTP, and the in-place step-up that unblocks enrollment.
 */

export interface MfaTotpFactor {
  enrolled: boolean;
  /** ISO-8601, or null on an account enrolled before the field existed. */
  enrolledAt: string | null;
}

export interface MfaFactorsSnapshot {
  totp: MfaTotpFactor;
  passkeys: PasskeyInfo[];
  /** TOTP (0 or 1) + registered passkeys. Zero means mandatory setup. */
  totalFactors: number;
  /** Unused backup codes, so a code is offered only while one is left; null when unknown. */
  backupCodeCount: number | null;
  /**
   * Has this session cleared an MFA challenge? Mirrors `checkMfaEnrollmentGate`
   * so the UI can offer a step-up before walking into a 403.
   */
  mfaVerified: boolean;
}

/** What the UI renders before the first response lands. */
const EMPTY_SNAPSHOT: MfaFactorsSnapshot = {
  totp: { enrolled: false, enrolledAt: null },
  passkeys: [],
  totalFactors: 0,
  backupCodeCount: null,
  mfaVerified: false,
};

/** Pull the server's own sentence out of a failed response, else a fallback. */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error || fallback;
}

export function useMfaFactors(userId: string | undefined) {
  const [factors, setFactors] = useState<MfaFactorsSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!userId) {
      setFactors(EMPTY_SNAPSHOT);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      // No userId in the request: the route derives it from the session.
      const res = await fetch('/api/mfa/factors');
      if (!res.ok) {
        throw new Error(await errorMessage(res, 'failed to load second factors'));
      }
      const data = (await res.json()) as Partial<MfaFactorsSnapshot>;
      setFactors({
        totp: data.totp ?? EMPTY_SNAPSHOT.totp,
        passkeys: data.passkeys ?? [],
        totalFactors: data.totalFactors ?? 0,
        backupCodeCount: data.backupCodeCount ?? null,
        mfaVerified: data.mfaVerified === true,
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load second factors');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /**
   * Remove the TOTP factor. `/api/mfa/disable` demands live proof every time (a
   * current code or an unused backup code), hence the argument rather than a
   * warm session. Removing the last factor is allowed and re-arms
   * `requiresMfaSetup` — the route owns that decision.
   */
  const removeTotp = useCallback(
    async (code: string, isBackupCode = false) => {
      const res = await fetch('/api/mfa/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, isBackupCode }),
      });

      if (!res.ok) {
        throw new Error(await errorMessage(res, 'failed to remove authenticator app'));
      }

      await refresh();
    },
    [refresh],
  );

  /**
   * Clear this session's MFA challenge with a passkey, in place — the
   * enrollment gate refuses a second factor from an unproved session, and
   * bouncing to /verify-2fa costs the user their open dialog.
   *
   * Uses `/api/passkeys/step-up/*`, NOT `/authenticate/*` (the pre-login route
   * that mints a session).
   */
  const stepUpWithPasskey = useCallback(async () => {
    const optionsRes = await fetch('/api/passkeys/step-up/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!optionsRes.ok) {
      throw new Error(await errorMessage(optionsRes, 'failed to start passkey verification'));
    }
    const { options, challengeId } = await optionsRes.json();

    const credential = await startAuthentication({ optionsJSON: options });

    const verifyRes = await fetch('/api/passkeys/step-up/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential, challengeId }),
    });
    if (!verifyRes.ok) {
      throw new Error(await errorMessage(verifyRes, 'passkey verification failed'));
    }

    // Cookie re-minted with `mfaVerified: true`; refresh drops the callout.
    await refresh();
  }, [refresh]);

  return {
    factors,
    loading,
    error,
    refresh,
    removeTotp,
    stepUpWithPasskey,
  };
}
