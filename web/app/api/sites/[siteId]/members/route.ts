/**
 * GET  /api/sites/{siteId}/members — reads `sites/{siteId}/members`, the rows
 *      that actually grant access, and derives each person's role FROM THE ROW.
 *      It used to query `users where sites array-contains {siteId}` and compute
 *      the per-site role from the GLOBAL role, which reported a real site-admin
 *      as a plain member forever. each member also carries `swoop`, their own
 *      swoop mode: null when the role decides (always, on the owner's row), and
 *      `none` for a malformed value, so a hand edit never reads as a grant. and
 *      `machineIds`, their machine scope: null for the whole site, else the
 *      machines they reach, read as the rules read it, so `[]` or a malformed
 *      value is no machines.
 *
 * POST /api/sites/{siteId}/members  `{uid | email, role}` — writes the member
 *      row through `addMember`, so the requested role is STORED rather than
 *      derived, and mirrors the id into the legacy `users/{uid}.sites[]` while
 *      that field still exists. `email` is the dashboard's affordance (an admin
 *      knows a colleague's address, not their uid) and resolves through Admin
 *      Auth to the same uid path. Idempotency-Key required. `roleHonored` says
 *      whether the row was actually written at the requested role — adding an
 *      existing member is a 200 no-op, not a promotion. the body may also carry
 *      `swoop` (`none`, `view` or `control`), written on a new row only; the
 *      no-op writes no mode either. `machineIds`, 1-30 machines of this site,
 *      makes the new row a scoped member; absent means the whole site. like the
 *      mode it is written on a new row only, and nobody scopes themselves.
 *
 * Auth (both verbs): `authorizedSiteHandler({ capability: 'SITE_MEMBER_MANAGE' })`,
 * with api-key permissions `['read','admin']` on GET and `['write','admin']` on
 * POST. Site access is membership — a global `admin` role grants nothing here.
 * POST additionally re-checks the capability IN the handler, where the
 * `capability_enforcement` kill switch cannot skip it — see
 * `refuseWithoutSiteMemberManage` in `_shared.ts`.
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
import {
  applyAuthDeprecations,
  readAndParseJsonBody,
  refuseWithoutSiteMemberManage,
} from '../../../_shared';
import { addMember, type AssignableRole } from '@/lib/membership.server';
import { deriveMachineIds, deriveSwoopMode } from '@/lib/sitePolicy.server';
import { normalizeMachineIdsInput } from '@/lib/machineAccess';
import { SWOOP_MODES, type SwoopMode } from '@/lib/swoopMode';

const UID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
const VALID_ADD_ROLES = new Set(['member', 'admin']);
/** RFC 5321 max path length — a plausibility bound, not an address validator. */
const MAX_EMAIL_LENGTH = 254;

type RouteParams = { siteId: string };

interface AddMemberBody {
  uid?: unknown;
  email?: unknown;
  role?: unknown;
  swoop?: unknown;
  machineIds?: unknown;
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

/**
 * a 400 naming each id that is not a machine of this site, or null when every
 * one is. one getAll, however long the list. PATCH /members/{uid} shares it.
 */
export async function refuseUnknownMachines(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineIds: readonly string[],
): Promise<NextResponse | null> {
  const machines = db.collection('sites').doc(siteId).collection('machines');
  const snaps = await db.getAll(...machineIds.map((id) => machines.doc(id)));
  const unknown = machineIds.filter((_, i) => !snaps[i].exists);
  if (unknown.length === 0) return null;
  return problemValidation('machineIds must name machines on this site', {
    'body.machineIds': [`unknown machine: ${unknown.join(', ')}`],
  });
}

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
      swoop: SwoopMode | null;
      machineIds: readonly string[] | null;
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
        swoop: deriveSwoopMode(row.data() ?? null, rowRole),
        machineIds: deriveMachineIds(row.data() ?? null, rowRole),
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

    // Placed before the body read and before `withIdempotency`: the decision
    // depends on nothing but actor and site, and `withIdempotency` saves
    // whatever the handler returns — a 403 stored under a key would be replayed
    // at a legitimate later call.
    const manageRefusal = refuseWithoutSiteMemberManage(
      ctx.actor,
      siteId,
      'adding a member',
      `/api/sites/${siteId}/members`,
    );
    if (manageRefusal) return manageRefusal;

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

        // a new row has no mode to clear, so null is a bad value here, unlike on PATCH
        const requestedSwoop = SWOOP_MODES.find((mode) => mode === body.swoop);
        if (body.swoop !== undefined && requestedSwoop === undefined) {
          return problemValidation('swoop must be none, view or control', {
            'body.swoop': ['must be one of: none, view, control'],
          });
        }

        const scopeInput =
          body.machineIds === undefined
            ? undefined
            : normalizeMachineIdsInput(body.machineIds, { allowNull: false });
        if (scopeInput && !scopeInput.ok) {
          return problemValidation(scopeInput.error, { 'body.machineIds': [scopeInput.error] });
        }
        // allowNull is off, so a valid list is never null
        const requestedMachineIds = scopeInput?.value ?? undefined;

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

        // scoping yourself changes the row that decides what you may do, which
        // PATCH /members/{uid} refuses too (`refuseSelfMembershipChange`)
        if (requestedMachineIds !== undefined && targetUid === ctx.actor.userId) {
          return problem({
            type: ProblemType.Forbidden,
            title: 'cannot modify your own membership',
            status: 403,
            detail:
              'you cannot set your own machine access on this site; ask another admin on this site',
            instance: `/api/sites/${siteId}/members`,
            code: 'cannot_modify_own_membership',
          });
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

        if (requestedMachineIds !== undefined) {
          const unknownMachines = await refuseUnknownMachines(db, siteId, requestedMachineIds);
          if (unknownMachines) return unknownMachines;
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
          swoop: requestedSwoop,
          machineIds: requestedMachineIds,
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
            ...(requestedSwoop !== undefined ? { requestedSwoop } : {}),
            ...(requestedMachineIds !== undefined ? { requestedMachineIds } : {}),
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
