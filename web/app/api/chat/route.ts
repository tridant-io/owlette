/**
 * GET /api/hoot/conversations — list conversations the caller can access.
 * `/api/chat` is a compatibility alias for the same handler.
 *
 * Filters on `siteId` against the caller's effective access set. Api-key
 * callers additionally intersect with the key's `chat=<siteId>:read` scopes, so
 * a key scoped to one site can't list others even when the user behind it can.
 * Session/id-token callers use `listUserSiteIds` (member rows).
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problemFromError,
  problemUnauthorized,
  mfaChallengeProblem,
  problemValidation,
} from '@/lib/apiErrors';
import {
  ApiAuthError,
  resolveAuth,
} from '@/lib/apiAuth.server';
import { listUserSiteIds } from '@/lib/membership.server';
import {
  listConversations,
  serializeConversationSummary,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '@/lib/chatStorage.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { SITE_ID_RE } from '@/lib/sitePolicy.server';


export async function GET(request: NextRequest) {
  try {
    let auth;
    try {
      auth = await resolveAuth(request);
    } catch (err) {
      if (err instanceof ApiAuthError) return mfaChallengeProblem(err) ?? problemUnauthorized();
      throw err;
    }

    const pageSizeRaw = Number(
      request.nextUrl.searchParams.get('page_size') ??
        request.nextUrl.searchParams.get('limit') ??
        DEFAULT_PAGE_SIZE,
    );
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(
        1,
        Number.isFinite(pageSizeRaw) ? Math.floor(pageSizeRaw) : DEFAULT_PAGE_SIZE,
      ),
    );
    const pageToken =
      request.nextUrl.searchParams.get('page_token') ??
      request.nextUrl.searchParams.get('cursor') ??
      '';
    const includeDeleted = request.nextUrl.searchParams.get('includeDeleted') === 'true';
    // Conversations are user-private, so default to owner-is-me — without it any
    // site member could enumerate others' chats on a shared site. Only
    // superadmins may widen it with `?owner=all`.
    const ownerParam = request.nextUrl.searchParams.get('owner');
    let ownerFilter: string | undefined = auth.userId;
    if (ownerParam === 'all') {
      const userDoc = await getAdminDb().collection('users').doc(auth.userId).get();
      const isSuperadmin = userDoc.exists && userDoc.data()?.role === 'superadmin';
      if (isSuperadmin) ownerFilter = undefined;
    }
    const siteIdRaw = request.nextUrl.searchParams.get('siteId');

    let requestedSiteId: string | undefined;
    if (siteIdRaw !== null) {
      requestedSiteId = siteIdRaw.trim();
      if (!SITE_ID_RE.test(requestedSiteId)) {
        return problemValidation('invalid siteId format', {
          'query.siteId': ['must be 1-128 chars: letters, digits, underscore, hyphen'],
        });
      }
    }

    const accessibleSiteIds = await resolveReadableSiteIds(auth.userId, auth.keyContext);
    const effectiveSiteIds = requestedSiteId
      ? accessibleSiteIds.filter((siteId) => siteId === requestedSiteId)
      : accessibleSiteIds;

    if (effectiveSiteIds.length === 0) {
      return NextResponse.json({
        ok: true,
        data: { conversations: [], next_page_token: '', nextPageToken: '' },
      });
    }

    const result = await listConversations({
      siteIds: effectiveSiteIds,
      ownerUid: ownerFilter,
      pageSize,
      pageToken,
      includeDeleted,
    });

    return NextResponse.json({
      ok: true,
      data: {
        conversations: result.conversations.map(serializeConversationSummary),
        next_page_token: result.nextPageToken,
        nextPageToken: result.nextPageToken,
      },
    });
  } catch (err) {
    return problemFromError(err, 'chat:GET');
  }
}

/**
 * Site ids whose chat conversations the caller may read.
 *
 * - Session/id-token: membership list plus owned sites. No wildcard even for
 *   superadmins — the list helper needs a site-id filter for sane query plans.
 * - Scoped api keys: membership ∩ the key's `chat` scopes; `chat=*` widens back
 *   to the full membership list.
 * - Legacy keys (no `scopes`): treated as session callers, no intersection.
 */
async function resolveReadableSiteIds(
  userId: string,
  keyContext: Awaited<ReturnType<typeof resolveAuth>>['keyContext'],
): Promise<string[]> {
  // Member ROWS, not `users/{uid}.sites[]`. That array is legacy and wave 6.1
  // strips it; reading it here would have made this route return an empty 200
  // — no error, no log — for every caller the moment the migration ran.
  //
  // The owned-sites read stays as a transitional union: on an environment where
  // the membership backfill has not run yet, a site owner has no member row, and
  // dropping it would lock them out of their own conversations. It is redundant
  // once backfilled (owners get a row with role 'owner') and is safe to remove
  // after prod is migrated.
  const membership = await listUserSiteIds(userId);
  const ownedSites = await readOwnedSiteIds(userId);
  const membershipSet = new Set<string>([...membership, ...ownedSites]);

  if (!keyContext || keyContext.isLegacy || !keyContext.scopes) {
    return [...membershipSet];
  }

  const chatScopes = keyContext.scopes.filter(
    (s) => s.resource === 'chat' && s.permissions.includes('read'),
  );
  if (chatScopes.length === 0) return [];
  if (chatScopes.some((s) => s.id === '*')) return [...membershipSet];

  const allowed = new Set(chatScopes.map((s) => s.id));
  return [...membershipSet].filter((siteId) => allowed.has(siteId));
}

async function readOwnedSiteIds(userId: string): Promise<string[]> {
  try {
    const db = getAdminDb();
    const snap = await db.collection('sites').where('owner', '==', userId).get();
    return snap.docs.map((d) => d.id);
  } catch {
    // Degrade to the membership list. This filter is defence-in-depth narrowing;
    // it never grants access beyond the scope/membership check.
    return [];
  }
}
