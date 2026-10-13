/**
 * POST /api/auth/app-link/approve — the browser approves a code an app started
 * (lib/appLink.server.ts).
 *
 * Login cookie with mfa complete; body `{ code }`. Pending → approved for the caller, with the
 * caller's mfa state.
 *
 * 200 `{ status: 'approved' }` · 400 no code · 401 no session · 403 mfa pending or inactive user ·
 * 404 unknown or expired · 409 not pending. Per-user limit.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getUserIdFromSession, withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError } from '@/lib/apiAuth.server';
import { apiError } from '@/lib/apiErrorResponse';
import { approveAppLink, requireAppLinkApprover } from '@/lib/appLink.server';

export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      const approver = await requireAppLinkApprover(request);
      const body = await request.json().catch(() => ({}));
      const code = typeof body?.code === 'string' ? body.code : '';
      if (!code) {
        return NextResponse.json({ error: 'missing required field: code' }, { status: 400 });
      }

      const outcome = await approveAppLink(code, approver);
      if (outcome === 'not_found') {
        return NextResponse.json({ error: 'unknown or expired code' }, { status: 404 });
      }
      if (outcome === 'not_pending') {
        return NextResponse.json({ error: 'code is not pending' }, { status: 409 });
      }
      return NextResponse.json({ status: 'approved' });
    } catch (error) {
      if (error instanceof ApiAuthError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
      }
      return apiError(error, 'auth/app-link/approve');
    }
  },
  { strategy: 'user', identifier: 'user', getUserId: getUserIdFromSession },
);
