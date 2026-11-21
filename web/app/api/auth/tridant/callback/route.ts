/**
 * GET /api/auth/tridant/callback?code&state (or `error`): the return from
 * tridant id after /api/auth/tridant/link. exchanges the code, and presents the
 * id token to tridant id as the owner's consent to link this account to their
 * organization (`POST /v1/billing/link`), then retries the trial start.
 *
 * it always answers with a redirect to the flow's `return` path on this origin
 * and clears the state cookie. the outcome is in the query:
 *   link=done                  linked
 *   link=choose&orgs=<b64url>  several organizations owned and none chosen;
 *                              `orgs` is json `[{id,name}]`, and the page sends
 *                              the choice back through /api/auth/tridant/link?org=
 *   link=no_org                the tridant user owns no organization
 *   link=failed&code=<code>    tridant's error code, an oauth error, or one of
 *                              this flow's own
 * no token, authorization code or email ever goes into the url.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/apiAuth.server';
import { emitMutation } from '@/lib/auditLogClient';
import logger from '@/lib/logger';
import { clearLinkRequired, recordOrg } from '@/lib/planAccounts.server';
import { ensureTrial } from '@/lib/planTrial.server';
import { linkAccount } from '@/lib/tridantBilling.server';
import {
  DEFAULT_RETURN_PATH,
  exchangeCode,
  OIDC_STATE_COOKIE,
  OIDC_STATE_COOKIE_OPTIONS,
  oidcRedirectUri,
  openState,
  readIdTokenClaims,
  urlSafeCode,
} from '@/lib/tridantOidc.server';
import { withRateLimit } from '@/lib/withRateLimit';

function finish(returnPath: string, link: string, extra: Record<string, string> = {}): NextResponse {
  // resolved against the configured origin, so the path can never leave it.
  const url = new URL(returnPath, oidcRedirectUri());
  for (const key of ['link', 'code', 'orgs']) url.searchParams.delete(key);
  url.searchParams.set('link', link);
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);

  const response = NextResponse.redirect(url, 302);
  response.headers.set('Cache-Control', 'no-store');
  response.cookies.set(OIDC_STATE_COOKIE, '', { ...OIDC_STATE_COOKIE_OPTIONS, maxAge: 0 });
  return response;
}

export const GET = withRateLimit(
  async (request: NextRequest) => {
    const sealed = request.cookies.get(OIDC_STATE_COOKIE)?.value;
    const saved = sealed ? await openState(sealed) : null;
    const returnPath = saved?.return ?? DEFAULT_RETURN_PATH;
    const fail = (code: string) => finish(returnPath, 'failed', { code });

    try {
      if (!saved) return fail('state_missing');
      const params = request.nextUrl.searchParams;
      if (params.get('state') !== saved.state) return fail('state_mismatch');

      // the browser that comes back must still be the account that left.
      const uid = await requireSession(request).catch(() => null);
      if (uid !== saved.uid) return fail('session_mismatch');

      const error = params.get('error');
      if (error) return fail(urlSafeCode(error) ?? 'oidc_error');
      const code = params.get('code');
      if (!code) return fail('code_missing');

      const exchanged = await exchangeCode({ code, codeVerifier: saved.verifier, redirectUri: oidcRedirectUri() });
      if (!exchanged.ok) return fail(exchanged.code);
      const claims = readIdTokenClaims(exchanged.idToken, saved.nonce);
      if (!claims.ok) return fail(claims.code);

      const owned = claims.orgs.filter((org) => org.role === 'owner');
      if (owned.length === 0) return finish(returnPath, 'no_org');
      // an organization that was asked for and is not owned is refused, never swapped for another.
      if (saved.org && !owned.some((org) => org.id === saved.org)) return fail('org_not_owned');
      const chosen = owned.find((org) => org.id === saved.org) ?? (owned.length === 1 ? owned[0] : null);
      if (!chosen) {
        const orgs = JSON.stringify(owned.map(({ id, name }) => ({ id, name })));
        return finish(returnPath, 'choose', { orgs: Buffer.from(orgs, 'utf8').toString('base64url') });
      }

      const linked = await linkAccount({ uid, orgId: chosen.id, idToken: exchanged.idToken });
      if (!linked.ok) return fail(urlSafeCode(linked.code) ?? linked.reason);

      await clearLinkRequired(uid);
      await recordOrg(uid, chosen.id);
      const trial = await ensureTrial(uid);
      emitMutation({
        kind: 'billing_mutated',
        siteId: '',
        actor: `user:${uid}`,
        targetId: uid,
        attributes: {
          endpoint: '/api/auth/tridant/callback',
          method: 'GET',
          verb: 'tridant_account_linked',
          orgId: chosen.id,
          tridantUser: claims.sub,
          already: linked.already,
          trial: trial.status,
        },
      });
      return finish(returnPath, 'done');
    } catch (error) {
      logger.error('[tridant] link callback failed', {
        context: 'tridant',
        data: { error: error instanceof Error ? error.message : String(error) },
      });
      return fail('internal_error');
    }
  },
  { strategy: 'api', identifier: 'ip' },
);
