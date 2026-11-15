/**
 * DELETE /api/agent/fleet/grant — a granted machine drops its own grant: the
 * desktop app's hoot mcp switch turns off here, without a person in the
 * dashboard.
 *
 * a machine may only lower its own access (ADR 0017): this route removes the
 * caller's row from `sites/{siteId}/settings/fleet` and can never add, raise
 * or widen anything, so a leaked ID token can only take away what that machine
 * had. the site and machine come from the token's claims, never the body; a
 * user's ID token, a session cookie or an api key is refused.
 *
 * the pairing is re-checked as on the session route (a live agent token and a
 * machine row). after a drop the machine's fleet sessions are revoked and it is
 * told to refresh, both best effort: the grant is read live on every fleet
 * call, so a failed revoke leaves a session that reaches nothing.
 *
 * 200 `{ dropped }`, `false` when the machine had no row (idempotent). 401
 * `unauthorized` or `pairing_revoked`. 429 `rate_limited` with `Retry-After`.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import { machineAuditActor } from '@/lib/actions/auditActor.server';
import { SITE_SETTINGS_REFRESH_COMMAND } from '@/lib/actions/setDisplaySettings.server';
import { agentClaims } from '@/lib/agentAuth.server';
import { apiError } from '@/lib/apiErrorResponse';
import { problem, problemUnauthorized, ProblemType } from '@/lib/apiErrors';
import { emitMutation } from '@/lib/auditLogClient';
import { writeCommandFanOut } from '@/lib/commandLifecycle';
import { getAdminDb } from '@/lib/firebase-admin';
import { own } from '@/lib/fleet/grant';
import { FLEET_SETTINGS_DOC } from '@/lib/fleet/policy.server';
import { machinePairingIsLive, revokeFleetSessions } from '@/lib/fleet/session.server';
import logger from '@/lib/logger';
import { checkRateLimit, fleetGrantRateLimit } from '@/lib/rateLimit';
import { applyRateLimitCounters, rateLimitedResponse } from '@/lib/withRateLimit';

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    const agent = await agentClaims(request);
    if (!agent) return problemUnauthorized('agent token required');
    const { siteId, machineId } = agent;

    const rateLimitKey = `fleet_grant:${siteId}:${machineId}`;
    const rateResult = await checkRateLimit(fleetGrantRateLimit, rateLimitKey);
    if (!rateResult.success) {
      console.warn(`[agent/fleet/grant] rate limited: ${rateLimitKey}`);
      return rateLimitedResponse(rateResult, 'endpoint-rate');
    }

    const db = getAdminDb();
    if (!(await machinePairingIsLive(db, siteId, machineId))) {
      return problem({
        type: ProblemType.Unauthorized,
        title: 'unauthorized',
        status: 401,
        detail: 'this machine is no longer paired to its site',
        code: 'pairing_revoked',
      });
    }

    const ref = db.collection('sites').doc(siteId).collection('settings').doc(FLEET_SETTINGS_DOC);
    const dropped = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const senders = snap.exists ? snap.data()?.senders : undefined;
      if (typeof senders !== 'object' || senders === null || own(senders, machineId) === undefined) return false;
      tx.update(ref, new FieldPath('senders', machineId), FieldValue.delete(), 'updatedAt', FieldValue.serverTimestamp());
      return true;
    });

    if (dropped) {
      try {
        await revokeFleetSessions(db, { siteId, machineId });
      } catch (err) {
        logger.warn('[agent/fleet/grant] could not revoke the fleet sessions of the machine', {
          context: 'agent/fleet/grant',
          data: { siteId, machineId, error: err instanceof Error ? err.message : String(err) },
        });
      }
      const [told] = await writeCommandFanOut(
        siteId,
        [machineId],
        SITE_SETTINGS_REFRESH_COMMAND,
        {
          type: SITE_SETTINGS_REFRESH_COMMAND,
          siteId,
          timestamp: FieldValue.serverTimestamp(),
          status: 'pending',
          queuedBy: machineAuditActor(machineId),
        },
        { db },
      );
      if (!told.ok) {
        logger.warn('[agent/fleet/grant] the machine could not be told to refresh its session', {
          context: 'agent/fleet/grant',
          data: { siteId, machineId },
        });
      }

      emitMutation({
        kind: 'site_mutated',
        siteId,
        actor: machineAuditActor(machineId),
        targetId: machineId,
        attributes: {
          verb: 'fleet_grant_dropped',
          endpoint: 'agent/fleet/grant',
          method: 'DELETE',
          machineId,
        },
      });
    }

    return applyRateLimitCounters(
      NextResponse.json({ dropped }, { headers: { 'Cache-Control': 'no-store' } }),
      rateResult,
    );
  } catch (error: unknown) {
    return apiError(error, 'agent/fleet/grant');
  }
}
