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

import { NextRequest, NextResponse } from 'next/server';
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
  getSessionFromRequest,
  markSessionMfaCeremony,
  sessionPassedMfaCeremony,
} from '@/lib/sessionManager.server';
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
import { recordSwoopDenied, recordSwoopSessionStarted } from '@/lib/swoop/audit.server';
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

/** `reason` is the audit code for the refusal, never the ceremony's detail. */
type StepUpResult =
  | { ok: true }
  | { ok: false; response: NextResponse; reason: string };

/**
 * Run a live second-factor ceremony, open the 10-minute window for this
 * (user, machine) pair, and record on the login session that it has now itself
 * proved a second factor — which is what lets this operator's reloads reuse the
 * window for the rest of those 10 minutes.
 *
 * A timestamp can never stand in for any of it: a session born from the 30-day
 * device-trust cookie carries `mfaCompletedAt = now` with no ceremony behind it
 * (`lib/sessionManager.server.ts`, the `deviceTrusted` arm of
 * `resolveMfaOnSessionCreate`).
 */
async function openStepUpFromProof(args: {
  userId: string;
  siteId: string;
  machineId: string;
  proof: unknown;
}): Promise<StepUpResult> {
  const parsed = parseMfaProof(args.proof);
  if (!parsed.ok) {
    return { ok: false, reason: 'proof_malformed', response: mfaProofErrorResponse(parsed) };
  }

  // An account with no enrolled factor cannot have produced a live proof, so a
  // proof that "verifies" for one means the ceremony was bypassed. Refused
  // before the verification rather than after it.
  if (!(await hasEnrolledFactor(args.userId))) {
    return {
      ok: false,
      reason: 'no_enrolled_factor',
      response: problem({
        type: ProblemType.Unauthorized,
        title: 'step-up required',
        status: 401,
        detail:
          'enroll a passkey or an authenticator app before taking control of a machine. signing in with google or a password is not a second factor.',
        code: 'step_up_required',
      }),
    };
  }

  const userData = await assertActiveUser(args.userId);
  const outcome = await verifyMfaProof(args.userId, parsed.proof, userData);
  if (!outcome.ok) {
    return { ok: false, reason: 'proof_rejected', response: mfaProofErrorResponse(outcome) };
  }

  await openStepUpWindow({
    userId: args.userId,
    siteId: args.siteId,
    machineId: args.machineId,
    proof: outcome,
  });

  // Best effort, and deliberately after the window: the ceremony has already
  // happened and this request is already authorised, so a cookie that cannot be
  // written costs the operator a prompt on their next reload and nothing more.
  // Refusing control here would refuse someone who just proved a second factor.
  try {
    await markSessionMfaCeremony(args.userId);
  } catch (err) {
    logger.warn('[swoop/sessions] could not record the ceremony on the login session', {
      context: 'swoop/sessions',
      data: {
        siteId: args.siteId,
        machineId: args.machineId,
        err: err instanceof Error ? err.message : String(err),
      },
    });
  }
  return { ok: true };
}

/**
 * Did the LOGIN session behind this request pass a live ceremony of its own?
 *
 * Read off the server's encrypted, signed session cookie — the browser has no
 * field it can set to claim this — and only when that cookie names the caller
 * and is still live, so a request authenticated by an ID token rides on no
 * cookie it did not earn. Anything short of that reads as "no ceremony".
 */
async function requestPassedMfaCeremony(
  request: NextRequest,
  userId: string,
): Promise<boolean> {
  const login = await getSessionFromRequest(request);
  return (
    login.userId === userId &&
    typeof login.expiresAt === 'number' &&
    login.expiresAt > Date.now() &&
    sessionPassedMfaCeremony(login)
  );
}

const coreHandler: SiteRouteHandler<SwoopRouteParams> = async (request, ctx, { params }) => {
  try {
    const { machineId } = await params;
    const siteId = ctx.siteId;
    const userId = ctx.actor.userId;
    // Every swoop refusal below is recorded on the session's own trail as well
    // as the wrapper's decision row, because `sites/{siteId}/logs` — which a
    // site admin can bulk-delete — must never be where a session is evidenced.
    const auditBase = { siteId, machineId, actor: ctx.actor, correlationId: ctx.correlationId };

    const keyRefusal = apiKeyRefusal(ctx);
    if (keyRefusal) {
      // The watch bar: the body is still unparsed here, and a key clears neither.
      recordSwoopDenied({
        ...auditBase,
        event: 'session_denied',
        denyReason: 'api_key_not_permitted',
        ctl: false,
      });
      return keyRefusal;
    }

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
    const gate = await swoopGate({ ctx, machineId, intent });

    // Only control reads the window, and a watch request never opens, extends,
    // touches one or even reads the login session — the two intents share no
    // state at all.
    const stepUpOpen =
      intent === 'control'
        ? await hasOpenStepUpWindow({
            userId,
            siteId,
            machineId,
            sessionPassedCeremony: await requestPassedMfaCeremony(request, userId),
          })
        : false;

    let decision = evaluateSwoopAccess({ ...gate, stepUpOpen });
    // The one refusal the caller can answer inside this same request: a live
    // ceremony opens the window and the decision is taken again.
    if (!decision.ok && decision.code === 'step_up_required' && body.mfaProof !== undefined) {
      const opened = await openStepUpFromProof({ userId, siteId, machineId, proof: body.mfaProof });
      if (!opened.ok) {
        recordSwoopDenied({
          ...auditBase,
          event: 'step_up_failed',
          denyReason: opened.reason,
          ctl: true,
        });
        return opened.response;
      }
      decision = evaluateSwoopAccess({ ...gate, stepUpOpen: true });
    }
    if (!decision.ok) {
      recordSwoopDenied({
        ...auditBase,
        event: 'session_denied',
        denyReason: decision.code,
        ctl: intent === 'control',
      });
      return decisionProblem(decision);
    }

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

    // Blocking and BEFORE the session exists: a control session that starts
    // unrecorded is the failure this trail exists to prevent, so an audit that
    // cannot be written refuses the session instead.
    try {
      await recordSwoopSessionStarted({ ...auditBase, sid, viewerId, ctl: decision.ctl });
    } catch (err) {
      logger.error('[swoop/sessions] session audit write failed; refusing to start', {
        context: 'swoop/sessions',
        data: {
          siteId,
          machineId,
          err: err instanceof Error ? err.message : String(err),
        },
      });
      return problem({
        type: ProblemType.ServiceUnavailable,
        title: 'service unavailable',
        status: 503,
        detail: 'audit log unavailable; refusing to start a swoop session.',
        code: 'audit_unavailable',
      });
    }

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
  // One read of the body. Peeking on a clone and letting the handler read the
  // original again is two reads of one streamed body, which failed now and
  // then in production ("could not read request body", 2026-09-23). The bytes
  // are read here once and handed on in a fresh request; anything that is not
  // an explicit `control: true` takes the watch bar, and the core handler
  // re-derives the intent from the body it parses itself.
  let raw: string | null = null;
  try {
    raw = await request.text();
  } catch {
    // Unreadable here is unreadable there: let the handler report it.
  }
  let control = false;
  if (raw !== null) {
    try {
      control = (JSON.parse(raw) as { control?: unknown })?.control === true;
    } catch {
      // An unparseable body is a watch request as far as the bar goes; the
      // core handler emits the validation error.
    }
  }
  const handler = control ? controlHandler : viewHandler;
  if (raw === null) return handler(request, routeContext);
  const replay = new NextRequest(request.url, {
    method: request.method,
    headers: request.headers,
    body: raw,
  });
  return handler(replay, routeContext);
}
