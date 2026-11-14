/**
 * Passkey List API
 *
 * Returns all passkeys for the authenticated user (metadata only, no public keys).
 *
 * GET /api/passkeys/list?userId=...
 * Response: { passkeys: PasskeyInfo[] }
 */

import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, requirePreMfaSessionUser } from '@/lib/apiAuth.server';
import { getPasskeyListInfo } from '@/lib/webauthn.server';
import { apiError } from '@/lib/apiErrorResponse';

export const GET = withRateLimit(async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('userId');

    if (!userId) {
      return NextResponse.json({ error: 'Missing userId' }, { status: 400 });
    }

    await requirePreMfaSessionUser(request, userId);

    const passkeys = await getPasskeyListInfo(userId);
    return NextResponse.json({ passkeys });
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'passkeys/list');
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});
