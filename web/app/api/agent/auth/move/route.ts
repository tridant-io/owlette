/**
 * POST /api/agent/auth/move — a machine that is moving fetches its new site's
 * credentials with the refresh token it holds for the old one.
 *
 * Body: { refreshToken, machineId, moveId }.
 * 200 { accessToken, refreshToken, expiresIn: 3600, siteId } for the target site,
 * the shape a deferred device-code mint answers with · 400 missing fields · 401
 * refresh token unknown, expired or retired · 403 machineId is not the token's ·
 * 404 no such move for this token's site and machine, or its target site is gone
 * · 409 the target already has a machine with this id · 410 the pending move
 * lapsed · 402 the target's plan has no room · 429 rate limited. a refusal is
 * `{ error }`.
 *
 * 401 and 403 come only where refresh gives them: a fielded agent reads either on
 * an auth route as a dead credential, so a move that is not the caller's answers
 * 404. the source token is left alone; the source is cleaned when the agent
 * confirms from the target. a retry mints anew and deletes the target token the
 * last call minted, so a move holds one.
 *
 * a 409 or 402 is the target turning the move away for good: a pending move is
 * dropped with its `site_move` command, so the dashboard stops waiting on it and
 * asking again gives the refusal at once. a switching move is kept for its confirm.
 */

import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import { mintAgentIdToken, newRefreshToken } from '@/lib/agentCredentials.server';
import { isTokenDead } from '@/lib/agentTokens';
import { apiError } from '@/lib/apiErrorResponse';
import { emitMutation } from '@/lib/auditLogClient';
import { pruneMachineFromFleet } from '@/lib/fleet/cleanup.server';
import logger from '@/lib/logger';
import { MOVE_EXISTS } from '@/lib/machineMove';
import {
  dropRefusedMove,
  moveExpired,
  moveRef,
  readMoveById,
  type MachineMove,
} from '@/lib/machineMoves.server';
import { pruneMachineFromMembers } from '@/lib/membership.server';
import { ensureAgentAuthUser, machineLimitRefusal, machineOnSite } from '@/lib/pairingPlan.server';
import { withRateLimit } from '@/lib/withRateLimit';

const ENDPOINT = '/api/agent/auth/move';
const NO_MOVE = 'no move for this machine';
const MOVE_LAPSED = 'this move lapsed. ask for it again from the dashboard.';

type MintOutcome = { error: string; status: number; refused?: 'machine_exists' } | { remint: boolean };

function refusal(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

/**
 * the target turned the move away for good: drop it, and say why on the source
 * and the platform. best effort, since the agent stops on the 409 or 402 either
 * way and a move left pending lapses on its own.
 */
async function refuseMove(
  db: Firestore,
  move: MachineMove,
  reason: 'machine_exists' | 'plan_required',
  error: string,
  status: number,
): Promise<NextResponse> {
  try {
    const dropped = await dropRefusedMove(db, move.sourceSiteId, move.machineId, move.targetSiteId);
    if (dropped) {
      for (const siteId of [dropped.sourceSiteId, '']) {
        emitMutation({
          kind: 'site_mutated',
          siteId,
          actor: `user:${dropped.requestedBy}`,
          targetId: dropped.machineId,
          attributes: {
            verb: 'machine.move_refused',
            endpoint: ENDPOINT,
            method: 'POST',
            moveId: dropped.moveId,
            sourceSiteId: dropped.sourceSiteId,
            targetSiteId: dropped.targetSiteId,
            machineId: dropped.machineId,
            reason,
          },
        });
      }
    }
  } catch (err) {
    logger.warn('agent/auth/move: refused move not dropped (non-fatal)', {
      context: 'agent/auth/move',
      data: { moveId: move.moveId, reason, err: err instanceof Error ? err.message : String(err) },
    });
  }
  return refusal(error, status);
}

export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const body = await request.json().catch(() => null);
    const { refreshToken, machineId, moveId } = (body ?? {}) as Record<string, unknown>;
    if (
      typeof refreshToken !== 'string' || !refreshToken ||
      typeof machineId !== 'string' || !machineId ||
      typeof moveId !== 'string' || !moveId
    ) {
      return refusal('Missing required fields: refreshToken, machineId, moveId', 400);
    }

    const adminDb = getAdminDb();
    const tokens = adminDb.collection('agent_refresh_tokens');

    // the refresh route's checks, read only: this call neither rotates nor retires it
    const presentedHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const tokenSnap = await tokens.doc(presentedHash).get();
    const token = tokenSnap.data();
    if (!token || isTokenDead(token, Date.now())) {
      return refusal('Invalid refresh token', 401);
    }
    if (token.machineId !== machineId) {
      return refusal('Machine ID mismatch. Token may be compromised.', 403);
    }
    const { siteId: tokenSiteId, version } = token;
    if (!tokenSiteId || !version || !token.agentUid || !token.createdBy) {
      return refusal('Invalid refresh token data', 401);
    }

    const move = await readMoveById(adminDb, moveId);
    if (!move || move.sourceSiteId !== tokenSiteId || move.machineId !== machineId) {
      return refusal(NO_MOVE, 404);
    }
    if (moveExpired(move)) {
      return refusal(MOVE_LAPSED, 410);
    }

    const { targetSiteId } = move;
    const targetSite = adminDb.collection('sites').doc(targetSiteId);
    const [site, targetMachine] = await Promise.all([
      targetSite.get(),
      targetSite.collection('machines').doc(machineId).get(),
    ]);
    if (!site.exists) {
      return refusal(NO_MOVE, 404);
    }
    const siteData = site.data();
    const siteName = typeof siteData?.name === 'string' && siteData.name ? siteData.name : targetSiteId;
    // checked before the mint so a refusal touches no auth user, and again in the transaction
    if (targetMachine.exists) {
      return refuseMove(adminDb, move, 'machine_exists', MOVE_EXISTS(siteName, machineId), 409);
    }
    const limit = await machineLimitRefusal(targetSiteId, machineId, siteData);
    if (limit) {
      return refuseMove(adminDb, move, 'plan_required', limit, 402);
    }

    // the target has no machine with this id, so any scope or fleet grant naming it is
    // left from an earlier machine of that name: recordPairing prunes them only for a
    // machine doc it does not find, and by the confirm the agent has written one.
    // before the mint, a failure strands nothing and the agent asks again.
    await pruneMachineFromMembers({ siteId: targetSiteId, machineId });
    await pruneMachineFromFleet({ siteId: targetSiteId, machineId });

    const agentUid = `agent_${targetSiteId}_${machineId}`.replace(/[^a-zA-Z0-9_]/g, '_');
    await ensureAgentAuthUser(getAdminAuth(), agentUid);
    const accessToken = await mintAgentIdToken(agentUid, {
      role: 'agent',
      site_id: targetSiteId,
      machine_id: machineId,
      version,
    });
    const minted = newRefreshToken();

    const ref = moveRef(adminDb, move.sourceSiteId, machineId);
    const result = await adminDb.runTransaction(async (transaction): Promise<MintOutcome> => {
      // the move may have been cancelled, or asked for again elsewhere, while it minted
      const current = (await transaction.get(ref)).data();
      if (!current || current.targetSiteId !== targetSiteId) {
        return { error: NO_MOVE, status: 404 };
      }
      if (moveExpired({ status: current.status, expiresAt: current.expiresAt })) {
        return { error: MOVE_LAPSED, status: 410 };
      }
      if (await machineOnSite(transaction, targetSiteId, machineId)) {
        return { error: MOVE_EXISTS(siteName, machineId), status: 409, refused: 'machine_exists' };
      }

      const previous: string = typeof current.mintedTokenHash === 'string' ? current.mintedTokenHash : '';
      transaction.set(tokens.doc(minted.refreshTokenHash), {
        siteId: targetSiteId,
        machineId,
        version,
        createdBy: move.requestedBy,
        createdAt: FieldValue.serverTimestamp(),
        lastUsed: FieldValue.serverTimestamp(),
        agentUid,
      });
      transaction.update(ref, { status: 'switching', mintedTokenHash: minted.refreshTokenHash });
      if (previous) {
        transaction.delete(tokens.doc(previous));
      }
      return { remint: previous !== '' };
    });

    if ('error' in result) {
      return result.refused
        ? refuseMove(adminDb, move, result.refused, result.error, result.status)
        : refusal(result.error, result.status);
    }

    emitMutation({
      kind: 'site_mutated',
      siteId: targetSiteId,
      actor: `user:${move.requestedBy}`,
      targetId: machineId,
      attributes: {
        verb: 'machine.move_mint',
        endpoint: ENDPOINT,
        method: 'POST',
        siteId: targetSiteId,
        sourceSiteId: move.sourceSiteId,
        machineId,
        moveId: move.moveId,
        remint: result.remint,
      },
    });

    logger.info(
      `move credentials minted: source=${move.sourceSiteId}, target=${targetSiteId}, ` +
        `machine=${machineId}, remint=${result.remint}`,
    );

    return NextResponse.json(
      {
        accessToken,
        refreshToken: minted.refreshToken,
        expiresIn: 3600,
        siteId: targetSiteId,
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    return apiError(error, 'agent/auth/move');
  }
}, {
  strategy: 'tokenRefresh',
  identifier: 'ip',
});
