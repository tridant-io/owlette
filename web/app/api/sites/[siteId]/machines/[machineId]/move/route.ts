/**
 * POST   /api/sites/{siteId}/machines/{machineId}/move  body `{ targetSiteId }`
 *        ask for the machine to move to another site: a pending move and a
 *        `site_move` command its agent follows (lib/machineMoves.server.ts).
 * DELETE /api/sites/{siteId}/machines/{machineId}/move
 *        cancel the move while it is pending.
 *
 * MACHINE_REMOVE on this site, and MACHINE_ENROLL on the target: superadmins,
 * and anyone who administers both. api keys are refused, as on fleet-settings:
 * a key is scoped to one site and a move reaches a second one.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import {
  problem,
  problemForbidden,
  problemFromError,
  problemNotFound,
  problemPlanRequired,
  ProblemType,
} from '@/lib/apiErrors';
import { readAndParseJsonBody } from '@/app/api/_shared';
import { ApiAuthError, assertUserHasSiteCapability } from '@/lib/apiAuth.server';
import { emitMutation } from '@/lib/auditLogClient';
import { siteAuditActor } from '@/lib/actions/auditActor.server';
import { authorizedSiteHandler, type SiteHandlerContext } from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import { stampCommand } from '@/lib/commandLifecycle';
import { getAdminDb } from '@/lib/firebase-admin';
import { withIdempotency } from '@/lib/idempotency';
import { canFollowMove, MOVE_BUSY, MOVE_EXISTS, MOVE_TOO_OLD } from '@/lib/machineMove';
import {
  cancelMove,
  MOVE_PENDING_TTL_MS,
  moveRef,
  moveRefusal,
  readMove,
  type MachineMove,
} from '@/lib/machineMoves.server';
import { machineLimitRefusal } from '@/lib/pairingPlan.server';
import { SITE_ID_RE } from '@/lib/sitePolicy.server';
import { SITE_MOVE_MIN_AGENT_VERSION } from '@/lib/versionUtils';

type PathParams = { siteId: string; machineId: string } & Record<string, string | undefined>;

const moveHandler = authorizedSiteHandler<PathParams>({
  capability: Capability.MACHINE_REMOVE,
  siteIdParam: 'path',
  targetKind: 'machine',
  targetIdParam: 'machineId',
  apiKeyScope: { resource: 'machine', idParam: 'machineId', permission: 'write' },
});

function refuseApiKey(ctx: SiteHandlerContext): NextResponse | null {
  if (ctx.auth.keyContext === null) return null;
  return problem({
    type: ProblemType.Forbidden,
    title: 'forbidden',
    status: 403,
    code: 'api_key_not_permitted',
    detail: 'a machine cannot be moved with an api key.',
  });
}

function conflict(code: string, detail: string): NextResponse {
  return problem({ type: ProblemType.Conflict, title: 'conflict', status: 409, code, detail });
}

function moveBody({ moveId, status, targetSiteId, expiresAt }: MachineMove, httpStatus: number): NextResponse {
  return NextResponse.json({ ok: true, data: { moveId, status, targetSiteId, expiresAt } }, { status: httpStatus });
}

/** a request for a machine already moving: the same site is that move, another is a conflict. */
function answerExistingMove(move: MachineMove, targetSiteId: string, name: string): NextResponse {
  if (move.targetSiteId === targetSiteId) return moveBody(move, 200);
  return conflict(
    'move_pending',
    move.status === 'switching'
      ? `${name} is switching to another site now.`
      : `${name} is already moving to another site. cancel that move first.`,
  );
}

/** the three audit rows a move writes: on both sites, and on the platform's. */
function emitMoveRows(
  verb: 'machine.move_request' | 'machine.move_cancel',
  method: 'POST' | 'DELETE',
  actor: string,
  move: Pick<MachineMove, 'moveId' | 'sourceSiteId' | 'targetSiteId' | 'machineId'>,
): void {
  for (const siteId of [move.sourceSiteId, move.targetSiteId, '']) {
    emitMutation({
      kind: 'site_mutated',
      siteId,
      actor,
      targetId: move.machineId,
      attributes: {
        verb,
        endpoint: 'machines/move',
        method,
        machineId: move.machineId,
        moveId: move.moveId,
        sourceSiteId: move.sourceSiteId,
        targetSiteId: move.targetSiteId,
      },
    });
  }
}

export const POST = moveHandler(async (request: NextRequest, ctx, routeContext) => {
  try {
    const keyRefusal = refuseApiKey(ctx);
    if (keyRefusal) return keyRefusal;

    const { machineId } = await routeContext.params;
    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    return await withIdempotency(
      request,
      { userId: ctx.actor.userId, environment: 'unknown' },
      parsed.raw,
      async () => {
        const targetSiteId = (parsed.body as { targetSiteId?: unknown } | null)?.targetSiteId;
        if (typeof targetSiteId !== 'string' || !SITE_ID_RE.test(targetSiteId)) {
          return problem({
            type: ProblemType.ValidationFailed,
            title: 'validation failed',
            status: 400,
            detail: 'targetSiteId must be a site id',
            errors: { targetSiteId: ['must be 1-128 chars: letters, digits, underscore, hyphen'] },
          });
        }
        if (targetSiteId === ctx.siteId) {
          return problem({
            type: ProblemType.ValidationFailed,
            title: 'validation failed',
            status: 400,
            code: 'same_site',
            detail: 'the machine is already on this site.',
          });
        }

        const db = getAdminDb();
        const machineRef = db.collection('sites').doc(ctx.siteId).collection('machines').doc(machineId);
        const machineSnap = await machineRef.get();
        if (!machineSnap.exists) {
          return problem({
            type: ProblemType.NotFound,
            title: 'machine not found',
            status: 404,
            code: 'machine_not_found',
            detail: `machine ${machineId} not found on site ${ctx.siteId}`,
          });
        }
        const machine = machineSnap.data() ?? {};
        const name =
          typeof machine.name === 'string'
            ? machine.name
            : typeof machine.machine_name === 'string'
              ? machine.machine_name
              : machineId;

        let targetSiteData: Record<string, unknown> | null;
        try {
          ({ siteData: targetSiteData } = await assertUserHasSiteCapability(
            ctx.actor.userId,
            targetSiteId,
            Capability.MACHINE_ENROLL,
          ));
        } catch (err) {
          if (!(err instanceof ApiAuthError)) throw err;
          return err.status === 404
            ? problemNotFound('target site not found')
            : problemForbidden('you may not add machines to the target site.');
        }
        const targetName = typeof targetSiteData?.name === 'string' ? targetSiteData.name : targetSiteId;

        const targetMachine = await db.collection('sites').doc(targetSiteId).collection('machines').doc(machineId).get();
        if (targetMachine.exists) return conflict('machine_exists', MOVE_EXISTS(targetName, machineId));

        const existing = await readMove(db, ctx.siteId, machineId);
        if (existing) return answerExistingMove(existing, targetSiteId, name);

        if (await moveRefusal(db, { sourceSiteId: ctx.siteId, machineId })) {
          return conflict('machine_busy', MOVE_BUSY(name));
        }

        // the raw doc is snake_case; the gate takes the dashboard's names
        if (!canFollowMove({ agentVersion: machine.agent_version, capabilities: machine.capabilities })) {
          const version = typeof machine.agent_version === 'string' ? machine.agent_version : 'unknown';
          return conflict('agent_too_old', MOVE_TOO_OLD(name, version, SITE_MOVE_MIN_AGENT_VERSION));
        }

        const limit = await machineLimitRefusal(targetSiteId, machineId, targetSiteData);
        if (limit) return problemPlanRequired(limit, 'owlette.machines');

        const ref = moveRef(db, ctx.siteId, machineId);
        const requestedAt = Date.now();
        const move: MachineMove = {
          moveId: ref.id,
          sourceSiteId: ctx.siteId,
          targetSiteId,
          machineId,
          status: 'pending',
          requestedBy: ctx.actor.userId,
          requestedAt,
          expiresAt: requestedAt + MOVE_PENDING_TTL_MS,
        };
        const auditActor = siteAuditActor(ctx);
        const commandId = `cmd_site_move_${machineId.replace(/-/g, '_')}_${requestedAt}`;
        const command = stampCommand(
          {
            type: 'site_move',
            moveId: move.moveId,
            siteId: ctx.siteId,
            status: 'pending',
            queuedBy: auditActor,
            // the field the agent's hourly stale-command sweep reads
            timestamp: FieldValue.serverTimestamp(),
          },
          { auditCorrelationId: ctx.correlationId },
        );

        const batch = db.batch();
        // create, not set: a move another request stored since the read above wins
        batch.create(ref, move);
        batch.set(machineRef.collection('commands').doc('pending'), { [commandId]: command }, { merge: true });
        try {
          await batch.commit();
        } catch (err) {
          const raced = await readMove(db, ctx.siteId, machineId);
          if (!raced) throw err;
          return answerExistingMove(raced, targetSiteId, name);
        }

        emitMoveRows('machine.move_request', 'POST', auditActor, move);
        return moveBody(move, 202);
      },
      { requireKey: true },
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/machines/[machineId]/move:POST');
  }
});

export const DELETE = moveHandler(async (request: NextRequest, ctx, routeContext) => {
  try {
    const keyRefusal = refuseApiKey(ctx);
    if (keyRefusal) return keyRefusal;

    const { machineId } = await routeContext.params;
    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    return await withIdempotency(
      request,
      { userId: ctx.actor.userId, environment: 'unknown' },
      parsed.raw,
      async () => {
        const result = await cancelMove(getAdminDb(), ctx.siteId, machineId);
        if (result.outcome === 'missing') return problemNotFound(`machine ${machineId} has no move to cancel`);
        if (result.outcome === 'switching') {
          return conflict('move_switching', 'the machine is switching sites now. remove it to end the move.');
        }

        const { move } = result;
        emitMoveRows('machine.move_cancel', 'DELETE', siteAuditActor(ctx), move);
        return NextResponse.json({
          ok: true,
          data: { moveId: move.moveId, status: 'cancelled', targetSiteId: move.targetSiteId },
        });
      },
      { requireKey: true },
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/machines/[machineId]/move:DELETE');
  }
});
