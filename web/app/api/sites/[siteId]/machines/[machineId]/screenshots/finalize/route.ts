/**
 * POST /api/sites/{siteId}/machines/{machineId}/screenshots/finalize
 *
 * Last step of the agent's `capture_screenshot` pipeline, after it PUTs bytes
 * to the signed URL from `/screenshots/upload-url`: verify the object landed
 * and its path matches this site+machine, make it public-read, write
 * `machines/{id}.lastScreenshot`, append a history doc and prune to 20.
 *
 * A separate step because pre-registering would flash a stub lastScreenshot,
 * agents hold no GCS credentials (no makePublic / public URLs), and a bucket
 * trigger would add latency and infra for a one-line action.
 *
 * Auth: `machine=<id>:write` or agent ID-token, as on /screenshots/upload-url.
 * Naturally idempotent apart from the history append, which pruning absorbs.
 * Not separately rate limited: every call needs a storagePath minted by an already-counted
 * /screenshots/upload-url request, so billing both legs would halve the per-IP screenshot budget.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import {
  problemFromError,
  problemNotFound,
  problemValidation,
} from '@/lib/apiErrors';
import {
  applyAuthDeprecations,
  requireMachineAuthAndScope,
} from '../../../../../../_shared';
import { getAdminDb, getAdminStorage } from '@/lib/firebase-admin';
import { sanitizeForLog } from '@/lib/logSanitize';

interface RouteParams {
  params: Promise<{ siteId: string; machineId: string }>;
}

const ALLOWED_CONTENT_TYPES = new Set(['image/png', 'image/jpeg']);

// Screenshot history kept per machine; older entries are pruned on finalize.
const MAX_HISTORY = 20;

// Bound on the ADVISORY agent-reported size; object metadata below is
// authoritative. Rejects bogus values before any write.
const MAX_SIZE_KB = 10_240; // 10 MB

interface FinalizeBody {
  storagePath?: unknown;
  sizeKB?: unknown;
  monitor?: unknown;
  contentType?: unknown;
}

function resolveBucketName(): string {
  const explicit =
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ||
    process.env.FIREBASE_STORAGE_BUCKET;
  if (!explicit || explicit.length === 0) {
    throw new Error(
      '[screenshots/finalize] NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not configured',
    );
  }
  return explicit;
}

/**
 * Reassert `screenshots/{siteId}/{machineId}/...` server-side so an agent
 * cannot finalize a path belonging to another machine.
 */
function validateStoragePath(
  storagePath: string,
  siteId: string,
  machineId: string,
): { ok: true } | { ok: false; reason: string } {
  if (!storagePath.startsWith('screenshots/')) {
    return { ok: false, reason: 'storagePath must start with screenshots/' };
  }
  // Firebase Storage tolerates `..` segments; we don't.
  if (storagePath.includes('..')) {
    return { ok: false, reason: 'storagePath must not contain ".."' };
  }
  // screenshots / siteId / machineId / filename...
  const segments = storagePath.split('/');
  if (segments.length < 4) {
    return {
      ok: false,
      reason: 'storagePath must be screenshots/{site}/{machine}/{name}',
    };
  }
  if (segments[1] !== siteId) {
    return {
      ok: false,
      reason: `storagePath site segment '${segments[1]}' does not match URL siteId`,
    };
  }
  if (segments[2] !== machineId) {
    return {
      ok: false,
      reason: `storagePath machine segment '${segments[2]}' does not match URL machineId`,
    };
  }
  return { ok: true };
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId, machineId } = await params;

    const auth = await requireMachineAuthAndScope(
      request,
      siteId,
      machineId,
      'write',
    );
    if (!auth.ok) return auth.response;

    let body: FinalizeBody;
    try {
      body = (await request.json()) as FinalizeBody;
    } catch {
      return problemValidation('request body is not valid json');
    }
    if (!body || typeof body !== 'object') {
      return problemValidation('request body must be a json object');
    }

    if (typeof body.storagePath !== 'string' || body.storagePath.length === 0) {
      return problemValidation('storagePath is required (string)', {
        'body.storagePath': ['must be a non-empty string'],
      });
    }
    const pathCheck = validateStoragePath(body.storagePath, siteId, machineId);
    if (!pathCheck.ok) {
      return problemValidation(pathCheck.reason, {
        'body.storagePath': [pathCheck.reason],
      });
    }

    const agentSizeKB =
      typeof body.sizeKB === 'number' && Number.isFinite(body.sizeKB)
        ? Math.max(0, Math.round(body.sizeKB))
        : 0;
    if (agentSizeKB > MAX_SIZE_KB) {
      return problemValidation(
        `sizeKB ${agentSizeKB} exceeds max ${MAX_SIZE_KB}`,
        { 'body.sizeKB': [`must be <= ${MAX_SIZE_KB}`] },
      );
    }

    const monitor =
      typeof body.monitor === 'number' && Number.isFinite(body.monitor)
        ? Math.max(0, Math.round(body.monitor))
        : 0;

    let contentType = 'image/jpeg';
    if (body.contentType !== undefined && body.contentType !== null) {
      if (
        typeof body.contentType !== 'string' ||
        !ALLOWED_CONTENT_TYPES.has(body.contentType)
      ) {
        return problemValidation(
          'contentType must be image/png or image/jpeg when provided',
          { 'body.contentType': ['must be image/png or image/jpeg'] },
        );
      }
      contentType = body.contentType;
    }

    const storage = getAdminStorage();
    const bucket = storage.bucket(resolveBucketName());
    const file = bucket.file(body.storagePath);

    // The PUT can fail silently or the signed URL expire between issuance and
    // use, either of which finalizes against a missing object.
    const [exists] = await file.exists();
    if (!exists) {
      return problemNotFound(
        'storage object not found at storagePath — upload likely never completed',
      );
    }

    // Mirror the legacy endpoint's setMetadata so CDN/browser handling of the
    // public URL matches, despite the signed URL already binding a type.
    await file.setMetadata({
      contentType,
      cacheControl: 'public, max-age=60',
      metadata: {
        machineId,
        siteId,
        capturedAt: String(Date.now()),
      },
    });

    // Bucket metadata is authoritative; the agent's sizeKB is advisory.
    const [meta] = await file.getMetadata();
    const objectSizeBytes =
      typeof meta.size === 'string'
        ? Number.parseInt(meta.size, 10)
        : typeof meta.size === 'number'
          ? meta.size
          : 0;
    const sizeKB = Math.max(
      1,
      Math.round((Number.isFinite(objectSizeBytes) ? objectSizeBytes : 0) / 1024),
    );

    // Public-read so the dashboard renders a plain storage.googleapis.com URL
    // without a signed-URL roundtrip per poll.
    await file.makePublic();

    // ?t= cache-buster in case two captures ever share a storagePath.
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${body.storagePath}?t=${Date.now()}`;

    const db = getAdminDb();
    const machineRef = db
      .collection('sites')
      .doc(siteId)
      .collection('machines')
      .doc(machineId);

    await machineRef.set(
      {
        lastScreenshot: {
          url: publicUrl,
          timestamp: FieldValue.serverTimestamp(),
          sizeKB,
        },
      },
      { merge: true },
    );

    // History feed for the screenshot-dialog sidebar.
    const screenshotsCol = machineRef.collection('screenshots');
    await screenshotsCol.add({
      url: publicUrl,
      timestamp: FieldValue.serverTimestamp(),
      sizeKB,
      monitor,
    });

    // Prune doc AND storage object — otherwise the bucket grows until the
    // 30-day lifecycle rule sweeps it.
    const allDocs = await screenshotsCol.orderBy('timestamp', 'asc').get();
    if (allDocs.size > MAX_HISTORY) {
      const toDelete = allDocs.docs.slice(0, allDocs.size - MAX_HISTORY);
      for (const docSnap of toDelete) {
        const data = docSnap.data();
        try {
          // Strip the storage prefix and ?t= to get the bucket-relative path.
          const rawUrl = typeof data.url === 'string' ? data.url : '';
          const prefix = `${bucket.name}/`;
          const pathStart = rawUrl.indexOf(prefix);
          if (pathStart !== -1) {
            const tail = rawUrl.slice(pathStart + prefix.length);
            const qIdx = tail.indexOf('?');
            const oldPath = qIdx === -1 ? tail : tail.slice(0, qIdx);
            if (oldPath) {
              await bucket.file(oldPath).delete().catch(() => {
                // Already gone (manual delete, lifecycle rule) — best-effort.
              });
            }
          }
        } catch {
          /* swallow — pruning is best-effort */
        }
        await docSnap.ref.delete();
      }
      console.log(
        `[screenshots/finalize] pruned ${toDelete.length} old screenshots for ${sanitizeForLog(machineId)}`,
      );
    }

    console.log(
      `[screenshots/finalize] ${sanitizeForLog(machineId)} (${sizeKB}KB, monitor=${sanitizeForLog(monitor)}) → ${sanitizeForLog(body.storagePath)}`,
    );

    return applyAuthDeprecations(
      NextResponse.json({
        ok: true,
        data: {
          url: publicUrl,
          storagePath: body.storagePath,
          sizeKB,
          monitor,
        },
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(
      err,
      'sites/[siteId]/machines/[machineId]/screenshots/finalize:POST',
    );
  }
}
