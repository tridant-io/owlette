import { NextRequest, NextResponse } from 'next/server';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import { getAdminDb, getAdminStorage } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';
import { screenshotRecordPath } from '@/lib/screenshotStorage.server';

type RouteParams = {
  siteId: string;
  machineId: string;
} & Record<string, string | undefined>;

/**
 * DELETE /api/sites/{siteId}/machines/{machineId}/screenshots
 *
 * Delete screenshot history for a machine. If `screenshotId` is omitted,
 * deletes all history and clears the machine's `lastScreenshot`.
 */
export const DELETE = authorizedSiteHandler<RouteParams>({
  capability: Capability.MACHINE_CONFIG_WRITE,
  siteIdParam: 'path',
  targetKind: 'machine',
  targetIdParam: 'machineId',
  apiKeyScope: { resource: 'machine', idParam: 'machineId', permission: 'write' },
})(async function DELETE(request: NextRequest, ctx, routeContext) {
  try {
    const { machineId } = await routeContext.params;
    const siteId = ctx.siteId;
    const screenshotId = request.nextUrl.searchParams.get('screenshotId');

    if (!machineId) {
      return NextResponse.json({ error: 'Missing machineId' }, { status: 400 });
    }

    const db = getAdminDb();
    const storage = getAdminStorage();
    const bucketName = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
    const bucket = bucketName ? storage.bucket(bucketName) : null;

    const screenshotsCol = db
      .collection('sites').doc(siteId)
      .collection('machines').doc(machineId)
      .collection('screenshots');

    if (screenshotId) {
      const docRef = screenshotsCol.doc(screenshotId);
      const docSnap = await docRef.get();

      if (!docSnap.exists) {
        return NextResponse.json({ error: 'Screenshot not found' }, { status: 404 });
      }

      const storagePath = bucket ? screenshotRecordPath(docSnap.data(), bucket.name) : null;
      if (bucket && storagePath) {
        try {
          await bucket.file(storagePath).delete();
        } catch {
          // Storage file may already be deleted.
        }
      }

      await docRef.delete();
      return NextResponse.json({ success: true, deleted: 1 });
    }

    const allDocs = await screenshotsCol.get();

    if (allDocs.empty) {
      return NextResponse.json({ success: true, deleted: 0 });
    }

    let deleted = 0;
    for (const docSnap of allDocs.docs) {
      const storagePath = bucket ? screenshotRecordPath(docSnap.data(), bucket.name) : null;
      if (bucket && storagePath) {
        try {
          await bucket.file(storagePath).delete();
        } catch {
          // Storage file may already be deleted.
        }
      }
      await docSnap.ref.delete();
      deleted++;
    }

    const machineRef = db.collection('sites').doc(siteId).collection('machines').doc(machineId);
    await machineRef.update({ lastScreenshot: null });

    if (bucket) {
      try {
        await bucket.file(`screenshots/${siteId}/${machineId}/latest.jpg`).delete();
      } catch {
        // May not exist.
      }
    }

    return NextResponse.json({ success: true, deleted });
  } catch (error: unknown) {
    return apiError(error, 'sites/machines/screenshots');
  }
});
