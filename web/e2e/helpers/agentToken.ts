/**
 * An agent's ID token from the Auth emulator, for the agent routes that read
 * the bearer through `agentClaims` (lib/agentAuth.server.ts). The e2e web
 * server runs with FIREBASE_AUTH_EMULATOR_HOST, so it verifies tokens the
 * emulator signs.
 *
 * Password sign-in after setting the claims, as desktop-sync/agentToken.ts
 * does: custom-token minting wants a signing credential, and claims set
 * beforehand are baked into the ID token sign-in returns. The claim names are
 * snake_case on purpose; `agentClaims` and firestore.rules read them verbatim.
 */

import { AUTH_EMULATOR_URL, getAdminAuth } from './emulator';

/** anything non-empty works against the Auth emulator */
const EMULATOR_API_KEY = 'demo-api-key';
const AGENT_PASSWORD = 'e2e-agent-password';

/** an ID token for `machineId` on `siteId`, under the uid pairing gives that agent. */
export async function agentIdToken(siteId: string, machineId: string): Promise<string> {
  const auth = getAdminAuth();
  const uid = `agent_${siteId}_${machineId}`;
  const email = `${uid.toLowerCase()}@e2e.agent`;

  try {
    await auth.createUser({ uid, email, password: AGENT_PASSWORD, emailVerified: true });
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code !== 'auth/uid-already-exists' && code !== 'auth/email-already-exists') throw err;
    await auth.updateUser(uid, { email, password: AGENT_PASSWORD, emailVerified: true });
  }
  await auth.setCustomUserClaims(uid, { role: 'agent', site_id: siteId, machine_id: machineId });

  const res = await fetch(
    `${AUTH_EMULATOR_URL}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${EMULATOR_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: AGENT_PASSWORD, returnSecureToken: true }),
    },
  );
  if (!res.ok) throw new Error(`Auth emulator refused the agent sign-in (${res.status}): ${await res.text()}`);
  const { idToken } = (await res.json()) as { idToken?: string };
  if (!idToken) throw new Error('Auth emulator returned no idToken for the agent account');
  return idToken;
}
