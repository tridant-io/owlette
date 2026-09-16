/**
 * POST /api/roosts/{roostId}/resync — { siteId } → { resynced, targets }.
 * Force every current target to re-pull the current version: operator retry
 * after a sync failure, or resetting hand-edited drift.
 *
 * Not routed through `onRoostWritten`: that trigger is idempotent per
 * `rollouts/{versionId}` and only fires on `currentVersionId` changes, so it
 * can't re-fire the same version. A resync is also the deliberate retry-all
 * lane — skipping canary→fleet staging is the point.
 *
 * One atomic BulkWriter commit: delete `target_state/{machineId}` (so the UI
 * drops the stale "failed" pill), delete `rollouts/{currentVersionId}` (so old
 * canary state can't shadow the resync), and queue a fresh `sync_pull` with a
 * unique cmdId — the agent dedupes by cmdId, so the original id would be
 * skipped on replay.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problem,
  problemFromError,
  ProblemType,
} from '@/lib/apiErrors';
import { emitMutation } from '@/lib/auditLogClient';
import { getAdminDb } from '@/lib/firebase-admin';
import { gateOrProceed } from '@/lib/roostKillSwitch';
import { FieldValue } from 'firebase-admin/firestore';
import {
  auditActorIdentifier,
  applyAuthDeprecations,
  parseJsonBody,
  requireRoostAuthAndScope,
  validateResourceId,
  validateSiteIdBody,
} from '../../../_shared';

// Must match the windows entry of the agent's destination_allowlist
// `default_roots()` and the cloud function's DEFAULT_EXTRACT_ROOT — same
// literal, so `~` expands identically.
const DEFAULT_EXTRACT_ROOT = '~/Documents/Owlette';

interface RouteParams {
  params: Promise<{ roostId: string }>;
}

async function readSiteDocForGate(siteId: string): Promise<Record<string, unknown> | null> {
  const snap = await getAdminDb().collection('sites').doc(siteId).get();
  return snap.exists ? (snap.data() ?? null) : null;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { roostId } = await params;
    const roostError = validateResourceId(roostId, 'roostId');
    if (roostError) return roostError;

    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as { siteId?: unknown };

    const site = validateSiteIdBody(body.siteId);
    if (!site.ok) return site.response;

    const auth = await requireRoostAuthAndScope(request, site.siteId, roostId, 'deploy');
    if (!auth.ok) return auth.response;

    const gateRes = await gateOrProceed(site.siteId, readSiteDocForGate);
    if (gateRes) return gateRes;

    const db = getAdminDb();
    const roostRef = db
      .collection('sites')
      .doc(site.siteId)
      .collection('roosts')
      .doc(roostId);

    const snap = await roostRef.get();
    if (!snap.exists) {
      return problem({
        type: ProblemType.NotFound,
        title: 'not found',
        status: 404,
        detail: `roost ${roostId} not found on site ${site.siteId}`,
        instance: `/api/roosts/${roostId}/resync`,
      });
    }
    const data = snap.data() ?? {};
    const versionId = (data.currentVersionId as string | undefined) ?? null;
    const versionUrl = (data.versionUrl as string | undefined) ?? null;
    const targets = Array.isArray(data.targets) ? (data.targets as string[]) : [];
    const extractRoot =
      typeof data.extractPath === 'string' && data.extractPath.trim()
        ? data.extractPath.trim()
        : DEFAULT_EXTRACT_ROOT;

    if (!versionId || !versionUrl) {
      return problem({
        type: ProblemType.Conflict,
        title: 'nothing to resync',
        status: 409,
        detail:
          'roost has no current version to re-pull. upload a new distribution first.',
        instance: `/api/roosts/${roostId}/resync`,
      });
    }
    if (targets.length === 0) {
      return problem({
        type: ProblemType.Conflict,
        title: 'no targets',
        status: 409,
        detail: 'roost has no targets assigned — nothing to re-sync.',
        instance: `/api/roosts/${roostId}/resync`,
      });
    }

    // One timestamp nonce for the whole resync: same cmdId family everywhere,
    // and unique against the agent's _seen_commands set.
    const nonce = Date.now().toString(36);

    const batch = db.batch();
    for (const machineId of targets) {
      const pendingRef = db
        .collection('sites')
        .doc(site.siteId)
        .collection('machines')
        .doc(machineId)
        .collection('commands')
        .doc('pending');
      const cmdId = `roost_resync_${roostId}_${versionId}_${nonce}`;
      batch.set(
        pendingRef,
        {
          [cmdId]: {
            type: 'sync_pull',
            site_id: site.siteId,
            roost_id: roostId,
            version_id: versionId,
            version_url: versionUrl,
            extract_root: extractRoot,
            queued_at: FieldValue.serverTimestamp(),
            resync: true,
            resync_requested_by: auth.userId,
          },
        },
        { merge: true },
      );

      // Clear stale target_state so the UI resets before the agent's first report.
      const tsRef = roostRef.collection('target_state').doc(machineId);
      batch.delete(tsRef);
    }

    // Drop the prior rollout doc, else the fanout state machine reads resync
    // reports as late arrivals for an aborted wave.
    const rolloutRef = roostRef.collection('rollouts').doc(versionId);
    batch.delete(rolloutRef);

    // Stamps `updatedAt` for audit/UI. Leaves currentVersionId alone, so
    // `onRoostWritten` does not re-fire.
    batch.set(
      roostRef,
      {
        resyncedAt: FieldValue.serverTimestamp(),
        resyncedBy: auth.userId,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    await batch.commit();

    emitMutation({
      kind: 'roost_mutated',
      siteId: site.siteId,
      actor: auditActorIdentifier(auth.auth),
      targetId: roostId,
      attributes: {
        verb: 'resync',
        endpoint: request.nextUrl.pathname,
        method: request.method,
        versionId,
        targetCount: targets.length,
      },
    });

    return applyAuthDeprecations(
      NextResponse.json({ resynced: targets.length, targets }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/roosts/[roostId]/resync');
  }
}
