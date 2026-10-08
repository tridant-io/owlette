/**
 * DELETE /api/installer/{version} — soft-delete: only `deletedAt` is set, the
 * doc and storage object stay. Hard delete is a separate admin sweep.
 *
 * Refuses to drop active versions below 2, checked inside a transaction so
 * concurrent deletes can't both see "3 active"; 409 `min_versions_violated`
 * otherwise.
 *
 * A version registered with tridant id is yanked there; the outcome is
 * `tridant`, and a tridant id failure never fails the delete.
 *
 * Auth: api key with `installer=*:admin`, or a superadmin session/id-token.
 * Idempotent — re-deleting returns the same 200 shape, deletedAt unchanged.
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
import { emitMutation } from '@/lib/auditLogClient';
import { syncInstallerRelease } from '@/lib/tridantRelease.server';
import { applyAuthDeprecations, requirePlatformAuthAndScope } from '../../_shared';

const VERSION_REGEX = /^\d+\.\d+\.\d+$/;
const MIN_ACTIVE_VERSIONS = 2;

interface RouteParams {
  params: Promise<{ version: string }>;
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { version } = await params;
    if (!VERSION_REGEX.test(version)) {
      return problemValidation('version must match X.Y.Z', {
        'path.version': ['must be a semver string like "2.2.1"'],
      });
    }

    const auth = await requirePlatformAuthAndScope(request, 'installer', 'admin');
    if (!auth.ok) return auth.response;

    const db = getAdminDb();
    const versionsCol = db
      .collection('installer_metadata')
      .doc('data')
      .collection('versions');
    const targetRef = versionsCol.doc(version);
    const latestRef = db.collection('installer_metadata').doc('latest');

    const result = await db.runTransaction(async (tx) => {
      const targetSnap = await tx.get(targetRef);
      if (!targetSnap.exists) {
        return { kind: 'not_found' as const };
      }
      const targetData = targetSnap.data() ?? {};

      // Idempotent: return current state, no audit event, no write.
      if (typeof targetData.deletedAt === 'number') {
        return {
          kind: 'already_deleted' as const,
          deletedAt: targetData.deletedAt as number,
        };
      }

      const latestSnap = await tx.get(latestRef);
      const latestData = latestSnap.exists ? latestSnap.data() : null;
      if (latestData?.version === version) {
        return { kind: 'latest_protected' as const };
      }

      // Counted inside the transaction so a concurrent delete can't race it.
      const allSnap = await tx.get(versionsCol);
      const activeCount = allSnap.docs.reduce((n, doc) => {
        const d = doc.data();
        return typeof d.deletedAt === 'number' ? n : n + 1;
      }, 0);

      if (activeCount <= MIN_ACTIVE_VERSIONS) {
        return {
          kind: 'min_violated' as const,
          activeCount,
        };
      }

      const now = Date.now();
      tx.update(targetRef, {
        deletedAt: now,
        deletedBy: auth.userId,
      });
      return { kind: 'deleted' as const, deletedAt: now };
    });

    if (result.kind === 'not_found') {
      return problem({
        type: ProblemType.NotFound,
        title: 'version not found',
        status: 404,
        detail: `installer version ${version} does not exist`,
        instance: `/api/installer/${version}`,
      });
    }

    if (result.kind === 'latest_protected') {
      return problem({
        type: ProblemType.Conflict,
        title: 'latest version protected',
        status: 409,
        detail:
          'cannot delete the current latest installer; promote another active version first',
        instance: `/api/installer/${version}`,
        code: 'latest_version_protected',
      });
    }

    if (result.kind === 'min_violated') {
      return problem({
        type: ProblemType.Conflict,
        title: 'min versions violated',
        status: 409,
        detail: `cannot delete: only ${result.activeCount} active version(s) remain; floor is ${MIN_ACTIVE_VERSIONS}`,
        instance: `/api/installer/${version}`,
        code: 'min_versions_violated',
        minActiveVersions: MIN_ACTIVE_VERSIONS,
        currentActiveCount: result.activeCount,
      });
    }

    if (result.kind === 'deleted') {
      emitMutation({
        kind: 'installer_mutated',
        siteId: '',
        actor: auth.auth.keyContext
          ? `apiKey:${auth.auth.keyContext.keyId}`
          : `user:${auth.userId}`,
        targetId: version,
        attributes: {
          endpoint: `/api/installer/${version}`,
          method: 'DELETE',
          verb: 'soft_deleted',
        },
      });
    }

    const tridant = await syncInstallerRelease(version);

    return applyAuthDeprecations(
      NextResponse.json({
        version,
        deletedAt: result.deletedAt,
        alreadyDeleted: result.kind === 'already_deleted',
        tridant,
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'installer/[version]:DELETE');
  }
}
