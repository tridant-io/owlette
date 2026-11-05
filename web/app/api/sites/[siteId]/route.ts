/**
 * GET    /api/sites/{siteId}
 * PATCH  /api/sites/{siteId}
 * DELETE /api/sites/{siteId}
 *
 * GET keeps the existing public detail contract. PATCH/DELETE migrate the
 * dashboard site CRUD writes behind the site-scoped authorization wrapper.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { timestampToIso } from '@/lib/firestoreTime.server';
import {
  problem,
  problemForbidden,
  problemFromError,
  problemNotFound,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  applyAuthDeprecations,
  readAndParseJsonBody,
  requireSiteAuthAndScope,
} from '../../_shared';
import { authorizedSiteHandler, type SiteHandlerContext } from '@/lib/authorizedHandler.server';
import { Capability, hasCapability } from '@/lib/capabilities';
import { updateSite } from '@/lib/actions/updateSite.server';
import { deleteSite } from '@/lib/actions/deleteSite.server';
import { withIdempotency } from '@/lib/idempotency';

type RouteParams = { siteId: string };

interface UpdateSiteBody {
  name?: unknown;
  timezone?: unknown;
  timeFormat?: unknown;
  schedulesFollowSiteTime?: unknown;
}

function auditActor(ctx: SiteHandlerContext): string {
  return ctx.auth.keyContext
    ? `apiKey:${ctx.auth.keyContext.keyId}`
    : `user:${ctx.actor.userId}`;
}

export async function GET(request: NextRequest, { params }: { params: Promise<RouteParams> }) {
  try {
    const { siteId } = await params;
    const auth = await requireSiteAuthAndScope(request, siteId, 'read');
    if (!auth.ok) return auth.response;

    const db = getAdminDb();
    const siteSnap = await db.collection('sites').doc(siteId).get();
    if (!siteSnap.exists) {
      return problem({
        type: ProblemType.NotFound,
        title: 'site not found',
        status: 404,
        detail: `site ${siteId} not found`,
        instance: `/api/sites/${siteId}`,
      });
    }

    const data = siteSnap.data() ?? {};
    const rawTier = data.tier;
    const tier: 'core' | 'pro' | null =
      rawTier === 'core' || rawTier === 'pro' ? rawTier : null;

    return applyAuthDeprecations(
      NextResponse.json({
        id: siteId,
        name: typeof data.name === 'string' ? data.name : siteId,
        plan: typeof data.plan === 'string' ? data.plan : null,
        tier,
        tierUpgradedAt: timestampToIso(data.tierUpgradedAt),
        timezone: typeof data.timezone === 'string' ? data.timezone : null,
        owner: typeof data.owner === 'string' ? data.owner : null,
        createdAt: timestampToIso(data.createdAt),
        // Effective value — an absent field means the site was never asked and
        // still runs schedules on machine clocks.
        schedulesFollowSiteTime: data.schedulesFollowSiteTime === true,
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/sites/[siteId]:GET');
  }
}

export const PATCH = authorizedSiteHandler<RouteParams>({
  capability: Capability.SITE_MEMBER_MANAGE,
  siteIdParam: 'path',
  targetKind: 'site',
  apiKeyPermission: 'admin',
})(async (request: NextRequest, ctx: SiteHandlerContext) => {
  try {
    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    return await withIdempotency(
      request,
      {
        userId: ctx.actor.userId,
        environment: ctx.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        const body = parsed.body as UpdateSiteBody;
        const result = await updateSite(
          {
            auditActor: auditActor(ctx),
            endpoint: `/api/sites/${ctx.siteId}`,
            method: 'PATCH',
          },
          {
            siteId: ctx.siteId,
            ...(body.name !== undefined ? { name: body.name as string } : {}),
            ...(body.timezone !== undefined ? { timezone: body.timezone as string } : {}),
            ...(body.timeFormat !== undefined
              ? { timeFormat: body.timeFormat as '12h' | '24h' }
              : {}),
            ...(body.schedulesFollowSiteTime !== undefined
              ? { schedulesFollowSiteTime: body.schedulesFollowSiteTime as boolean }
              : {}),
          },
        );

        if (result.kind === 'not_found') {
          return problemNotFound(`site ${ctx.siteId} not found`);
        }
        if (result.kind === 'invalid_name') {
          return problemValidation(result.reason, {
            'body.name': [result.reason],
          });
        }
        if (result.kind === 'invalid_timezone') {
          return problemValidation(result.reason, {
            'body.timezone': [result.reason],
          });
        }
        if (result.kind === 'invalid_time_format') {
          return problemValidation(result.reason, {
            'body.timeFormat': [result.reason],
          });
        }
        if (result.kind === 'invalid_schedule_tz_flag') {
          return problemValidation(result.reason, {
            'body.schedulesFollowSiteTime': [result.reason],
          });
        }

        return applyAuthDeprecations(
          NextResponse.json({
            siteId: ctx.siteId,
            changed: result.kind === 'updated',
            updated: result.kind === 'updated' ? result.updated : {},
          }),
          ctx.scopeCheck,
        );
      },
    );
  } catch (err) {
    return problemFromError(err, 'v2/sites/[siteId]:PATCH');
  }
});

export const DELETE = authorizedSiteHandler<RouteParams>({
  // SITE_DELETE, not SITE_MEMBER_MANAGE: destroying a site is the owner's call, not
  // every site admin's. No role holds it in the matrix, so it resolves through the
  // ownership short-circuit (owner) or the superadmin grant — which is the target
  // semantics under per-site roles, reachable on today's data with no new machinery.
  capability: Capability.SITE_DELETE,
  siteIdParam: 'path',
  targetKind: 'site',
  apiKeyPermission: 'admin',
})(async (request: NextRequest, ctx: SiteHandlerContext) => {
  try {
    // re-checked here for the reason the members POST comment gives
    // (`members/route.ts`): the break-glass skips SITE_DELETE in the wrapper,
    // which is not exempt. before the body read and `withIdempotency`, so a 403
    // is never replayed under a key. it answers what the wrapper would.
    if (!hasCapability(ctx.actor, Capability.SITE_DELETE, ctx.siteId)) {
      return problemForbidden('capability not granted');
    }

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    return await withIdempotency(
      request,
      {
        userId: ctx.actor.userId,
        environment: ctx.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        const result = await deleteSite(
          {
            auditActor: auditActor(ctx),
            endpoint: `/api/sites/${ctx.siteId}`,
            method: 'DELETE',
            actor: ctx.actor,
            correlationId: ctx.correlationId,
          },
          { siteId: ctx.siteId },
        );

        if (result.kind === 'not_found') {
          return problemNotFound(`site ${ctx.siteId} not found`);
        }

        return applyAuthDeprecations(
          NextResponse.json({
            siteId: result.siteId,
            deleted: true,
          }),
          ctx.scopeCheck,
        );
      },
    );
  } catch (err) {
    return problemFromError(err, 'v2/sites/[siteId]:DELETE');
  }
});
