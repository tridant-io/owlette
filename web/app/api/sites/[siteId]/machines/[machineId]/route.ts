/**
 * GET    /api/sites/{siteId}/machines/{machineId}
 *        Machine detail: list fields + metrics + processes.
 * DELETE /api/sites/{siteId}/machines/{machineId}
 *        Remove the machine and bounded associated data.
 *
 * roost public api wave 3.6.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { Timestamp } from 'firebase-admin/firestore';
import {
  problem,
  problemFromError,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  applyAuthDeprecations,
  readAndParseJsonBody,
  requireSiteAuthAndScope,
} from '../../../../_shared';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import { withIdempotency } from '@/lib/idempotency';
import { removeMachine } from '@/lib/actions/removeMachine.server';
import { siteAuditActor } from '@/lib/actions/auditActor.server';

interface RouteParams {
  params: Promise<{ siteId: string; machineId: string }>;
}

type PathParams = { siteId: string; machineId: string } & Record<string, string | undefined>;

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId, machineId } = await params;
    const auth = await requireSiteAuthAndScope(request, siteId, 'read');
    if (!auth.ok) return auth.response;

    const db = getAdminDb();
    const machineRef = db
      .collection('sites')
      .doc(siteId)
      .collection('machines')
      .doc(machineId);

    const machineSnap = await machineRef.get();
    if (!machineSnap.exists) {
      return problem({
        type: ProblemType.NotFound,
        title: 'machine not found',
        status: 404,
        detail: `machine ${machineId} not found on site ${siteId}`,
        instance: `/api/sites/${siteId}/machines/${machineId}`,
      });
    }

    const data = machineSnap.data() ?? {};
    const lastHeartbeat = data.lastHeartbeat ?? data.presence?.lastHeartbeat ?? null;

    return applyAuthDeprecations(
      NextResponse.json({
        id: machineId,
        siteId,
        name: typeof data.name === 'string'
          ? data.name
          : typeof data.machine_name === 'string'
            ? data.machine_name
            : machineId,
        online: data.online === true,
        lastHeartbeat: heartbeatToIso(lastHeartbeat),
        agentVersion:
          data.agent_version ?? data.presence?.agent_version ?? null,
        os: data.os ?? data.presence?.os ?? null,
        // what the agent writes on every heartbeat (firebase_client._os_identity):
        // 'windows' | 'macos' | 'linux', 'x64' | 'arm64', and the version string.
        // an absent osFamily is a pre-3.4 windows agent.
        osFamily: data.osFamily ?? null,
        arch: data.arch ?? null,
        osVersion: data.osVersion ?? null,
        hostname: data.hostname ?? data.presence?.hostname ?? null,
        metrics: data.metrics ?? data.status?.metrics ?? null,
        // what the agent reports it can do, as the heartbeat wrote it. the
        // dashboard reads this from firestore directly; api callers had no
        // way to see it at all, so every capability gate read undefined.
        capabilities: data.capabilities ?? null,
        processes: Array.isArray(data.processes)
          ? data.processes
          : Array.isArray(data.status?.processes)
            ? data.status.processes
            : [],
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/sites/[siteId]/machines/[machineId]:GET');
  }
}

export const DELETE = authorizedSiteHandler<PathParams>({
  capability: Capability.MACHINE_REMOVE,
  siteIdParam: 'path',
  targetKind: 'machine',
  targetIdParam: 'machineId',
  apiKeyScope: { resource: 'machine', idParam: 'machineId', permission: 'write' },
})(async (request: NextRequest, ctx, routeContext) => {
  try {
    const { machineId } = await routeContext.params;
    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    return withIdempotency(
      request,
      {
        userId: ctx.actor.userId,
        environment: ctx.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        const result = await removeMachine({
          siteId: ctx.siteId,
          machineId,
          auditActor: siteAuditActor(ctx),
        });

        return applyAuthDeprecations(
          NextResponse.json({
            ok: true,
            data: result,
          }),
          ctx.scopeCheck,
        );
      },
      { requireKey: true },
    );
  } catch (err) {
    return problemFromError(err, 'v2/sites/[siteId]/machines/[machineId]:DELETE');
  }
});

function heartbeatToIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (typeof v === 'number') return new Date(v).toISOString();
  if (typeof v === 'string') {
    const parsed = Date.parse(v);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  if (v && typeof v === 'object' && 'toDate' in v && typeof (v as { toDate: () => Date }).toDate === 'function') {
    return (v as { toDate: () => Date }).toDate().toISOString();
  }
  return null;
}
