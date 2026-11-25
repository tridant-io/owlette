/**
 * agent credentials: the ID token a mint signs in for, and the refresh token the
 * agent trades for new ones. device-code pairing and a machine's move mint here;
 * refresh rotates its own. the caller creates the agent's auth user first, see
 * ensureAgentAuthUser.
 */

import crypto from 'crypto';
import { getAdminAuth } from '@/lib/firebase-admin';

function signInWithCustomToken(token: string, firebaseApiKey: string): Promise<Response> {
  return fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${firebaseApiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, returnSecureToken: true }),
    }
  );
}

/** a Firebase ID token for `agentUid` that carries `claims`. */
export async function mintAgentIdToken(
  agentUid: string,
  claims: Record<string, unknown>,
): Promise<string> {
  const adminAuth = getAdminAuth();
  const customToken = await adminAuth.createCustomToken(agentUid, claims);

  const firebaseApiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  if (!firebaseApiKey) {
    throw new Error('Firebase API key not configured');
  }

  const authResponse = await signInWithCustomToken(customToken, firebaseApiKey);
  if (!authResponse.ok) {
    const errorData = await authResponse.json();
    throw new Error(`Failed to exchange custom token: ${errorData.error?.message || 'Unknown error'}`);
  }

  authResponse.body?.cancel();

  // the claims are set before the second sign-in, so its ID token carries them.
  await adminAuth.setCustomUserClaims(agentUid, claims);

  const customTokenWithClaims = await adminAuth.createCustomToken(agentUid, claims);
  const refreshAuthResponse = await signInWithCustomToken(customTokenWithClaims, firebaseApiKey);
  if (!refreshAuthResponse.ok) {
    const errorData = await refreshAuthResponse.json();
    throw new Error(`Failed to refresh token with claims: ${errorData.error?.message || 'Unknown error'}`);
  }

  const refreshAuthData = await refreshAuthResponse.json();
  return refreshAuthData.idToken;
}

/** a new agent refresh token, and the hash its `agent_refresh_tokens` doc is keyed by. */
export function newRefreshToken(): { refreshToken: string; refreshTokenHash: string } {
  const refreshToken = crypto.randomBytes(64).toString('base64url');
  const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  return { refreshToken, refreshTokenHash };
}
