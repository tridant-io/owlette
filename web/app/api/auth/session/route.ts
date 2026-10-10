/**
 * Session management API — HTTPOnly cookie sessions.
 * POST create (after Firebase auth) · DELETE sign out · GET status.
 * Rate limited to 10 requests/min per IP.
 *
 * MFA (Wave 2): POST bakes `mfaRequired` / `mfaVerified` into the cookie from
 * `users/{uid}.mfaEnrolled`; GET exposes them as UX hints only — the proxy is the gate.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  createSession,
  destroySession,
  getSessionData,
} from '@/lib/sessionManager.server';
import { withRateLimit } from '@/lib/withRateLimit';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';
import { appLinkMfaFromIdToken, type AppLinkMfa } from '@/lib/appLink.server';

/**
 * POST /api/auth/session — create a session after successful Firebase auth.
 * Body: `{ idToken, userId? (must match idToken), durationDays? }`. 10 req/min per IP.
 */
export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const body = await request.json();
    const { userId, durationDays = 7, idToken } = body;

    if (!idToken || typeof idToken !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid ID token' },
        { status: 400 }
      );
    }

    let verifiedUserId: string;
    let appLinkMfa: AppLinkMfa | undefined;
    try {
      const adminAuth = getAdminAuth();
      const decoded = await adminAuth.verifyIdToken(idToken);
      verifiedUserId = decoded.uid;
      appLinkMfa = appLinkMfaFromIdToken(decoded);
    } catch {
      return NextResponse.json(
        { error: 'Invalid or expired ID token' },
        { status: 401 }
      );
    }

    // Optional userId must match verified token
    if (userId && userId !== verifiedUserId) {
      return NextResponse.json(
        { error: 'User ID does not match token' },
        { status: 403 }
      );
    }

    if (durationDays && (typeof durationDays !== 'number' || durationDays < 1 || durationDays > 30)) {
      return NextResponse.json(
        { error: 'Invalid duration (must be 1-30 days)' },
        { status: 400 }
      );
    }

    const userDoc = await getAdminDb().collection('users').doc(verifiedUserId).get();
    if (userDoc.exists && typeof userDoc.data()?.deletedAt === 'number') {
      return NextResponse.json(
        { error: 'User is deleted or inactive' },
        { status: 403 }
      );
    }

    // Session creation reads users/{uid}.mfaEnrolled and bakes mfaRequired/mfaVerified into
    // the cookie; the proxy enforces the gate, so the POST response needn't surface them.
    // An app-link sign-in inherits the approving browser session's MFA state, and the time of
    // its ceremony rather than this sign-in's.
    await createSession(verifiedUserId, durationDays, appLinkMfa?.satisfiedBy, appLinkMfa?.completedAt);

    return NextResponse.json({
      success: true,
      message: 'Session created',
      expiresIn: durationDays * 24 * 60 * 60, // seconds
    });
  } catch (error) {
    return apiError(error, 'auth/session POST');
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});

/** DELETE /api/auth/session — destroy the current session (sign out). */
export async function DELETE() {
  try {
    await destroySession();

    return NextResponse.json({
      success: true,
      message: 'Session destroyed',
    });
  } catch (error) {
    return apiError(error, 'auth/session DELETE');
  }
}

/**
 * GET /api/auth/session — session status.
 * `{ authenticated, userId, expiresAt, mfaRequired, mfaVerified, mfaCompletedAt }`; the
 * mfa* fields are null for pre-Wave-2 sessions and are UX hints only — the proxy is the
 * authoritative MFA gate, not this response.
 */
export async function GET() {
  try {
    const sessionData = await getSessionData();

    if (!sessionData) {
      return NextResponse.json({
        authenticated: false,
        userId: null,
        expiresAt: null,
        mfaRequired: null,
        mfaVerified: null,
        mfaCompletedAt: null,
      });
    }

    return NextResponse.json({
      authenticated: true,
      userId: sessionData.userId,
      expiresAt: sessionData.expiresAt,
      expiresIn: Math.max(0, Math.floor((sessionData.expiresAt - Date.now()) / 1000)), // seconds
      mfaRequired:
        typeof sessionData.mfaRequired === 'boolean'
          ? sessionData.mfaRequired
          : null,
      mfaVerified:
        typeof sessionData.mfaVerified === 'boolean'
          ? sessionData.mfaVerified
          : null,
      mfaCompletedAt: sessionData.mfaCompletedAt ?? null,
    });
  } catch (error) {
    return apiError(error, 'auth/session GET');
  }
}
