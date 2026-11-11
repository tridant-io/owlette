/**
 * POST /api/agent/fleet/session — mint the fleet session a granted machine's
 * local MCP script presents on the other `/api/agent/fleet/*` routes (ADR 0017).
 *
 * the caller is the agent with its own ID token. the site and machine come
 * from that token's claims, never from the body, so a machine only ever mints
 * a session for itself; a user's ID token, a session cookie or an api key is
 * refused.
 *
 * a valid ID token is not proof the machine is still paired, so the pairing is
 * re-checked against what the refresh route reads: the machine must still hold an
 * `agent_refresh_tokens` row that route would accept (not `isTokenDead`), and
 * its machine row must still exist. revoking its agent tokens and removing the
 * machine both delete those rows, so either stops new sessions at once.
 *
 * 200 `{ token, expiresAt, ttlSeconds }`, `expiresAt` in epoch seconds, no-store.
 * 401 `unauthorized`: not an agent ID token. 429 `rate_limited` with
 * `Retry-After`: this machine's `fleetSessionRateLimit` is spent. 401
 * `pairing_revoked`: no live agent token or no machine row. 403
 * `fleet_not_granted`: the site has the feature off or this machine is not a
 * sender.
 *
 * rate limited per machine once the claims name it, not per ip: every machine
 * at a site shares the site's NAT address, and the agent calls this every 10
 * minutes whether or not it is granted. as for the agent's screenshot and
 * issue-log upload urls, an unauthenticated flood is bounded by the 401, which
 * only verifies a JWT and reads no document.
 *
 * the token is never logged, audited or put in an error.
 */

import { NextResponse, type NextRequest } from 'next/server';
import type { Firestore } from 'firebase-admin/firestore';
import { machineAuditActor } from '@/lib/actions/auditActor.server';
import { agentClaims } from '@/lib/agentAuth.server';
import { isTokenDead } from '@/lib/agentTokens';
import { apiError } from '@/lib/apiErrorResponse';
import { problem, problemUnauthorized, ProblemType } from '@/lib/apiErrors';
import { emitMutation } from '@/lib/auditLogClient';
import { getAdminDb } from '@/lib/firebase-admin';
import { fleetGrantFor, loadFleetSettings } from '@/lib/fleet/policy.server';
import { FLEET_SESSION_TTL_MS, mintFleetSession } from '@/lib/fleet/session.server';
import { checkRateLimit, fleetSessionRateLimit } from '@/lib/rateLimit';
import { applyRateLimitCounters, rateLimitedResponse } from '@/lib/withRateLimit';

async function pairingIsLive(db: Firestore, siteId: string, machineId: string): Promise<boolean> {
  const [tokens, machine] = await Promise.all([
    db.collection('agent_refresh_tokens')
      .where('siteId', '==', siteId)
      .where('machineId', '==', machineId)
      .get(),
    db.collection('sites').doc(siteId).collection('machines').doc(machineId).get(),
  ]);
  if (!machine.exists) return false;
  const now = Date.now();
  return tokens.docs.some((doc) => !isTokenDead(doc.data(), now));
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const agent = await agentClaims(request);
    if (!agent) return problemUnauthorized('agent token required');
    const { siteId, machineId } = agent;

    const rateLimitKey = `fleet_session:${siteId}:${machineId}`;
    const rateResult = await checkRateLimit(fleetSessionRateLimit, rateLimitKey);
    if (!rateResult.success) {
      console.warn(`[agent/fleet/session] rate limited: ${rateLimitKey}`);
      return rateLimitedResponse(rateResult, 'endpoint-rate');
    }

    const db = getAdminDb();
    if (!(await pairingIsLive(db, siteId, machineId))) {
      return problem({
        type: ProblemType.Unauthorized,
        title: 'unauthorized',
        status: 401,
        detail: 'this machine is no longer paired to its site',
        code: 'pairing_revoked',
      });
    }

    const settings = await loadFleetSettings(siteId, { db });
    if (!fleetGrantFor(settings, machineId)) {
      return problem({
        type: ProblemType.Forbidden,
        title: 'forbidden',
        status: 403,
        detail: 'this machine has no grant to act on machines in its site',
        code: 'fleet_not_granted',
      });
    }

    const { token, expiresAt } = await mintFleetSession(db, { siteId, machineId });

    emitMutation({
      kind: 'site_mutated',
      siteId,
      actor: machineAuditActor(machineId),
      targetId: machineId,
      attributes: {
        verb: 'fleet_session_minted',
        endpoint: 'agent/fleet/session',
        method: 'POST',
        machineId,
      },
    });

    return applyRateLimitCounters(
      NextResponse.json(
        {
          token,
          // floored, so the client never thinks a session outlives the stored one
          expiresAt: Math.floor(expiresAt / 1000),
          ttlSeconds: FLEET_SESSION_TTL_MS / 1000,
        },
        { headers: { 'Cache-Control': 'no-store' } },
      ),
      rateResult,
    );
  } catch (error: unknown) {
    return apiError(error, 'agent/fleet/session');
  }
}
