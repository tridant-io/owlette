/**
 * POST /api/auth/app-link/start — cold-start half of the sign-in handoff (lib/appLink.server.ts).
 *
 * Public. Mints a pending code and a poll secret, good for 10 min. The app opens `approveUrl` in
 * the system browser and polls /exchange with both; only the code ever leaves the app.
 *
 * 201 `{ code, secret, approveUrl, expiresAt }`. Rate limited per IP.
 */
import { NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { apiError } from '@/lib/apiErrorResponse';
import { startPendingAppLink } from '@/lib/appLink.server';

export const POST = withRateLimit(
  async () => {
    try {
      return NextResponse.json(await startPendingAppLink(), { status: 201 });
    } catch (error) {
      return apiError(error, 'auth/app-link/start');
    }
  },
  { strategy: 'tokenExchange', identifier: 'ip' },
);
