/**
 * POST /api/installer/{version}/set-latest
 *
 * Update the `installer_metadata/latest` pointer to the given version.
 * Atomic Firestore transaction — refuses if the version doesn't exist or
 * is soft-deleted. Then registers the version with tridant id, yanking any
 * registered release above it (a rollback); the outcome is `tridant`, and a
 * tridant id failure never fails the promote.
 *
 * Auth: an api key with `installer=*:admin` scope, or a superadmin session.
 * Idempotency-Key is REQUIRED; the same key + body within 24h replays the
 * cached response.
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
import { withIdempotency } from '@/lib/idempotency';
import { emitMutation } from '@/lib/auditLogClient';
import {
  installerVersionResponse,
  type InstallerVersionRecord,
} from '@/lib/installerVersionResponse.server';
import { syncInstallerRelease } from '@/lib/tridantRelease.server';
import {
  applyAuthDeprecations,
  readAndParseJsonBody,
  requirePlatformAuthAndScope,
} from '../../../_shared';

const VERSION_REGEX = /^\d+\.\d+\.\d+$/;

interface RouteParams {
  params: Promise<{ version: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { version } = await params;
    if (!VERSION_REGEX.test(version)) {
      return problemValidation('version must match X.Y.Z', {
        'path.version': ['must be a semver string like "2.2.1"'],
      });
    }

    // Read + discard the body so idempotency body-hashing is consistent whether
    // callers send `{}` or nothing; also rejects malformed json early.
    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    const auth = await requirePlatformAuthAndScope(request, 'installer', 'admin');
    if (!auth.ok) return auth.response;

    return await withIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        const db = getAdminDb();
        const versionRef = db
          .collection('installer_metadata')
          .doc('data')
          .collection('versions')
          .doc(version);
        const latestRef = db.collection('installer_metadata').doc('latest');

        const result = await db.runTransaction(async (tx) => {
          const versionSnap = await tx.get(versionRef);
          if (!versionSnap.exists) {
            return { kind: 'not_found' as const };
          }
          const data = versionSnap.data() ?? {};
          if (typeof data.deletedAt === 'number') {
            return { kind: 'deleted' as const };
          }

          const now = Date.now();
          const latestData = installerVersionResponse(version, {
            ...(data as InstallerVersionRecord),
            version: typeof data.version === 'string' ? data.version : version,
            deletedAt: null,
            promoted_at: now,
            promoted_by: auth.userId,
          });
          tx.set(latestRef, latestData);
          return { kind: 'set' as const, latestData };
        });

        if (result.kind === 'not_found') {
          return problem({
            type: ProblemType.NotFound,
            title: 'version not found',
            status: 404,
            detail: `installer version ${version} does not exist`,
            instance: `/api/installer/${version}/set-latest`,
          });
        }

        if (result.kind === 'deleted') {
          return problem({
            type: ProblemType.Conflict,
            title: 'version is deleted',
            status: 409,
            detail: `installer version ${version} is soft-deleted; restore it before promoting`,
            instance: `/api/installer/${version}/set-latest`,
            code: 'version_deleted',
          });
        }

        emitMutation({
          kind: 'installer_mutated',
          siteId: '',
          actor: auth.auth.keyContext
            ? `apiKey:${auth.auth.keyContext.keyId}`
            : `user:${auth.userId}`,
          targetId: version,
          attributes: {
            endpoint: `/api/installer/${version}/set-latest`,
            method: 'POST',
            verb: 'set_latest',
          },
        });

        const tridant = await syncInstallerRelease(version);

        return applyAuthDeprecations(
          NextResponse.json({
            version,
            latest: result.latestData,
            tridant,
          }),
          auth.scopeCheck,
        );
      },
      { requireKey: true },
    );
  } catch (err) {
    return problemFromError(err, 'installer/[version]/set-latest:POST');
  }
}
