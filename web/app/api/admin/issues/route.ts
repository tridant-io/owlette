/**
 * GET /api/admin/issues — issues, newest first, cursor-paginated (AIP-158).
 * Returns `{ issues, nextPageToken }`.
 *
 * Superadmin only: an `issue=*:read` api key, or a session/id-token whose
 * `users/{uid}.role === 'superadmin'`, rechecked on every request.
 *
 * Params: status (new | triaged | fixed | wontfix), page_size (1..100, default
 * 20), page_token (opaque — the issue id to start after).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problemFromError, problemValidation } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { ISSUE_STATUSES, type IssueStatus } from '@/lib/issues';
import { serializeIssue } from '@/lib/issues.server';
import {
  collectFilteredPage,
  parsePagination,
  withPaginationFields,
} from '@/lib/pagination';
import { applyAuthDeprecations, requirePlatformAuthAndScope } from '@/app/api/_shared';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export async function GET(request: NextRequest) {
  try {
    const auth = await requirePlatformAuthAndScope(request, 'issue', 'read');
    if (!auth.ok) return auth.response;

    const sp = request.nextUrl.searchParams;

    const status = sp.get('status');
    if (status !== null && !ISSUE_STATUSES.includes(status as IssueStatus)) {
      return problemValidation('invalid status', {
        'query.status': [`must be one of ${ISSUE_STATUSES.join(', ')}`],
      });
    }

    const parsedPagination = parsePagination(sp, {
      defaultPageSize: DEFAULT_PAGE_SIZE,
      maxPageSize: MAX_PAGE_SIZE,
    });
    if (!parsedPagination.ok) return parsedPagination.response;
    const { pageSize, pageToken } = parsedPagination.pagination;

    const issuesCol = getAdminDb().collection('bug_reports');
    const filtered = status === null ? issuesCol : issuesCol.where('status', '==', status);

    const page = await collectFilteredPage({
      pageSize,
      pageToken,
      fetchPage: async (cursor, limit) => {
        let query = filtered.orderBy('createdAt', 'desc').limit(limit);
        if (cursor) {
          const cursorSnap = await issuesCol.doc(cursor).get();
          if (cursorSnap.exists) query = query.startAfter(cursorSnap);
        }
        const snap = await query.get();
        return snap.docs;
      },
      include: () => true,
    });

    return applyAuthDeprecations(
      NextResponse.json(
        withPaginationFields({ issues: page.docs.map(serializeIssue) }, page.nextPageToken),
      ),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'admin/issues:GET');
  }
}
