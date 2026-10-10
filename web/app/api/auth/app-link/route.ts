/**
 * POST /api/auth/app-link — website → app half of the sign-in handoff (lib/appLink.server.ts).
 *
 * Login cookie with mfa complete; body `{}`. Mints a single-use code, already approved for the
 * caller and good for 60 s, that the owlette-swoop:// deep link carries to the app.
 *
 * 201 `{ code, expiresAt }` · 401 no session · 403 mfa pending or inactive user. Per-user limit.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getUserIdFromSession, withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError } from '@/lib/apiAuth.server';
import { apiError } from '@/lib/apiErrorResponse';
import { mintApprovedAppLink, requireAppLinkApprover } from '@/lib/appLink.server';

export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      const approver = await requireAppLinkApprover(request);
      return NextResponse.json(await mintApprovedAppLink(approver), { status: 201 });
    } catch (error) {
      if (error instanceof ApiAuthError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
      }
      return apiError(error, 'auth/app-link');
    }
  },
  { strategy: 'user', identifier: 'user', getUserId: getUserIdFromSession },
);
