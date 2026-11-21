/**
 * POST /api/installer/{version}/register
 *
 * Runs the version's tridant id sync again, after a failed registration or
 * yank: an active version at or below `latest` is imported, a deleted one or
 * one above `latest` is yanked. Returns `{ version, tridant }`; a tridant id
 * failure is reported there, not as an error status.
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
        const snap = await getAdminDb()
          .collection('installer_metadata')
          .doc('data')
          .collection('versions')
          .doc(version)
          .get();
        if (!snap.exists) {
          return problem({
            type: ProblemType.NotFound,
            title: 'version not found',
            status: 404,
            detail: `installer version ${version} does not exist`,
            instance: `/api/installer/${version}/register`,
          });
        }

        const tridant = await syncInstallerRelease(version);

        emitMutation({
          kind: 'installer_mutated',
          siteId: '',
          actor: auth.auth.keyContext
            ? `apiKey:${auth.auth.keyContext.keyId}`
            : `user:${auth.userId}`,
          targetId: version,
          attributes: {
            endpoint: `/api/installer/${version}/register`,
            method: 'POST',
            verb: 'release_synced',
            tridantStatus: tridant.status,
          },
        });

        return applyAuthDeprecations(
          NextResponse.json({ version, tridant }),
          auth.scopeCheck,
        );
      },
      { requireKey: true },
    );
  } catch (err) {
    return problemFromError(err, 'installer/[version]/register:POST');
  }
}
