/**
 * DELETE /api/sites/{siteId}/members/{uid}
 *
 * Removes the member, through the single writer in `lib/membership.server.ts`,
 * which dual-writes the member document and the legacy `users/{uid}.sites[]`
 * entry in one transaction. Refuses the site owner — transfer ownership with
 * POST /api/sites/{siteId}/transfer-ownership first.
 *
 * Authored talons survive the removal (they are site-owned), but a talon with a
 * hoot output re-resolves its AUTHOR's site access every run, so it starts
 * failing silently. Hence `talonCount` always in the response, and
 * `?talonSuccessorUid=<uid>` to move them BEFORE the membership write.
 * Reassignment is never implicit — silently rewriting authorship on someone
 * else's automations is worse than an orphan the operator was told about.
 *
 * Idempotent: a non-member returns 200 with `wasMember: false`.
 * Auth: `requireSiteAuthAndScope(req, siteId, 'admin')`.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problem,
  problemFromError,
  problemNotFound,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { withIdempotency } from '@/lib/idempotency';
import { emitMutation } from '@/lib/auditLogClient';
import { authorizedSiteHandler, type SiteHandlerContext } from '@/lib/authorizedHandler.server';
import { Capability, hasCapability } from '@/lib/capabilities';
import {
  countTalonsAuthoredBy,
  reassignTalons,
  TalonStoreError,
} from '@/lib/talons/store.server';
import { auditActorIdentifier } from '@/app/api/_shared';
import { talonStoreProblem } from '../../talons/route';
import {
  applyAuthDeprecations,
  readAndParseJsonBody,
} from '../../../../_shared';
import { changeRole, removeMember } from '@/lib/membership.server';
import { revokeSwoopSessionsForUser } from '@/lib/swoop/revokeViewerSessions.server';

// The talon store pulls in `node:crypto` for webhook secret minting.
export const runtime = 'nodejs';

const UID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

type RouteParams = { siteId: string; uid: string };

export const DELETE = authorizedSiteHandler<RouteParams>({
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
  targetKind: 'user',
  targetIdParam: 'uid',
})(async (request: NextRequest, ctx: SiteHandlerContext, routeContext) => {
  try {
    const { siteId, uid } = await routeContext.params;
    if (!UID_REGEX.test(uid)) {
      return problemValidation('uid must be 1-128 chars', {
        'path.uid': ['letters, digits, underscore, hyphen only'],
      });
    }

    const talonSuccessorUid = request.nextUrl.searchParams.get('talonSuccessorUid');
    if (talonSuccessorUid !== null && !UID_REGEX.test(talonSuccessorUid)) {
      return problemValidation('talonSuccessorUid is malformed', {
        'query.talonSuccessorUid': ['must match user-id format'],
      });
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
        const db = getAdminDb();

        const [siteSnap, userSnap] = await Promise.all([
          db.collection('sites').doc(siteId).get(),
          db.collection('users').doc(uid).get(),
        ]);

        if (!siteSnap.exists) {
          return problemNotFound(`site ${siteId} not found`);
        }
        if (!userSnap.exists) {
          return problemNotFound(`user ${uid} not found`);
        }

        const siteData = siteSnap.data() ?? {};
        const ownerUid =
          typeof siteData.owner === 'string' ? siteData.owner : null;

        if (ownerUid === uid) {
          return problem({
            type: ProblemType.Conflict,
            title: 'cannot remove site owner',
            status: 409,
            detail:
              'the site owner cannot be removed via this endpoint; transfer ownership first via POST /api/sites/{siteId}/transfer-ownership',
            instance: `/api/sites/${siteId}/members/${uid}`,
            code: 'cannot_remove_owner',
          });
        }

        // Membership is the ROW, not `users/{uid}.sites[]`. The legacy array is
        // not written by every path that grants — `transferSiteOwnership` creates
        // a member row without touching it — so reading it here reported
        // `wasMember: false` and toasted "no longer has access" while leaving a
        // live grant in place. It is still unioned as a fallback until wave 6.1
        // strips it, so a pre-migration membership is not silently dropped.
        const userData = userSnap.data() ?? {};
        const sites = Array.isArray(userData.sites)
          ? (userData.sites as unknown[]).filter(
              (s): s is string => typeof s === 'string',
            )
          : [];
        const memberRowSnap = await db
          .collection('sites')
          .doc(siteId)
          .collection('members')
          .doc(uid)
          .get();
        const hasActiveRow =
          memberRowSnap.exists && (memberRowSnap.data() ?? {}).status === 'active';
        const wasMember = hasActiveRow || sites.includes(siteId);

        // Read before the write so the reported count is the one that was true
        // when the decision was made.
        const talonCount = await countTalonsAuthoredBy(db, siteId, uid);

        // Reassign first; a failure aborts the removal. Better a member still
        // on the site than automations pointing at someone who isn't.
        let reassignedTalonIds: string[] = [];
        if (talonSuccessorUid && talonCount > 0) {
          // The wrapper authorized SITE_MEMBER_MANAGE, not TALON_MANAGE. Same
          // role grants both today, but gate the talon mutation as a talon
          // mutation or a future matrix split silently widens this endpoint.
          if (!hasCapability(ctx.actor, Capability.TALON_MANAGE, siteId)) {
            return problem({
              type: ProblemType.Forbidden,
              title: 'forbidden',
              status: 403,
              detail: 'reassigning talons requires the TALON_MANAGE capability on this site',
              instance: `/api/sites/${siteId}/members/${uid}`,
              code: 'talon_manage_required',
            });
          }

          const result = await reassignTalons(
            db,
            {
              siteId,
              actor: ctx.actor,
              auditActor: auditActorIdentifier(ctx.auth),
              via: 'ui',
              endpoint: request.nextUrl.pathname,
              method: 'DELETE',
            },
            talonSuccessorUid,
            { fromUid: uid },
          );
          reassignedTalonIds = result.reassignedTalonIds;
        }

        // Wave 2 task 2.3: the membership write goes through the single writer,
        // which dual-writes the member document and the legacy `sites[]` entry in
        // one transaction and re-checks ownership INSIDE it. The early 409 above
        // still stands and still earns its place — it refuses an owner before any
        // talon work happens — but it is evaluated against a snapshot taken
        // before `reassignTalons`, so an ownership transfer landing in that window
        // slips past it. This is the guard that cannot be raced.
        if (wasMember) {
          const removal = await removeMember({ siteId, uid });
          if (!removal.ok) {
            if (removal.failure.kind === 'is_owner') {
              // Reached only by losing the race described above.
              return problem({
                type: ProblemType.Conflict,
                title: 'cannot remove site owner',
                status: 409,
                detail:
                  'the site owner cannot be removed via this endpoint; transfer ownership first via POST /api/sites/{siteId}/transfer-ownership',
                instance: `/api/sites/${siteId}/members/${uid}`,
                code: 'cannot_remove_owner',
              });
            }
            if (removal.failure.kind === 'site_not_found') {
              return problemNotFound(`site ${siteId} not found`);
            }
          }
          // After the membership write and only when it landed, outside its
          // transaction, and never awaited into the response: the lease already
          // ends their sessions within five minutes (PROTOCOL.md §10) and this
          // only closes that window to the kill path's two seconds.
          if (removal.ok) {
            void revokeSwoopSessionsForUser({
              siteId,
              uid,
              actor: ctx.actor,
              auditActor: auditActorIdentifier(ctx.auth),
              reason: 'member_removed',
              ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
            });
          }
        }

        emitMutation({
          kind: 'site_member_mutated',
          siteId,
          actor: ctx.auth.keyContext
            ? `apiKey:${ctx.auth.keyContext.keyId}`
            : `user:${ctx.actor.userId}`,
          targetId: uid,
          attributes: {
            endpoint: `/api/sites/${siteId}/members/${uid}`,
            method: 'DELETE',
            verb: 'member_removed',
            wasMember,
            talonCount,
            reassignedTalonCount: reassignedTalonIds.length,
            talonSuccessorUid: talonSuccessorUid ?? null,
          },
        });

        return applyAuthDeprecations(
          NextResponse.json({
            siteId,
            uid,
            wasMember,
            talonCount,
            reassignedTalonIds,
          }),
          ctx.scopeCheck,
        );
      },
    );
  } catch (err) {
    // A rejected successor is a bad request against this endpoint, not a 500.
    if (err instanceof TalonStoreError) {
      return talonStoreProblem(err, request.nextUrl.pathname);
    }
    return problemFromError(err, 'sites/[siteId]/members/[uid]:DELETE');
  }
});

/**
 * PATCH /api/sites/{siteId}/members/{uid}
 *
 * Changes a member's per-site role. New in Wave 2 task 2.3 — before this there
 * was no way to change a per-site role at all, because there was no per-site role
 * to change: it was derived from the global role at read time, so "make this
 * person a site admin here" meant promoting them globally on every site they
 * belong to. That is the leak per-site roles exist to close.
 *
 * `'owner'` is not assignable. Ownership moves only through
 * POST /api/sites/{siteId}/transfer-ownership, which is transactional and
 * re-reads the owner row; `changeRole` refuses an owner as a source as well, so
 * an admin can neither promote themselves into ownership nor demote the owner
 * out of it. Both halves are enforced inside the transaction that writes.
 *
 * Auth: `requireSiteAuthAndScope(req, siteId, 'admin')`, capability
 * SITE_MEMBER_MANAGE — the same gate the sibling DELETE takes.
 */
export const PATCH = authorizedSiteHandler<RouteParams>({
  capability: 'SITE_MEMBER_MANAGE',
  siteIdParam: 'path',
  // write AND admin: the inner gate asked for admin while the wrapper defaulted
  // to write, and permissions are not hierarchical, so both were required. The
  // inner gate is gone; the requirement it carried is stated here.
  apiKeyPermission: ['write', 'admin'],
  targetKind: 'user',
  targetIdParam: 'uid',
})(async (request: NextRequest, ctx: SiteHandlerContext, routeContext) => {
  try {
    const { siteId, uid } = await routeContext.params;
    if (!UID_REGEX.test(uid)) {
      return problemValidation('uid must be 1-128 chars', {
        'path.uid': ['letters, digits, underscore, hyphen only'],
      });
    }

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;


    const role = (parsed.body as { role?: unknown } | null)?.role;
    if (role !== 'admin' && role !== 'member') {
      return problemValidation('role is required and must be admin or member', {
        'body.role': ['must be one of: admin, member'],
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
        const result = await changeRole({ siteId, uid, role });

        // A demotion to `member` loses MACHINE_REMOTE_CONTROL, so any session
        // in which they hold control has to end — but a watch they are still
        // entitled to survives, which is why this is `controlOnly`.
        if (result.ok && role === 'member') {
          void revokeSwoopSessionsForUser({
            siteId,
            uid,
            actor: ctx.actor,
            auditActor: auditActorIdentifier(ctx.auth),
            reason: 'role_changed',
            controlOnly: true,
            ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
          });
        }

        if (!result.ok) {
          if (result.failure.kind === 'is_owner') {
            return problem({
              type: ProblemType.Conflict,
              title: 'cannot change the site owner\'s role',
              status: 409,
              detail:
                'the owner\'s role is set by ownership; transfer ownership via POST /api/sites/{siteId}/transfer-ownership instead',
              instance: `/api/sites/${siteId}/members/${uid}`,
              code: 'cannot_change_owner_role',
            });
          }
          if (result.failure.kind === 'not_member') {
            // Distinguished from "no such user" on purpose: the caller is told
            // the membership is missing, not that the account does not exist.
            return problemNotFound(`user ${uid} is not a member of site ${siteId}`);
          }
          return problemValidation('role is required and must be admin or member', {
            'body.role': ['must be one of: admin, member'],
          });
        }

        emitMutation({
          kind: 'site_member_mutated',
          siteId,
          actor: auditActorIdentifier(ctx.auth),
          targetId: uid,
          attributes: {
            endpoint: `/api/sites/${siteId}/members/${uid}`,
            method: 'PATCH',
            verb: 'member_role_changed',
            role,
          },
        });

        return applyAuthDeprecations(
          NextResponse.json({ siteId, uid, role }),
          ctx.scopeCheck,
        );
      },
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/members/[uid]:PATCH');
  }
});
