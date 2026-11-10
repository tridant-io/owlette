/**
 * GET /api/roosts/{roostId}/deployments?siteId=...&limit=20&cursor=...
 *     → List rollouts for a roost, newest first. Cursor is the rollout
 *       doc id (= versionId) of the last item on the previous page.
 *
 * roost public api wave 3.3.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { timestampToIso } from '@/lib/firestoreTime.server';
import {
  problemFromError,
  problemValidation,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { gateOrProceed } from '@/lib/roostKillSwitch';
import {
  collectFilteredPage,
  parsePagination,
  withPaginationFields,
} from '@/lib/pagination';
import {
  applyAuthDeprecations,
  requireRoostAuthAndScope,
  validateResourceId,
  validateSiteIdBody,
} from '../../../_shared';

interface RouteParams {
  params: Promise<{ roostId: string }>;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const VALID_STAGES = ['scheduled', 'canary', 'fleet', 'complete', 'aborted'];

async function readSiteDocForGate(siteId: string): Promise<Record<string, unknown> | null> {
  const snap = await getAdminDb().collection('sites').doc(siteId).get();
  return snap.exists ? (snap.data() ?? null) : null;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { roostId } = await params;
    const roostError = validateResourceId(roostId, 'roostId');
    if (roostError) return roostError;

    const siteIdParam = request.nextUrl.searchParams.get('siteId');
    if (!siteIdParam) {
      return problemValidation('query param `siteId` is required', {
        'query.siteId': ['required'],
      });
    }
    const site = validateSiteIdBody(siteIdParam, 'query.siteId');
    if (!site.ok) return site.response;

    const auth = await requireRoostAuthAndScope(request, site.siteId, roostId, 'read');
    if (!auth.ok) return auth.response;

    const gateRes = await gateOrProceed(site.siteId, readSiteDocForGate);
    if (gateRes) return gateRes;

    const parsedPagination = parsePagination(request.nextUrl.searchParams, {
      defaultPageSize: DEFAULT_LIMIT,
      maxPageSize: MAX_LIMIT,
    });
    if (!parsedPagination.ok) return parsedPagination.response;
    const { pageSize, pageToken } = parsedPagination.pagination;

    const stageFilter = request.nextUrl.searchParams.get('stage');
    if (stageFilter && !VALID_STAGES.includes(stageFilter)) {
      return problemValidation(`stage must be one of ${VALID_STAGES.join(', ')}`, {
        'query.stage': ['invalid stage'],
      });
    }

    const db = getAdminDb();
    const rolloutsCol = db
      .collection('sites')
      .doc(site.siteId)
      .collection('roosts')
      .doc(roostId)
      .collection('rollouts');

    const page = await collectFilteredPage({
      pageSize,
      pageToken,
      fetchPage: async (cursor, limit) => {
        let query = rolloutsCol.orderBy('startedAt', 'desc').limit(limit);
        if (cursor) {
          const cursorSnap = await rolloutsCol.doc(cursor).get();
          if (cursorSnap.exists) query = query.startAfter(cursorSnap);
        }
        const snap = await query.get();
        return snap.docs;
      },
      include: (doc) => {
        if (!stageFilter) return true;
        const data = doc.data();
        return data.stage === stageFilter;
      },
    });

    const rollouts = page.docs.map((d) => {
      const data = d.data();
      return {
        rolloutId: d.id,
        versionId: typeof data.versionId === 'string' ? data.versionId : d.id,
        stage: typeof data.stage === 'string' ? data.stage : 'unknown',
        canaryCount: Array.isArray(data.canary) ? data.canary.length : 0,
        fleetCount: Array.isArray(data.fleet) ? data.fleet.length : 0,
        extractRoot: typeof data.extractRoot === 'string' ? data.extractRoot : null,
        versionUrl: typeof data.versionUrl === 'string' ? data.versionUrl : null,
        triggeredBy: data.triggeredBy ?? null,
        startedAt: timestampToIso(data.startedAt),
        completedAt: timestampToIso(data.completedAt),
        abortedAt: timestampToIso(data.abortedAt),
        abortReason: data.abortReason ?? null,
        scheduledAt: timestampToIso(data.scheduledAt),
      };
    });

    return applyAuthDeprecations(
      NextResponse.json(
        withPaginationFields(
          {
            rollouts,
            items: rollouts,
          },
          page.nextPageToken,
        ),
      ),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/roosts/[roostId]/deployments:GET');
  }
}
