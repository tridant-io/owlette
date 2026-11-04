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
 * Auth: `requireSiteAuthAndScope(req, siteId, 'admin')`, plus the self-guard in
 * `refuseSelfMembershipChange` — a caller cannot remove their own row — and
 * SITE_MEMBER_MANAGE re-checked in the handler by `refuseWithoutMemberManage`.
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
import { removeMember, updateMember } from '@/lib/membership.server';
import { revokeSwoopSessionsForUser } from '@/lib/swoop/revokeViewerSessions.server';
import { grantedSwoopMode, SWOOP_MODES } from '@/lib/swoopMode';

// The talon store pulls in `node:crypto` for webhook secret minting.
export const runtime = 'nodejs';

const UID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

type RouteParams = { siteId: string; uid: string };

/**
 * A caller may never act on their OWN membership row, at any role.
 *
 * That row is what decides what the caller may do, so it is the one membership
 * mutation that can hand them rights they did not have. The capability gating
 * this route, SITE_MEMBER_MANAGE, is NOT in BYPASS_EXEMPT_CAPABILITIES — so
 * while `capability_enforcement` is off (the 4h break-glass in
 * `global/security_config`) a plain site `member` on a browser session reaches
 * this handler, and `PATCH {role:'admin'}` on their own uid made them a site
 * admin. From there MACHINE_REMOTE_CONTROL is held ON MERIT and every
 * kill-switch exemption passes legitimately — the switch could not grant screen
 * control, but it could grant the role that carries it. This guard lives in the
 * handler, before any write, precisely so it holds whether or not the switch is
 * on, and so it costs a real break-glass nothing.
 *
 * The OWNER is covered too, and loses nothing: their role moves only through
 * POST /api/sites/{siteId}/transfer-ownership, and `updateMember`/`removeMember`
 * refuse an owner outright either way. No self-service flow breaks — there is no
 * "leave site", and the members UI already refuses "remove yourself"
 * client-side (`components/admin/sites/SiteMembersSection.tsx`); this is that
 * rule's missing server half, matching the self-guard on
 * `users/{uid}/mfa-reset`.
 *
 * Api-key callers are refused on the KEY OWNER's row for the same reason: a key
 * is the user's credential and must not reach what their session cannot.
 */
function refuseSelfMembershipChange(
  ctx: SiteHandlerContext,
  siteId: string,
  uid: string,
  action: 'change' | 'remove',
): NextResponse | null {
  if (uid !== ctx.actor.userId) return null;
  return problem({
    type: ProblemType.Forbidden,
    title: 'cannot modify your own membership',
    status: 403,
    detail:
      action === 'remove'
        ? 'you cannot remove your own membership; ask another admin on this site to remove your access'
        : 'you cannot change your own role on this site; ask another admin on this site',
    instance: `/api/sites/${siteId}/members/${uid}`,
    code: 'cannot_modify_own_membership',
  });
}

/**
 * SITE_MEMBER_MANAGE, re-checked in the handler for the reason the members POST
 * comment gives (`members/route.ts`): the wrapper skips its capability check
 * while `capability_enforcement` is off, and this capability is not exempt, so
 * a plain member reached both handlers here during the break-glass. the swoop
 * mode makes PATCH a second way to hand out MACHINE_REMOTE_CONTROL.
 */
function refuseWithoutMemberManage(
  ctx: SiteHandlerContext,
  siteId: string,
  uid: string,
  action: 'change' | 'remove',
): NextResponse | null {
  if (hasCapability(ctx.actor, Capability.SITE_MEMBER_MANAGE, siteId)) return null;
  return problem({
    type: ProblemType.Forbidden,
    title: 'forbidden',
    status: 403,
    detail:
      action === 'remove'
        ? 'removing a member requires the SITE_MEMBER_MANAGE capability on this site'
        : 'changing a member requires the SITE_MEMBER_MANAGE capability on this site',
    instance: `/api/sites/${siteId}/members/${uid}`,
    code: 'site_member_manage_required',
  });
}

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

    // Before the body read and before `withIdempotency`: both refusals depend on
    // nothing but caller and target, and a 403 must never be recorded under an
    // idempotency key and replayed at a legitimate later call.
    const selfRefusal = refuseSelfMembershipChange(ctx, siteId, uid, 'remove');
    if (selfRefusal) return selfRefusal;
    const manageRefusal = refuseWithoutMemberManage(ctx, siteId, uid, 'remove');
    if (manageRefusal) return manageRefusal;

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
 * PATCH /api/sites/{siteId}/members/{uid}  `{role?, swoop?}`, at least one
 *
 * Changes a member's per-site role, their swoop mode, or both. New in Wave 2
 * task 2.3 — before this there was no way to change a per-site role at all,
 * because there was no per-site role to change: it was derived from the global
 * role at read time, so "make this person a site admin here" meant promoting
 * them globally on every site they belong to. That is the leak per-site roles
 * exist to close.
 *
 * `swoop` is `none`, `view` or `control`, or null for the role's default, which
 * deletes the field. a role change keeps an explicit mode, so an admin set to
 * control who is demoted keeps control. a change that loses control ends the
 * seats they hold control in, and one that loses swoop altogether ends every
 * seat.
 *
 * `'owner'` is not assignable. Ownership moves only through
 * POST /api/sites/{siteId}/transfer-ownership, which is transactional and
 * re-reads the owner row; `updateMember` refuses an owner as a source as well, so
 * an admin can neither promote themselves into ownership nor demote the owner
 * out of it, nor set the owner's swoop mode. Both halves are enforced inside the
 * transaction that writes.
 *
 * Neither of those covered `member` → `admin` on the caller's OWN row, which is
 * what `refuseSelfMembershipChange` closes.
 *
 * Auth: `requireSiteAuthAndScope(req, siteId, 'admin')`, capability
 * SITE_MEMBER_MANAGE — the same gate the sibling DELETE takes, and re-checked in
 * the handler as DELETE's is, by `refuseWithoutMemberManage`.
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

    // Same placement as the sibling DELETE, and for the same reasons.
    const selfRefusal = refuseSelfMembershipChange(ctx, siteId, uid, 'change');
    if (selfRefusal) return selfRefusal;
    const manageRefusal = refuseWithoutMemberManage(ctx, siteId, uid, 'change');
    if (manageRefusal) return manageRefusal;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;


    const body = parsed.body as { role?: unknown; swoop?: unknown } | null;
    const role = body?.role;
    const rawSwoop = body?.swoop;
    if (role === undefined && rawSwoop === undefined) {
      return problemValidation('role or swoop is required', {
        'body.role': ['provide role, swoop or both'],
        'body.swoop': ['provide role, swoop or both'],
      });
    }
    if (role !== undefined && role !== 'admin' && role !== 'member') {
      return problemValidation('role must be admin or member', {
        'body.role': ['must be one of: admin, member'],
      });
    }
    const swoop = rawSwoop === null ? null : SWOOP_MODES.find((mode) => mode === rawSwoop);
    if (rawSwoop !== undefined && swoop === undefined) {
      return problemValidation('swoop must be none, view, control or null', {
        'body.swoop': ['must be one of: none, view, control, or null for the role default'],
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
        const result = await updateMember({ siteId, uid, role, swoop });

        if (!result.ok) {
          if (result.failure.kind === 'is_owner') {
            return problem({
              type: ProblemType.Conflict,
              title: 'cannot change the site owner\'s role',
              status: 409,
              detail:
                'the owner\'s role and swoop come with ownership; transfer ownership via POST /api/sites/{siteId}/transfer-ownership instead',
              instance: `/api/sites/${siteId}/members/${uid}`,
              code: 'cannot_change_owner_role',
            });
          }
          if (result.failure.kind === 'not_member') {
            // Distinguished from "no such user" on purpose: the caller is told
            // the membership is missing, not that the account does not exist.
            return problemNotFound(`user ${uid} is not a member of site ${siteId}`);
          }
          return problemValidation('role must be admin or member', {
            'body.role': ['must be one of: admin, member'],
          });
        }

        // after the write, never awaited, as in DELETE. a watch they still hold
        // survives a lost control, hence `controlOnly`. `membersMayWatch` is not
        // consulted: this PATCH did not change it, and the lease enforces it.
        const { before, after } = result.value;
        const had = grantedSwoopMode(before.role, before.swoop);
        const has = grantedSwoopMode(after.role, after.swoop);
        const lostSwoop = had !== 'none' && has === 'none';
        const lostControl = had === 'control' && has !== 'control';
        if (lostSwoop || lostControl) {
          void revokeSwoopSessionsForUser({
            siteId,
            uid,
            actor: ctx.actor,
            auditActor: auditActorIdentifier(ctx.auth),
            reason: before.role !== after.role ? 'role_changed' : 'swoop_changed',
            ...(lostSwoop ? {} : { controlOnly: true }),
            ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
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
            verb: role !== undefined ? 'member_role_changed' : 'member_swoop_changed',
            ...(role !== undefined ? { role } : {}),
            ...(swoop !== undefined ? { swoop } : {}),
          },
        });

        return applyAuthDeprecations(
          NextResponse.json({ siteId, uid, role: after.role, swoop: after.swoop }),
          ctx.scopeCheck,
        );
      },
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/members/[uid]:PATCH');
  }
});
