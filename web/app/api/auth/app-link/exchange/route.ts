/**
 * POST /api/auth/app-link/exchange — the app trades a code for a firebase custom token
 * (lib/appLink.server.ts).
 *
 * Public. Body `{ code, secret? }`; a code from /start needs its secret in every state.
 *
 * 202 `{ status: 'pending' }` · 200 `{ customToken }` (the code is spent) · 400 no code ·
 * 404 unknown code or wrong secret · 410 expired or already used. The uid is never returned.
 * Rate limited per IP (300/h); the cold-start poll runs every 3 s, at most 200 calls a wait.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { apiError } from '@/lib/apiErrorResponse';
import { exchangeAppLink } from '@/lib/appLink.server';

export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      const body = await request.json().catch(() => ({}));
      const code = typeof body?.code === 'string' ? body.code : '';
      if (!code) {
        return NextResponse.json({ error: 'missing required field: code' }, { status: 400 });
      }
      const secret = typeof body?.secret === 'string' ? body.secret : undefined;

      const outcome = await exchangeAppLink(code, secret);
      switch (outcome.kind) {
        case 'pending':
          return NextResponse.json({ status: 'pending' }, { status: 202 });
        case 'token':
          return NextResponse.json({ customToken: outcome.customToken });
        case 'gone':
          return NextResponse.json({ error: 'expired' }, { status: 410 });
        case 'not_found':
          return NextResponse.json({ error: 'invalid code' }, { status: 404 });
      }
    } catch (error) {
      return apiError(error, 'auth/app-link/exchange');
    }
  },
  { strategy: 'api', identifier: 'ip' },
);
