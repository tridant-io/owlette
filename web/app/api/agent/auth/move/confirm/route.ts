/**
 * POST /api/agent/auth/move/confirm — the agent says it arrived on the site it
 * was moved to. only now is the source cleaned, exactly as remove machine
 * cleans it: cleaned before the agent had switched, its old config doc would
 * vanish under it and #326 removal detection would unpair it.
 *
 * auth: `Authorization: Bearer <agent ID token of the TARGET site>`, read
 * through `agentClaims`. body `{ machineId, moveId }`. the token's
 * `machine_id` must be `machineId`, and the move must be that machine's, with
 * the token's `site_id` as its target and its status `switching`.
 *
 * 200 `{ moveId, sourceSiteId, targetSiteId, machineId }`: the source is
 * clean, the pairing is recorded on the target, the move is gone.
 * 404 `move_not_found`: the agent reads it as done. a lost 200, a cancel,
 * removing the machine from the source and deleting either site all end here.
 * 400 bad body, 401 not an agent ID token, 403 `machine_mismatch` or
 * `wrong_site`, 409 `move_not_switching`: the agent retries on its next connect.
 *
 * the move is deleted in removeMachineData's one commit with the source
 * machine doc, so a failed cleanup leaves it switching for the retry. the
 * source's agent auth user stays, as remove machine leaves it. no token is
 * logged or audited.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { removeMachineData } from '@/lib/actions/removeMachine.server';
import { deleteScreenshotsBestEffort } from '@/lib/screenshotStorage.server';
import { agentClaims } from '@/lib/agentAuth.server';
import { apiError } from '@/lib/apiErrorResponse';
import { problem, problemUnauthorized, problemValidation, ProblemType } from '@/lib/apiErrors';
import { emitMutation } from '@/lib/auditLogClient';
import { siteStanding, type UserActor } from '@/lib/capabilities';
import { getAdminDb } from '@/lib/firebase-admin';
import { readMoveById } from '@/lib/machineMoves.server';
import { recordPairing } from '@/lib/pairingPlan.server';
import { resolveSiteAccess, standingOf } from '@/lib/sitePolicy.server';
import { withRateLimit } from '@/lib/withRateLimit';

const ENDPOINT = 'agent/auth/move/confirm';

const REFUSALS = {
  403: { type: ProblemType.Forbidden, title: 'forbidden' },
  404: { type: ProblemType.NotFound, title: 'not found' },
  409: { type: ProblemType.Conflict, title: 'conflict' },
} as const;

function refused(status: keyof typeof REFUSALS, code: string, detail: string): NextResponse {
  return problem({ ...REFUSALS[status], status, detail, code });
}

export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      const agent = await agentClaims(request);
      if (!agent) return problemUnauthorized('agent token required');

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return problemValidation('body must be JSON: { machineId, moveId }');
      }
      const { machineId, moveId } = (body ?? {}) as Record<string, unknown>;
      if (typeof machineId !== 'string' || !machineId || typeof moveId !== 'string' || !moveId) {
        return problemValidation('machineId and moveId are required');
      }
      if (agent.machineId !== machineId) {
        return refused(403, 'machine_mismatch', 'the token is for another machine');
      }

      const db = getAdminDb();
      const move = await readMoveById(db, moveId);
      if (!move) return refused(404, 'move_not_found', 'no move to confirm');
      if (move.machineId !== machineId) {
        return refused(403, 'machine_mismatch', 'the move is of another machine');
      }
      // the source's token still verifies: only the target may confirm the arrival
      if (move.targetSiteId !== agent.siteId) {
        return refused(403, 'wrong_site', 'the token is not for the site the machine moves to');
      }
      if (move.status !== 'switching') {
        return refused(409, 'move_not_switching', 'the machine has not fetched its new site credentials');
      }

      // labels the swoop sessions the cleanup ends. the requester may have left
      // the source or been deleted since, so the standing is recorded, never gated on.
      const { facts } = await resolveSiteAccess(move.requestedBy, move.sourceSiteId, db);
      const actor: UserActor = {
        type: 'user',
        userId: move.requestedBy,
        role: facts.globalRole,
        ...siteStanding([[move.sourceSiteId, standingOf(facts)]]),
      };

      await removeMachineData({ siteId: move.sourceSiteId, machineId, actor, db });
      await recordPairing(move.targetSiteId, machineId);

      const attributes = {
        endpoint: ENDPOINT,
        method: 'POST',
        machineId,
        moveId: move.moveId,
        sourceSiteId: move.sourceSiteId,
        targetSiteId: move.targetSiteId,
      };
      const rows = [
        [move.sourceSiteId, 'machine.move_out'],
        [move.targetSiteId, 'machine.move_in'],
        ['', 'machine.move'],
      ] as const;
      for (const [siteId, verb] of rows) {
        emitMutation({
          kind: 'site_mutated',
          siteId,
          actor: `user:${move.requestedBy}`,
          targetId: machineId,
          attributes: { verb, ...attributes },
        });
      }
      // its screenshots stay with the site it left. last, as that delete has no bound,
      // and awaited, so the answer means they are gone
      await deleteScreenshotsBestEffort(move.sourceSiteId, machineId, 'moveConfirm', db);

      return NextResponse.json({
        moveId: move.moveId,
        sourceSiteId: move.sourceSiteId,
        targetSiteId: move.targetSiteId,
        machineId,
      });
    } catch (error: unknown) {
      return apiError(error, ENDPOINT);
    }
  },
  { strategy: 'tokenRefresh', identifier: 'ip' },
);
