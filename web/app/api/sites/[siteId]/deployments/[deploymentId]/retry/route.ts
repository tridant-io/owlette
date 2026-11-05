/**
 * POST /api/sites/{siteId}/deployments/{deploymentId}/retry
 *
 * Re-queues `install_software` for `failed` targets ONLY; every other state is
 * left untouched. Deployment status flips to `in_progress` until the retried
 * targets settle, then recomputes exactly as cancel does.
 *
 * Requires `site=<id>:write` and an `Idempotency-Key` header.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { problem, problemFromError, problemValidation, ProblemType } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  applyAuthDeprecations,
  readAndParseJsonBody,
} from '../../../../../_shared';
import { withIdempotency } from '@/lib/idempotency';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import { emitMutation } from '@/lib/auditLogClient';
import { installerChecksumErrorToResponse } from '@/lib/installerChecksumResponse.server';
import {
  computeInstallerChecksum,
  InstallerChecksumError,
} from '@/lib/actions/computeInstallerChecksum.server';
import { resolveActiveHoursOverride } from '@/lib/actions/executeMachineCommand.server';
import { siteAuditActor } from '@/lib/actions/auditActor.server';
import type { DeploymentTarget } from '@/hooks/useDeployments';

type RouteParams = { siteId: string; deploymentId: string };

export const runtime = 'nodejs';
// Self-healing legacy deployments streams the installer to pin a checksum;
// large binaries need headroom on the Vercel failover origin.
export const maxDuration = 300;

export const POST = authorizedSiteHandler<RouteParams>({
  capability: 'DEPLOYMENT_MANAGE',
  siteIdParam: 'path',
  // Opted in: enforced through the inner _shared gate until now, so without
  // this, removing that gate would drop the 400 on an unsupported
  // Roost-Version.
  roostVersioned: true,
  targetKind: 'deployment',
})(async (request: NextRequest, ctx, routeContext) => {
  try {
    const { siteId, deploymentId } = await routeContext.params;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as { machines?: unknown; active_hours_override?: unknown };

    // Optional filter for the dashboard's per-row retry; omitted → all failed.
    let machineFilter: Set<string> | null = null;
    if (body.machines !== undefined) {
      if (
        !Array.isArray(body.machines) ||
        body.machines.length === 0 ||
        body.machines.some((m) => typeof m !== 'string' || m.length === 0)
      ) {
        return problemValidation('machines must be a non-empty string array when provided', {
          'body.machines': ['must be a non-empty string array when provided'],
        });
      }
      machineFilter = new Set(body.machines as string[]);
    }

    // a retry needs its own approval; the original call's override does not carry over.
    const actor = siteAuditActor(ctx);
    const override = resolveActiveHoursOverride(body.active_hours_override, actor);
    if (!override.ok) {
      return problemValidation(`active_hours_override: ${override.error}`, {
        'body.active_hours_override': [override.error],
      });
    }
    const activeHoursOverride = override.override;

    return withIdempotency(
      request,
      {
        userId: ctx.actor.userId,
        environment: ctx.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        const db = getAdminDb();
        const deploymentRef = db
          .collection('sites')
          .doc(siteId)
          .collection('deployments')
          .doc(deploymentId);
        const snap = await deploymentRef.get();

        if (!snap.exists) {
          return problem({
            type: ProblemType.NotFound,
            title: 'not found',
            status: 404,
            detail: `deployment ${deploymentId} not found on site ${siteId}`,
            instance: `/api/sites/${siteId}/deployments/${deploymentId}/retry`,
          });
        }

        const data = snap.data() ?? {};
        const targets: DeploymentTarget[] = Array.isArray(data.targets)
          ? (data.targets as DeploymentTarget[])
          : [];
        const failed = targets.filter(
          (t) => t.status === 'failed' && (!machineFilter || machineFilter.has(t.machineId)),
        );

        if (failed.length === 0) {
          return problem({
            type: ProblemType.Conflict,
            title: 'no failed targets',
            status: 409,
            detail: machineFilter
              ? 'no targets in `failed` state matching the machines filter'
              : 'no targets in `failed` state to retry',
            instance: `/api/sites/${siteId}/deployments/${deploymentId}/retry`,
            code: 'no_failed_targets',
          });
        }

        const installerUrl = typeof data.installer_url === 'string' ? data.installer_url : '';
        const installerName = typeof data.installer_name === 'string' ? data.installer_name : '';
        const silentFlags = typeof data.silent_flags === 'string' ? data.silent_flags : '';
        let sha256 =
          typeof data.sha256_checksum === 'string' ? data.sha256_checksum : undefined;
        const verifyPath =
          typeof data.verify_path === 'string' ? data.verify_path : undefined;
        const parallelInstall = data.parallel_install === true;

        if (!installerUrl || !installerName) {
          return problem({
            type: ProblemType.Conflict,
            title: 'deployment incomplete',
            status: 409,
            detail: 'deployment record is missing installer_url or installer_name; cannot retry',
            instance: `/api/sites/${siteId}/deployments/${deploymentId}/retry`,
          });
        }

        // Pre-checksum-automation deployments have no pinned checksum, and
        // agents refuse install_software without one — so pin it now, and
        // surface a failure rather than queuing commands all agents refuse.
        let healedChecksum = false;
        if (!sha256) {
          try {
            const computed = await computeInstallerChecksum(installerUrl, {
              signal: request.signal,
            });
            sha256 = computed.sha256_checksum;
            healedChecksum = true;
          } catch (err) {
            if (err instanceof InstallerChecksumError) {
              return installerChecksumErrorToResponse(err);
            }
            throw err;
          }
        }

        const retryEpoch = Date.now();

        // Failed targets only; see the contract at the top of the file.
        await Promise.all(
          failed.map(async (target) => {
            const sanitizedDeploymentId = deploymentId.replace(/-/g, '_');
            const sanitizedMachineId = target.machineId.replace(/-/g, '_');
            const commandId = `install_${sanitizedDeploymentId}_${sanitizedMachineId}_${retryEpoch}`;

            const pendingRef = db
              .collection('sites')
              .doc(siteId)
              .collection('machines')
              .doc(target.machineId)
              .collection('commands')
              .doc('pending');

            const commandData: Record<string, unknown> = {
              type: 'install_software',
              installer_url: installerUrl,
              installer_name: installerName,
              silent_flags: silentFlags,
              deployment_id: deploymentId,
              timestamp: FieldValue.serverTimestamp(),
              status: 'pending',
              retry_attempt: true,
            };
            if (sha256) commandData.sha256_checksum = sha256;
            if (verifyPath) commandData.verify_path = verifyPath;
            if (parallelInstall) commandData.parallel_install = true;
            if (activeHoursOverride) commandData.activeHoursOverride = activeHoursOverride;

            await pendingRef.set({ [commandId]: commandData }, { merge: true });
          }),
        );

        const retryAt = Timestamp.now();
        // Reset to `pending`, dropping `error` so no stale message sits beside
        // a re-running target, and stamping `retriedAt` for audit. Typed as a
        // generic record: the on-disk shape carries ad-hoc fields that aren't
        // on the strict `DeploymentTarget` union.
        const updatedTargets: Array<Record<string, unknown>> = targets.map((target) => {
          if (target.status !== 'failed' || (machineFilter && !machineFilter.has(target.machineId))) {
            return target as unknown as Record<string, unknown>;
          }
          const { error: _droppedError, ...rest } = target;
          void _droppedError;
          return {
            ...rest,
            status: 'pending',
            retriedAt: retryAt,
          };
        });

        await deploymentRef.update({
          targets: updatedTargets,
          status: 'in_progress',
          updatedAt: FieldValue.serverTimestamp(),
          // Clear completedAt — the deployment is back in flight.
          completedAt: FieldValue.delete(),
          // Persist the computed checksum so future retries skip the download
          // and the doc matches what the commands were issued with.
          ...(healedChecksum && sha256 ? { sha256_checksum: sha256 } : {}),
        });

        emitMutation({
          kind: 'deployment_mutated',
          siteId,
          actor,
          targetId: deploymentId,
          attributes: {
            endpoint: `/api/sites/${siteId}/deployments/${deploymentId}/retry`,
            method: 'POST',
            verb: 'retry',
            retried_count: failed.length,
            machine_ids: failed.map((t) => t.machineId),
            correlationId: ctx.correlationId,
            ...(activeHoursOverride
              ? { activeHoursOverride: true, activeHoursOverrideReason: activeHoursOverride.reason }
              : {}),
          },
        });

        return applyAuthDeprecations(
          NextResponse.json({
            deploymentId,
            siteId,
            status: 'in_progress',
            retried: failed.length,
            machine_ids: failed.map((t) => t.machineId),
          }),
          ctx.scopeCheck,
        );
      },
      { requireKey: true },
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/deployments/[deploymentId]/retry:POST');
  }
});
