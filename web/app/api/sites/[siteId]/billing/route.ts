/**
 * POST   /api/sites/{siteId}/billing — put the site on a paid plan. body
 *        `{ tier: 'core' | 'pro', founders: boolean }`; answers `{ checkoutUrl }`
 *        for the owner's first billed site, or `{ added: true }` when the site
 *        went straight onto their running subscription.
 * PATCH  /api/sites/{siteId}/billing — switch plan. body `{ tier, founders? }`.
 * DELETE /api/sites/{siteId}/billing — stop billing at the end of the period.
 *
 * the site owner only (adr 0018): SITE_BILLING_MANAGE sits on the owner row and
 * is checked even while capability_enforcement is off. api keys are refused on
 * every verb: spending the owner's money is a person's decision, made with a
 * session. `planExempt`, because these are how a site gets a plan at all.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problem, problemFromError, problemValidation, ProblemType } from '@/lib/apiErrors';
import { readAndParseJsonBody } from '@/app/api/_shared';
import { emitMutation } from '@/lib/auditLogClient';
import {
  authorizedSiteHandler,
  type SiteHandlerContext,
  type SiteRouteHandler,
} from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import { withIdempotency } from '@/lib/idempotency';
import { billingProblem, stopSiteBilling, switchSiteTier, upgradeSite } from '@/lib/siteBilling.server';

type RouteParams = { siteId: string };

function refuseApiKey(ctx: SiteHandlerContext): NextResponse | null {
  if (ctx.auth.keyContext === null) return null;
  return problem({
    type: ProblemType.Forbidden,
    title: 'forbidden',
    status: 403,
    code: 'api_key_not_permitted',
    detail: "a site's billing cannot be changed with an api key.",
  });
}

/** `tier` and `founders` from a request body, or the 400 that names what is wrong with them. */
function readChange(
  body: unknown,
  foundersRequired: boolean,
): { tier: 'core' | 'pro'; founders?: boolean } | NextResponse {
  const { tier, founders } = (body ?? {}) as { tier?: unknown; founders?: unknown };
  if (tier !== 'core' && tier !== 'pro') {
    return problemValidation('tier must be core or pro', { 'body.tier': ['must be "core" or "pro"'] });
  }
  if (typeof founders !== 'boolean' && (foundersRequired || founders !== undefined)) {
    return problemValidation('founders must be true or false', { 'body.founders': ['must be a boolean'] });
  }
  return { tier, ...(typeof founders === 'boolean' ? { founders } : {}) };
}

function audit(ctx: SiteHandlerContext, method: string, attributes: Record<string, unknown>): void {
  emitMutation({
    kind: 'billing_mutated',
    siteId: ctx.siteId,
    // keys were refused, so the actor is always a signed-in user.
    actor: `user:${ctx.actor.userId}`,
    targetId: ctx.siteId,
    attributes: { endpoint: `/api/sites/${ctx.siteId}/billing`, method, ...attributes },
  });
}

const upgrade: SiteRouteHandler<RouteParams> = async (request: NextRequest, ctx) => {
  try {
    const keyRefusal = refuseApiKey(ctx);
    if (keyRefusal) return keyRefusal;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const change = readChange(parsed.body, true);
    if (change instanceof NextResponse) return change;
    const { tier } = change;
    const founders = change.founders === true;

    return await withIdempotency(
      request,
      { userId: ctx.actor.userId, environment: 'unknown' },
      parsed.raw,
      async () => {
        const result = await upgradeSite({ siteId: ctx.siteId, uid: ctx.actor.userId, tier, founders });
        if (!result.ok) return billingProblem(result);

        const added = 'added' in result;
        audit(ctx, 'POST', { verb: added ? 'site_added' : 'checkout_started', tier, founders });
        return NextResponse.json(added ? { added: true } : { checkoutUrl: result.checkoutUrl });
      },
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/billing:POST');
  }
};

const switchPlan: SiteRouteHandler<RouteParams> = async (request: NextRequest, ctx) => {
  try {
    const keyRefusal = refuseApiKey(ctx);
    if (keyRefusal) return keyRefusal;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const change = readChange(parsed.body, false);
    if (change instanceof NextResponse) return change;

    const result = await switchSiteTier({ siteId: ctx.siteId, uid: ctx.actor.userId, ...change });
    if (!result.ok) return billingProblem(result);

    audit(ctx, 'PATCH', { verb: 'tier_switched', ...result.billing });
    return NextResponse.json({ billing: result.billing });
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/billing:PATCH');
  }
};

const stop: SiteRouteHandler<RouteParams> = async (_request, ctx) => {
  try {
    const keyRefusal = refuseApiKey(ctx);
    if (keyRefusal) return keyRefusal;

    const result = await stopSiteBilling({ siteId: ctx.siteId, uid: ctx.actor.userId });
    if (!result.ok) return billingProblem(result);

    audit(ctx, 'DELETE', { verb: 'billing_stopped', ...result.billing });
    return NextResponse.json({ billing: result.billing });
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/billing:DELETE');
  }
};

const handlerOptions = {
  capability: Capability.SITE_BILLING_MANAGE,
  siteIdParam: 'path' as const,
  planExempt: true,
};

export const POST = authorizedSiteHandler<RouteParams>(handlerOptions)(upgrade);
export const PATCH = authorizedSiteHandler<RouteParams>(handlerOptions)(switchPlan);
export const DELETE = authorizedSiteHandler<RouteParams>(handlerOptions)(stop);
