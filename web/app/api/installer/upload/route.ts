/**
 * POST /api/installer/upload — step 1: request a signed upload URL; the client then
 * uploads the binary directly to Firebase Storage with it.
 *
 * PUT /api/installer/upload — step 2 (finalize): verify the file is in Storage, compute
 * the checksum, reject a caller-supplied mismatch, merge the file into
 * `installer_metadata/data/versions/{version}.files.<platform>` and optionally
 * write the `latest` pointer.
 *
 * Auth (both verbs): an api key with `installer=*:write` (superadmin-only at minting),
 * or a superadmin session / id-token.
 *
 * Idempotency required on both; the same key + body within 24h replays the cached
 * response. api-sprint wave 1 track 1B.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { createHash, randomUUID } from 'crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import {
  problem,
  problemFromError,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb, getAdminStorage } from '@/lib/firebase-admin';
import { withIdempotency } from '@/lib/idempotency';
import { emitMutation } from '@/lib/auditLogClient';
import {
  INSTALLER_PLATFORMS,
  PLATFORM_EXT,
  installerFileName,
  normalizeInstallerFiles,
  platformFromExtension,
  type InstallerPlatform,
} from '@/lib/installerPlatform';
import {
  applyAuthDeprecations,
  readAndParseJsonBody,
  requirePlatformAuthAndScope,
} from '../../_shared';

const VERSION_REGEX = /^\d+\.\d+\.\d+$/;
const SIGNED_URL_EXPIRY_MINUTES = 15;
const IS_E2E = process.env.OWLETTE_E2E === '1';

interface UploadStartBody {
  version?: unknown;
  fileName?: unknown;
  platform?: unknown;
  contentType?: unknown;
  releaseNotes?: unknown;
  setAsLatest?: unknown;
}

interface UploadFinalizeBody {
  uploadId?: unknown;
  checksum_sha256?: unknown;
}

export async function POST(request: NextRequest) {
  try {
    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    const auth = await requirePlatformAuthAndScope(request, 'installer', 'write');
    if (!auth.ok) return auth.response;

    return await withIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        const body = parsed.body as UploadStartBody;

        if (typeof body.version !== 'string' || !VERSION_REGEX.test(body.version)) {
          return problemValidation('version is required and must match X.Y.Z', {
            'body.version': ['must be a semver string like "2.2.1"'],
          });
        }
        const version = body.version;

        const fileName = typeof body.fileName === 'string' ? body.fileName : '';
        const platform = platformFromExtension(fileName);
        if (!platform) {
          return problemValidation(
            'fileName is required and must end with .exe, .pkg or .deb',
            { 'body.fileName': ['must be a string ending in .exe, .pkg or .deb'] },
          );
        }

        if (
          body.platform !== undefined &&
          !(INSTALLER_PLATFORMS as readonly unknown[]).includes(body.platform)
        ) {
          return problemValidation(
            `platform must be one of ${INSTALLER_PLATFORMS.join(', ')} when provided`,
            { 'body.platform': [`must be one of ${INSTALLER_PLATFORMS.join(', ')}`] },
          );
        }
        if (body.platform !== undefined && body.platform !== platform) {
          return problemValidation(
            `fileName extension does not match platform ${body.platform}`,
            {
              'body.fileName': [
                `must end in .${PLATFORM_EXT[body.platform as InstallerPlatform]}`,
              ],
            },
          );
        }

        if (
          body.contentType !== undefined &&
          typeof body.contentType !== 'string'
        ) {
          return problemValidation('contentType must be a string when provided', {
            'body.contentType': ['must be a string'],
          });
        }
        const contentType =
          (typeof body.contentType === 'string' && body.contentType) ||
          'application/octet-stream';

        if (
          body.releaseNotes !== undefined &&
          body.releaseNotes !== null &&
          typeof body.releaseNotes !== 'string'
        ) {
          return problemValidation('releaseNotes must be a string when provided', {
            'body.releaseNotes': ['must be a string or null'],
          });
        }
        const releaseNotes =
          typeof body.releaseNotes === 'string' ? body.releaseNotes : null;

        if (
          body.setAsLatest !== undefined &&
          typeof body.setAsLatest !== 'boolean'
        ) {
          return problemValidation('setAsLatest must be a boolean when provided', {
            'body.setAsLatest': ['must be boolean'],
          });
        }
        const setAsLatest = body.setAsLatest !== false; // default true

        const db = getAdminDb();
        const storage = getAdminStorage();
        const bucket = storage.bucket();
        const storagePath = `agent-installers/versions/${version}/${installerFileName(version, platform)}`;
        const file = bucket.file(storagePath);

        const expiresAt = new Date(
          Date.now() + SIGNED_URL_EXPIRY_MINUTES * 60 * 1000,
        );
        const uploadUrl = IS_E2E
          ? `http://127.0.0.1:9199/v0/b/${encodeURIComponent(bucket.name)}/o/${encodeURIComponent(storagePath)}?uploadType=media`
          : (
              await file.getSignedUrl({
                action: 'write',
                version: 'v4',
                expires: expiresAt,
                contentType,
              })
            )[0];

        const uploadId = randomUUID();
        await db.collection('installer_uploads').doc(uploadId).set({
          version,
          fileName,
          platform,
          storagePath,
          userId: auth.userId,
          releaseNotes,
          setAsLatest,
          status: 'pending',
          createdAt: FieldValue.serverTimestamp(),
          expiresAt: Timestamp.fromDate(expiresAt),
        });

        emitMutation({
          kind: 'installer_mutated',
          siteId: '',
          actor: auth.auth.keyContext
            ? `apiKey:${auth.auth.keyContext.keyId}`
            : `user:${auth.userId}`,
          targetId: version,
          attributes: {
            endpoint: '/api/installer/upload',
            method: 'POST',
            verb: 'upload_initiated',
            uploadId,
            platform,
            setAsLatest,
          },
        });

        return applyAuthDeprecations(
          NextResponse.json({
            uploadUrl,
            uploadId,
            platform,
            storagePath,
            expiresAt: expiresAt.toISOString(),
          }),
          auth.scopeCheck,
        );
      },
      { requireKey: true },
    );
  } catch (err) {
    return problemFromError(err, 'installer/upload:POST');
  }
}

export async function PUT(request: NextRequest) {
  try {
    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    const auth = await requirePlatformAuthAndScope(request, 'installer', 'write');
    if (!auth.ok) return auth.response;

    return await withIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        const body = parsed.body as UploadFinalizeBody;

        if (typeof body.uploadId !== 'string' || body.uploadId.length === 0) {
          return problemValidation('uploadId is required', {
            'body.uploadId': ['must be a non-empty string'],
          });
        }
        const uploadId = body.uploadId;

        let providedChecksum: string | null = null;
        if (body.checksum_sha256 !== undefined && body.checksum_sha256 !== null) {
          if (
            typeof body.checksum_sha256 !== 'string' ||
            !/^[a-f0-9]{64}$/i.test(body.checksum_sha256)
          ) {
            return problemValidation(
              'checksum_sha256 must be a 64-char lowercase hex string when provided',
              { 'body.checksum_sha256': ['must be a sha-256 hex digest'] },
            );
          }
          providedChecksum = body.checksum_sha256.toLowerCase();
        }

        const db = getAdminDb();

        const uploadDoc = await db
          .collection('installer_uploads')
          .doc(uploadId)
          .get();
        if (!uploadDoc.exists) {
          return problem({
            type: ProblemType.NotFound,
            title: 'upload record not found',
            status: 404,
            detail: `no pending upload with id ${uploadId}`,
            instance: '/api/installer/upload',
          });
        }

        const uploadData = uploadDoc.data()!;
        if (uploadData.status !== 'pending') {
          return problem({
            type: ProblemType.Conflict,
            title: 'upload already finalized',
            status: 409,
            detail: `upload ${uploadId} is already ${uploadData.status}`,
            instance: '/api/installer/upload',
            code: 'upload_not_pending',
          });
        }

        const expiresAtMs =
          (typeof uploadData.expiresAt?.toMillis === 'function'
            ? uploadData.expiresAt.toMillis()
            : Number(uploadData.expiresAt)) || 0;
        if (Date.now() > expiresAtMs) {
          await db
            .collection('installer_uploads')
            .doc(uploadId)
            .update({ status: 'expired' });
          return problem({
            type: ProblemType.PreconditionFailed,
            title: 'upload expired',
            status: 410,
            detail: 'upload window expired; request a fresh signed url',
            instance: '/api/installer/upload',
            code: 'upload_expired',
          });
        }

        const storage = getAdminStorage();
        const bucket = storage.bucket();
        const file = bucket.file(uploadData.storagePath);

        const [exists] = await file.exists();
        if (!exists) {
          return problem({
            type: ProblemType.NotFound,
            title: 'binary not in storage',
            status: 404,
            detail:
              'the signed url was issued but no object was uploaded; complete step 2 before finalizing',
            instance: '/api/installer/upload',
            code: 'binary_missing',
          });
        }

        const [metadata] = await file.getMetadata();
        const fileSize = parseInt(metadata.size as string, 10) || 0;

        const [fileBuffer] = await file.download();
        const computedChecksum = createHash('sha256')
          .update(fileBuffer)
          .digest('hex');
        if (providedChecksum && providedChecksum !== computedChecksum) {
          return problem({
            type: ProblemType.PreconditionFailed,
            title: 'checksum mismatch',
            status: 412,
            detail:
              'checksum_sha256 does not match the uploaded binary; upload the file again before finalizing',
            instance: '/api/installer/upload',
            code: 'checksum_mismatch',
          });
        }
        const finalChecksum = computedChecksum;

        const downloadExpiry = new Date('2030-01-01');
        // the emulator cannot sign urls; its media endpoint is the public read
        const downloadUrl = IS_E2E
          ? `http://127.0.0.1:9199/v0/b/${encodeURIComponent(bucket.name)}/o/${encodeURIComponent(uploadData.storagePath)}?alt=media`
          : (
              await file.getSignedUrl({
                action: 'read',
                expires: downloadExpiry,
              })
            )[0];

        const version = uploadData.version as string;
        // an upload requested before `platform` was recorded is a windows exe
        const platform: InstallerPlatform = uploadData.platform ?? 'windows_x64';
        const now = Date.now();

        const fileEntry = {
          download_url: downloadUrl,
          checksum_sha256: finalChecksum,
          file_size: fileSize,
          file_name: uploadData.fileName,
          uploaded_at: now,
        };
        const alias =
          platform === 'windows_x64'
            ? { download_url: downloadUrl, checksum_sha256: finalChecksum, file_size: fileSize }
            : {};

        const versionRef = db
          .collection('installer_metadata')
          .doc('data')
          .collection('versions')
          .doc(version);
        const latestRef = db.collection('installer_metadata').doc('latest');

        // one transaction so two platforms finalizing at once both land in `files`
        const versionData = await db.runTransaction(async (tx) => {
          const snap = await tx.get(versionRef);
          const existing = snap.data() ?? {};
          // a re-upload of a deleted version is a new release of that number:
          // fresh version-level fields, and only the files uploaded from here on
          const fresh = !snap.exists || typeof existing.deletedAt === 'number';
          const merged: Record<string, unknown> = {
            ...(fresh
              ? {
                  version,
                  release_notes: uploadData.releaseNotes ?? null,
                  uploaded_at: now,
                  release_date: Timestamp.fromMillis(now),
                  uploaded_by: uploadData.userId,
                  deletedAt: null,
                }
              : existing),
            ...alias,
            files: { ...(fresh ? {} : existing.files), [platform]: fileEntry },
          };
          tx.set(versionRef, merged);
          if (uploadData.setAsLatest) {
            tx.set(latestRef, {
              ...merged,
              files: normalizeInstallerFiles(merged),
              release_date: isoReleaseDate(merged.release_date, now),
              promoted_at: now,
              promoted_by: auth.userId,
            });
          }
          return merged;
        });

        await db
          .collection('installer_uploads')
          .doc(uploadId)
          .update({
            status: 'completed',
            completedAt: now,
            file_size: fileSize,
          });

        emitMutation({
          kind: 'installer_mutated',
          siteId: '',
          actor: auth.auth.keyContext
            ? `apiKey:${auth.auth.keyContext.keyId}`
            : `user:${auth.userId}`,
          targetId: version,
          attributes: {
            endpoint: '/api/installer/upload',
            method: 'PUT',
            verb: 'upload_finalized',
            uploadId,
            platform,
            setAsLatest: uploadData.setAsLatest === true,
            file_size: fileSize,
          },
        });

        return applyAuthDeprecations(
          NextResponse.json({
            version,
            platform,
            download_url: downloadUrl,
            checksum_sha256: finalChecksum,
            file_size: fileSize,
            files: normalizeInstallerFiles(versionData),
          }),
          auth.scopeCheck,
        );
      },
      { requireKey: true },
    );
  } catch (err) {
    return problemFromError(err, 'installer/upload:PUT');
  }
}

// `latest` keeps release_date as an iso string: deployed agents parse it as text
function isoReleaseDate(value: unknown, fallbackMs: number): string {
  if (typeof value === 'string') return value;
  const stamp = value as { toDate?: () => Date } | null;
  return typeof stamp?.toDate === 'function'
    ? stamp.toDate().toISOString()
    : new Date(fallbackMs).toISOString();
}
