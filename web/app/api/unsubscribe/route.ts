import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';
import { publicOrigin } from '@/lib/publicOrigin.server';

/**
 * Unsubscribe from alert emails. The token is an HMAC-signed userId, so no
 * authentication is needed.
 *
 * GET /api/unsubscribe?token=... — the link in every alert email. It changes
 * nothing: a valid token is sent on to the /unsubscribe page, which asks first,
 * because mail scanners open links on their own.
 *
 * POST /api/unsubscribe `{ token }` — what that page sends once the person
 * confirms. Turns every alert email off.
 */

const ALERT_PREFERENCES = {
  healthAlerts: false,
  processAlerts: false,
  thresholdAlerts: false,
  cortexAlerts: false,
  displayAlerts: false,
  talonAlerts: false,
  apiKeyAlerts: false,
};

function getSecret(): string | null {
  return process.env.CRON_SECRET || null;
}

/** Generate a signed unsubscribe token for a userId. Throws when no secret is configured. */
export function generateUnsubscribeToken(userId: string): string {
  const secret = getSecret();
  if (!secret) throw new Error('CRON_SECRET is not configured; unsubscribe links cannot be signed');
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(userId);
  const signature = hmac.digest('hex');
  // Encode as base64url: userId:signature
  return Buffer.from(`${userId}:${signature}`).toString('base64url');
}

/** Verify and extract userId from a token. No secret verifies nothing. */
function verifyToken(token: string): string | null {
  const secret = getSecret();
  if (!secret) return null;
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf-8');
    const colonIdx = decoded.lastIndexOf(':');
    if (colonIdx === -1) return null;

    const userId = decoded.substring(0, colonIdx);
    const signature = decoded.substring(colonIdx + 1);

    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(userId);
    const expected = hmac.digest('hex');

    if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return userId;
    }
    return null;
  } catch {
    return null;
  }
}

/** The token's userId, or the 400 that refuses it. */
function checkToken(token: unknown): { userId: string } | { response: NextResponse } {
  if (typeof token !== 'string' || !token) {
    return { response: NextResponse.json({ error: 'Missing token' }, { status: 400 }) };
  }
  const userId = verifyToken(token);
  if (!userId) {
    return { response: NextResponse.json({ error: 'Invalid or expired token' }, { status: 400 }) };
  }
  return { userId };
}

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token') ?? '';
  const checked = checkToken(token);
  if ('response' in checked) return checked.response;

  return NextResponse.redirect(
    `${publicOrigin(request)}/unsubscribe?token=${encodeURIComponent(token)}`,
  );
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
  const checked = checkToken(body?.token);
  if ('response' in checked) return checked.response;

  try {
    await getAdminDb().collection('users').doc(checked.userId).set(
      { preferences: ALERT_PREFERENCES },
      { merge: true }
    );
    return NextResponse.json({ unsubscribed: true });
  } catch (error) {
    return apiError(error, 'unsubscribe');
  }
}
