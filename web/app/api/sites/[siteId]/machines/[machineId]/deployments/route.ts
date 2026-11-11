/**
 * GET /api/sites/{siteId}/machines/{machineId}/deployments — per-roost state
 * for one machine. For every roost whose targets[] include it: the intended
 * currentVersionId (roost doc) plus reportedVersionId + status (that roost's
 * target_state/{machineId} doc).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { timestampToIso } from '@/lib/firestoreTime.server';
import { problemFromError } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  applyAuthDeprecations,
  requireSiteMachineAuthAndScope,
} from '../../../../../_shared';

interface RouteParams {
  params: Promise<{ siteId: string; machineId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId, machineId } = await params;
    const auth = await requireSiteMachineAuthAndScope(request, siteId, machineId, 'read');
    if (!auth.ok) return auth.response;

    const db = getAdminDb();
    const siteRef = db.collection('sites').doc(siteId);

    // `array-contains` is native — one query, no full scan.
    const targetingRoostsSnap = await siteRef
      .collection('roosts')
      .where('targets', 'array-contains', machineId)
      .get();

    const perRoost = await Promise.all(
      targetingRoostsSnap.docs.map(async (roostDoc) => {
        const data = roostDoc.data();
        if (data.deletedAt) return null;
        const targetStateSnap = await roostDoc.ref
          .collection('target_state')
          .doc(machineId)
          .get();
        const ts = targetStateSnap.exists ? (targetStateSnap.data() ?? {}) : {};
        return {
          roostId: roostDoc.id,
          name: typeof data.name === 'string' ? data.name : roostDoc.id,
          currentVersionId: typeof data.currentVersionId === 'string' ? data.currentVersionId : null,
          previousVersionId: typeof data.previousVersionId === 'string' ? data.previousVersionId : null,
          versionCounter: typeof data.versionCounter === 'number' ? data.versionCounter : 0,
          extractPath: typeof data.extractPath === 'string' ? data.extractPath : null,
          reportedVersionId: typeof ts.reportedVersionId === 'string' ? ts.reportedVersionId : null,
          reportedStatus: typeof ts.status === 'string' ? ts.status : null,
          reportedAt: timestampToIso(ts.reportedAt),
        };
      }),
    );

    const deployments = perRoost.filter((r): r is NonNullable<typeof r> => r !== null);
    deployments.sort((a, b) => a.name.localeCompare(b.name));

    return applyAuthDeprecations(
      NextResponse.json({
        siteId,
        machineId,
        deployments,
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/sites/[siteId]/machines/[machineId]/deployments:GET');
  }
}
