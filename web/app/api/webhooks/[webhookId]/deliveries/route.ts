/**
 * GET /api/webhooks/{webhookId}/deliveries?siteId=&limit=&cursor= →
 * `{ deliveries, nextPageToken }`. Cursor-paginated, newest first, scoped to the
 * last 30 days (the dispatcher's retention); requires `site:<id>:read` and
 * WEBHOOK_MANAGE; 404 when the subscription is missing or soft-deleted.
 *
 * Reads the top-level `webhook_deliveries` collection written by
 * functions/webhookDispatch.ts, querying `subscriptionId == webhookId`. The
 * (subscriptionId + createdAt desc) composite-index error is surfaced unchanged
 * so ops can click through and create it.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import {
  problemFromError,
  problemNotFound,
  problemValidation,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  nextPageTokenFromDocs,
  parsePagination,
  withPaginationFields,
} from '@/lib/pagination';

import {
  applyAuthDeprecations,
  requireSiteAuthAndScope,
  requireWebhookManageCapability,
  validateSiteIdBody,
} from '../../../_shared';

export const runtime = 'nodejs';

const WEBHOOK_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DELIVERIES_COLLECTION = 'webhook_deliveries';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ webhookId: string }> },
) {
  try {
    const { webhookId } = await params;
    if (!WEBHOOK_ID_RE.test(webhookId)) {
      return problemValidation(
        'webhookId must be 8-64 chars: letters, digits, underscore, hyphen',
        { 'path.webhookId': ['invalid format'] },
      );
    }

    const siteIdParam = request.nextUrl.searchParams.get('siteId');
    if (!siteIdParam) {
      return problemValidation('query param `siteId` is required', {
        'query.siteId': ['required'],
      });
    }
    const site = validateSiteIdBody(siteIdParam, 'query.siteId');
    if (!site.ok) return site.response;

    const auth = await requireSiteAuthAndScope(request, site.siteId, 'read');
    if (!auth.ok) return auth.response;

    const capabilityError = await requireWebhookManageCapability(auth.auth, site.siteId);
    if (capabilityError) return capabilityError;

    const db = getAdminDb();

    // Confirm the subscription belongs to this site before exposing its history —
    // never reveal that an id is valid on another site.
    const webhookRef = db
      .collection('sites')
      .doc(site.siteId)
      .collection('webhooks')
      .doc(webhookId);
    const webhookSnap = await webhookRef.get();
    const webhookData = webhookSnap.data();
    if (!webhookSnap.exists || !webhookData || webhookData.deletedAt) {
      return problemNotFound(`webhook ${webhookId} not found on site ${site.siteId}`);
    }

    const parsedPagination = parsePagination(request.nextUrl.searchParams, {
      defaultPageSize: DEFAULT_LIST_LIMIT,
      maxPageSize: MAX_LIST_LIMIT,
    });
    if (!parsedPagination.ok) return parsedPagination.response;
    const { pageSize, pageToken } = parsedPagination.pagination;

    const windowStart = Date.now() - HISTORY_WINDOW_MS;
    const base = db
      .collection(DELIVERIES_COLLECTION)
      .where('subscriptionId', '==', webhookId)
      .where('createdAt', '>=', windowStart)
      .orderBy('createdAt', 'desc');

    let query = base.limit(pageSize + 1);
    if (pageToken) {
      const cursorSnap = await db.collection(DELIVERIES_COLLECTION).doc(pageToken).get();
      if (cursorSnap.exists) query = query.startAfter(cursorSnap);
    }

    const snap = await query.get();
    const overflow = snap.docs.length > pageSize;
    const pageDocs = overflow ? snap.docs.slice(0, pageSize) : snap.docs;
    const nextPageToken = nextPageTokenFromDocs(snap.docs, pageSize);

    const deliveries = pageDocs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        event: typeof data.event === 'string' ? data.event : null,
        state:
          typeof data.state === 'string'
            ? (data.state as 'pending' | 'succeeded' | 'failed')
            : 'pending',
        attempt: typeof data.attempt === 'number' ? data.attempt : 0,
        lastStatus: typeof data.lastStatus === 'number' ? data.lastStatus : null,
        lastError: typeof data.lastError === 'string' ? data.lastError : null,
        createdAt: msToIso(data.createdAt),
        completedAt: msToIso(data.completedAt),
        nextAttemptAt:
          data.state === 'pending' ? msToIso(data.nextAttemptAt) : null,
      };
    });

    return applyAuthDeprecations(
      NextResponse.json(withPaginationFields({ deliveries }, nextPageToken)),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'webhooks/[webhookId]/deliveries:GET');
  }
}

function msToIso(v: unknown): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return new Date(v).toISOString();
}
