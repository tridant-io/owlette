/**
 * GET /api/sites/{siteId}/member-candidates — the people the add-member search
 * may offer for this site, as `{ candidates: [{ uid, email, displayName }] }`.
 *
 * a site admin is offered the active members of every site where they hold
 * SITE_MEMBER_MANAGE, minus the people already on this site: rosters they can
 * already read through GET members. never the whole platform, because anyone
 * can create a site and own it, so a platform-wide search would list every
 * account. a superadmin is offered every user minus this site's members.
 * soft-deleted accounts and superadmin accounts are never offered: superadmins
 * reach every site without a row and are deliberately not members.
 *
 * the dialog fetches this once per open and filters in the browser. there is no
 * `?q=`: firestore has no case-insensitive text match, so every keystroke would
 * read the whole list again, and each request costs a blocking audit row and a
 * tick of the caller's 30/min SITE_MEMBER_MANAGE budget, which adding, removing
 * and changing members share.
 *
 * api keys are refused: a key scoped to one site must not read the rosters of
 * its owner's other sites.
 *
 * a typed email is never resolved here. an exact email goes through
 * POST /api/sites/{siteId}/members {email}, which adds the person and is
 * audited, so this route never answers whether an account exists.
 */

import { NextResponse } from 'next/server';
import { problem, problemFromError, ProblemType } from '@/lib/apiErrors';
import { applyAuthDeprecations, refuseWithoutSiteMemberManage } from '@/app/api/_shared';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import { Capability, hasCapability, siteStanding } from '@/lib/capabilities';
import { getAdminDb } from '@/lib/firebase-admin';
import type { MemberCandidate } from '@/lib/memberCandidates';
import { listUserStanding } from '@/lib/sitePolicy.server';

/** users per `getAll`, so a large union is never one unbounded read. */
const USER_READ_CHUNK = 100;

/** the ids of a site's active member rows. */
async function activeMemberIds(
  db: FirebaseFirestore.Firestore,
  siteId: string,
): Promise<Set<string>> {
  const snap = await db.collection('sites').doc(siteId).collection('members').get();
  return new Set(
    snap.docs.filter((doc) => doc.data().status === 'active').map((doc) => doc.id),
  );
}

async function readUsers(
  db: FirebaseFirestore.Firestore,
  uids: string[],
): Promise<FirebaseFirestore.DocumentSnapshot[]> {
  const reads: Array<Promise<FirebaseFirestore.DocumentSnapshot[]>> = [];
  for (let i = 0; i < uids.length; i += USER_READ_CHUNK) {
    const refs = uids.slice(i, i + USER_READ_CHUNK).map((uid) => db.collection('users').doc(uid));
    reads.push(db.getAll(...refs));
  }
  return (await Promise.all(reads)).flat();
}

function sortName(candidate: MemberCandidate): string {
  return candidate.displayName || candidate.email || candidate.uid;
}

export const GET = authorizedSiteHandler<{ siteId: string }>({
  capability: 'SITE_MEMBER_MANAGE',
  siteIdParam: 'path',
  apiKeyPermission: ['read', 'admin'],
})(async (_request, ctx) => {
  try {
    if (ctx.auth.keyContext !== null) {
      return problem({
        type: ProblemType.Forbidden,
        title: 'forbidden',
        status: 403,
        code: 'api_key_not_permitted',
        detail: 'member candidates cannot be listed with an api key.',
      });
    }

    const manageRefusal = refuseWithoutSiteMemberManage(
      ctx.actor,
      ctx.siteId,
      'listing member candidates',
      `/api/sites/${ctx.siteId}/member-candidates`,
    );
    if (manageRefusal) return manageRefusal;

    const db = getAdminDb();
    const onTarget = await activeMemberIds(db, ctx.siteId);

    let users: FirebaseFirestore.DocumentSnapshot[];
    if (ctx.actor.role === 'superadmin') {
      // no orderBy: it would drop legacy user docs that have no createdAt
      users = (
        await db.collection('users').select('email', 'displayName', 'deletedAt', 'role').get()
      ).docs;
    } else {
      // ctx.actor carries only this site's standing. it is rebuilt across every
      // site the caller is on, from the row reading every gate uses, and
      // hasCapability rather than a role check decides whose rosters are theirs.
      // this site's roster is already in hand.
      const standing = await listUserStanding(ctx.actor.userId);
      const actor = { ...ctx.actor, ...siteStanding(standing) };
      const manageable = Object.keys(standing).filter(
        (id) => id !== ctx.siteId && hasCapability(actor, Capability.SITE_MEMBER_MANAGE, id),
      );
      const rosters = await Promise.all(manageable.map((id) => activeMemberIds(db, id)));
      const uids = new Set<string>();
      for (const roster of rosters) {
        for (const uid of roster) {
          if (!onTarget.has(uid)) uids.add(uid);
        }
      }
      users = await readUsers(db, [...uids]);
    }

    const candidates: MemberCandidate[] = [];
    for (const user of users) {
      if (!user.exists || onTarget.has(user.id)) continue;
      const data = user.data() ?? {};
      if (typeof data.deletedAt === 'number' || data.role === 'superadmin') continue;
      candidates.push({
        uid: user.id,
        email: typeof data.email === 'string' ? data.email : null,
        displayName: typeof data.displayName === 'string' ? data.displayName : null,
      });
    }
    candidates.sort((a, b) =>
      sortName(a).localeCompare(sortName(b), undefined, { sensitivity: 'base' }),
    );

    return applyAuthDeprecations(NextResponse.json({ candidates }), ctx.scopeCheck);
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/member-candidates:GET');
  }
});
