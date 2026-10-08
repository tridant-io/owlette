/**
 * GET /api/installer — installer versions, newest first, cursor-paginated
 * (AIP-158). Returns `{ versions, nextPageToken }`.
 *
 * Superadmin only: an `installer=*:read` api key, or a session/id-token whose
 * `users/{uid}.role === 'superadmin'`.
 *
 * Params: page_size (1..100, default 20), page_token (opaque — the version id to
 * start after), includeDeleted (default false).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problemFromError } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  collectFilteredPage,
  parsePagination,
  withPaginationFields,
} from '@/lib/pagination';
import {
  installerVersionResponse,
  type InstallerVersionRecord,
} from '@/lib/installerVersionResponse.server';
import { tridantReleaseState } from '@/lib/tridantRelease.server';
import { applyAuthDeprecations, requirePlatformAuthAndScope } from '../_shared';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export async function GET(request: NextRequest) {
  try {
    const auth = await requirePlatformAuthAndScope(request, 'installer', 'read');
    if (!auth.ok) return auth.response;

    const sp = request.nextUrl.searchParams;

    const parsedPagination = parsePagination(sp, {
      defaultPageSize: DEFAULT_PAGE_SIZE,
      maxPageSize: MAX_PAGE_SIZE,
    });
    if (!parsedPagination.ok) return parsedPagination.response;
    const { pageSize, pageToken } = parsedPagination.pagination;
    const includeDeleted = sp.get('includeDeleted') === 'true';

    const db = getAdminDb();
    const versionsCol = db
      .collection('installer_metadata')
      .doc('data')
      .collection('versions');

    const page = await collectFilteredPage({
      pageSize,
      pageToken,
      fetchPage: async (cursor, limit) => {
        let query = versionsCol.orderBy('uploaded_at', 'desc').limit(limit);
        if (cursor) {
          const cursorSnap = await versionsCol.doc(cursor).get();
          if (cursorSnap.exists) query = query.startAfter(cursorSnap);
        }
        const snap = await query.get();
        return snap.docs;
      },
      include: (doc) => {
        const data = doc.data() as InstallerVersionRecord;
        const deletedAt =
          typeof data.deletedAt === 'number' ? data.deletedAt : null;
        return includeDeleted || deletedAt === null;
      },
    });

    const versions = page.docs.map((d) => ({
      ...installerVersionResponse(d.id, d.data() as InstallerVersionRecord),
      tridant: tridantReleaseState(d.data().tridant),
    }));

    return applyAuthDeprecations(
      NextResponse.json(withPaginationFields({ versions }, page.nextPageToken)),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'installer:GET');
  }
}
