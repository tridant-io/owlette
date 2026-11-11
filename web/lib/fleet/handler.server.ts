/**
 * `fleetHandler`: the request wrapper for `/api/agent/fleet/*`, where a granted
 * machine calls with its fleet session (ADR 0017). it mirrors
 * `authorizedSiteHandler` for a machine instead of a person, in this order:
 *
 *   1. `Authorization: Bearer <fleet session>`, verified with one document get:
 *      none, unknown or expired is 401 `fleet_session_invalid`
 *   2. the site's grant, one more get: not a sender, or the feature off, is 403
 *      `fleet_not_granted`, and that machine's sessions are revoked
 *   3. the MachineActor, from the session and the grant
 *   4. MACHINE_VIEW at site level, the one capability a machine holds there. it
 *      proves only "a granted machine of this site": dispatch decides the
 *      machine a call acts on
 *   5. rate limit, in the machine's own bucket
 *   6. the payer's `owlette.hoot` (402)
 *   7. handler(`FleetContext`)
 *
 * the wrapper audits only its own refusals. a tool call is audited where it is
 * decided: `admitFleetCall` writes the blocking allow row just before the call
 * runs, and `denyFleetCall` records a refusal dispatch produced. a request that
 * only reads (the tools list, a poll) writes no audit row, so a script polling
 * a long call does not write one a second.
 *
 * no kill switch reaches any of this: a machine's checks always run, so the
 * security config is never read.
 */

import { NextRequest, NextResponse } from 'next/server';
import { problem, problemRateLimited, ProblemType } from '@/lib/apiErrors';
import { Capability, type MachineActor, hasCapability } from '@/lib/capabilities';
import {
  generateCorrelationId,
  writeAuditEntry,
  writeAuditEntryBlocking,
  type AuditActor,
  type AuditTarget,
} from '@/lib/auditLog.server';
import { checkRateLimit, rateLimitHeaders } from '@/lib/rateLimit.server';
import { requireEntitlement } from '@/lib/plan.server';
import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';
import type { AdmitFleetCall, FleetCallDenial, FleetContext } from '@/lib/fleet/context';
import { fleetGrantFor, loadFleetSettings, type FleetGrant } from '@/lib/fleet/policy.server';
import { revokeFleetSessions, verifyFleetSession, type FleetSessionSubject } from '@/lib/fleet/session.server';

export type FleetRouteHandler<TParams = Record<string, string | undefined>> = (
  request: NextRequest,
  ctx: FleetContext,
  routeContext: { params: Promise<TParams> },
) => Promise<NextResponse> | NextResponse;

/** what every request is checked for and charged at entry. */
const ENTRY_CAPABILITY = Capability.MACHINE_VIEW;

const PLAN_KEY = 'owlette.hoot';

function sessionInvalid(): NextResponse {
  return problem({
    type: ProblemType.Unauthorized,
    title: 'unauthorized',
    status: 401,
    detail: 'fleet session missing, unknown or expired',
    code: 'fleet_session_invalid',
  });
}

function forbidden(code: string, detail: string): NextResponse {
  return problem({ type: ProblemType.Forbidden, title: 'forbidden', status: 403, detail, code });
}

function serviceUnavailable(detail: string): NextResponse {
  return problem({ type: ProblemType.ServiceUnavailable, title: 'service unavailable', status: 503, detail });
}

function bearerOf(request: NextRequest): string | null {
  const match = (request.headers.get('authorization') ?? '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** the audit row's actor: the calling machine. */
function auditActorOf(siteId: string, machineId: string): AuditActor {
  return { type: 'machine', siteId, machineId };
}

function routeMetadata(request: NextRequest): Record<string, unknown> {
  return { route: request.nextUrl.pathname, method: request.method };
}

export function fleetHandler<TParams extends Record<string, string | undefined> = Record<string, string | undefined>>(
  handler: FleetRouteHandler<TParams>,
) {
  return async function fleetRoute(
    request: NextRequest,
    routeContext?: { params: Promise<TParams> },
  ): Promise<NextResponse> {
    const correlationId = generateCorrelationId();
    const db = getAdminDb();

    // 1. the fleet session
    const bearer = bearerOf(request);
    if (!bearer) return sessionInvalid();
    let subject: FleetSessionSubject | null;
    try {
      subject = await verifyFleetSession(db, bearer);
    } catch (err) {
      // the error's name only: a firestore message can name the document, which is the session's hash
      logger.error('[fleetHandler] could not read the fleet session', {
        context: 'fleetHandler',
        data: { correlationId, err: err instanceof Error ? err.name : typeof err },
      });
      return serviceUnavailable('could not verify the fleet session');
    }
    if (!subject) return sessionInvalid();
    const { siteId, machineId } = subject;
    const deny = (denyReason: string, metadata: Record<string, unknown> = {}) =>
      writeAuditEntry(siteId, {
        correlationId,
        actor: auditActorOf(siteId, machineId),
        capability: ENTRY_CAPABILITY,
        target: { kind: 'site', id: siteId },
        outcome: 'deny',
        denyReason,
        metadata: { ...routeMetadata(request), ...metadata },
      });

    // 2. the grant, read on every call so a change cuts within one
    let grant: FleetGrant | null;
    try {
      grant = fleetGrantFor(await loadFleetSettings(siteId, { db }), machineId);
    } catch (err) {
      logger.error('[fleetHandler] could not load the fleet settings', {
        context: 'fleetHandler',
        data: { correlationId, siteId, machineId, err: errorMessage(err) },
      });
      return serviceUnavailable('could not load the fleet settings');
    }
    if (!grant) {
      deny('fleet_not_granted');
      // best-effort: the request is refused either way
      try {
        await revokeFleetSessions(db, { siteId, machineId });
      } catch (err) {
        logger.warn('[fleetHandler] could not revoke the fleet sessions of an ungranted machine', {
          context: 'fleetHandler',
          data: { correlationId, siteId, machineId, err: errorMessage(err) },
        });
      }
      return forbidden('fleet_not_granted', 'this machine is not granted fleet access on its site');
    }

    // 3. the actor
    const actor: MachineActor = {
      type: 'machine',
      siteId,
      machineId,
      maxTier: grant.maxTier,
      machineIds: grant.machineIds,
    };

    // 4. the entry capability
    if (!hasCapability(actor, ENTRY_CAPABILITY, siteId)) {
      deny('capability_missing');
      return forbidden('capability_missing', 'capability not granted');
    }

    // 5. rate limit
    const rl = await checkRateLimit(actor, ENTRY_CAPABILITY, siteId);
    if (!rl.ok) {
      deny('rate_limited', { retryAfterSec: rl.retryAfterSec });
      return problemRateLimited(rl.retryAfterSec, undefined, rateLimitHeaders(rl));
    }

    // 6. plan, after the cheaper rate limit
    const planRefusal = await requireEntitlement(siteId, PLAN_KEY);
    if (planRefusal) {
      deny('plan_locked', { entitlement: PLAN_KEY });
      return planRefusal;
    }

    // 7. the handler
    const response = await handler(
      request,
      { actor, siteId, machineId, grant, correlationId, db },
      { params: routeContext?.params ?? Promise.resolve({} as TParams) },
    );
    for (const [key, value] of Object.entries(rateLimitHeaders(rl))) {
      response.headers.set(key, value);
    }
    return response;
  };
}

function callTarget(ctx: FleetContext, machineId: string | null): AuditTarget {
  return machineId === null ? { kind: 'site', id: ctx.siteId } : { kind: 'machine', id: machineId };
}

/**
 * the admission dispatch runs immediately before a call it has checked: the
 * call's capability rate limit, unless it is the one every request is charged
 * at entry, then the blocking allow row naming the tool and the machine. it
 * does not re-decide coverage, which dispatch owns. a response means refused,
 * already audited; a failed allow row is 503 and the call never runs.
 */
export function admitFleetCall(request: NextRequest, ctx: FleetContext): AdmitFleetCall {
  return async ({ capability, tool, machineId }) => {
    const row = {
      correlationId: ctx.correlationId,
      actor: auditActorOf(ctx.siteId, ctx.machineId),
      capability,
      target: callTarget(ctx, machineId),
    };
    const metadata = { ...routeMetadata(request), tool, machineId };

    if (capability !== ENTRY_CAPABILITY) {
      const rl = await checkRateLimit(ctx.actor, capability, ctx.siteId);
      if (!rl.ok) {
        writeAuditEntry(ctx.siteId, {
          ...row,
          outcome: 'deny',
          denyReason: 'rate_limited',
          metadata: { ...metadata, retryAfterSec: rl.retryAfterSec },
        });
        return problemRateLimited(rl.retryAfterSec, undefined, rateLimitHeaders(rl));
      }
    }

    try {
      await writeAuditEntryBlocking(ctx.siteId, { ...row, outcome: 'allow', metadata, enforcementBypassed: false });
    } catch (err) {
      logger.error('[fleetHandler] allow-audit write failed; refusing the call', {
        context: 'fleetHandler',
        data: { correlationId: ctx.correlationId, siteId: ctx.siteId, machineId: ctx.machineId, tool, err: errorMessage(err) },
      });
      return serviceUnavailable('audit log unavailable; refusing privileged action');
    }
    return null;
  };
}

/**
 * records a refusal dispatch produced, as a deny row under the entry
 * capability, which is what authorizedSiteHandler's deny rows carry.
 * fire-and-forget: it never throws and never holds the response.
 */
export function denyFleetCall(request: NextRequest, ctx: FleetContext, { reason, tool, machineId }: FleetCallDenial): void {
  writeAuditEntry(ctx.siteId, {
    correlationId: ctx.correlationId,
    actor: auditActorOf(ctx.siteId, ctx.machineId),
    capability: ENTRY_CAPABILITY,
    target: callTarget(ctx, machineId),
    outcome: 'deny',
    denyReason: reason,
    metadata: { ...routeMetadata(request), tool, machineId },
  });
}
