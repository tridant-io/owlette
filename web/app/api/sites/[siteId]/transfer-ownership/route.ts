/**
 * POST /api/sites/{siteId}/transfer-ownership
 *
 * Moves ownership of a site to another user, atomically.
 *
 * Replaces the only prior path — the `DELETE /api/users/{uid}?successorUid=<uid>`
 * cascade, whose non-transactional failure modes are catalogued in
 * `transferSiteOwnership.server.ts`. This route is one transaction.
 *
 * Authorization is two-layered and the inner layer is the real one. The wrapper
 * admits owner / site-admin / superadmin (SITE_MEMBER_MANAGE, plus the site-owner
 * short-circuit) from a read taken before the transaction opened;
 * `transferSiteOwnership` then re-decides from the site document read INSIDE its
 * transaction — the actor must BE the owner or a superadmin. A site admin passing
 * the wrapper and being refused by the core is deliberate, not redundancy.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problem,
  problemFromError,
  problemNotFound,
  problemPlanRequired,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { withIdempotency } from '@/lib/idempotency';
import { emitMutation } from '@/lib/auditLogClient';
import { authorizedSiteHandler, type SiteHandlerContext } from '@/lib/authorizedHandler.server';
import { transferSiteOwnership } from '@/lib/actions/transferSiteOwnership.server';
import {
  applyAuthDeprecations,
  auditActorIdentifier,
  readAndParseJsonBody,
} from '../../../_shared';

const UID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

type RouteParams = { siteId: string };

export const POST = authorizedSiteHandler<RouteParams>({
  capability: 'SITE_MEMBER_MANAGE',
  siteIdParam: 'path',
  // Opted in because these routes already enforced it through the inner
  // _shared gate; without this, removing that gate would silently drop the
  // 400 on an unsupported Roost-Version.
  roostVersioned: true,
  // write AND admin: the inner gate asked for admin while the wrapper defaulted
  // to write, and permissions are not hierarchical, so both were required. The
  // inner gate is gone; the requirement it carried is stated here.
  apiKeyPermission: ['write', 'admin'],
  targetKind: 'site',
})(async (request: NextRequest, ctx: SiteHandlerContext, routeContext) => {
  try {
    const { siteId } = await routeContext.params;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;


    const body = (parsed.body ?? {}) as { successorUid?: unknown };
    const successorUid = body.successorUid;
    if (typeof successorUid !== 'string' || !UID_REGEX.test(successorUid)) {
      return problemValidation('successorUid is required and must be valid', {
        'body.successorUid': ['must be 1-128 chars: letters, digits, underscore, hyphen'],
      });
    }

    return await withIdempotency(
      request,
      {
        userId: ctx.actor.userId,
        environment: ctx.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        const result = await transferSiteOwnership({
          siteId,
          successorUid,
          actorUid: ctx.actor.userId,
          actorIsSuperadmin: ctx.actor.role === 'superadmin',
        });

        if (!result.ok) {
          switch (result.failure.kind) {
            case 'site_not_found':
              return problemNotFound(`site ${siteId} not found`);
            case 'successor_not_found':
              return problemNotFound(`user ${successorUid} not found`);
            case 'not_owner':
              // Not 404: the caller demonstrably reaches this site (the wrapper
              // admitted them), so hiding the site would be noise, not privacy.
              return problem({
                type: ProblemType.Forbidden,
                title: 'only the owner may transfer ownership',
                status: 403,
                detail:
                  'transferring a site is the owner\'s decision; administering it is not enough',
                instance: `/api/sites/${siteId}/transfer-ownership`,
                code: 'not_owner',
              });
            case 'successor_inactive':
              return problemValidation('successor is deleted or inactive', {
                'body.successorUid': ['user is soft-deleted'],
              });
            case 'successor_already_owner':
              // 409 rather than a no-op 200: the user-delete cascade's equivalent
              // hole reports success while stranding the site on a deleted owner.
              return problem({
                type: ProblemType.Conflict,
                title: 'successor already owns this site',
                status: 409,
                detail: 'successorUid is already the owner of this site',
                instance: `/api/sites/${siteId}/transfer-ownership`,
                code: 'successor_already_owner',
              });
            case 'site_has_no_owner':
              return problem({
                type: ProblemType.Conflict,
                title: 'site has no owner to transfer',
                status: 409,
                detail:
                  'this site records no owner; it needs repair rather than a transfer',
                instance: `/api/sites/${siteId}/transfer-ownership`,
                code: 'site_has_no_owner',
              });
            case 'plan_limit':
              return problemPlanRequired(
                result.failure.entitlement === 'owlette.sites'
                  ? "the new owner's plan covers no more sites. they need to upgrade before taking this one."
                  : "the new owner's plan doesn't cover this site's machines. they need to upgrade before taking this one.",
                result.failure.entitlement,
              );
          }
        }

        emitMutation({
          kind: 'site_member_mutated',
          siteId,
          actor: auditActorIdentifier(ctx.auth),
          targetId: result.newOwnerUid,
          attributes: {
            endpoint: `/api/sites/${siteId}/transfer-ownership`,
            method: 'POST',
            verb: 'ownership_transferred',
            previousOwnerUid: result.previousOwnerUid,
            newOwnerUid: result.newOwnerUid,
          },
        });

        return applyAuthDeprecations(
          NextResponse.json({
            siteId,
            previousOwnerUid: result.previousOwnerUid,
            newOwnerUid: result.newOwnerUid,
          }),
          ctx.scopeCheck,
        );
      },
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/transfer-ownership:POST');
  }
});
