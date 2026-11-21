/**
 * GET /api/billing/checkout/{sessionId} — the return from stripe checkout: asks
 * tridant id whether the purchase is fulfilled and, once it is, records the
 * site's billing. answers `{ status, siteId, tier, error? }`, `status` being
 * `pending`, `complete` or `failed`.
 *
 * session or the user's own firebase id token; never an agent or an api key.
 * only the account that started the checkout may read it; anyone else gets the
 * 404 of a checkout that does not exist.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { ApiAuthError, assertActiveUser, requireSessionOrIdToken } from '@/lib/apiAuth.server';
import { problemForbidden, problemFromError, problemNotFound, problemUnauthorized } from '@/lib/apiErrors';
import { billingProblem, confirmSiteCheckout } from '@/lib/siteBilling.server';
import { withRateLimit } from '@/lib/withRateLimit';

// it comes from the return url and becomes a firestore doc id, and firestore throws on `__x__`.
const SESSION_ID_RE = /^(?!__.*__$)[A-Za-z0-9_]{1,200}$/;

export const GET = withRateLimit(
  async (request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) => {
    try {
      const uid = await requireSessionOrIdToken(request, { rejectAgentTokens: true });
      const { sessionId } = await params;
      if (!SESSION_ID_RE.test(sessionId)) return problemNotFound('checkout not found');
      await assertActiveUser(uid);

      const outcome = await confirmSiteCheckout(uid, sessionId);
      if (!outcome.ok) return billingProblem(outcome);
      const { status, siteId, tier, error } = outcome;
      return NextResponse.json({ status, siteId, tier, ...(error ? { error } : {}) });
    } catch (error) {
      if (error instanceof ApiAuthError) {
        return error.status === 403 ? problemForbidden('this account cannot confirm a checkout') : problemUnauthorized();
      }
      return problemFromError(error, 'billing/checkout/[sessionId]:GET');
    }
  },
  { strategy: 'api', identifier: 'ip' },
);
