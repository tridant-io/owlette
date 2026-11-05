/**
 * Client half of the app-link sign-in handoff; the routes and the security note live in
 * lib/appLink.server.ts.
 */
import { signInWithCustomToken } from 'firebase/auth';
import { auth } from '@/lib/firebase';

/** A non-2xx answer from an app-link route; `status` is what the callers branch on. */
export class AppLinkError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'AppLinkError';
    this.status = status;
  }
}

async function postJson(path: string, body: Record<string, unknown> = {}): Promise<Response> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new AppLinkError(res.status, data.error || `request failed (${res.status})`);
  }
  return res;
}

/** website → app: a 60 s code for the signed-in caller, for the owlette-swoop:// deep link. */
export async function mintAppLink(): Promise<{ code: string; expiresAt: number }> {
  return (await postJson('/api/auth/app-link')).json();
}

/** cold app start: a pending code to approve in a browser, and the secret to poll it with. */
export async function startAppLink(): Promise<{
  code: string;
  secret: string;
  approveUrl: string;
  expiresAt: number;
}> {
  return (await postJson('/api/auth/app-link/start')).json();
}

/** The browser approves a pending code for the signed-in caller. */
export async function approveAppLink(code: string): Promise<void> {
  await postJson('/api/auth/app-link/approve', { code });
}

/** `{ status: 'pending' }` until approved, then the custom token once; throws on 404/410. */
export async function exchangeAppLink(
  code: string,
  secret?: string,
): Promise<{ status: 'pending' } | { customToken: string }> {
  const res = await postJson('/api/auth/app-link/exchange', secret ? { code, secret } : { code });
  if (res.status === 202) return { status: 'pending' };
  const { customToken } = await res.json();
  return { customToken };
}

/** Signs in with the exchanged token, then mints the session cookie the way AuthContext does. */
export async function completeAppLinkSignIn(customToken: string): Promise<void> {
  if (!auth) throw new Error('firebase authentication is not configured');
  const { user } = await signInWithCustomToken(auth, customToken);
  const idToken = await user.getIdToken();
  await postJson('/api/auth/session', { userId: user.uid, idToken });
}

/** Same-origin relative paths only; `//host` and `/\host` both leave the site. */
export function safeNextPath(value: string | null, fallback = '/swoop'): string {
  return value && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')
    ? value
    : fallback;
}
