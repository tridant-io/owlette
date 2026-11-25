import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb, getAdminStorage } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { withRateLimit } from '@/lib/withRateLimit';
import { apiError } from '@/lib/apiErrorResponse';
import { screenshotImageUrl, screenshotRecordPath } from '@/lib/screenshotStorage.server';

/**
 * POST /api/agent/screenshot — agent uploads a base64 JPEG (Bearer agent id
 * token; body: siteId, machineId, screenshot, agentVersion). Agents before the
 * signed-url upload still send their crash, hoot and live-view captures here.
 *
 * Storage:  screenshots/{siteId}/{machineId}/latest.jpg (overwritten)
 *           .../history/{timestamp}.jpg (max 20 kept), both private
 * Firestore: machines/{machineId}.lastScreenshot and its screenshots/ subcollection,
 *           each recording the path and its image-route url.
 */
export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      const authHeader = request.headers.get('Authorization') || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

      if (!token) {
        return NextResponse.json({ error: 'Missing Authorization header' }, { status: 401 });
      }

      let decodedToken;
      try {
        const adminAuth = getAdminAuth();
        decodedToken = await adminAuth.verifyIdToken(token);
      } catch {
        return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
      }

      if (decodedToken.role !== 'agent') {
        return NextResponse.json({ error: 'Forbidden — agent token required' }, { status: 403 });
      }

      const body = await request.json();
      const { siteId, machineId, screenshot } = body;

      if (!siteId || !machineId || !screenshot) {
        return NextResponse.json(
          { error: 'Missing required fields: siteId, machineId, screenshot' },
          { status: 400 }
        );
      }

      if (decodedToken.site_id && decodedToken.site_id !== siteId) {
        return NextResponse.json({ error: 'site_id mismatch' }, { status: 403 });
      }

      if (decodedToken.machine_id !== machineId) {
        return NextResponse.json({ error: 'machine_id_mismatch' }, { status: 403 });
      }

      const imageBuffer = Buffer.from(screenshot, 'base64');
      const sizeKB = Math.round(imageBuffer.length / 1024);

      if (sizeKB > 10240) {
        return NextResponse.json(
          { error: `Screenshot too large: ${sizeKB}KB (max 10MB)` },
          { status: 413 }
        );
      }

      const storage = getAdminStorage();
      const bucketName = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
      if (!bucketName) {
        console.error('[agent/screenshot] NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET not configured');
        return NextResponse.json({ error: 'Storage not configured' }, { status: 500 });
      }
      const bucket = storage.bucket(bucketName);
      const filePath = `screenshots/${siteId}/${machineId}/latest.jpg`;
      const file = bucket.file(filePath);

      await file.save(imageBuffer, {
        metadata: {
          contentType: 'image/jpeg',
          cacheControl: 'private, max-age=60',
          metadata: {
            machineId,
            siteId,
            capturedAt: String(Date.now()),
          },
        },
      });

      // Cache-buster: the path is fixed, so browsers would serve a stale image.
      const urlWithCacheBuster = `${screenshotImageUrl(siteId, machineId, filePath)}&t=${Date.now()}`;

      const db = getAdminDb();
      const machineRef = db
        .collection('sites')
        .doc(siteId)
        .collection('machines')
        .doc(machineId);

      await machineRef.set(
        {
          lastScreenshot: {
            url: urlWithCacheBuster,
            path: filePath,
            timestamp: FieldValue.serverTimestamp(),
            sizeKB,
          },
        },
        { merge: true }
      );

      const captureTimestamp = Date.now(); // storage path only
      const historyPath = `screenshots/${siteId}/${machineId}/history/${captureTimestamp}.jpg`;
      const historyFile = bucket.file(historyPath);
      await historyFile.save(imageBuffer, {
        metadata: {
          contentType: 'image/jpeg',
          cacheControl: 'private, max-age=31536000', // immutable history file
          metadata: { machineId, siteId, capturedAt: String(captureTimestamp) },
        },
      });

      const screenshotsCol = machineRef.collection('screenshots');
      await screenshotsCol.add({
        url: screenshotImageUrl(siteId, machineId, historyPath),
        path: historyPath,
        timestamp: FieldValue.serverTimestamp(),
        sizeKB,
      });

      const MAX_HISTORY = 20;
      const allDocs = await screenshotsCol.orderBy('timestamp', 'asc').get();
      if (allDocs.size > MAX_HISTORY) {
        const toDelete = allDocs.docs.slice(0, allDocs.size - MAX_HISTORY);
        for (const docSnap of toDelete) {
          try {
            const oldPath = screenshotRecordPath(docSnap.data(), bucket.name);
            if (oldPath) await bucket.file(oldPath).delete();
          } catch {
            // Already gone.
          }
          await docSnap.ref.delete();
        }
        console.log(`[agent/screenshot] Pruned ${toDelete.length} old screenshots for ${machineId}`);
      }

      console.log(`[agent/screenshot] Screenshot uploaded for ${machineId} (${sizeKB}KB) → Storage + history`);

      return NextResponse.json({ success: true, sizeKB, url: urlWithCacheBuster });
    } catch (error: unknown) {
      return apiError(error, 'agent/screenshot');
    }
  },
  { strategy: 'api', identifier: 'ip' }
);
