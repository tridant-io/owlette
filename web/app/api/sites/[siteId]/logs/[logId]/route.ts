/**
 * GET /api/sites/{siteId}/logs/{logId}
 *
 * Fetch one operational log entry from `sites/{siteId}/logs`.
 * a scoped member gets the missing log's 404 for a row with no machine, or a
 * machine outside their machine scope.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problem,
  problemFromError,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { timestampToIso } from '@/lib/firestoreTime.server';
import {
  applyAuthDeprecations,
  requireSiteAuthAndScope,
} from '@/app/api/_shared';

interface RouteParams {
  params: Promise<{ siteId: string; logId: string }>;
}

const LOG_ID_RE = /^[A-Za-z0-9_.:-]{1,256}$/;

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId, logId } = await params;
    if (!LOG_ID_RE.test(logId)) {
      return problemValidation('logId must be 1-256 URL-safe chars', {
        logId: ['must match ^[A-Za-z0-9_.:-]{1,256}$'],
      });
    }

    const auth = await requireSiteAuthAndScope(request, siteId, 'read', { machineScope: 'admit' });
    if (!auth.ok) return auth.response;

    const snap = await getAdminDb()
      .collection('sites')
      .doc(siteId)
      .collection('logs')
      .doc(logId)
      .get();

    const data = snap.exists ? (snap.data() ?? {}) : null;
    const machineId = typeof data?.machineId === 'string' ? data.machineId : null;
    const machineScope = auth.machineIds;
    if (data === null || (machineScope !== null && (machineId === null || !machineScope.includes(machineId)))) {
      return problem({
        type: ProblemType.NotFound,
        title: 'log entry not found',
        status: 404,
        detail: `log ${logId} not found on site ${siteId}`,
        instance: `/api/sites/${siteId}/logs/${logId}`,
      });
    }

    return applyAuthDeprecations(
      NextResponse.json({
        id: logId,
        siteId,
        timestamp: timestampToIso(data.timestamp),
        action: typeof data.action === 'string' ? data.action : 'unknown',
        level: typeof data.level === 'string' ? data.level : 'info',
        machineId,
        machineName: typeof data.machineName === 'string' ? data.machineName : null,
        processName: typeof data.processName === 'string' ? data.processName : null,
        details:
          typeof data.details === 'string' ||
          (data.details !== null && typeof data.details === 'object' && !Array.isArray(data.details))
            ? data.details
            : null,
        userId: typeof data.userId === 'string' ? data.userId : null,
        screenshotUrl: typeof data.screenshotUrl === 'string' ? data.screenshotUrl : null,
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/logs/[logId]:GET');
  }
}
