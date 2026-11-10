/**
 * GET /api/users/{uid}/talons — every talon this user authored, fleet-wide.
 *
 * `DELETE /api/users/{uid}` refuses to orphan the SITES a user owns but says
 * nothing about their automations, and every talon re-checks its author before
 * any output fires, so after the author is soft-deleted each one switches off
 * at its next run with nothing fired. This is the count the delete
 * confirmation needs to name that consequence.
 *
 * One collection-group query, NOT a walk of `users/{uid}.sites[]` — a
 * superadmin's membership array can be empty while they author fleet-wide,
 * under-reporting exactly the accounts whose departure costs most.
 *
 * Auth: superadmin session, or an api key with `user=*:read`.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { problemFromError, problemValidation } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { listTalonsAuthoredByAcrossSites } from '@/lib/talons/store.server';
import { applyAuthDeprecations, requirePlatformAuthAndScope } from '../../../_shared';

export const runtime = 'nodejs';

const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;

type RouteParams = { uid: string };

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<RouteParams> },
) {
  try {
    const { uid } = await params;
    if (!UID_RE.test(uid)) {
      return problemValidation('uid must be 1-128 chars', {
        'path.uid': ['letters, digits, underscore, hyphen only'],
      });
    }

    const auth = await requirePlatformAuthAndScope(request, 'user', 'read');
    if (!auth.ok) return auth.response;

    const talons = await listTalonsAuthoredByAcrossSites(getAdminDb(), uid);

    // Per-site tally so the confirmation reads "3 on the lobby, 1 on the
    // atrium" rather than one number.
    const countBySite = new Map<string, number>();
    for (const talon of talons) {
      countBySite.set(talon.siteId, (countBySite.get(talon.siteId) ?? 0) + 1);
    }

    return applyAuthDeprecations(
      NextResponse.json({
        uid,
        count: talons.length,
        sites: [...countBySite.entries()].map(([siteId, count]) => ({ siteId, count })),
        talons,
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'users/[uid]/talons:GET');
  }
}
