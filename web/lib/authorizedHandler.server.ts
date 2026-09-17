/**
 * `authorizedSiteHandler` / `authorizedPlatformHandler` — the fixed
 * authorization pipeline every api route runs before its handler:
 *
 *   1. resolveAuth → UserActor (api-key or session/id-token)
 *   2. site access + actor (site wrapper only) — resolveSiteAccess, the shared
 *      decision core in lib/sitePolicy.server.ts, in one batched read
 *   3. securityConfig.read() for kill-switch state
 *   4. api-key scope — ALWAYS runs, never bypassed: it is the resilient line
 *      against a downgraded key gaining rights while capability enforcement
 *      is off.
 *   5. capability — skipped when `capability_enforcement === false`, EXCEPT for
 *      BYPASS_EXEMPT_CAPABILITIES; bypass recorded in the audit row so the
 *      trail survives the kill switch.
 *   6. rate limit — skipped when `rate_limit_enforcement === false`, logged
 *      the same way.
 *   7. allow audit — BLOCKING: an uncommittable row means 503 and no handler
 *      call. Deny/error audits stay best-effort; they grant nothing.
 *   8. handler(`{ actor, siteId, correlationId }`)
 *   9. handler throw → error audit (best-effort) + re-throw
 *
 * `siteIdParam: 'body'` is a compile error by design — siteId-from-body is
 * the confused-deputy surface this closes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import {
  ApiAuthError,
  auditApiKeyUse,
  resolveAuth,
  requireScope,
  type ResolvedAuth,
  type ScopeCheckResult,
} from '@/lib/apiAuth.server';
import { checkRoostVersion } from '@/lib/versionHeader';
import {
  resolveSiteAccess,
  SITE_ID_RE,
  type SiteAccessOutcome,
} from '@/lib/sitePolicy.server';
import {
  problem,
  problemForbidden,
  problemNotFound,
  problemRateLimited,
  problemScopeInsufficient,
  problemTokenExpired,
  problemUnauthorized,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import {
  type Actor,
  Capability,
  type Role,
  type SiteRole,
  type UserActor,
  hasCapability,
} from '@/lib/capabilities';
import {
  generateCorrelationId,
  writeAuditEntry,
  writeAuditEntryBlocking,
  type AuditEntryInput,
  type AuditTarget,
  type AuditTargetKind,
} from '@/lib/auditLog.server';
import type { ApiKeyPermission, ApiKeyResource } from '@/lib/apiKeyTypes';
import {
  checkRateLimit,
  rateLimitHeaders,
  type RateLimitResult,
} from '@/lib/rateLimit.server';
import { securityConfig } from '@/lib/securityConfig.server';
import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';
import { emitSecurityBoundaryMetric } from '@/lib/securityBoundaryMetrics.server';

/** Source of `siteId`. `'body'` is deliberately absent — using it won't compile. */
export type SiteIdSource = 'path' | 'query';

/**
 * Capabilities the `capability_enforcement` kill switch does NOT turn off.
 *
 * That switch exists so an authorization misfire cannot lock operators out of
 * their own fleet — it fails towards availability. Handing every site member
 * live control of a machine's keyboard, or its screen and system audio, is the
 * wrong direction to fail in, so swoop's two capabilities keep running
 * `hasCapability` while the switch is off. Everything else still bypasses and
 * still records `enforcement_bypassed` in its allow audit.
 */
export const BYPASS_EXEMPT_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  Capability.MACHINE_REMOTE_CONTROL,
  Capability.MACHINE_REMOTE_VIEW,
]);

export interface SiteHandlerContext {
  actor: UserActor;
  siteId: string;
  correlationId: string;
  auth: ResolvedAuth;
  scopeCheck: ScopeCheckResult;
}

export interface PlatformHandlerContext {
  actor: UserActor;
  correlationId: string;
  auth: ResolvedAuth;
  scopeCheck: ScopeCheckResult;
}

export interface SiteHandlerOptions {
  capability: Capability;
  siteIdParam: SiteIdSource;
  /** Audit `target.kind`, default `'site'`; pass the nested kind where it applies. */
  targetKind?: AuditTargetKind;
  /**
   * Route param for the audit target id, default the resolved siteId. Nested
   * routes should pass theirs so audit rows name the mutated resource.
   */
  targetIdParam?: string;
  /**
   * Permission(s) an api-key caller needs (sessions/id-tokens bypass scope).
   * Default `'write'`; read-class routes must pass `'read'`.
   *
   * A LIST means ALL of them are required. Permissions are not hierarchical, so
   * `['write', 'admin']` is a real requirement and not a redundant one — it is
   * how the formerly double-gated routes keep the conjunction they always
   * enforced.
   */
  apiKeyPermission?: ApiKeyPermission | ApiKeyPermission[];
  /**
   * Scope to enforce, default `site={siteId}:<permission>`. Nested public
   * routes can keep their pre-migration contract, e.g. `machine={id}:write`.
   */
  apiKeyScope?: {
    resource: ApiKeyResource;
    idParam?: string;
    id?: string;
    /** A list means ALL are required — see `apiKeyPermission`. */
    permission?: ApiKeyPermission | ApiKeyPermission[];
  };
  /**
   * OPT IN to the roost version contract: reject an unsupported `Roost-Version`
   * with 400, and flag a missing one so the route can advise.
   *
   * Opt-in rather than automatic, because `checkRoostVersion` REJECTS. It
   * currently reaches 43 route files via the `_shared` gates; making it
   * universal would extend a 400 to presets, talons, agent-tokens, api-keys and
   * the platform surface, none of which has ever parsed the header. Routes set
   * this only when they already had the behaviour — which means the 13 formerly
   * double-gated routes, as their inner gate is removed.
   *
   * The check runs FIRST, ahead of auth, to preserve `_shared`'s ordering: a
   * request with an unsupported version gets 400 there today even when
   * unauthenticated, and moving it after auth would turn those into 401.
   */
  roostVersioned?: boolean;
}

export interface PlatformHandlerOptions {
  capability: Capability;
  targetKind?: AuditTargetKind;
  /**
   * Route param for the audit target id. Omit for platform-wide routes (they
   * record `__platform__`); routes mutating one resource MUST pass theirs so
   * the audit row names what changed.
   */
  targetIdParam?: string;
  /**
   * Scope an api-key caller must hold (sessions/id-tokens bypass, per
   * `requireScope`). Default `{ resource: 'user', permission: 'admin' }`.
   */
  apiKeyScope?: { resource: ApiKeyResource; permission: ApiKeyPermission };
}

export type SiteRouteHandler<TParams = Record<string, string | undefined>> = (
  request: NextRequest,
  ctx: SiteHandlerContext,
  routeContext: { params: Promise<TParams> },
) => Promise<NextResponse> | NextResponse;

export type PlatformRouteHandler<TParams = Record<string, string | undefined>> = (
  request: NextRequest,
  ctx: PlatformHandlerContext,
  routeContext?: { params: Promise<TParams> },
) => Promise<NextResponse> | NextResponse;

/** One permission or many; callers may write either and mean "all of these". */
function toPermissionList(
  p: ApiKeyPermission | ApiKeyPermission[],
): ApiKeyPermission[] {
  return Array.isArray(p) ? p : [p];
}

/**
 * `siteRoles` carries the caller's standing on the site this request names, and
 * is `{}` on platform routes where no site was resolved. An empty map denies
 * every site-scoped capability, which is the correct default: a route that never
 * resolved membership must not be able to act on a site.
 */
function authToActor(
  auth: ResolvedAuth,
  role: Role,
  siteRoles: Record<string, SiteRole>,
): UserActor {
  return {
    type: 'user',
    userId: auth.userId,
    ...(auth.keyContext ? { apiKeyId: auth.keyContext.keyId } : {}),
    role,
    siteRoles,
  };
}

async function loadUserActor(auth: ResolvedAuth): Promise<UserActor> {
  const db = getAdminDb();
  const userDoc = await db.collection('users').doc(auth.userId).get();
  const data = userDoc.exists ? userDoc.data() ?? null : null;
  if (!data || typeof data.deletedAt === 'number') {
    throw new ApiAuthError(403, 'Forbidden: User is deleted or inactive', {
      code: 'user_inactive',
    });
  }
  const rawRole = data?.role;
  // `'user'` and every other value fall to the same tier as `'member'` — see
  // normaliseRole in lib/sitePolicy.server.ts for why that matters.
  const role: Role = rawRole === 'superadmin' || rawRole === 'admin' ? rawRole : 'member';
  // No site is in scope on this path, so no per-site standing is resolved and
  // every site-scoped capability denies. Platform routes are the only callers.
  return authToActor(auth, role, {});
}

function authErrorToResponse(err: ApiAuthError): NextResponse {
  if (err.code === 'token_expired') {
    const expiredAt = typeof err.details?.expiredAt === 'number' ? err.details.expiredAt : undefined;
    return problemTokenExpired(expiredAt);
  }
  if (err.code === 'scope_insufficient') {
    const d = err.details as { resource?: string; id?: string; permission?: string } | undefined;
    return problemScopeInsufficient(err.message, {
      resource: d?.resource ?? 'unknown',
      id: d?.id ?? 'unknown',
      permission: d?.permission ?? 'unknown',
    });
  }
  if (err.status === 401) return problemUnauthorized(err.message);
  if (err.status === 403) return problemForbidden(err.message);
  if (err.status === 404) return problemNotFound(err.message);
  return problem({
    type: ProblemType.Internal,
    title: 'authorization error',
    status: err.status,
    detail: err.message,
  });
}

function serviceUnavailable(detail: string, instance?: string): NextResponse {
  return problem({
    type: ProblemType.ServiceUnavailable,
    title: 'service unavailable',
    status: 503,
    detail,
    ...(instance ? { instance } : {}),
  });
}

function denyAudit(
  siteId: string,
  entry: AuditEntryInput,
): void {
  // Best-effort: a failed deny/error audit can't change a response already decided.
  writeAuditEntry(siteId, entry);
}

/**
 * Platform audit rows live at `global/audit_log/{entryId}`, not under a site.
 * Firestore-direct because `auditLog.server.ts` only knows the site path.
 */
async function writePlatformAuditBlocking(entry: AuditEntryInput): Promise<void> {
  const db = getAdminDb();
  const docRef = db.collection('global').doc('audit_log').collection('entries').doc();
  if (entry.enforcementBypassed) {
    logger.warn('authorization enforcement bypassed (platform)', {
      context: 'authorizedHandler',
      data: {
        correlationId: entry.correlationId,
        capability: entry.capability,
        outcome: entry.outcome,
        target: entry.target,
        metadata: entry.metadata,
      },
    });
    emitSecurityBoundaryMetric('authorization_enforcement_bypass_total', 1, {
      severity: 'warning',
      labels: {
        site: '__platform__',
        capability: entry.capability,
        outcome: entry.outcome,
        role: auditActorRoleLabel(entry.actor),
        bypass: String(entry.metadata?.enforcement_bypassed ?? 'unknown'),
      },
      fields: {
        correlationId: entry.correlationId,
        target: entry.target,
      },
    });
  }
  const payload: Record<string, unknown> = {
    correlationId: entry.correlationId,
    actor: entry.actor,
    capability: entry.capability,
    target: entry.target,
    outcome: entry.outcome,
    timestamp: FieldValue.serverTimestamp(),
  };
  if (entry.metadata !== undefined) payload.metadata = entry.metadata;
  if (entry.denyReason !== undefined) payload.denyReason = entry.denyReason;
  if (entry.errorCode !== undefined) payload.errorCode = entry.errorCode;
  if (entry.enforcementBypassed !== undefined) {
    payload.enforcementBypassed = entry.enforcementBypassed;
  }
  try {
    await docRef.set(payload);
  } catch (err) {
    emitSecurityBoundaryMetric('audit_write_failures_total', 1, {
      severity: 'error',
      labels: {
        site: '__platform__',
        capability: entry.capability,
        outcome: entry.outcome,
        role: auditActorRoleLabel(entry.actor),
      },
      fields: {
        correlationId: entry.correlationId,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
  emitSecurityBoundaryMetric('capability_decision_total', 1, {
    labels: {
      outcome: entry.outcome,
      capability: entry.capability,
      role: auditActorRoleLabel(entry.actor),
      site: '__platform__',
    },
    fields: {
      correlationId: entry.correlationId,
      target: entry.target,
      denyReason: entry.denyReason,
      errorCode: entry.errorCode,
      enforcementBypassed: entry.enforcementBypassed,
    },
  });
}

function platformDenyAudit(entry: AuditEntryInput): void {
  void writePlatformAuditBlocking(entry).catch((err) => {
    logger.error('platform audit log write failed (fire-and-forget)', {
      context: 'authorizedHandler',
      data: {
        correlationId: entry.correlationId,
        capability: entry.capability,
        outcome: entry.outcome,
        err: err instanceof Error ? err.message : String(err),
      },
    });
  });
}

// Firestore reserves document ids matching `__.*__`; platform routes still
// need a stable bucket for rate-limit counters, so use a non-reserved id.
const PLATFORM_RATE_LIMIT_SITE_ID = 'platform_global';

// Audit `target.id` for platform-wide routes. Routes acting on one resource
// pass `targetIdParam` instead — readers (account-deletions feed) rely on it.
const PLATFORM_TARGET_ID = '__platform__';

function auditActorRoleLabel(actor: AuditEntryInput['actor']): string {
  if (actor.type === 'system') return `system:${actor.name}`;
  return actor.apiKeyId ? `api-key:${actor.role}` : actor.role;
}

function headersForRateLimit(result: RateLimitResult): Record<string, string> {
  return typeof rateLimitHeaders === 'function' ? rateLimitHeaders(result) : {};
}

function extractSiteIdFromRequest(
  request: NextRequest,
  source: SiteIdSource,
  paramsPromise: Promise<Record<string, string | undefined>> | undefined,
): Promise<string | null> {
  if (source === 'query') {
    const v = request.nextUrl.searchParams.get('siteId');
    return Promise.resolve(v && v.length > 0 ? v : null);
  }
  // 'path' — pull from Next.js dynamic route params (always Promise in Next 16).
  if (!paramsPromise) return Promise.resolve(null);
  return paramsPromise.then((params) => {
    const v = params?.siteId;
    return typeof v === 'string' && v.length > 0 ? v : null;
  });
}

async function extractRouteParam(
  paramsPromise: Promise<Record<string, string | undefined>> | undefined,
  paramName: string,
): Promise<string | null> {
  if (!paramsPromise) return null;
  const params = await paramsPromise;
  const value = params?.[paramName];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function extractRouteParamFromPath(request: NextRequest, paramName: string): string | null {
  const segments = request.nextUrl.pathname.split('/').filter(Boolean);
  const markerByParam: Record<string, string> = {
    deploymentId: 'deployments',
    processId: 'processes',
    presetId: 'system-presets',
    version: 'installer',
    webhookId: 'webhooks',
  };
  const marker = markerByParam[paramName];
  if (!marker) return null;
  const idx = segments.indexOf(marker);
  const value = idx >= 0 ? segments[idx + 1] : null;
  return value ? decodeURIComponent(value) : null;
}

/**
 * For any route scoped to one site (or a resource nested under it).
 * `siteIdParam` must be `'path'` or `'query'`; `'body'` is a compile error —
 * that's the guard against a body siteId disagreeing with the URL.
 */
export function authorizedSiteHandler<TParams extends Record<string, string | undefined> = Record<string, string | undefined>>(
  options: SiteHandlerOptions,
) {
  return function wrap(handler: SiteRouteHandler<TParams>) {
    return async function authorizedRoute(
      request: NextRequest,
      routeContext?: { params: Promise<TParams> },
    ): Promise<NextResponse> {
      const correlationId = generateCorrelationId();
      let actor: UserActor | null = null;
      let siteId = '';
      const targetKind: AuditTargetKind = options.targetKind ?? 'site';
      const routeParamsPromise = (routeContext?.params ?? Promise.resolve({} as TParams)) as Promise<Record<string, string | undefined>>;

      // 0. Roost version, for routes that opt in. Deliberately ahead of auth:
      // the `_shared` gates check it before resolving auth, so an unsupported
      // version answers 400 even unauthenticated. Running it later would turn
      // those into 401 and change a shipped contract.
      let missingVersion = false;
      if (options.roostVersioned) {
        const versionCheck = checkRoostVersion(request);
        if (!versionCheck.ok) return versionCheck.response;
        missingVersion = versionCheck.missing === true;
      }

      // 1. Resolve auth.
      let auth: ResolvedAuth;
      try {
        auth = await resolveAuth(request);
      } catch (err) {
        if (err instanceof ApiAuthError) return authErrorToResponse(err);
        throw err;
      }

      // 2. Resolve siteId from path/query (NEVER body).
      const resolvedSiteId = await extractSiteIdFromRequest(
        request,
        options.siteIdParam,
        routeParamsPromise,
      );
      // SHAPE, not just presence (Wave 1 task 1.3). Without this the raw value
      // went straight to Firestore: a non-site-shaped id simply MISSED, so the
      // caller got 404 "site not found or no access" for input that was never a
      // valid id — and for ids the SDK rejects client-side (containing '/', or
      // the reserved __.*__ form) the read THREW and the wrapper answered 503.
      // Three different answers for one class of bad input. `_shared` has always
      // answered 400; both paths now do.
      //
      // Placed after auth on purpose. `_shared` validates first, so an
      // unauthenticated caller learns whether an id is well-formed before
      // proving anything; this order refuses them at 401 instead, and `_shared`
      // is moved to match.
      if (resolvedSiteId && !SITE_ID_RE.test(resolvedSiteId)) {
        return problemValidation('invalid siteId format', {
          siteId: ['must be 1-128 chars: letters, digits, underscore, hyphen'],
        });
      }
      if (!resolvedSiteId) {
        return problem({
          type: ProblemType.ValidationFailed,
          title: 'validation failed',
          status: 400,
          detail: `siteId missing from ${options.siteIdParam}`,
        });
      }
      siteId = resolvedSiteId;

      const targetId = options.targetIdParam
        ? (await extractRouteParam(routeParamsPromise, options.targetIdParam))
          ?? extractRouteParamFromPath(request, options.targetIdParam)
        : siteId;
      if (!targetId) {
        return problem({
          type: ProblemType.ValidationFailed,
          title: 'validation failed',
          status: 400,
          detail: `${options.targetIdParam ?? 'target id'} missing from path`,
        });
      }

      const apiKeyScopeId = options.apiKeyScope?.id
        ?? (options.apiKeyScope?.idParam
          ? (await extractRouteParam(routeParamsPromise, options.apiKeyScope.idParam))
            ?? extractRouteParamFromPath(request, options.apiKeyScope.idParam)
          : siteId);
      if (!apiKeyScopeId) {
        return problem({
          type: ProblemType.ValidationFailed,
          title: 'validation failed',
          status: 400,
          detail: `${options.apiKeyScope?.idParam ?? 'api key scope id'} missing from path`,
        });
      }

      // 3+4. Site access AND the actor's role/sites, from ONE round trip
      // (lib/sitePolicy.server.ts). These were two steps and three document
      // reads: assertUserHasSiteAccess read sites/{id} + users/{uid}, then
      // loadUserActor read users/{uid} AGAIN. The decision core reads both
      // once via getAll and hands back everything both steps needed.
      //
      // The response mapping below is deliberately still this wrapper's own —
      // it answers 403 for an inactive user where _shared collapses to 404.
      // Wave 1 Task 1.3 unifies the two mappings; keeping them separate here
      // is what lets the parity matrix stay green across this extraction.
      let outcome: SiteAccessOutcome;
      try {
        outcome = await resolveSiteAccess(auth.userId, siteId);
      } catch (err) {
        logger.error('[authorizedSiteHandler] failed to resolve site access', {
          context: 'authorizedHandler',
          data: { err: err instanceof Error ? err.message : String(err) },
        });
        return serviceUnavailable('could not load user record');
      }

      if (!outcome.ok) {
        if (outcome.reason === 'user_inactive') {
          return authErrorToResponse(
            new ApiAuthError(403, 'Forbidden: User is deleted or inactive', {
              code: 'user_inactive',
            }),
          );
        }
        // Don't leak existence: missing site and no access answer identically.
        return problemNotFound('site not found or no access');
      }

      actor = authToActor(
        auth,
        outcome.facts.globalRole,
        // Reached only when the outcome is ok, so a superadmin may legitimately
        // have no membership; their capabilities short-circuit on global role.
        outcome.facts.membershipRole
          ? { [siteId]: outcome.facts.membershipRole }
          : {},
      );

      // 5. Read kill-switch config.
      const config = await securityConfig.read();

      // 6. API-key scope check — ALWAYS runs (never bypassed).
      //
      // A LIST of permissions, ALL of which must be held. API-key permissions are
      // NOT hierarchical — `scopeMatches` (lib/apiKeyTypes.ts) is exact
      // membership, so `admin` does not imply `write`, nor `write` `read`. The
      // double-gated routes therefore enforced a CONJUNCTION (the wrapper's
      // permission AND the inner helper's), and collapsing them to one
      // permission would have widened access for any custom-scoped key holding
      // one but not the other. Task 1.4 keeps that conjunction and states it
      // here, once, instead of leaving it an accident of two gates.
      let scopeCheck: ScopeCheckResult;
      const requiredPermissions = toPermissionList(
        options.apiKeyScope?.permission ?? options.apiKeyPermission ?? 'write',
      );
      try {
        scopeCheck = { isLegacy: false };
        for (const permission of requiredPermissions) {
          scopeCheck = requireScope(
            auth,
            options.apiKeyScope?.resource ?? 'site',
            apiKeyScopeId,
            permission,
          );
        }
        // Only ever true for a route that opted in, so routes without the roost
        // version contract cannot start emitting X-Roost-Version-Missing.
        if (missingVersion) scopeCheck = { ...scopeCheck, missingVersion: true };
        // The api-key audit event. `_shared` emits this on every gate; the
        // wrapper never did, so api-key use went unaudited on every
        // wrapper-only route. No-ops for session/id-token callers.
        auditApiKeyUse(auth, siteId, request);
      } catch (err) {
        if (err instanceof ApiAuthError) {
          denyAudit(siteId, {
            correlationId,
            actor,
            capability: options.capability,
            target: { kind: targetKind, id: targetId } as AuditTarget,
            outcome: 'deny',
            denyReason: 'scope_insufficient',
            metadata: { route: request.nextUrl.pathname, method: request.method },
          });
          return authErrorToResponse(err);
        }
        throw err;
      }

      // 7. Capability check — bypassable, except for BYPASS_EXEMPT_CAPABILITIES.
      const capabilityExempt = BYPASS_EXEMPT_CAPABILITIES.has(options.capability);
      const enforcementBypassed: 'capability' | 'rate_limit' | undefined =
        !config.capability_enforcement && !capabilityExempt ? 'capability' : undefined;
      if (config.capability_enforcement || capabilityExempt) {
        // No ownership short-circuit. It existed because self-serve owners are
        // created with global role `member` (lib/actions/bootstrapUser.server.ts),
        // so a matrix keyed on the GLOBAL role locked an owner out of their own
        // site. The matrix is keyed on per-site standing now, and `owner` is a
        // row in it — so ownership is granted by the matrix rather than routed
        // around it, and `sites/{siteId}.owner` is no longer read here at all.
        const ok = hasCapability(actor as Actor, options.capability, siteId);
        if (!ok) {
          denyAudit(siteId, {
            correlationId,
            actor,
            capability: options.capability,
            target: { kind: targetKind, id: targetId } as AuditTarget,
            outcome: 'deny',
            denyReason: 'capability_missing',
            metadata: { route: request.nextUrl.pathname, method: request.method },
          });
          return problemForbidden('capability not granted');
        }
      }

      // 8. Rate-limit check — bypassable.
      let rateLimitBypassed = false;
      let rateLimitResult: RateLimitResult | null = null;
      if (config.rate_limit_enforcement) {
        const rl = await checkRateLimit(actor as Actor, options.capability, siteId);
        rateLimitResult = rl;
        if (!rl.ok) {
          denyAudit(siteId, {
            correlationId,
            actor,
            capability: options.capability,
            target: { kind: targetKind, id: targetId } as AuditTarget,
            outcome: 'deny',
            denyReason: 'rate_limited',
            metadata: {
              route: request.nextUrl.pathname,
              method: request.method,
              retryAfterSec: rl.retryAfterSec,
            },
          });
          return problemRateLimited(
            rl.retryAfterSec,
            undefined,
            headersForRateLimit(rl),
          );
        }
      } else {
        rateLimitBypassed = true;
      }

      // 9. Allow audit — BLOCKING. Failure -> 503, handler not called.
      const bypassMeta: Record<string, unknown> = { route: request.nextUrl.pathname, method: request.method };
      if (enforcementBypassed) bypassMeta.enforcement_bypassed = enforcementBypassed;
      else if (rateLimitBypassed) bypassMeta.enforcement_bypassed = 'rate_limit';

      try {
        await writeAuditEntryBlocking(siteId, {
          correlationId,
          actor,
          capability: options.capability,
          target: { kind: targetKind, id: targetId } as AuditTarget,
          outcome: 'allow',
          metadata: bypassMeta,
          enforcementBypassed: Boolean(enforcementBypassed) || rateLimitBypassed,
        });
      } catch (err) {
        logger.error('[authorizedSiteHandler] allow-audit write failed; refusing handler', {
          context: 'authorizedHandler',
          data: {
            correlationId,
            siteId,
            err: err instanceof Error ? err.message : String(err),
          },
        });
        return serviceUnavailable('audit log unavailable; refusing privileged action');
      }

      // 10. Invoke handler.
      try {
        const ctx: SiteHandlerContext = { actor, siteId, correlationId, auth, scopeCheck };
        const response = await handler(request, ctx, { params: routeParamsPromise as Promise<TParams> });
        if (rateLimitResult) {
          Object.entries(headersForRateLimit(rateLimitResult)).forEach(([key, value]) => {
            response.headers.set(key, value);
          });
        }
        return response;
      } catch (err) {
        // Best-effort error audit, then re-throw for the framework's handler.
        denyAudit(siteId, {
          correlationId,
          actor,
          capability: options.capability,
          target: { kind: targetKind, id: targetId } as AuditTarget,
          outcome: 'error',
          errorCode: err instanceof Error ? err.name : 'handler_error',
          metadata: { route: request.nextUrl.pathname, method: request.method },
        });
        throw err;
      }
    };
  };
}

/**
 * For routes mutating platform state (installer, global settings, user roles).
 * Audits to `global/audit_log/{entryId}` — there is no governing site.
 * Requires `actor.role === 'superadmin'`; SystemActor goes via `systemInvoker`.
 */
export function authorizedPlatformHandler<TParams extends Record<string, string | undefined> = Record<string, string | undefined>>(
  options: PlatformHandlerOptions,
) {
  return function wrap(handler: PlatformRouteHandler<TParams>) {
    return async function authorizedRoute(
      request: NextRequest,
      routeContext?: { params: Promise<TParams> },
    ): Promise<NextResponse> {
      const correlationId = generateCorrelationId();
      const targetKind: AuditTargetKind = options.targetKind ?? 'site';
      // Resolved once so deny/allow/error rows all name the same target;
      // falls back to the platform sentinel when there is no resource.
      const targetId = options.targetIdParam
        ? (await extractRouteParam(
            (routeContext?.params ?? Promise.resolve({} as TParams)) as Promise<Record<string, string | undefined>>,
            options.targetIdParam,
          )) ?? PLATFORM_TARGET_ID
        : PLATFORM_TARGET_ID;
      const auditTarget = { kind: targetKind, id: targetId } as AuditTarget;

      let auth: ResolvedAuth;
      try {
        auth = await resolveAuth(request);
      } catch (err) {
        if (err instanceof ApiAuthError) return authErrorToResponse(err);
        throw err;
      }

      let actor: UserActor;
      try {
        actor = await loadUserActor(auth);
      } catch (err) {
        if (err instanceof ApiAuthError) return authErrorToResponse(err);
        logger.error('[authorizedPlatformHandler] failed to load user actor', {
          context: 'authorizedHandler',
          data: { err: err instanceof Error ? err.message : String(err) },
        });
        return serviceUnavailable('could not load user record');
      }

      const apiKeyScope = options.apiKeyScope ?? { resource: 'user' as ApiKeyResource, permission: 'admin' as ApiKeyPermission };

      // Role gate: platform endpoints require superadmin.
      if (actor.role !== 'superadmin') {
        platformDenyAudit({
          correlationId,
          actor,
          capability: options.capability,
          target: auditTarget,
          outcome: 'deny',
          denyReason: 'role_insufficient',
          metadata: { route: request.nextUrl.pathname, method: request.method },
        });
        return problemForbidden('superadmin access required');
      }

      const config = await securityConfig.read();

      // API-key scope check — ALWAYS runs (sessions/id-tokens bypass inside requireScope).
      let scopeCheck: ScopeCheckResult;
      try {
        scopeCheck = requireScope(auth, apiKeyScope.resource, '*', apiKeyScope.permission);
      } catch (err) {
        if (err instanceof ApiAuthError) {
          platformDenyAudit({
            correlationId,
            actor,
            capability: options.capability,
            target: auditTarget,
            outcome: 'deny',
            denyReason: 'scope_insufficient',
            metadata: { route: request.nextUrl.pathname, method: request.method },
          });
          return authErrorToResponse(err);
        }
        throw err;
      }

      const enforcementBypassed: 'capability' | 'rate_limit' | undefined = !config.capability_enforcement
        ? 'capability'
        : undefined;
      if (config.capability_enforcement) {
        const ok = hasCapability(actor as Actor, options.capability);
        if (!ok) {
          platformDenyAudit({
            correlationId,
            actor,
            capability: options.capability,
            target: auditTarget,
            outcome: 'deny',
            denyReason: 'capability_missing',
            metadata: { route: request.nextUrl.pathname, method: request.method },
          });
          return problemForbidden('capability not granted');
        }
      }

      let rateLimitBypassed = false;
      let rateLimitResult: RateLimitResult | null = null;
      if (config.rate_limit_enforcement) {
        // No siteId here; a synthetic one keeps the counter partitioned.
        const rl = await checkRateLimit(
          actor as Actor,
          options.capability,
          PLATFORM_RATE_LIMIT_SITE_ID,
        );
        rateLimitResult = rl;
        if (!rl.ok) {
          platformDenyAudit({
            correlationId,
            actor,
            capability: options.capability,
            target: auditTarget,
            outcome: 'deny',
            denyReason: 'rate_limited',
            metadata: {
              route: request.nextUrl.pathname,
              method: request.method,
              retryAfterSec: rl.retryAfterSec,
            },
          });
          return problemRateLimited(
            rl.retryAfterSec,
            undefined,
            headersForRateLimit(rl),
          );
        }
      } else {
        rateLimitBypassed = true;
      }

      const bypassMeta: Record<string, unknown> = { route: request.nextUrl.pathname, method: request.method };
      if (enforcementBypassed) bypassMeta.enforcement_bypassed = enforcementBypassed;
      else if (rateLimitBypassed) bypassMeta.enforcement_bypassed = 'rate_limit';

      try {
        await writePlatformAuditBlocking({
          correlationId,
          actor,
          capability: options.capability,
          target: auditTarget,
          outcome: 'allow',
          metadata: bypassMeta,
          enforcementBypassed: Boolean(enforcementBypassed) || rateLimitBypassed,
        });
      } catch (err) {
        logger.error('[authorizedPlatformHandler] allow-audit write failed; refusing handler', {
          context: 'authorizedHandler',
          data: {
            correlationId,
            err: err instanceof Error ? err.message : String(err),
          },
        });
        return serviceUnavailable('audit log unavailable; refusing privileged action');
      }

      try {
        const response = await handler(request, { actor, correlationId, auth, scopeCheck }, routeContext);
        if (rateLimitResult) {
          Object.entries(headersForRateLimit(rateLimitResult)).forEach(([key, value]) => {
            response.headers.set(key, value);
          });
        }
        return response;
      } catch (err) {
        platformDenyAudit({
          correlationId,
          actor,
          capability: options.capability,
          target: auditTarget,
          outcome: 'error',
          errorCode: err instanceof Error ? err.name : 'handler_error',
          metadata: { route: request.nextUrl.pathname, method: request.method },
        });
        throw err;
      }
    };
  };
}
