'use client';

import { useState, useEffect, useCallback } from 'react';
import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import type { PasskeyInfo } from '@/lib/webauthn.server';

export { browserSupportsWebAuthn };

/**
 * Slug `checkMfaEnrollmentGate` returns with its 403 when the account already
 * holds a second factor and this session hasn't proved one.
 *
 * Duplicated as a literal rather than imported from
 * `lib/mfaEnrollmentGate.server.ts`, which pulls in `firebase-admin` and
 * `next/server` — neither belongs in a client bundle. Keep in sync with
 * `MFA_CHALLENGE_REQUIRED` there.
 */
export const MFA_CHALLENGE_REQUIRED = 'mfa_challenge_required';

/**
 * Error carrying the server's machine-readable `code` alongside its message.
 *
 * The gate's 403 body is `{ error, code }`. A bare `new Error(data.error)`
 * strands the caller: it can't tell "verify your existing factor first"
 * (recoverable — offer a step-up) from "passkey already registered" (not), so
 * every gated attempt dead-ends in a toast. The slug is never shown to a human.
 */
export class PasskeyApiError extends Error {
  code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'PasskeyApiError';
    this.code = code;
  }
}

/** True when `err` is the enrollment gate asking for a challenge to be cleared. */
export function isMfaChallengeRequired(err: unknown): boolean {
  return err instanceof PasskeyApiError && err.code === MFA_CHALLENGE_REQUIRED;
}

/**
 * Failed response -> `PasskeyApiError` carrying both legs of the body.
 * `fallback` covers a response with no JSON at all (a proxy 502, say).
 */
async function passkeyApiError(res: Response, fallback: string): Promise<PasskeyApiError> {
  // the gate answers `{ error, code }`; a session refused before it answers a problem with `detail`
  const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string; code?: string };
  return new PasskeyApiError(body.error || body.detail || fallback, body.code);
}

export function usePasskeys(userId: string | undefined) {
  const [passkeys, setPasskeys] = useState<PasskeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshPasskeys = useCallback(async () => {
    if (!userId) {
      setPasskeys([]);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const res = await fetch(`/api/passkeys/list?userId=${encodeURIComponent(userId)}`);
      if (!res.ok) {
        throw new Error('Failed to fetch passkeys');
      }
      const data = await res.json();
      setPasskeys(data.passkeys || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch passkeys');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    refreshPasskeys();
  }, [refreshPasskeys]);

  const registerPasskey = useCallback(async (friendlyName?: string) => {
    if (!userId) throw new Error('Not authenticated');

    const optionsRes = await fetch('/api/passkeys/register/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });

    if (!optionsRes.ok) {
      // Gated: an account with an existing factor must clear a challenge before
      // adding another. Callers key off `code` to offer a step-up.
      throw await passkeyApiError(optionsRes, 'Failed to get registration options');
    }

    const options = await optionsRes.json();

    const credential = await startRegistration({ optionsJSON: options });

    const verifyRes = await fetch('/api/passkeys/register/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        credential,
        friendlyName: friendlyName || 'Passkey',
      }),
    });

    if (!verifyRes.ok) {
      throw await passkeyApiError(verifyRes, 'Failed to verify registration');
    }

    await refreshPasskeys();
  }, [userId, refreshPasskeys]);

  const deletePasskey = useCallback(async (credentialId: string) => {
    if (!userId) throw new Error('Not authenticated');

    const res = await fetch(
      `/api/passkeys/${encodeURIComponent(credentialId)}?userId=${encodeURIComponent(userId)}`,
      { method: 'DELETE' }
    );

    if (!res.ok) {
      throw await passkeyApiError(res, 'Failed to delete passkey');
    }

    await refreshPasskeys();
  }, [userId, refreshPasskeys]);

  const renamePasskey = useCallback(async (credentialId: string, name: string) => {
    if (!userId) throw new Error('Not authenticated');

    const res = await fetch(`/api/passkeys/${encodeURIComponent(credentialId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, friendlyName: name }),
    });

    if (!res.ok) {
      throw await passkeyApiError(res, 'Failed to rename passkey');
    }

    setPasskeys((prev) =>
      prev.map((p) =>
        p.credentialId === credentialId ? { ...p, friendlyName: name } : p
      )
    );
  }, [userId]);

  return {
    passkeys,
    loading,
    error,
    supported: browserSupportsWebAuthn(),
    registerPasskey,
    deletePasskey,
    renamePasskey,
    refreshPasskeys,
  };
}
