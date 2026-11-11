/**
 * POST /api/sites/{siteId}/deployments/{deploymentId}/retry
 *
 * Re-queues `install_software` for `failed` targets ONLY; every other state is
 * left untouched, and so is a target whose failure was an uninstall. The targets
 * are reset to `pending` in a transaction on a fresh read before any command is
 * queued. Deployment status flips to `in_progress` until the retried targets
 * settle, then recomputes exactly as cancel does.
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
import { parseMachinesFilter } from '@/lib/machinesFilter';
import { installerChecksumErrorToResponse } from '@/lib/installerChecksumResponse.server';
import {
  computeInstallerChecksum,
  InstallerChecksumError,
} from '@/lib/actions/computeInstallerChecksum.server';
import { resolveActiveHoursOverride } from '@/lib/actions/executeMachineCommand.server';
import { siteAuditActor } from '@/lib/actions/auditActor.server';
import { retryableTarget } from '@/lib/deploymentStatuses';
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
    const body = (parsed.body ?? {}) as { active_hours_override?: unknown };

    // Optional filter for the dashboard's per-row retry; omitted → all failed.
    const filter = parseMachinesFilter(parsed.body);
    if (!filter.ok) return filter.response;
    const machineFilter = filter.machines ? new Set(filter.machines) : null;

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
        const instance = `/api/sites/${siteId}/deployments/${deploymentId}/retry`;
        const notFound = () =>
          problem({
            type: ProblemType.NotFound,
            title: 'not found',
            status: 404,
            detail: `deployment ${deploymentId} not found on site ${siteId}`,
            instance,
          });
        const noFailedTargets = (detail: string) =>
          problem({
            type: ProblemType.Conflict,
            title: 'no failed targets',
            status: 409,
            detail,
            instance,
            code: 'no_failed_targets',
          });

        const snap = await deploymentRef.get();
        if (!snap.exists) return notFound();

        const data = snap.data() ?? {};
        const targets: DeploymentTarget[] = Array.isArray(data.targets)
          ? (data.targets as DeploymentTarget[])
          : [];
        const inCall = (t: DeploymentTarget) => !machineFilter || machineFilter.has(t.machineId);
        const failed = targets.filter((t) => inCall(t) && retryableTarget(t));

        if (failed.length === 0) {
          if (targets.some((t) => inCall(t) && t.status === 'failed')) {
            return noFailedTargets(
              'the only failed targets here failed an uninstall, which a retry would reinstall; ' +
                'run the uninstall again instead',
            );
          }
          return noFailedTargets(
            machineFilter
              ? 'no targets in `failed` state matching the machines filter'
              : 'no targets in `failed` state to retry',
          );
        }

        const installerUrl = typeof data.installer_url === 'string' ? data.installer_url : '';
        const installerName = typeof data.installer_name === 'string' ? data.installer_name : '';
        const silentFlags = typeof data.silent_flags === 'string' ? data.silent_flags : '';
        let sha256 =
          typeof data.sha256_checksum === 'string' ? data.sha256_checksum : undefined;
        const verifyPath =
          typeof data.verify_path === 'string' ? data.verify_path : undefined;
        const parallelInstall = data.parallel_install === true;
        // stored by createDeployment only when non-empty. a retry that left them
        // out reinstalled over the running app, which is often why the first try failed.
        const closeProcesses = Array.isArray(data.close_processes) ? data.close_processes : undefined;
        const suppressProjects = Array.isArray(data.suppress_projects)
          ? data.suppress_projects
          : undefined;

        if (!installerUrl || !installerName) {
          return problem({
            type: ProblemType.Conflict,
            title: 'deployment incomplete',
            status: 409,
            detail: 'deployment record is missing installer_url or installer_name; cannot retry',
            instance,
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

        // claim the targets before queuing anything: the checksum can take minutes, and
        // another retry or a late result can move a target off `failed` meanwhile. queuing
        // first would send that target a second install. if the queuing below then fails,
        // the claimed targets sit `pending` until the sweeper fails them.
        const callSet = new Set(failed.map((t) => t.machineId));
        const retryAt = Timestamp.now();
        const claimed = await db.runTransaction(async (tx) => {
          const fresh = await tx.get(deploymentRef);
          if (!fresh.exists) return null;
          const freshData = fresh.data() ?? {};
          const freshTargets: DeploymentTarget[] = Array.isArray(freshData.targets)
            ? (freshData.targets as DeploymentTarget[])
            : [];

          // Reset to `pending`, dropping `error` and `failedCommandType` so no stale failure
          // sits beside a re-running target, and stamping `retriedAt` for audit. Typed as a
          // generic record: the on-disk shape carries ad-hoc fields that aren't on the strict
          // `DeploymentTarget` union.
          const machineIds: string[] = [];
          const updatedTargets: Array<Record<string, unknown>> = freshTargets.map((target) => {
            if (!callSet.has(target.machineId) || !retryableTarget(target)) {
              return target as unknown as Record<string, unknown>;
            }
            machineIds.push(target.machineId);
            const { error: _droppedError, failedCommandType: _droppedFailure, ...rest } = target;
            void _droppedError;
            void _droppedFailure;
            return {
              ...rest,
              status: 'pending',
              retriedAt: retryAt,
            };
          });
          if (machineIds.length === 0) return machineIds;

          tx.update(deploymentRef, {
            targets: updatedTargets,
            // a target is pending again, so the deployment is back in flight.
            status: 'in_progress',
            updatedAt: FieldValue.serverTimestamp(),
            completedAt: FieldValue.delete(),
            // Persist the computed checksum so future retries skip the download
            // and the doc matches what the commands were issued with.
            ...(healedChecksum && sha256 ? { sha256_checksum: sha256 } : {}),
          });
          // the stale-deployment sweeper scans only sites stamped in the last 30 minutes;
          // it is what fails a claimed target whose install below never got queued.
          tx.set(
            db.collection('sites').doc(siteId),
            { lastDeploymentActivityAt: FieldValue.serverTimestamp() },
            { merge: true },
          );
          return machineIds;
        });

        if (claimed === null) return notFound();
        if (claimed.length === 0) {
          return noFailedTargets(
            'every target this retry matched left `failed` while it ran; nothing was queued',
          );
        }

        const retryEpoch = Date.now();

        // The claimed targets only; see the contract at the top of the file.
        const queuing = await Promise.allSettled(
          claimed.map(async (machineId) => {
            const sanitizedDeploymentId = deploymentId.replace(/-/g, '_');
            const sanitizedMachineId = machineId.replace(/-/g, '_');
            const commandId = `install_${sanitizedDeploymentId}_${sanitizedMachineId}_${retryEpoch}`;

            const pendingRef = db
              .collection('sites')
              .doc(siteId)
              .collection('machines')
              .doc(machineId)
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
            if (closeProcesses) commandData.close_processes = closeProcesses;
            if (suppressProjects) commandData.suppress_projects = suppressProjects;
            if (parallelInstall) commandData.parallel_install = true;
            if (activeHoursOverride) commandData.activeHoursOverride = activeHoursOverride;

            // a target the sweeper timed out at `pending` still has its first install queued
            // for when the machine reconnects; replace it, or the machine runs both.
            const queuedBefore = (await pendingRef.get()).data() ?? {};
            const superseded = Object.entries(queuedBefore)
              .filter(([, queued]) => {
                const command = queued as { type?: unknown; deployment_id?: unknown } | null;
                return command?.type === 'install_software' && command.deployment_id === deploymentId;
              })
              .map(([queuedId]) => [queuedId, FieldValue.delete()]);

            await pendingRef.set(
              { ...Object.fromEntries(superseded), [commandId]: commandData },
              { merge: true },
            );
          }),
        );
        const queued = claimed.filter((_, i) => queuing[i].status === 'fulfilled');
        const unqueued = claimed.filter((_, i) => queuing[i].status === 'rejected');

        // audited before any failure is answered: the record changed and the queued installs run.
        emitMutation({
          kind: 'deployment_mutated',
          siteId,
          actor,
          targetId: deploymentId,
          attributes: {
            endpoint: instance,
            method: 'POST',
            verb: 'retry',
            retried_count: queued.length,
            machine_ids: queued,
            ...(unqueued.length > 0 ? { unqueued_machine_ids: unqueued } : {}),
            correlationId: ctx.correlationId,
            ...(activeHoursOverride
              ? { activeHoursOverride: true, activeHoursOverrideReason: activeHoursOverride.reason }
              : {}),
          },
        });

        const failedQueue = queuing.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        // the unqueued targets stay `pending` until the sweeper fails them.
        if (failedQueue) {
          return problemFromError(
            failedQueue.reason,
            'sites/[siteId]/deployments/[deploymentId]/retry:POST',
          );
        }

        return applyAuthDeprecations(
          NextResponse.json({
            deploymentId,
            siteId,
            status: 'in_progress',
            retried: claimed.length,
            machine_ids: claimed,
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
