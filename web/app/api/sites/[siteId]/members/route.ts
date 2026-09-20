/**
 * GET  /api/sites/{siteId}/members — reads `sites/{siteId}/members`, the rows
 *      that actually grant access, and derives each person's role FROM THE ROW.
 *      It used to query `users where sites array-contains {siteId}` and compute
 *      the per-site role from the GLOBAL role, which reported a real site-admin
 *      as a plain member forever.
 *
 * POST /api/sites/{siteId}/members  `{uid | email, role}` — writes the member
 *      row through `addMember`, so the requested role is STORED rather than
 *      derived, and mirrors the id into the legacy `users/{uid}.sites[]` while
 *      that field still exists. `email` is the dashboard's affordance (an admin
 *      knows a colleague's address, not their uid) and resolves through Admin
 *      Auth to the same uid path. Idempotency-Key required. `roleHonored` says
 *      whether the row was actually written at the requested role — adding an
 *      existing member is a 200 no-op, not a promotion.
 *
 * Auth (both verbs): `authorizedSiteHandler({ capability: 'SITE_MEMBER_MANAGE' })`,
 * with api-key permissions `['read','admin']` on GET and `['write','admin']` on
 * POST. Site access is membership — a global `admin` role grants nothing here.
 * POST additionally re-checks the capability IN the handler, where the
 * `capability_enforcement` kill switch cannot skip it — see the comment there.
 *
 * api-sprint wave 3 track 3B (users-api / site-members).
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
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import { withIdempotency } from '@/lib/idempotency';
import { emitMutation } from '@/lib/auditLogClient';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import { Capability, hasCapability } from '@/lib/capabilities';
import {
  applyAuthDeprecations,
  readAndParseJsonBody,
} from '../../../_shared';
import { addMember, type AssignableRole } from '@/lib/membership.server';

const UID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
const VALID_ADD_ROLES = new Set(['member', 'admin']);
/** RFC 5321 max path length — a plausibility bound, not an address validator. */
const MAX_EMAIL_LENGTH = 254;

type RouteParams = { siteId: string };

interface AddMemberBody {
  uid?: unknown;
  email?: unknown;
  role?: unknown;
}

/** Which identifier the caller supplied; resolved to a uid before any write. */
type AddMemberTarget =
  | { kind: 'uid'; uid: string }
  | { kind: 'email'; email: string };

interface UserDoc {
  email?: string;
  role?: string;
  displayName?: string;
  deletedAt?: number;
}

/** Per-site standing, read from the row that grants it. */
type MemberRole = 'owner' | 'admin' | 'member';

export const GET = authorizedSiteHandler<RouteParams>({
  capability: 'SITE_MEMBER_MANAGE',
  siteIdParam: 'path',
  // Opted in because these routes already enforced it through the inner
  // _shared gate; without this, removing that gate would silently drop the
  // 400 on an unsupported Roost-Version.
  roostVersioned: true,
  // read AND admin: the inner gate asked for admin, the outer for read, and
  // permissions are not hierarchical, so both were genuinely required.
  apiKeyPermission: ['read', 'admin'],
})(async (request: NextRequest, ctx, routeContext) => {
  try {
    const { siteId } = await routeContext.params;

    const db = getAdminDb();

    // Read the ROWS THAT GRANT, not `users where sites array-contains`. The old
    // query derived each per-site role from the GLOBAL role, so a member added as
    // a site admin — which `addMember` genuinely writes — was reported as
    // `member` forever, and the one surface that could reveal the grant showed
    // the opposite of the truth.
    const [siteSnap, memberRowsSnap] = await Promise.all([
      db.collection('sites').doc(siteId).get(),
      db.collection('sites').doc(siteId).collection('members').get(),
    ]);

    if (!siteSnap.exists) {
      return problemNotFound(`site ${siteId} not found`);
    }

    // No `sites` field: a member's full membership list would hand a site admin
    // the site ids of every other org that member belongs to.
    const members: Array<{
      uid: string;
      email: string | null;
      role: MemberRole;
      globalRole: string;
      displayName: string | null;
    }> = [];

    const activeRows = memberRowsSnap.docs.filter(
      (doc) => (doc.data() ?? {}).status === 'active',
    );
    const userSnaps = activeRows.length
      ? await db.getAll(...activeRows.map((doc) => db.collection('users').doc(doc.id)))
      : [];

    activeRows.forEach((row, i) => {
      const userSnap = userSnaps[i];
      // A member row can outlive its user (hard-deleted account, or an owner that
      // was never a real user). Listing it would surface a uid with no account.
      if (!userSnap?.exists) return;
      const data = userSnap.data() as UserDoc;
      if (typeof data.deletedAt === 'number') return;
      const rowRole = (row.data() ?? {}).role;
      members.push({
        uid: row.id,
        email: typeof data.email === 'string' ? data.email : null,
        role:
          rowRole === 'owner' || rowRole === 'admin' || rowRole === 'member'
            ? rowRole
            : 'member',
        globalRole: typeof data.role === 'string' ? data.role : 'member',
        displayName:
          typeof data.displayName === 'string' ? data.displayName : null,
      });
    });

    return applyAuthDeprecations(
      NextResponse.json({ members }),
      ctx.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/members:GET');
  }
});

export const POST = authorizedSiteHandler<RouteParams>({
  capability: 'SITE_MEMBER_MANAGE',
  siteIdParam: 'path',
  // write AND admin: the inner gate asked for admin while the wrapper defaulted
  // to write, and permissions are not hierarchical, so both were required. The
  // inner gate is gone; the requirement it carried is stated here.
  apiKeyPermission: ['write', 'admin'],
  targetKind: 'user',
})(async (request: NextRequest, ctx, routeContext) => {
  try {
    const { siteId } = await routeContext.params;

    // CAPABILITY, RE-CHECKED IN THE HANDLER — deliberately not a duplicate of
    // the wrapper's check, because the wrapper's is SKIPPED while
    // `capability_enforcement` is false (the 4h operator break-glass in
    // `global/security_config`) and SITE_MEMBER_MANAGE is not in
    // BYPASS_EXEMPT_CAPABILITIES. Browser sessions never reach `requireScope`
    // either, so during that window a plain site `member` reached this handler
    // and could write a membership row for any account at any role. Nothing
    // below stopped it: the owner guard refuses only the OWNER as a target, and
    // `addMember`'s create() refuses only a target that ALREADY has a row.
    //
    // What makes that worse than an ordinary bypass is that the grant OUTLIVES
    // the window. The added account is a site admin on merit, so it keeps
    // MACHINE_REMOTE_CONTROL and SWOOP_SETTINGS_MANAGE once the switch is back
    // on, and can then promote the original caller through the sibling PATCH
    // with enforcement fully restored. Time-boxed break-glass, permanent admin.
    //
    // Placed before the body read and before `withIdempotency`: the decision
    // depends on nothing but actor and site, and `withIdempotency` saves
    // whatever the handler returns — a 403 stored under a key would be replayed
    // at a legitimate later call.
    if (!hasCapability(ctx.actor, Capability.SITE_MEMBER_MANAGE, siteId)) {
      return problem({
        type: ProblemType.Forbidden,
        title: 'forbidden',
        status: 403,
        detail:
          'adding a member requires the SITE_MEMBER_MANAGE capability on this site',
        instance: `/api/sites/${siteId}/members`,
        code: 'site_member_manage_required',
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
        const body = parsed.body as AddMemberBody;
        const hasUid = body.uid !== undefined && body.uid !== null;
        const hasEmail = body.email !== undefined && body.email !== null;
        if (hasUid === hasEmail) {
          return problemValidation(
            'exactly one of uid or email is required',
            {
              'body.uid': ['provide exactly one of uid or email'],
              'body.email': ['provide exactly one of uid or email'],
            },
          );
        }

        let target: AddMemberTarget;
        if (hasUid) {
          if (typeof body.uid !== 'string' || !UID_REGEX.test(body.uid)) {
            return problemValidation('uid is required and must be valid', {
              'body.uid': ['must be 1-128 chars: letters, digits, underscore, hyphen'],
            });
          }
          target = { kind: 'uid', uid: body.uid };
        } else {
          const email =
            typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
          if (
            email.length === 0 ||
            email.length > MAX_EMAIL_LENGTH ||
            !email.includes('@')
          ) {
            return problemValidation('email is required and must be valid', {
              'body.email': [
                `must be an email address of at most ${MAX_EMAIL_LENGTH} chars`,
              ],
            });
          }
          target = { kind: 'email', email };
        }

        const requestedRole = body.role;
        if (
          typeof requestedRole !== 'string' ||
          !VALID_ADD_ROLES.has(requestedRole)
        ) {
          return problemValidation(
            'role is required and must be admin or member',
            { 'body.role': ['must be one of: admin, member'] },
          );
        }

        // An email is only an alias for a uid — resolve it through Admin Auth,
        // then every downstream step is the uid path unchanged.
        let targetUid: string;
        if (target.kind === 'uid') {
          targetUid = target.uid;
        } else {
          try {
            const record = await getAdminAuth().getUserByEmail(target.email);
            targetUid = record.uid;
          } catch (authErr) {
            if (
              (authErr as { code?: string } | null)?.code ===
              'auth/user-not-found'
            ) {
              return problemNotFound(`user ${target.email} not found`);
            }
            throw authErr;
          }
        }

        const db = getAdminDb();
        const userRef = db.collection('users').doc(targetUid);
        const userSnap = await userRef.get();
        if (!userSnap.exists) {
          return problemNotFound(`user ${targetUid} not found`);
        }
        const userData = userSnap.data() ?? {};
        if (typeof userData.deletedAt === 'number') {
          // Key the field error to whichever identifier the caller actually sent.
          return problemValidation(
            'cannot add a soft-deleted user as a member',
            { [`body.${target.kind}`]: ['user is soft-deleted'] },
          );
        }

        // OWNER GUARD. `addMember` uses create(), which refuses to overwrite an
        // existing member row — but that protects nothing on a site created before
        // the members subcollection existed, because its owner has no row to
        // collide with until the Wave 3 backfill. The legacy `owner` field is the
        // only thing reliably true today, so it is checked here. Without this,
        // POSTing the owner of a pre-backfill site would write them a `member` row
        // and quietly demote the owner in the new shape.
        const siteSnapForOwner = await db.collection('sites').doc(siteId).get();
        const ownerUid = (siteSnapForOwner.data() ?? {}).owner;
        if (typeof ownerUid === 'string' && ownerUid === targetUid) {
          return problem({
            type: ProblemType.Conflict,
            title: 'target already owns this site',
            status: 409,
            detail:
              'the site owner is already a member and cannot be re-added with a lesser role',
            instance: `/api/sites/${siteId}/members`,
            code: 'target_is_owner',
          });
        }

        // Wave 2 task 2.3: through the single writer, which dual-writes the member
        // document and the legacy `sites[]` entry in one batch.
        //
        // `already_member` maps to this endpoint's existing 200: the route is
        // documented idempotent and clients rely on it. That mapping is safe
        // precisely BECAUSE create() refused — nothing was overwritten, so
        // reporting success costs no integrity. The helper's job is to never
        // silently clobber; the HTTP semantic is the route's to choose.
        // VALID_ADD_ROLES holds exactly these two and the check above already
        // rejected anything else; `Set.has` just does not narrow the type.
        const assignableRole: AssignableRole =
          requestedRole === 'admin' ? 'admin' : 'member';
        const added = await addMember({
          siteId,
          uid: targetUid,
          role: assignableRole,
          addedBy: ctx.actor.userId,
        });
        if (!added.ok && added.failure.kind !== 'already_member') {
          return problemValidation('could not add member', {
            'body.role': ['must be one of: admin, member'],
          });
        }

        // What actually happened to the ROW, which is not always what was asked.
        //
        // This once computed whether the GLOBAL role would let the requested
        // per-site role stick, back when per-site roles were derived at read
        // time; reporting `false` while writing a real site-admin row made the
        // response, the dashboard toast, both SDKs and the AUDIT ROW state the
        // inverse of what happened. Hardcoding `true` fixed that case and
        // introduced its mirror image: `addMember` uses create(), so a target who
        // is ALREADY a member is `already_member` — nothing is written and the
        // row keeps the role it had. This endpoint still answers 200 there on
        // purpose (see the note above), which leaves `roleHonored` as the only
        // thing carrying the difference, in the response AND in the audit row
        // someone reads after a break-glass to find out what was granted.
        //
        // Changing an existing member's role is PATCH /members/{uid}.
        const roleHonored = added.ok;
        // Still reported so a caller can see the account's platform tier, which is
        // now unrelated to what they may do on this site.
        const targetGlobalRole =
          typeof userData.role === 'string' ? userData.role : 'member';

        emitMutation({
          kind: 'site_member_mutated',
          siteId,
          actor: ctx.auth.keyContext
            ? `apiKey:${ctx.auth.keyContext.keyId}`
            : `user:${ctx.actor.userId}`,
          targetId: targetUid,
          attributes: {
            endpoint: `/api/sites/${siteId}/members`,
            method: 'POST',
            verb: 'member_added',
            requestedRole,
            roleHonored,
            globalRole: targetGlobalRole,
          },
        });

        return applyAuthDeprecations(
          NextResponse.json({
            uid: targetUid,
            siteId,
            requestedRole,
            roleHonored,
            globalRole: targetGlobalRole,
          }),
          ctx.scopeCheck,
        );
      },
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/members:POST');
  }
});
