/**
 * GET /api/sites/{siteId}/talons/authored?uid={uid} — what this person wrote.
 *
 * The departure preview. Removing a member touches nothing under `sites/{siteId}`, so
 * their talons survive and keep looking healthy in the list — but every talon re-checks
 * its AUTHOR's site access before any output fires, so at its next run after they lose
 * access it switches off with nothing fired. This lets the member-removal UI say "they
 * wrote 4 talons — these stop running" *before* the removal instead of after.
 *
 * Names, not just a count: an operator deciding whether to reassign needs to know it's
 * the nightly restart, not a one-off test. Bounded by MAX_TALONS_PER_SITE (20), so the
 * read can never grow expensive; `countTalonsAuthoredBy` backs count-only surfaces.
 *
 * Capability: TALON_MANAGE, read-class api-key scope — same as listing talons.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { problemFromError, problemValidation } from '@/lib/apiErrors';
import {
  authorizedSiteHandler,
  type SiteHandlerContext,
} from '@/lib/authorizedHandler.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { listTalonsAuthoredBy } from '@/lib/talons/store.server';

export const runtime = 'nodejs';

const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;

type RouteParams = { siteId: string };

export const GET = authorizedSiteHandler<RouteParams>({
  capability: 'TALON_MANAGE',
  siteIdParam: 'path',
  targetKind: 'talon',
  apiKeyPermission: 'read',
})(async (request: NextRequest, ctx: SiteHandlerContext) => {
  try {
    const uid = request.nextUrl.searchParams.get('uid');
    if (!uid || !UID_RE.test(uid)) {
      return problemValidation('uid is required', {
        'query.uid': ['must be 1-128 chars: letters, digits, underscore, hyphen'],
      });
    }

    const talons = await listTalonsAuthoredBy(getAdminDb(), ctx.siteId, uid);

    return NextResponse.json({
      siteId: ctx.siteId,
      uid,
      count: talons.length,
      talons: talons.map((talon) => ({
        id: talon.id,
        name: talon.name,
        enabled: talon.enabled,
      })),
    });
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/talons/authored:GET');
  }
});
