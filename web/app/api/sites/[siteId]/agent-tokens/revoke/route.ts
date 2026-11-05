import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import type { Firestore, DocumentReference, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { adminDb } from '@/lib/firebase-admin';
import { withRateLimit } from '@/lib/withRateLimit';
import { apiError } from '@/lib/apiErrorResponse';
import logger from '@/lib/logger';
import { isTokenDead, tokenTimestampToMillis } from '@/lib/agentTokens';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import { siteAuditActor } from '@/lib/actions/auditActor.server';
import { emitMutation } from '@/lib/auditLogClient';
import { writeCommandFanOut } from '@/lib/commandLifecycle';

type RouteParams = {
  siteId: string;
} & Record<string, string | undefined>;

/**
 * Deleting the token doc is invisible to a live agent until its next refresh,
 * up to an hour away (#327): the `unpair` command is what reaches it now. The
 * agent confirms with the server before acting, so a stale command is harmless.
 * Never fatal — the tokens are already gone — and `writeCommandFanOut`
 * isolates each machine's write, so one failure cannot hide another's.
 */
async function queueUnpair(
  db: Firestore,
  siteId: string,
  machineIds: Iterable<string>,
  queuedBy: string,
  auditCorrelationId: string,
): Promise<void> {
  const ids = [...new Set(machineIds)].filter((id) => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) return;
  const results = await writeCommandFanOut(
    siteId,
    ids,
    'cmd_unpair',
    // `timestamp` is the field the agent's hourly stale-command sweep reads.
    { type: 'unpair', siteId, status: 'pending', queuedBy, timestamp: FieldValue.serverTimestamp() },
    { db, auditCorrelationId },
  );
  for (const result of results) {
    if (!result.ok) {
      logger.warn(
        `Revoke: unpair command not queued for machine ${result.machineId} in site ${siteId}: ${result.error}`,
      );
    }
  }
}

/**
 * Chunked deletes — a write batch caps at 500 ops and revoke-all/prune can
 * exceed that on sites with thousands of dead token docs. 450 leaves headroom.
 */
async function deleteRefsInChunks(
  db: Firestore,
  refs: DocumentReference[],
): Promise<number> {
  const CHUNK_SIZE = 450;
  for (let i = 0; i < refs.length; i += CHUNK_SIZE) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + CHUNK_SIZE)) {
      batch.delete(ref);
    }
    await batch.commit();
  }
  return refs.length;
}

/**
 * POST /api/sites/{siteId}/agent-tokens/revoke — revoke agent refresh tokens
 * by site, machine or token id, or prune only provably-dead docs.
 *
 * Site-scoped AGENT_TOKEN_REVOKE: site admins on their assigned sites,
 * superadmins anywhere. Every branch filters on ctx.siteId (and the tokenId
 * branch re-checks the doc's siteId), so an admin can never reach another
 * site's tokens. Not GLOBAL_SETTINGS_WRITE — that was inherited from the old
 * /api/admin/tokens/revoke path and 403'd the dashboard's own menu item.
 */
export const POST = withRateLimit(authorizedSiteHandler<RouteParams>({
  capability: 'AGENT_TOKEN_REVOKE',
  siteIdParam: 'path',
})(async (request: NextRequest, ctx) => {
  try {
    const body = await request.json();
    const { tokenId, machineId, all, prune, latestOnly } = body;
    const siteId = ctx.siteId;

    // Exactly one primary mode; latestOnly is a MODIFIER of machineId. Rejecting
    // it standalone or mixed with a bulk mode stops a precise request falling
    // through to a broader all/prune delete on branch ordering.
    const modeCount = [tokenId, machineId, all, prune].filter(Boolean).length;
    if (modeCount === 0) {
      return NextResponse.json(
        { error: 'Must specify tokenId, machineId, all: true, or prune: true' },
        { status: 400 },
      );
    }
    if (modeCount > 1) {
      return NextResponse.json(
        { error: 'Specify exactly one of tokenId, machineId, all, or prune' },
        { status: 400 },
      );
    }
    if (latestOnly && !machineId) {
      return NextResponse.json(
        { error: 'latestOnly is only valid together with machineId' },
        { status: 400 },
      );
    }

    const db = adminDb.value;
    let revokedCount = 0;

    // `agent_refresh_tokens` doc ids ARE the refresh-token hash, so the audit
    // records the mode, machine and count — never the token id.
    const auditActor = siteAuditActor(ctx);
    const emitRevoked = (
      mode: 'prune' | 'all' | 'token' | 'machine' | 'machine-latest',
      count: number,
      revokedMachineId?: string,
    ) =>
      emitMutation({
        kind: 'site_mutated',
        siteId,
        actor: auditActor,
        targetId: revokedMachineId ?? siteId,
        attributes: {
          verb: 'agent_token.revoke',
          endpoint: 'agent-tokens/revoke',
          method: 'POST',
          mode,
          revokedCount: count,
          ...(revokedMachineId ? { machineId: revokedMachineId } : {}),
        },
      });

    if (prune) {
      // Only provably-dead docs (superseded past grace, or expired). Live
      // tokens and in-grace rotations are untouched, so this is always safe.
      const tokensSnapshot = await db.collection('agent_refresh_tokens')
        .where('siteId', '==', siteId)
        .get();

      const now = Date.now();
      const deadRefs = tokensSnapshot.docs
        .filter((doc) => isTokenDead(doc.data(), now))
        .map((doc) => doc.ref);

      revokedCount = await deleteRefsInChunks(db, deadRefs);

      logger.info(`Pruned ${revokedCount} dead tokens for site ${siteId}`);
      emitRevoked('prune', revokedCount);

      return NextResponse.json({
        success: true,
        revokedCount,
        message: revokedCount > 0
          ? `Pruned ${revokedCount} dead token(s) for site ${siteId}`
          : `No dead tokens to prune for site ${siteId}`,
      });
    } else if (all) {
      const tokensSnapshot = await db.collection('agent_refresh_tokens')
        .where('siteId', '==', siteId)
        .get();

      revokedCount = await deleteRefsInChunks(
        db,
        tokensSnapshot.docs.map((doc) => doc.ref),
      );
      // Only machines that still had a usable token have an agent to cut off.
      const now = Date.now();
      await queueUnpair(
        db,
        siteId,
        tokensSnapshot.docs
          .filter((doc) => !isTokenDead(doc.data(), now))
          .map((doc) => doc.data().machineId),
        auditActor,
        ctx.correlationId,
      );

      logger.info(`Revoked ${revokedCount} tokens for site ${siteId}`);
      emitRevoked('all', revokedCount);

      return NextResponse.json({
        success: true,
        revokedCount,
        message: `Revoked all ${revokedCount} tokens for site ${siteId}`,
      });
    } else if (tokenId) {
      const tokenRef = db.collection('agent_refresh_tokens').doc(tokenId);
      const tokenDoc = await tokenRef.get();

      if (!tokenDoc.exists) {
        return NextResponse.json({
          success: false,
          revokedCount: 0,
          message: 'Token not found',
        });
      }

      const tokenData = tokenDoc.data();
      if (tokenData?.siteId !== siteId) {
        return NextResponse.json(
          { error: 'Token does not belong to this site' },
          { status: 403 },
        );
      }

      await tokenRef.delete();
      revokedCount = 1;
      await queueUnpair(
        db,
        siteId,
        isTokenDead(tokenData, Date.now()) ? [] : [tokenData?.machineId],
        auditActor,
        ctx.correlationId,
      );

      logger.info(`Revoked token ${tokenId} for site ${siteId}`);
      emitRevoked(
        'token',
        revokedCount,
        typeof tokenData?.machineId === 'string' ? tokenData.machineId : undefined,
      );

      return NextResponse.json({
        success: true,
        revokedCount,
        message: `Revoked token for machine ${tokenData?.machineId || 'unknown'}`,
      });
    } else {
      const tokensSnapshot = await db.collection('agent_refresh_tokens')
        .where('siteId', '==', siteId)
        .where('machineId', '==', machineId)
        .get();

      if (latestOnly) {
        // Delete only the most-recently-used LIVE token — the connected agent's
        // credential. Siblings sharing this hostname (cloned machines, older
        // re-pairs) survive, so revoking one machine can't disconnect another.
        // lastUsed is the key, createdAt only breaks ties — never mix scales.
        const now = Date.now();
        let pick: QueryDocumentSnapshot | null = null;
        let pickLast = -Infinity;
        let pickCreated = -Infinity;
        for (const doc of tokensSnapshot.docs) {
          const data = doc.data();
          if (isTokenDead(data, now)) continue;
          const last = tokenTimestampToMillis(data.lastUsed) ?? 0;
          const created = tokenTimestampToMillis(data.createdAt) ?? 0;
          if (last > pickLast || (last === pickLast && created > pickCreated)) {
            pick = doc;
            pickLast = last;
            pickCreated = created;
          }
        }

        revokedCount = await deleteRefsInChunks(db, pick ? [pick.ref] : []);
        // No live token means no agent to cut off: nothing to queue.
        await queueUnpair(db, siteId, pick ? [machineId] : [], auditActor, ctx.correlationId);

        logger.info(`Revoked ${revokedCount} current token for machine ${machineId} in site ${siteId}`);
        emitRevoked('machine-latest', revokedCount, machineId);

        return NextResponse.json({
          success: true,
          revokedCount,
          message: revokedCount > 0
            ? `Revoked the current token for machine ${machineId}`
            : `No live token found for machine ${machineId}`,
        });
      }

      revokedCount = await deleteRefsInChunks(
        db,
        tokensSnapshot.docs.map((doc) => doc.ref),
      );
      const now = Date.now();
      const hadUsableToken = tokensSnapshot.docs.some((doc) => !isTokenDead(doc.data(), now));
      await queueUnpair(db, siteId, hadUsableToken ? [machineId] : [], auditActor, ctx.correlationId);

      logger.info(`Revoked ${revokedCount} tokens for machine ${machineId} in site ${siteId}`);
      emitRevoked('machine', revokedCount, machineId);

      return NextResponse.json({
        success: true,
        revokedCount,
        message: revokedCount > 0
          ? `Revoked ${revokedCount} token(s) for machine ${machineId}`
          : `No tokens found for machine ${machineId}`,
      });
    }
  } catch (error: unknown) {
    return apiError(error, 'sites/agent-tokens:revoke');
  }
}), {
  strategy: 'api',
  identifier: 'ip',
});
