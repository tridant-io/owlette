/**
 * POST /api/sites/{siteId}/machines/{machineId}/swoop/sessions — start a swoop
 * session and hand the browser everything it needs to connect.
 *
 * The response carries the viewer's own JWT and its per-viewer key `k`. It
 * NEVER carries `K_session`, and nothing secret is ever put in a url — the
 * signaling url names a room and nothing else (PROTOCOL.md §11).
 *
 * The two notifications that follow the write — the doorbell ring and the
 * polled Firestore command — carry the opaque `sid` and nothing else, and
 * neither one failing withholds a session the caller is entitled to.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  problem,
  problemFromError,
  problemNotFound,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { applyAuthDeprecations, readAndParseJsonBody } from '@/app/api/_shared';
import { ApiAuthError, assertActiveUser } from '@/lib/apiAuth.server';
import { authorizedSiteHandler, type SiteRouteHandler } from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import logger from '@/lib/logger';
import {
  mfaProofErrorResponse,
  parseMfaProof,
  verifyMfaProof,
} from '@/lib/mfaProof.server';
import {
  evaluateSwoopAccess,
  hasEnrolledFactor,
  hasOpenStepUpWindow,
  openStepUpWindow,
  SWOOP_LEASE_SECONDS,
  SWOOP_SESSION_CAP_SECONDS,
  type SwoopIntent,
} from '@/lib/swoop/policy.server';
import { viewerKeyForResponse } from '@/lib/swoop/keys.server';
import { mintViewerToken, canonicalizeFingerprint } from '@/lib/swoop/tokens.server';
import { mintTurnCredentials, type SwoopIceServer } from '@/lib/swoop/turn.server';
import { ringDoorbell } from '@/lib/swoop/signal.server';
import { createSwoopSession, upsertSwoopViewer } from '@/lib/swoop/sessionStore.server';
import { requestSwoopSession } from '@/lib/actions/requestSwoopSession.server';
import {
  apiKeyRefusal,
  decisionProblem,
  mintSwoopId,
  swoopGate,
  swoopNotConfigured,
  viewerSignalUrl,
  type SwoopRouteParams,
} from '../_shared';

interface SessionBody {
  control?: unknown;
  fp?: unknown;
  clientCaps?: unknown;
  mfaProof?: unknown;
}

/** P2P first (plan.md D13); relays are added only when a mint succeeds. */
const STUN_ONLY: SwoopIceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478'] }];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

type StepUpResult = { ok: true } | { ok: false; response: NextResponse };

/**
 * Run a live second-factor ceremony and open the 10-minute window.
 *
 * A timestamp can never stand in for this: a session born from the 30-day
 * device-trust cookie carries `mfaCompletedAt = now` with no ceremony behind it
 * (`lib/sessionManager.server.ts:219-221`).
 */
async function openStepUpFromProof(args: {
  userId: string;
  binding: string | null;
  proof: unknown;
}): Promise<StepUpResult> {
  if (!args.binding) {
    return {
      ok: false,
      response: decisionProblem({
        ok: false,
        status: 401,
        code: 'step_up_required',
        error: 'sign in again to take control.',
      }),
    };
  }

  const parsed = parseMfaProof(args.proof);
  if (!parsed.ok) return { ok: false, response: mfaProofErrorResponse(parsed) };

  // An account with no enrolled factor cannot have produced a live proof, so a
  // proof that "verifies" for one means the ceremony was bypassed. Refused
  // before the verification rather than after it.
  if (!(await hasEnrolledFactor(args.userId))) {
    return {
      ok: false,
      response: problem({
        type: ProblemType.Unauthorized,
        title: 'step-up required',
        status: 401,
        detail: 'enrol a second factor before taking control of a machine.',
        code: 'step_up_required',
      }),
    };
  }

  const userData = await assertActiveUser(args.userId);
  const outcome = await verifyMfaProof(args.userId, parsed.proof, userData);
  if (!outcome.ok) return { ok: false, response: mfaProofErrorResponse(outcome) };

  await openStepUpWindow({ userId: args.userId, binding: args.binding, proof: outcome });
  return { ok: true };
}

const coreHandler: SiteRouteHandler<SwoopRouteParams> = async (request, ctx, { params }) => {
  try {
    const keyRefusal = apiKeyRefusal(ctx);
    if (keyRefusal) return keyRefusal;

    const { machineId } = await params;
    const siteId = ctx.siteId;
    const userId = ctx.actor.userId;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as SessionBody;

    const fp = canonicalizeFingerprint(body.fp);
    if (!fp) {
      return problemValidation('field `fp` is required', {
        fp: ['the browser dtls fingerprint, as `<hash-func> <HEX:WITH:COLONS>`'],
      });
    }
    if (body.clientCaps !== undefined && !isPlainObject(body.clientCaps)) {
      return problemValidation('field `clientCaps` must be an object', {
        clientCaps: ['expected the result of the browser capability probe'],
      });
    }

    const intent: SwoopIntent = body.control === true ? 'control' : 'view';
    const gate = await swoopGate({ request, ctx, machineId, intent });

    const stepUpOpen =
      intent === 'control' && gate.binding !== null
        ? await hasOpenStepUpWindow({ userId, binding: gate.binding })
        : false;

    let decision = evaluateSwoopAccess({ ...gate.input, stepUpOpen });
    // The one refusal the caller can answer inside this same request: a live
    // ceremony opens the window and the decision is taken again.
    if (!decision.ok && decision.code === 'step_up_required' && body.mfaProof !== undefined) {
      const opened = await openStepUpFromProof({ userId, binding: gate.binding, proof: body.mfaProof });
      if (!opened.ok) return opened.response;
      decision = evaluateSwoopAccess({ ...gate.input, stepUpOpen: true });
    }
    if (!decision.ok) return decisionProblem(decision);

    const signalUrl = viewerSignalUrl(siteId, machineId);
    if (!signalUrl) return swoopNotConfigured();

    // Never ring a machine that has not dialled in: whoever names a room first
    // homes its durable object permanently, so a ring to an absent agent pins
    // the room next to this api's colo forever (spike 0.4 §7).
    const machineSnap = await getAdminDb()
      .collection('sites')
      .doc(siteId)
      .collection('machines')
      .doc(machineId)
      .get();
    if (!machineSnap.exists) return problemNotFound('machine not found');
    if (machineSnap.data()?.online !== true) {
      return problem({
        type: ProblemType.Conflict,
        title: 'machine offline',
        status: 409,
        detail: 'this machine is offline; swoop cannot reach it until it reconnects.',
        code: 'machine_offline',
      });
    }

    const sid = mintSwoopId();
    const viewerId = mintSwoopId();
    const startedAt = Date.now();
    const leaseExpiresAt = startedAt + SWOOP_LEASE_SECONDS * 1000;

    await createSwoopSession({
      siteId,
      machineId,
      sid,
      createdBy: `user:${userId}`,
      startedAt,
      absoluteExpiresAt: startedAt + SWOOP_SESSION_CAP_SECONDS * 1000,
    });
    await upsertSwoopViewer({
      siteId,
      machineId,
      sid,
      viewer: { viewerId, uid: userId, ctl: decision.ctl, joinedAt: startedAt, leaseExpiresAt },
    });

    const viewerToken = mintViewerToken({
      uid: userId,
      site: siteId,
      machine: machineId,
      sid,
      viewer: viewerId,
      ctl: decision.ctl,
      fp,
    });

    const turn = await mintTurnCredentials({ siteId });
    if (!turn.ok) {
      logger.warn('[swoop/sessions] turn mint failed; offering stun only', {
        context: 'swoop/sessions',
        data: { siteId, machineId, reason: turn.reason },
      });
    }

    // Both notifications carry the sid alone, and both are best effort: the
    // ring is the fast path and the queued command is the 2-5 s fallback, so
    // one failing still leaves the other (plan.md D11).
    const [ring, queued] = await Promise.allSettled([
      ringDoorbell({ siteId, machineId, sid }),
      requestSwoopSession({
        type: 'swoop_session_requested',
        sid,
        siteId,
        machineId,
        actor: ctx.actor,
        auditActor: `user:${userId}`,
        correlationId: ctx.correlationId,
      }),
    ]);
    if (ring.status === 'fulfilled' && !ring.value.ok) {
      logger.warn('[swoop/sessions] doorbell ring failed; falling back to the polled command', {
        context: 'swoop/sessions',
        data: { siteId, machineId, reason: ring.value.reason },
      });
    }
    if (queued.status === 'rejected') {
      logger.warn('[swoop/sessions] fallback command could not be queued', {
        context: 'swoop/sessions',
        data: {
          siteId,
          machineId,
          err: queued.reason instanceof Error ? queued.reason.message : String(queued.reason),
        },
      });
    }

    return applyAuthDeprecations(
      NextResponse.json(
        {
          ok: true,
          data: {
            sid,
            viewerId,
            ctl: decision.ctl,
            viewerJwt: viewerToken.token,
            k: viewerKeyForResponse(sid, viewerId),
            iceServers: turn.ok ? turn.iceServers : STUN_ONLY,
            signalUrl,
            // When the lease must be renewed, not when the jwt lapses — the
            // token is spent once at connect, the lease is what keeps the
            // session alive (PROTOCOL.md §10).
            expiresAt: leaseExpiresAt,
          },
        },
        { status: 201 },
      ),
      ctx.scopeCheck,
    );
  } catch (err) {
    // `assertActiveUser` throws this on a soft-deleted account during the
    // step-up ceremony; its own status and code are the answer.
    if (err instanceof ApiAuthError) {
      return problem({
        type: ProblemType.Forbidden,
        title: 'forbidden',
        status: err.status,
        detail: err.message,
        ...(err.code ? { code: err.code } : {}),
      });
    }
    return problemFromError(err, 'sites/[siteId]/machines/[machineId]/swoop/sessions:POST');
  }
};

const sharedHandlerOptions = {
  siteIdParam: 'path' as const,
  targetKind: 'machine' as const,
  targetIdParam: 'machineId',
  apiKeyScope: {
    resource: 'machine' as const,
    idParam: 'machineId',
    permission: 'write' as const,
  },
};

const controlHandler = authorizedSiteHandler<SwoopRouteParams>({
  capability: Capability.MACHINE_REMOTE_CONTROL,
  ...sharedHandlerOptions,
})(coreHandler);

const viewHandler = authorizedSiteHandler<SwoopRouteParams>({
  capability: Capability.MACHINE_REMOTE_VIEW,
  ...sharedHandlerOptions,
})(coreHandler);

export async function POST(
  request: NextRequest,
  routeContext: { params: Promise<SwoopRouteParams> },
): Promise<NextResponse> {
  // Peek on a CLONE so the chosen handler still gets an unconsumed body.
  // Anything that is not an explicit `control: true` takes the watch bar, and
  // the core handler re-derives the intent from the body it parses itself.
  let control = false;
  try {
    const peek = (await request.clone().json()) as { control?: unknown };
    control = peek?.control === true;
  } catch {
    // An unparseable body is a watch request as far as the bar goes; the core
    // handler emits the validation error.
  }
  return (control ? controlHandler : viewHandler)(request, routeContext);
}
