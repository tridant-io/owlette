/**
 * GET /api/admin/activity — the superadmin activity feed, newest first,
 * cursor-paginated (AIP-158). Returns `{ rows, nextPageToken }`.
 *
 * Superadmin only: a `user=*:read` api key, or a session/id-token whose
 * `users/{uid}.role === 'superadmin'`, rechecked on every request. Reading the
 * feed writes no audit row of its own.
 *
 * Params: view (all | flagged | changes | refused | sign-ins, default all),
 * user (uid), site (site id), since and until (unix ms or iso 8601, both
 * included), page_size (1..100, default 50), page_token (opaque; a page can be
 * empty and still carry a token).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problemFromError, problemValidation } from '@/lib/apiErrors';
import { InvalidPageTokenError, loadActivityPage } from '@/lib/activity/feed.server';
import { loadUserLabels } from '@/lib/activity/labels.server';
import type { ActivityView } from '@/lib/activity/types';
import { getAdminDb } from '@/lib/firebase-admin';
import { parsePagination, withPaginationFields } from '@/lib/pagination';
import { parseTimestampQuery } from '@/lib/timestampQuery';
import { applyAuthDeprecations, requirePlatformAuthAndScope } from '@/app/api/_shared';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const VIEWS: readonly ActivityView[] = ['all', 'flagged', 'changes', 'refused', 'sign-ins'];
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export async function GET(request: NextRequest) {
  try {
    const auth = await requirePlatformAuthAndScope(request, 'user', 'read');
    if (!auth.ok) return auth.response;

    const sp = request.nextUrl.searchParams;

    const view = sp.get('view') ?? 'all';
    if (!VIEWS.includes(view as ActivityView)) {
      return problemValidation('invalid view', {
        'query.view': [`must be one of ${VIEWS.join(', ')}`],
      });
    }

    const userId = sp.get('user') ?? undefined;
    if (userId !== undefined && !ID_RE.test(userId)) {
      return problemValidation('invalid user', { 'query.user': ['must be a user id'] });
    }
    const siteId = sp.get('site') ?? undefined;
    if (siteId !== undefined && !ID_RE.test(siteId)) {
      return problemValidation('invalid site', { 'query.site': ['must be a site id'] });
    }

    const sinceMs = parseTimestampQuery(sp, 'since');
    if (sinceMs instanceof NextResponse) return sinceMs;
    const untilMs = parseTimestampQuery(sp, 'until');
    if (untilMs instanceof NextResponse) return untilMs;
    if (sinceMs !== undefined && untilMs !== undefined && sinceMs > untilMs) {
      return problemValidation('since must be <= until', {
        'query.since': ['must be <= query.until'],
      });
    }

    const parsedPagination = parsePagination(sp, {
      defaultPageSize: DEFAULT_PAGE_SIZE,
      maxPageSize: MAX_PAGE_SIZE,
    });
    if (!parsedPagination.ok) return parsedPagination.response;
    const { pageSize, pageToken } = parsedPagination.pagination;

    const db = getAdminDb();
    const page = await loadActivityPage(db, {
      view: view as ActivityView,
      userId,
      siteId,
      sinceMs,
      untilMs,
      pageSize,
      pageToken,
    });

    const people = page.rows.flatMap((r) => [r.actor, ...(r.subject ? [r.subject] : [])]).filter((a) => a.type === 'user');
    const labels = await loadUserLabels(db, people.map((a) => a.id));
    for (const person of people) person.label = labels[person.id];

    return applyAuthDeprecations(
      NextResponse.json(withPaginationFields({ rows: page.rows }, page.nextPageToken)),
      auth.scopeCheck,
    );
  } catch (err) {
    if (err instanceof InvalidPageTokenError) {
      return problemValidation('invalid page token', {
        'query.page_token': ['not a token this feed issued'],
      });
    }
    return problemFromError(err, 'admin/activity:GET');
  }
}
