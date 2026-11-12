/**
 * POST /api/roosts/{roostId}/deploy
 *
 * input:  {
 *   siteId: string,
 *   versionId?: string,          // default: current version
 *   machines?: string[],         // default: roost.targets
 *   scheduleAt?: string,         // iso8601 — >60s out parks the rollout at stage
 *                                // 'scheduled' for functions/src/rolloutScheduler.ts
 *   dryRun?: boolean,
 * }
 * output: {
 *   rolloutId: string,           // = versionId (keyed by version per existing arch)
 *   versionId, siteId, roostId,
 *   stage: 'canary' | 'scheduled',
 *   canary: string[], fleet: string[],
 *   extractRoot: string,
 *   versionUrl: string,
 *   alreadyRunning?: boolean,    // idempotent re-trigger hit
 *   dryRun?: boolean,
 *   scheduled?: { at: string, warning: string },
 * }
 *
 * 202 Accepted once queued. The optional `Idempotency-Key` header returns the
 * cached shape when a rollout for the same versionId exists — per-version
 * idempotency comes free from the rollout doc key.
 *
 * A `scheduled` rollout is stored with its canary/fleet split, versionUrl and
 * extractRoot already resolved; `sweepScheduledRollouts`
 * (functions/src/rolloutScheduler.ts) flips it to `canary` and queues the same
 * `sync_pull` commands this route would have queued immediately.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problem,
  problemFromError,
} from '@/lib/apiErrors';
import { deployRoost, RoostProblem } from '@/lib/actions/deployRoost.server';
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

interface DeployBody {
  siteId?: unknown;
  versionId?: unknown;
  machines?: unknown;
  scheduleAt?: unknown;
  dryRun?: unknown;
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
    const body = parsed.body as DeployBody;

    const site = validateSiteIdBody(body.siteId);
    if (!site.ok) return site.response;

    const auth = await requireRoostAuthAndScope(request, site.siteId, roostId, 'deploy');
    if (!auth.ok) return auth.response;

    const gateRes = await gateOrProceed(site.siteId, readSiteDocForGate);
    if (gateRes) return gateRes;

    const idem = await checkIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
    );
    if (idem.mode === 'invalid' || idem.mode === 'replay' || idem.mode === 'mismatch') {
      return idem.response;
    }

    let result;
    try {
      result = await deployRoost(
        { siteId: site.siteId, auditActor: auditActorIdentifier(auth.auth) },
        {
          roostId,
          versionId: body.versionId,
          machines: body.machines,
          scheduleAt: body.scheduleAt,
          dryRun: body.dryRun,
          requestedBy: auth.userId,
          endpoint: request.nextUrl.pathname,
          method: request.method,
        },
      );
    } catch (err) {
      if (err instanceof RoostProblem) return problem(err.details);
      throw err;
    }

    const response = applyAuthDeprecations(
      NextResponse.json(result.body, { status: result.status }),
      auth.scopeCheck,
    );
    if (result.outcome === 'queued' && idem.mode === 'proceed') await saveIdempotency(idem.token, response);
    return response;
  } catch (err) {
    return problemFromError(err, 'v2/roosts/[roostId]/deploy:POST');
  }
}
