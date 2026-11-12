/**
 * GET /api/auth/tridant/link?org=<org_id>&return=<path>: sends the signed-in
 * user to tridant id to sign in, so the id token that comes back can stand as
 * their consent to link this account to an organization they own there
 * (plan.md, "link"). the flow's state rides a sealed cookie to
 * /api/auth/tridant/callback, which answers on `return`.
 *
 * session only, and a verified email, as for the trial. 503 when the oidc
 * client is not configured or tridant id cannot be reached.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { ApiAuthError, assertActiveUser, requireSession } from '@/lib/apiAuth.server';
import { problem, problemForbidden, problemFromError, problemUnauthorized, ProblemType } from '@/lib/apiErrors';
import { getAdminAuth } from '@/lib/firebase-admin';
import {
  buildAuthorizeUrl,
  codeChallengeFor,
  OIDC_STATE_COOKIE,
  OIDC_STATE_COOKIE_OPTIONS,
  oidcConfigured,
  oidcRedirectUri,
  randomToken,
  safeReturnPath,
  sealState,
} from '@/lib/tridantOidc.server';
import { withRateLimit } from '@/lib/withRateLimit';

const ORG_ID = /^org_[A-Za-z0-9_-]{1,64}$/;

function unavailable(detail: string, code: string): NextResponse {
  return problem({ type: ProblemType.ServiceUnavailable, title: 'service unavailable', status: 503, detail, code });
}

export const GET = withRateLimit(
  async (request: NextRequest) => {
    try {
      // a link is started by a click in owlette. another site navigating a signed-in user here would
      // link their account to their tridant organization without one.
      if (request.headers.get('sec-fetch-site') === 'cross-site') {
        return problemForbidden('start linking from your plan page');
      }
      const uid = await requireSession(request);
      if (!oidcConfigured()) {
        return unavailable('linking a tridant account is not configured for this deployment.', 'tridant_link_not_configured');
      }
      await assertActiveUser(uid);
      const user = await getAdminAuth().getUser(uid);
      if (!user.emailVerified) return problemForbidden('verify your email before linking a tridant account');

      const params = request.nextUrl.searchParams;
      const org = params.get('org');
      const state = randomToken();
      const nonce = randomToken();
      const verifier = randomToken();

      const authorize = await buildAuthorizeUrl({
        state,
        nonce,
        codeChallenge: codeChallengeFor(verifier),
        redirectUri: oidcRedirectUri(),
      });
      if (!authorize.ok) return unavailable('tridant id could not be reached. try again shortly.', authorize.code);

      const response = NextResponse.redirect(authorize.url, 302);
      response.headers.set('Cache-Control', 'no-store');
      response.cookies.set(
        OIDC_STATE_COOKIE,
        await sealState({
          purpose: 'link',
          state,
          nonce,
          verifier,
          uid,
          org: org !== null && ORG_ID.test(org) ? org : null,
          return: safeReturnPath(params.get('return')),
        }),
        OIDC_STATE_COOKIE_OPTIONS,
      );
      return response;
    } catch (error) {
      if (error instanceof ApiAuthError) {
        return error.status === 403 ? problemForbidden() : problemUnauthorized();
      }
      return problemFromError(error, 'auth/tridant/link:GET');
    }
  },
  { strategy: 'api', identifier: 'ip' },
);
