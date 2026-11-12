/**
 * POST /api/roosts/{roostId}/rollback
 *      in:  { siteId: string, targetVersion?: string | number }
 *      out: { ok, roostId, siteId, currentVersionId, currentVersionNumber, previousVersionId }
 *
 * Flips `currentVersionId` to an already-published version. Mints NO new
 * version — versions are immutable, a rollback is a pointer change.
 *
 * `targetVersion` takes any form `web/lib/resolveVersion.ts` accepts (alias
 * 'current'|'previous'|'first', stable id 'vrs_<hex>', number 3/'3'/'#3'/'v3').
 * Defaults to 'previous' — one-click "undo last publish".
 *
 * Auth: scope `rollback` (`web/lib/apiKeyTypes.ts`), distinct from write so an
 * operator key can roll back without being able to push.
 *
 * Dispatch: the pointer flip must NOT let the fan-out trigger replay its
 * deterministic `roost_sync_{roostId}_{versionId}` command id, so the route
 * keeps/creates `rollouts/{targetVersionId}` (making `onRoostWritten` bail) and
 * enqueues nonce'd `sync_pull` commands itself.
 *
 * Webhooks: `version.rolled_back` is QUEUED per subscription after the flip and
 * dispatch land; `functions/src/webhookDispatch.ts` owns delivery and backoff.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problem, problemFromError } from '@/lib/apiErrors';
import { RoostProblem } from '@/lib/actions/deployRoost.server';
import { rollbackRoost } from '@/lib/actions/rollbackRoost.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { gateOrProceed } from '@/lib/roostKillSwitch';
import {
  auditActorIdentifier,
  applyAuthDeprecations,
  readAndParseJsonBody,
  requireRoostAuthAndScope,
  validateResourceId,
  validateSiteIdBody,
} from '../../../_shared';
import { checkIdempotency, saveIdempotency } from '@/lib/idempotency';

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

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as {
      siteId?: unknown;
      targetVersion?: unknown;
    };

    const site = validateSiteIdBody(body.siteId);
    if (!site.ok) return site.response;

    // Scope `rollback`: the operator preset grants it alongside
    // read/write/deploy; a read-only key gets 403 scope_insufficient.
    const auth = await requireRoostAuthAndScope(
      request,
      site.siteId,
      roostId,
      'rollback',
    );
    if (!auth.ok) return auth.response;

    const gateRes = await gateOrProceed(site.siteId, readSiteDocForGate);
    if (gateRes) return gateRes;

    // Idempotency replay (same pattern as the versions PATCH handler): a
    // double-click on a flaky network must not double-flip or fire two waves.
    const idem = await checkIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
    );
    if (idem.mode === 'invalid' || idem.mode === 'mismatch' || idem.mode === 'replay') {
      return idem.response;
    }

    let result;
    try {
      result = await rollbackRoost(
        { siteId: site.siteId, auditActor: auditActorIdentifier(auth.auth) },
        {
          roostId,
          targetVersion: body.targetVersion,
          requestedBy: auth.userId,
          endpoint: request.nextUrl.pathname,
          method: request.method,
        },
      );
    } catch (err) {
      if (err instanceof RoostProblem) return problem(err.details);
      throw err;
    }

    const response = applyAuthDeprecations(NextResponse.json(result), auth.scopeCheck);
    if (idem.mode === 'proceed') await saveIdempotency(idem.token, response);
    return response;
  } catch (err) {
    return problemFromError(err, 'v2/roosts/[roostId]/rollback');
  }
}
