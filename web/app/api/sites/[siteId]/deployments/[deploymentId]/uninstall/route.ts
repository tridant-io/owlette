/**
 * POST /api/sites/{siteId}/deployments/{deploymentId}/uninstall
 *
 * Body `{ software_name }`: the program's exact name in each machine's software
 * list. Queues `buildUniqueUninstallCommand`'s command, carrying `deployment_id`,
 * on every finished target whose machine still exists and lists that name once;
 * the rest come back in `skipped`. The reconciler moves each queued target from the agent's result,
 * so this route writes no deployment status. `409 no_uninstallable_targets`
 * when no target can take it, and then nothing is queued.
 *
 * Requires `site=<id>:admin` and an `Idempotency-Key` header.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problem, problemFromError, problemValidation, ProblemType } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  applyAuthDeprecations,
  readAndParseJsonBody,
} from '../../../../../_shared';
import { withIdempotency } from '@/lib/idempotency';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import { emitMutation } from '@/lib/auditLogClient';
import { TERMINAL_DEPLOYMENT_STATUSES } from '@/lib/deploymentStatuses';
import {
  parseTriggerUninstallInput,
  TriggerUninstallError,
} from '@/lib/actions/triggerUninstall.server';
import {
  buildUniqueUninstallCommand,
  type UninstallCommandRefusal,
} from '@/lib/actions/uninstallCommand.server';
import type { StampedCommandData } from '@/lib/commandLifecycle';
import type { DeploymentTarget } from '@/hooks/useDeployments';

type RouteParams = { siteId: string; deploymentId: string };

type Outcome =
  | { machineId: string; commandId: string; command: StampedCommandData }
  | {
      machineId: string;
      skip: UninstallCommandRefusal | 'software_ambiguous' | 'install_in_flight' | 'machine_not_found';
    };

export const POST = authorizedSiteHandler<RouteParams>({
  capability: 'DEPLOYMENT_MANAGE',
  siteIdParam: 'path',
  // Opted in because these routes already enforced it through the inner
  // _shared gate; without this, removing that gate would silently drop the
  // 400 on an unsupported Roost-Version.
  roostVersioned: true,
  // write AND admin: the inner gate asked for admin while the wrapper defaulted
  // to write, and permissions are not hierarchical, so both were required. The
  // inner gate is gone; the requirement it carried is stated here.
  apiKeyPermission: ['write', 'admin'],
  targetKind: 'deployment',
})(async (request: NextRequest, ctx, routeContext) => {
  try {
    const { siteId, deploymentId } = await routeContext.params;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    // same rules as the machine route's software_name.
    let softwareName: string;
    try {
      softwareName = parseTriggerUninstallInput({
        software_name: ((parsed.body ?? {}) as { software_name?: unknown }).software_name,
      }).software_name;
    } catch (err) {
      if (err instanceof TriggerUninstallError) {
        return problemValidation(err.message, err.fieldErrors);
      }
      throw err;
    }

    // Privileged: `admin`, not the `write` that create/retry/cancel take.

    return withIdempotency(
      request,
      {
        userId: ctx.actor.userId,
        environment: ctx.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        const db = getAdminDb();
        const instance = `/api/sites/${siteId}/deployments/${deploymentId}/uninstall`;
        const snap = await db
          .collection('sites')
          .doc(siteId)
          .collection('deployments')
          .doc(deploymentId)
          .get();

        if (!snap.exists) {
          return problem({
            type: ProblemType.NotFound,
            title: 'not found',
            status: 404,
            detail: `deployment ${deploymentId} not found on site ${siteId}`,
            instance,
          });
        }

        const data = snap.data() ?? {};
        const targets: DeploymentTarget[] = Array.isArray(data.targets)
          ? (data.targets as DeploymentTarget[])
          : [];

        if (targets.length === 0) {
          return problem({
            type: ProblemType.Conflict,
            title: 'no targets',
            status: 409,
            detail: 'deployment has no target machines to uninstall from',
            instance,
            code: 'no_targets',
          });
        }

        const now = Date.now();
        const outcomes = await Promise.all(
          targets.map(async ({ machineId, status }): Promise<Outcome> => {
            // an install still queued or running could land after the uninstall and undo it.
            if (!TERMINAL_DEPLOYMENT_STATUSES.has(status)) {
              return { machineId, skip: 'install_in_flight' };
            }
            // a removed machine keeps its software list, and a command left in its pending
            // map would run when the same hostname pairs again.
            const machineRef = db.collection('sites').doc(siteId).collection('machines').doc(machineId);
            if (!(await machineRef.get()).exists) {
              return { machineId, skip: 'machine_not_found' };
            }
            const built = await buildUniqueUninstallCommand(db, siteId, machineId, softwareName, {
              deploymentId,
              auditCorrelationId: ctx.correlationId,
              now,
            });
            return built.ok
              ? { machineId, commandId: built.commandId, command: built.command }
              : { machineId, skip: built.reason };
          }),
        );
        const queued = outcomes.flatMap((o) => ('command' in o ? [o] : []));
        const skipped = outcomes.flatMap((o) =>
          'skip' in o ? [{ machineId: o.machineId, reason: o.skip }] : [],
        );

        if (queued.length === 0) {
          return problem({
            type: ProblemType.Conflict,
            title: 'no uninstallable targets',
            status: 409,
            detail: `no target can take the uninstall of "${softwareName}"; skipped says why for each`,
            instance,
            code: 'no_uninstallable_targets',
            skipped,
          });
        }

        await Promise.all(
          queued.map(({ machineId, commandId, command }) =>
            db
              .collection('sites')
              .doc(siteId)
              .collection('machines')
              .doc(machineId)
              .collection('commands')
              .doc('pending')
              .set({ [commandId]: command }, { merge: true }),
          ),
        );

        const machineIds = queued.map((q) => q.machineId);
        emitMutation({
          kind: 'deployment_mutated',
          siteId,
          actor: ctx.auth.keyContext
            ? `apiKey:${ctx.auth.keyContext.keyId}`
            : `user:${ctx.actor.userId}`,
          targetId: deploymentId,
          attributes: {
            endpoint: instance,
            method: 'POST',
            verb: 'uninstall',
            target_count: queued.length,
            machine_ids: machineIds,
            skipped_count: skipped.length,
            software_name: softwareName,
            correlationId: ctx.correlationId,
          },
        });

        return applyAuthDeprecations(
          NextResponse.json({
            deploymentId,
            siteId,
            status: data.status,
            queued: queued.length,
            machine_ids: machineIds,
            skipped,
          }),
          ctx.scopeCheck,
        );
      },
      { requireKey: true },
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/deployments/[deploymentId]/uninstall:POST');
  }
});
