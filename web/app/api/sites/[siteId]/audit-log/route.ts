/**
 * GET /api/sites/{siteId}/audit-log?kind=&actor=&since=&page_size=50&page_token=
 *
 * List hash-chained audit records for a site, newest first. Legacy
 * `limit` and `cursor` aliases are accepted for existing callers.
 * Site admins and owners only (`requireAuditLogCapability`).
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { Timestamp, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { timestampToMs } from '@/lib/firestoreTime.server';
import {
  problemFromError,
  problemValidation,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  collectFilteredPage,
  parsePagination,
  withPaginationFields,
} from '@/lib/pagination';
import {
  applyAuthDeprecations,
  requireAuditLogCapability,
  requireSiteAuthAndScope,
} from '../../../_shared';

interface RouteParams {
  params: Promise<{ siteId: string }>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type Row = {
  hash: string;
  kind: string;
  actor: string;
  siteId: string;
  target: string | null;
  occurredAt: number | null;
  recordedAt: number | null;
  attributes: Record<string, unknown>;
};

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId } = await params;
    const auth = await requireSiteAuthAndScope(request, siteId, 'read');
    if (!auth.ok) return auth.response;

    const capabilityError = await requireAuditLogCapability(auth.auth, siteId);
    if (capabilityError) return capabilityError;

    const qp = request.nextUrl.searchParams;
    const kindFilter = qp.get('kind');
    const actorFilter = qp.get('actor');
    const sinceRaw = qp.get('since');
    const parsedPagination = parsePagination(qp, {
      defaultPageSize: DEFAULT_LIMIT,
      maxPageSize: MAX_LIMIT,
    });
    if (!parsedPagination.ok) return parsedPagination.response;
    const { pageSize, pageToken } = parsedPagination.pagination;

    let sinceMs: number | undefined;
    if (sinceRaw) {
      const asNumber = Number(sinceRaw);
      if (Number.isFinite(asNumber) && asNumber > 0) {
        sinceMs = asNumber;
      } else {
        const parsed = Date.parse(sinceRaw);
        if (Number.isNaN(parsed)) {
          return problemValidation('since must be unix-ms or iso8601', {
            'query.since': ['invalid date'],
          });
        }
        sinceMs = parsed;
      }
    }

    const db = getAdminDb();
    const col = db
      .collection('sites')
      .doc(siteId)
      .collection('audit_log');

    const rowForDoc = (d: QueryDocumentSnapshot): Row => {
      const data = d.data() as {
        event?: {
          kind?: string;
          siteId?: string;
          actor?: string;
          target?: string;
          occurredAt?: number;
          attributes?: Record<string, unknown>;
        };
        recordedAt?: number | Timestamp;
      };
      const evt = data.event ?? {};
      return {
        hash: d.id,
        kind: typeof evt.kind === 'string' ? evt.kind : 'unknown',
        actor: typeof evt.actor === 'string' ? evt.actor : '',
        siteId: typeof evt.siteId === 'string' ? evt.siteId : siteId,
        target: typeof evt.target === 'string' ? evt.target : null,
        occurredAt: typeof evt.occurredAt === 'number' ? evt.occurredAt : null,
        recordedAt: timestampToMs(data.recordedAt),
        attributes: evt.attributes && typeof evt.attributes === 'object' ? evt.attributes : {},
      };
    };

    const page = await collectFilteredPage({
      pageSize,
      pageToken,
      batchLimit: Math.min(MAX_LIMIT + 1, Math.max(pageSize + 1, pageSize * 3 + 1)),
      fetchPage: async (cursor, limit) => {
        let query = col.orderBy('recordedAt', 'desc').limit(limit);
        if (typeof sinceMs === 'number') {
          query = col
            .where('recordedAt', '>=', sinceMs)
            .orderBy('recordedAt', 'desc')
            .limit(limit);
        }
        if (cursor) {
          const cursorSnap = await col.doc(cursor).get();
          if (cursorSnap.exists) query = query.startAfter(cursorSnap);
        }
        const snap = await query.get();
        return snap.docs;
      },
      include: (doc) => {
        const row = rowForDoc(doc);
        if (kindFilter && row.kind !== kindFilter) return false;
        if (actorFilter && row.actor !== actorFilter) return false;
        return true;
      },
    });

    const records = page.docs.map(rowForDoc);

    return applyAuthDeprecations(
      NextResponse.json(withPaginationFields({ siteId, records }, page.nextPageToken)),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/sites/[siteId]/audit-log:GET');
  }
}
