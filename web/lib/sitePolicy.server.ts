/**
 * `sitePolicy.server.ts` — the single site-authorization decision core.
 *
 * Four paths used to gate site-scoped routes (`authorizedSiteHandler`,
 * `_shared`'s `require*AuthAndScope`, `hoot-utils`' `verifyUserSiteAccess`,
 * `assertUserHasSiteAccess`); they agreed on the happy path and drifted
 * everywhere else. This module owns the DECISION; callers own the RESPONSE —
 * it never builds a NextResponse, picks a status code, or decides whether a
 * capability is required.
 *
 * The wrappers keep their divergent response mappings until Task 1.3 unifies
 * them; that staging is what lets the characterization matrix in
 * `__tests__/lib/authorizationParity.test.ts` stay green across the extraction
 * and go red, deliberately, at the unification.
 */

import type { NextRequest } from 'next/server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import type { MemberStanding, Role, SiteRole } from '@/lib/capabilities';
import { parseSwoopMode, type SwoopMode } from '@/lib/swoopMode';

/**
 * The site-id ACCEPTANCE rule: could this string be an id we minted?
 *
 * Distinct from `validateSiteId` in lib/validators.ts, which is the CREATION
 * rule (3-50 chars, lowercase-leading, reserved words). The two answer different
 * questions, and using the creation rule at the gate would permanently lock a
 * tenant out of any site whose id predates it — the repo's own fixtures contain
 * ids like `s1` and `x` that the creation rule rejects.
 *
 * Lives here, beside the decision core, because every gate needs it and it was
 * previously copy-pasted into seven modules.
 */
export const SITE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Per-site standing, or `null` when the principal holds no active membership. */
export type MembershipRole = SiteRole | null;

/** Why a principal was refused. Callers map these to status codes. */
export type SiteAccessDenial = 'site_not_found' | 'user_inactive' | 'no_access';

/**
 * `siteData` is returned so callers needing the site document skip a second read.
 * It is no longer consulted for authorization: ownership is `membershipRole ===
 * 'owner'`, and the short-circuits that read `siteData.owner` are gone.
 */
export interface SiteAccessFacts {
  siteId: string;
  siteExists: boolean;
  siteData: Record<string, unknown> | null;
  /** Global role, normalised. Any unrecognised value reads as 'member'. */
  globalRole: Role;
  /**
   * `users/{uid}.role` verbatim — unnormalised, `null` when absent or non-string.
   *
   * Exposed because `hoot-utils`' `verifyUserSiteAccess` returns the raw value in
   * its public `SiteAccessLevel.role` (`string | null`). Without this, folding it
   * onto the core would quietly rewrite `null` to `'member'` and `'viewer'` to
   * `'member'`. Every consumer re-narrows the value today, so nothing would have
   * broken — but that is luck, not a contract, and the type says otherwise.
   */
  rawRole: string | null;
  /** Per-site standing. `null` when the principal is neither owner nor assigned. */
  membershipRole: MembershipRole;
  /**
   * the member row's explicit swoop mode. null with no active membership, on an
   * owner row, and with no `swoop` field.
   */
  swoopMode: SwoopMode | null;
  /**
   * `users/{uid}.sites[]`, filtered to strings. LEGACY — no longer part of any
   * access decision. Retained for audit context until wave 6.1 strips the field;
   * nothing may gate on it.
   */
  sites: string[];
  /** Millisecond timestamp when the user was soft-deleted, else null. */
  deletedAt: number | null;
  userExists: boolean;
}

export type SiteAccessOutcome =
  | { ok: true; facts: SiteAccessFacts }
  | { ok: false; reason: SiteAccessDenial; facts: SiteAccessFacts };

/** An agent ID token's claims, validated against the route it is calling. */
export interface AgentPrincipal {
  kind: 'agent';
  userId: string;
  siteId: string;
  machineId: string;
}

/**
 * Parse a stored global role.
 *
 * `'user'` is accepted alongside `'member'`: wave 5.2 rewrites every
 * non-superadmin value to `'user'`, and a parser that rejected it would drop
 * those accounts to a null/unknown role the moment the migration ran. Both
 * spellings mean the same tier — no global privilege — so accepting both is what
 * makes the rewrite a no-op for a live session rather than a mass demotion.
 */
function normaliseRole(raw: unknown): Role {
  return raw === 'superadmin' || raw === 'admin' ? raw : 'member';
}

function toStringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : [];
}

/**
 * THE MEMBERSHIP SEAM. Reads `sites/{siteId}/members/{uid}` and nothing else —
 * `sites/{siteId}.owner` and `users/{uid}.sites[]` no longer participate in any
 * access decision.
 *
 * Superadmin is deliberately NOT folded in: it is a global override resolved by
 * the caller, not a per-site role, and conflating them is what let a global
 * `admin` leak site-admin across every site in its array.
 *
 * A row whose `status` is not `active` grants nothing. `status` exists so
 * invitations can land later without a migration, and an invitation must never
 * read as a grant.
 *
 * exported so a listing of a user's sites reads member rows exactly as access does.
 */
export function deriveMembership(memberData: Record<string, unknown> | null): MembershipRole {
  if (!memberData) return null;
  if (memberData.status !== 'active') return null;
  const role = memberData.role;
  return role === 'owner' || role === 'admin' || role === 'member' ? role : null;
}

/**
 * the swoop mode a member row carries. only an admin or member row has one: the
 * owner always controls, and a row that grants nothing carries nothing.
 */
export function deriveSwoopMode(
  memberData: Record<string, unknown> | null,
  role: MembershipRole,
): SwoopMode | null {
  if (role !== 'admin' && role !== 'member') return null;
  return parseSwoopMode(memberData?.swoop);
}

/**
 * Resolve a user principal against a site in ONE batched read.
 *
 * Decision order is load-bearing and pinned by the parity matrix: a missing
 * SITE outranks an inactive user, which outranks the access check. Reordering
 * changes observable status codes.
 *
 * All three documents come from ONE `getAll`, superadmins included. Reading the
 * member row lazily would spare a superadmin one document read at the cost of a
 * second round trip for everyone else, and superadmins are a small fraction of
 * traffic — latency on the common path wins over a read on the rare one.
 */
export async function resolveSiteAccess(
  userId: string,
  siteId: string,
  /** Injectable so `hoot-utils`' `verifyUserSiteAccess` keeps its `db` contract (its tests pass a fake). */
  db: FirebaseFirestore.Firestore = getAdminDb(),
): Promise<SiteAccessOutcome> {
  const [siteDoc, userDoc, memberDoc] = await db.getAll(
    db.collection('sites').doc(siteId),
    db.collection('users').doc(userId),
    db.collection('sites').doc(siteId).collection('members').doc(userId),
  );

  const siteExists = Boolean(siteDoc?.exists);
  const siteData = (siteExists ? (siteDoc.data() as Record<string, unknown>) ?? null : null);
  const userData = userDoc?.exists ? (userDoc.data() as Record<string, unknown>) ?? null : null;
  const memberData = memberDoc?.exists ? (memberDoc.data() as Record<string, unknown>) ?? null : null;

  const globalRole = normaliseRole(userData?.role);
  const rawRole = typeof userData?.role === 'string' ? userData.role : null;
  const sites = toStringArray(userData?.sites);
  const deletedAt = typeof userData?.deletedAt === 'number' ? userData.deletedAt : null;
  const membershipRole = deriveMembership(memberData);

  const facts: SiteAccessFacts = {
    siteId,
    siteExists,
    siteData,
    globalRole,
    rawRole,
    membershipRole,
    swoopMode: deriveSwoopMode(memberData, membershipRole),
    sites,
    deletedAt,
    userExists: Boolean(userData),
  };

  if (!siteExists) return { ok: false, reason: 'site_not_found', facts };
  if (!userData || deletedAt !== null) return { ok: false, reason: 'user_inactive', facts };
  if (globalRole === 'superadmin') return { ok: true, facts };
  if (membershipRole !== null) return { ok: true, facts };

  return { ok: false, reason: 'no_access', facts };
}

/**
 * the read counterpart of `resolveSiteAccess` across every site the user is on:
 * each active member row's site role and swoop mode, keyed by site id.
 *
 * `status` is filtered in memory, by `deriveMembership`, rather than added as a
 * second `where`: a composite (uid, status) collection-group index does not
 * exist and this query is per-user, so the row count is small. the single-field
 * `members.uid` COLLECTION_GROUP override in `firestore.indexes.json` is what
 * makes this legal: automatic single-field indexing does not extend to
 * collection-group scope, and the emulator will not tell you when it is missing.
 */
export async function listUserStanding(
  userId: string,
): Promise<Record<string, MemberStanding & { role: SiteRole }>> {
  const snap = await getAdminDb().collectionGroup('members').where('uid', '==', userId).get();
  // null-prototype, because SITE_ID_RE admits `__proto__` as a site id
  const bySite: Record<string, MemberStanding & { role: SiteRole }> = Object.create(null);
  for (const doc of snap.docs) {
    const siteId = doc.ref.parent.parent?.id;
    const data = doc.data() ?? null;
    const role = deriveMembership(data);
    if (!siteId || role === null) continue;
    bySite[siteId] = { role, swoopMode: deriveSwoopMode(data, role) };
  }
  return bySite;
}

/**
 * Resolve an AGENT principal from its ID token claims alone.
 *
 * Agents have no `users/{uid}` document, so running them through
 * `resolveSiteAccess` would deny every agent screenshot and command call. The
 * token's `site_id` / `machine_id` claims ARE the authorization: an agent may
 * only ever act on the machine it was issued for.
 *
 * API keys (`owk_` prefix) are excluded up front — they are user credentials
 * and must take the user path.
 */
export async function resolveAgentPrincipal(
  req: NextRequest,
  siteId: string,
  machineId: string,
): Promise<{ matched: true; principal: AgentPrincipal } | { matched: 'mismatch' } | null> {
  const authHeader = req.headers.get('authorization') || '';
  const bearer = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!bearer || bearer[1].startsWith('owk_')) return null;

  try {
    const decoded = await getAdminAuth().verifyIdToken(bearer[1]);
    if (decoded.role !== 'agent') return null;
    if (decoded.site_id !== siteId || decoded.machine_id !== machineId) {
      return { matched: 'mismatch' };
    }
    return {
      matched: true,
      principal: {
        kind: 'agent',
        userId: decoded.uid,
        siteId,
        machineId,
      },
    };
  } catch {
    // Not a verifiable agent ID token — the caller falls through to user auth.
    return null;
  }
}
