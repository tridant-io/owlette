/**
 * Shared helpers for roost API routes (chunks/, roosts/).
 *
 * No URL or header versioning — the routes ARE the API. No backward compat with
 * legacy single-url distribution: v3.0.0 agents are required (clean cutover).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problemValidation,
  problemUnauthorized,
  problemForbidden,
  problemNotFound,
  problemPlanRequired,
  problemScopeInsufficient,
  problemTokenExpired,
} from '@/lib/apiErrors';
import {
  ApiAuthError,
  applyAuthDeprecations,
  auditApiKeyUse,
  requireAdminOrIdToken,
  requireScope,
  resolveAuth,
  assertUserHasSiteAccess,
  type ResolvedAuth,
  type ScopeCheckResult,
} from '@/lib/apiAuth.server';
import type { ApiKeyPermission, ApiKeyResource } from '@/lib/apiKeyTypes';
import {
  Capability,
  hasCapability,
  type UserActor,
} from '@/lib/capabilities';
import { checkRoostVersion } from '@/lib/versionHeader';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import {
  entitled,
  PLAN_REQUIRED_DETAIL,
  requireEntitlement,
  resolvePlan,
  type PlanFlag,
} from '@/lib/plan.server';
import { SITE_ID_RE, resolveSiteAccess } from '@/lib/sitePolicy.server';

export const MAX_HASHES_PER_REQUEST = 1000;

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const RESOURCE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// legacy helpers, for routes still on requireAdminOrIdToken

export async function requireAuthOrProblem(
  req: NextRequest,
): Promise<{ ok: true; userId: string } | { ok: false; response: NextResponse }> {
  try {
    const userId = await requireAdminOrIdToken(req);
    return { ok: true, userId };
  } catch (err) {
    if (err instanceof ApiAuthError) {
      if (err.status === 403) return { ok: false, response: problemForbidden() };
      if (err.status === 404) return { ok: false, response: problemNotFound() };
      return { ok: false, response: problemUnauthorized() };
    }
    throw err;
  }
}

export async function requireAgentOrSiteScope(
  req: NextRequest,
  siteId: string,
): Promise<{ ok: true; userId: string; isAgent: boolean } | { ok: false; response: NextResponse }> {
  if (!SITE_ID_RE.test(siteId)) {
    return {
      ok: false,
      response: problemValidation('invalid siteId format', {
        siteId: ['must be 1-128 chars: letters, digits, underscore, hyphen'],
      }),
    };
  }

  const authHeader = req.headers.get('authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (match) {
    try {
      const decoded = await getAdminAuth().verifyIdToken(match[1]);
      if (decoded.role === 'agent') {
        if (decoded.site_id !== siteId) {
          return { ok: false, response: problemNotFound('site not found or no access') };
        }
        return { ok: true, userId: decoded.uid, isAgent: true };
      }
    } catch {
      /* fall through */
    }
  }

  const auth = await requireAuthOrProblem(req);
  if (!auth.ok) return { ok: false, response: auth.response };
  const scopeError = await requireSiteScope(auth.userId, siteId);
  if (scopeError) return { ok: false, response: scopeError };
  return { ok: true, userId: auth.userId, isAgent: false };
}

export async function requireSiteScope(
  userId: string,
  siteId: string,
): Promise<NextResponse | null> {
  if (!SITE_ID_RE.test(siteId)) {
    return problemValidation('invalid siteId format', {
      siteId: ['must be 1-128 chars: letters, digits, underscore, hyphen'],
    });
  }
  try {
    await assertUserHasSiteAccess(userId, siteId);
    return null;
  } catch (err) {
    if (err instanceof ApiAuthError) {
      // An INACTIVE caller is 403, not the collapsed 404 (Wave 1 task 1.3).
      // Masking exists to stop a stranger enumerating sites; it has no job to do
      // when the caller has authenticated and it is their OWN account that is
      // gone. Telling them 404 sends them hunting for a missing site instead of
      // a disabled login. `authorizedSiteHandler` has always answered 403 here;
      // both paths now agree.
      //
      // NOTE this fires for a MISSING user document as well as a soft-deleted
      // one, so an api key whose owner was hard-deleted also moves 404 -> 403.
      if (err.code === 'user_inactive') {
        return problemForbidden(err.message);
      }
      if (err.status === 404 || err.status === 403) {
        return problemNotFound('site not found or no access');
      }
      return problemForbidden();
    }
    throw err;
  }
}

/**
 * Every site named in a bulk membership request must be one the caller's api key
 * is scoped for — the same `site=<id>:write` + `:admin` the equivalent
 * `/api/sites/{siteId}/members` call demands.
 *
 * Without this, `user=*:write` reached membership on every site in the
 * deployment while naming none of them, so a key confined to one site could not
 * touch /members elsewhere but could do the same job through here.
 *
 * Session and id-token callers are unaffected: `requireScope` returns early when
 * there is no key context, and they are already superadmin-only because
 * `authorizedPlatformHandler` capability-checks SITE_MEMBER_MANAGE with no
 * siteId, which only superadmin satisfies.
 */
export function requireSiteScopesForBulkMembership(
  auth: ResolvedAuth,
  siteIds: string[],
): NextResponse | null {
  for (const siteId of siteIds) {
    for (const permission of ['write', 'admin'] as const) {
      try {
        requireScope(auth, 'site', siteId, permission);
      } catch (err) {
        if (err instanceof ApiAuthError) {
          return problemScopeInsufficient(
            `api key is not scoped for site ${siteId}`,
            { resource: 'site', id: siteId, permission },
          );
        }
        throw err;
      }
    }
  }
  return null;
}

export function validateResourceId(id: string, fieldName: string): NextResponse | null {
  if (!RESOURCE_ID_RE.test(id)) {
    return problemValidation(
      `${fieldName} must be 8-64 chars: letters, digits, underscore, hyphen`,
      { [fieldName]: ['invalid format'] },
    );
  }
  return null;
}

export function validateSiteIdBody(value: unknown, fieldName = 'siteId'):
  | { ok: true; siteId: string }
  | { ok: false; response: NextResponse } {
  if (typeof value !== 'string' || !SITE_ID_RE.test(value)) {
    return {
      ok: false,
      response: problemValidation(`field ${fieldName} is required and must be a valid site id`, {
        [fieldName]: ['must be a non-empty string, ≤128 chars: letters, digits, underscore, hyphen'],
      }),
    };
  }
  return { ok: true, siteId: value };
}

export function validateHashList(value: unknown, fieldName: string):
  | { ok: true; hashes: string[] }
  | { ok: false; response: NextResponse } {
  if (!Array.isArray(value) || value.length === 0) {
    return {
      ok: false,
      response: problemValidation(
        `field ${fieldName} must be a non-empty array of sha-256 hashes`,
        { [fieldName]: ['must be a non-empty array of sha-256 hex strings'] },
      ),
    };
  }
  if (value.length > MAX_HASHES_PER_REQUEST) {
    return {
      ok: false,
      response: problemValidation(
        `field ${fieldName} contains ${value.length} hashes; max is ${MAX_HASHES_PER_REQUEST} per request`,
        { [fieldName]: [`max ${MAX_HASHES_PER_REQUEST} hashes per request`] },
      ),
    };
  }
  const bad: string[] = [];
  for (const h of value) {
    if (typeof h !== 'string' || !SHA256_HEX_RE.test(h)) {
      bad.push(String(h).slice(0, 16) + '…');
      if (bad.length >= 5) break;
    }
  }
  if (bad.length) {
    return {
      ok: false,
      response: problemValidation(
        `field ${fieldName} contains malformed hash entries (must be lowercase 64-char hex sha-256)`,
        { [fieldName]: [`malformed entries: ${bad.join(', ')}`] },
      ),
    };
  }
  return { ok: true, hashes: value as string[] };
}

export async function parseJsonBody(
  req: NextRequest,
): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  try {
    const body = await req.json();
    return { ok: true, body };
  } catch {
    return { ok: false, response: problemValidation('request body is not valid json') };
  }
}

/**
 * Read the body as text once, then JSON-parse. Returns both — the raw text is
 * what idempotency body-hashing needs.
 */
export async function readAndParseJsonBody(
  req: NextRequest,
): Promise<
  | { ok: true; raw: string; body: unknown }
  | { ok: false; response: NextResponse }
> {
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return { ok: false, response: problemValidation('could not read request body') };
  }
  let body: unknown = {};
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      return { ok: false, response: problemValidation('request body is not valid json') };
    }
  }
  return { ok: true, raw, body };
}

// scope-aware auth helpers

export interface ScopedAuthSuccess {
  ok: true;
  userId: string;
  auth: ResolvedAuth;
  scopeCheck: ScopeCheckResult;
}

export type ScopedAuthResult =
  | ScopedAuthSuccess
  | { ok: false; response: NextResponse };

export function auditActorIdentifier(auth: ResolvedAuth): string {
  return auth.keyContext ? `apiKey:${auth.keyContext.keyId}` : `user:${auth.userId}`;
}

async function resolveAuthOrProblem(
  req: NextRequest,
): Promise<{ ok: true; auth: ResolvedAuth } | { ok: false; response: NextResponse }> {
  try {
    const auth = await resolveAuth(req);
    return { ok: true, auth };
  } catch (err) {
    if (err instanceof ApiAuthError) {
      if (err.code === 'token_expired') {
        const expiredAt =
          typeof err.details?.expiredAt === 'number' ? err.details.expiredAt : undefined;
        return { ok: false, response: problemTokenExpired(expiredAt) };
      }
      if (err.status === 403) return { ok: false, response: problemForbidden() };
      if (err.status === 404) return { ok: false, response: problemNotFound() };
      return { ok: false, response: problemUnauthorized() };
    }
    throw err;
  }
}

function runScopeCheck(
  auth: ResolvedAuth,
  resource: ApiKeyResource,
  id: string,
  permission: ApiKeyPermission,
): { ok: true; scopeCheck: ScopeCheckResult } | { ok: false; response: NextResponse } {
  try {
    const scopeCheck = requireScope(auth, resource, id, permission);
    return { ok: true, scopeCheck };
  } catch (err) {
    if (err instanceof ApiAuthError && err.code === 'scope_insufficient') {
      return {
        ok: false,
        response: problemScopeInsufficient(err.message, {
          resource,
          id,
          permission,
        }),
      };
    }
    throw err;
  }
}

/**
 * Site-scoped capability gate for routes that authorize through
 * `requireSiteAuthAndScope`, which checks site MEMBERSHIP + api-key scope but no
 * capability (unlike `authorizedSiteHandler`, which runs its own capability
 * step). Works identically for session and api-key callers.
 *
 * Resolves through `resolveSiteAccess` — the SAME decision core
 * `authorizedSiteHandler` uses — so the two paths cannot drift on what
 * membership means. It used to read `users/{uid}` on its own and combine the
 * GLOBAL role with `sites[]`, which is precisely how one global `admin` came to
 * hold site-admin on every site in its array.
 *
 * The ownership short-circuit is gone. It existed because self-serve owners are
 * created with global role `member` (`lib/actions/bootstrapUser.server.ts`), so a
 * matrix keyed on the global role locked an owner out of their own site. The
 * matrix is keyed on per-site standing now and `owner` is a row in it, so
 * ownership is granted by the matrix rather than routed around it.
 *
 * `planFlag` also requires the site payer's plan flag, once the capability holds.
 */
async function requireSiteCapability(
  auth: ResolvedAuth,
  capability: Capability,
  siteId: string,
  planFlag?: PlanFlag,
): Promise<NextResponse | null> {
  const outcome = await resolveSiteAccess(auth.userId, siteId);
  // A refusal here is not distinguished by reason: membership and scope were
  // already checked upstream by `requireSiteAuthAndScope`, so reaching this with
  // no access means the capability is not granted either way, and saying more
  // would leak whether the site exists.
  if (!outcome.ok) return problemForbidden('capability not granted');

  const actor: UserActor = {
    type: 'user',
    userId: auth.userId,
    ...(auth.keyContext ? { apiKeyId: auth.keyContext.keyId } : {}),
    role: outcome.facts.globalRole,
    // A superadmin legitimately holds no membership; their capabilities
    // short-circuit on the global role before this map is consulted.
    siteRoles: outcome.facts.membershipRole
      ? { [siteId]: outcome.facts.membershipRole }
      : {},
  };

  if (!hasCapability(actor, capability, siteId)) {
    return problemForbidden('capability not granted');
  }
  return planFlag ? requireEntitlement(siteId, planFlag, outcome.facts.siteData) : null;
}

/**
 * DISTRIBUTION_MANAGE plus the payer's `owlette.roost`, for creating a roost and
 * uploading to one (plan.md decision 8).
 */
export async function requireDistributionManageCapability(
  auth: ResolvedAuth,
  siteId: string,
): Promise<NextResponse | null> {
  return requireSiteCapability(auth, Capability.DISTRIBUTION_MANAGE, siteId, 'owlette.roost');
}

/**
 * WEBHOOK_MANAGE gate for the mutating `/api/webhooks/**` handlers (create,
 * update, delete, rotate-secret, test). Read paths — list, detail, deliveries,
 * probe — stay at member level.
 *
 * `create` also requires the payer's `owlette.webhooks` (plan.md decision 8). the
 * rest stay open, so a payer who lapsed can still tidy up what they made.
 */
export async function requireWebhookManageCapability(
  auth: ResolvedAuth,
  siteId: string,
  { create = false }: { create?: boolean } = {},
): Promise<NextResponse | null> {
  return requireSiteCapability(
    auth,
    Capability.WEBHOOK_MANAGE,
    siteId,
    create ? 'owlette.webhooks' : undefined,
  );
}

/**
 * a 402 unless `uid` may mint api keys (plan.md decision 8). the minting user's
 * own plan decides, whichever sites the key is scoped to.
 */
export async function requireApiKeyMintPlan(uid: string): Promise<NextResponse | null> {
  if (entitled(await resolvePlan(uid), 'owlette.api_keys')) return null;
  return problemPlanRequired(PLAN_REQUIRED_DETAIL['owlette.api_keys'], 'owlette.api_keys');
}

/**
 * an api-key request also needs the site payer's `owlette.api_keys` (plan.md
 * decision 8). sessions are untouched: the dashboard is gated feature by feature.
 */
async function requireApiKeyPlan(
  auth: ResolvedAuth,
  siteId: string,
  siteData: Record<string, unknown> | null,
): Promise<NextResponse | null> {
  if (!auth.keyContext) return null;
  return requireEntitlement(siteId, 'owlette.api_keys', siteData);
}

function isMutationPermission(permission: ApiKeyPermission): boolean {
  return permission !== 'read';
}

/**
 * Site access for the `_shared` family.
 *
 * Goes through `assertUserHasSiteAccess`, which since Wave 1 Task 1.2 is a thin
 * adapter over the single decision core in `lib/sitePolicy.server.ts`. Calling
 * the adapter rather than the core directly is deliberate: this family needs
 * only pass/fail — it builds no actor, so it has no use for the role and
 * membership facts the core returns — and the adapter already serves five
 * production routes that call it on their own. One decision implementation,
 * without a second call shape to keep in step.
 *
 * NOTE the response mapping: an INACTIVE caller is 403 `user_inactive`; every
 * other denial collapses to 404. Task 1.3 unified this with
 * `authorizedSiteHandler`, so the divergence this comment used to describe is
 * gone — `__tests__/lib/authorizationParity.test.ts` now pins the AGREEMENT,
 * not the difference. Three auditors were nearly misled by the old wording.
 *
 * the site document comes back so the plan gates skip a second read of it.
 */
async function assertSiteAccessOrProblem(
  userId: string,
  siteId: string,
): Promise<
  | { ok: true; siteData: Record<string, unknown> | null }
  | { ok: false; response: NextResponse }
> {
  try {
    const { siteData } = await assertUserHasSiteAccess(userId, siteId);
    return { ok: true, siteData };
  } catch (err) {
    if (err instanceof ApiAuthError) {
      // An INACTIVE caller is 403, not the collapsed 404 (Wave 1 task 1.3).
      // Masking exists to stop a stranger enumerating sites; it has no job to
      // do once the caller has authenticated and it is their OWN account that
      // is gone. A 404 sends them hunting for a missing site instead of a
      // disabled login. `authorizedSiteHandler` has always answered 403 here.
      //
      // NOTE this fires for a MISSING user document as well as a soft-deleted
      // one, so an api key whose owner was hard-deleted also moves 404 -> 403.
      if (err.code === 'user_inactive') {
        return { ok: false, response: problemForbidden(err.message) };
      }
      if (err.status === 404 || err.status === 403) {
        return { ok: false, response: problemNotFound('site not found or no access') };
      }
      return { ok: false, response: problemForbidden() };
    }
    throw err;
  }
}

export async function requireSiteAuthAndScope(
  req: NextRequest,
  siteId: string,
  permission: ApiKeyPermission,
): Promise<ScopedAuthResult> {
  const versionCheck = checkRoostVersion(req);
  if (!versionCheck.ok) return { ok: false, response: versionCheck.response };

  const authResult = await resolveAuthOrProblem(req);
  if (!authResult.ok) return authResult;

  // AFTER auth (Wave 1 task 1.3). This ran first, so an unauthenticated caller
  // could learn whether a site id was well-formed before proving anything;
  // authenticating first refuses them at 401 and reveals nothing. It also makes
  // both gates answer identically, which is the point of the task.
  if (!SITE_ID_RE.test(siteId)) {
    return {
      ok: false,
      response: problemValidation('invalid siteId format', {
        siteId: ['must be 1-128 chars: letters, digits, underscore, hyphen'],
      }),
    };
  }

  const access = await assertSiteAccessOrProblem(authResult.auth.userId, siteId);
  if (!access.ok) return access;

  const scopeResult = runScopeCheck(authResult.auth, 'site', siteId, permission);
  if (!scopeResult.ok) return scopeResult;

  const planError = await requireApiKeyPlan(authResult.auth, siteId, access.siteData);
  if (planError) return { ok: false, response: planError };

  auditApiKeyUse(authResult.auth, siteId, req);

  return {
    ok: true,
    userId: authResult.auth.userId,
    auth: authResult.auth,
    scopeCheck: { ...scopeResult.scopeCheck, missingVersion: versionCheck.missing },
  };
}

/**
 * Machine-scoped auth + scope check for
 * `/api/sites/{siteId}/machines/{machineId}/...`.
 *
 * - session/id-token: needs site access; scope check bypassed (same as
 *   `requireScope` for non-key auth).
 * - api-key: must also satisfy `machine=<machineId>:<permission>`; `machine=*`
 *   matches any id.
 *
 * machineId validation matches siteId (1-128 of [A-Za-z0-9_-]) because machine
 * ids have several historical shapes (`mach_*`, hostnames, uuids).
 *
 * No `checkRoostVersion()` — machine endpoints aren't part of the roost surface
 * and take no deprecation header.
 */
export async function requireMachineAuthAndScope(
  req: NextRequest,
  siteId: string,
  machineId: string,
  permission: ApiKeyPermission,
): Promise<ScopedAuthResult> {
  if (!SITE_ID_RE.test(siteId)) {
    return {
      ok: false,
      response: problemValidation('invalid siteId format', {
        siteId: ['must be 1-128 chars: letters, digits, underscore, hyphen'],
      }),
    };
  }
  if (!SITE_ID_RE.test(machineId)) {
    return {
      ok: false,
      response: problemValidation('invalid machineId format', {
        machineId: ['must be 1-128 chars: letters, digits, underscore, hyphen'],
      }),
    };
  }

  // Agent short-circuit: an agent ID token carries role + site_id + machine_id
  // claims, but assertSiteAccessOrProblem resolves through `resolveSiteAccess`,
  // which requires a `users/{uid}` document AND an active
  // `sites/{siteId}/members/{uid}` row. An agent has neither, so falling through
  // would 404 every agent screenshot/command call. Validate the claims directly.
  const authHeader = req.headers.get('authorization') || '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch && !bearerMatch[1].startsWith('owk_')) {
    try {
      const decoded = await getAdminAuth().verifyIdToken(bearerMatch[1]);
      if (decoded.role === 'agent') {
        if (decoded.site_id !== siteId || decoded.machine_id !== machineId) {
          return { ok: false, response: problemNotFound('site not found or no access') };
        }
        return {
          ok: true,
          userId: decoded.uid,
          auth: { userId: decoded.uid, keyContext: null },
          scopeCheck: { isLegacy: false },
        };
      }
    } catch {
      /* not an agent id token — fall through to standard resolveAuthOrProblem */
    }
  }

  const authResult = await resolveAuthOrProblem(req);
  if (!authResult.ok) return authResult;

  const access = await assertSiteAccessOrProblem(authResult.auth.userId, siteId);
  if (!access.ok) return access;

  const scopeResult = runScopeCheck(authResult.auth, 'machine', machineId, permission);
  if (!scopeResult.ok) return scopeResult;

  const planError = await requireApiKeyPlan(authResult.auth, siteId, access.siteData);
  if (planError) return { ok: false, response: planError };

  auditApiKeyUse(authResult.auth, siteId, req);

  return {
    ok: true,
    userId: authResult.auth.userId,
    auth: authResult.auth,
    scopeCheck: scopeResult.scopeCheck,
  };
}

export async function requireRoostAuthAndScope(
  req: NextRequest,
  siteId: string,
  roostId: string,
  permission: ApiKeyPermission,
): Promise<ScopedAuthResult> {
  if (!SITE_ID_RE.test(siteId)) {
    return {
      ok: false,
      response: problemValidation('invalid siteId format', {
        siteId: ['must be 1-128 chars: letters, digits, underscore, hyphen'],
      }),
    };
  }
  if (!RESOURCE_ID_RE.test(roostId)) {
    return {
      ok: false,
      response: problemValidation(
        'roostId must be 8-64 chars: letters, digits, underscore, hyphen',
        { roostId: ['invalid format'] },
      ),
    };
  }

  const versionCheck = checkRoostVersion(req);
  if (!versionCheck.ok) return { ok: false, response: versionCheck.response };

  const authResult = await resolveAuthOrProblem(req);
  if (!authResult.ok) return authResult;

  const access = await assertSiteAccessOrProblem(authResult.auth.userId, siteId);
  if (!access.ok) return access;

  if (isMutationPermission(permission)) {
    const capabilityError = await requireSiteCapability(
      authResult.auth,
      Capability.DISTRIBUTION_MANAGE,
      siteId,
    );
    if (capabilityError) return { ok: false, response: capabilityError };
  }

  const scopeResult = runScopeCheck(authResult.auth, 'roost', roostId, permission);
  if (!scopeResult.ok) return scopeResult;

  const planError = await requireApiKeyPlan(authResult.auth, siteId, access.siteData);
  if (planError) return { ok: false, response: planError };

  // deleting stays open on every plan (plan.md decision 8), so a payer who lapsed can clean up.
  if (isMutationPermission(permission) && req.method !== 'DELETE') {
    const roostError = await requireEntitlement(siteId, 'owlette.roost', access.siteData);
    if (roostError) return { ok: false, response: roostError };
  }

  auditApiKeyUse(authResult.auth, siteId, req);

  return {
    ok: true,
    userId: authResult.auth.userId,
    auth: authResult.auth,
    scopeCheck: { ...scopeResult.scopeCheck, missingVersion: versionCheck.missing },
  };
}

/**
 * Superadmin-gated platform-wide auth + scope check, for non-site-scoped
 * resources (`installer`, `user`). Superadmin only, even with a session.
 *
 * api-key callers additionally need `<resource>=*:<permission>`. Minting scopes
 * for `SUPERADMIN_ONLY_RESOURCES` is already superadmin-restricted at key
 * creation, but the role is re-verified here as defense-in-depth: the user may
 * have been demoted since the key was minted.
 *
 * session/id-token callers get the role check only (scope bypassed, as
 * elsewhere). Audit emission uses `siteId=''` — platform mutations have no site.
 */
export async function requirePlatformAuthAndScope(
  req: NextRequest,
  resource: ApiKeyResource,
  permission: ApiKeyPermission,
): Promise<ScopedAuthResult> {
  const authResult = await resolveAuthOrProblem(req);
  if (!authResult.ok) return authResult;

  // role gate: platform endpoints require superadmin regardless of scope.
  const db = getAdminDb();
  const userDoc = await db.collection('users').doc(authResult.auth.userId).get();
  const userData = userDoc.exists ? userDoc.data() : null;
  if (typeof userData?.deletedAt === 'number') {
    return { ok: false, response: problemForbidden('user is deleted or inactive') };
  }
  const role = userData?.role ?? null;
  if (role !== 'superadmin') {
    return { ok: false, response: problemForbidden('superadmin access required') };
  }

  // scope gate (api-key callers only; session/id-token bypasses).
  const scopeResult = runScopeCheck(authResult.auth, resource, '*', permission);
  if (!scopeResult.ok) return scopeResult;

  auditApiKeyUse(authResult.auth, '', req);

  return {
    ok: true,
    userId: authResult.auth.userId,
    auth: authResult.auth,
    scopeCheck: scopeResult.scopeCheck,
  };
}

/**
 * Site-scoped Hoot conversation auth + scope check for
 * `/api/hoot/conversations/*`. session/id-token: site access, scope bypassed.
 * api-key: `chat=<siteId>:<permission>`, `chat=*` matches any siteId.
 *
 * No `checkRoostVersion()` — chat isn't part of the roost surface.
 */
export async function requireChatAuthAndScope(
  req: NextRequest,
  siteId: string,
  permission: ApiKeyPermission,
): Promise<ScopedAuthResult> {
  if (!SITE_ID_RE.test(siteId)) {
    return {
      ok: false,
      response: problemValidation('invalid siteId format', {
        siteId: ['must be 1-128 chars: letters, digits, underscore, hyphen'],
      }),
    };
  }

  const authResult = await resolveAuthOrProblem(req);
  if (!authResult.ok) return authResult;

  const access = await assertSiteAccessOrProblem(authResult.auth.userId, siteId);
  if (!access.ok) return access;

  const scopeResult = runScopeCheck(authResult.auth, 'chat', siteId, permission);
  if (!scopeResult.ok) return scopeResult;

  const planError = await requireApiKeyPlan(authResult.auth, siteId, access.siteData);
  if (planError) return { ok: false, response: planError };

  auditApiKeyUse(authResult.auth, siteId, req);

  return {
    ok: true,
    userId: authResult.auth.userId,
    auth: authResult.auth,
    scopeCheck: scopeResult.scopeCheck,
  };
}

export async function requireAgentOrSiteAuthAndScope(
  req: NextRequest,
  siteId: string,
  permission: ApiKeyPermission,
): Promise<
  | { ok: true; userId: string; isAgent: boolean; scopeCheck: ScopeCheckResult }
  | { ok: false; response: NextResponse }
> {
  if (!SITE_ID_RE.test(siteId)) {
    return {
      ok: false,
      response: problemValidation('invalid siteId format', {
        siteId: ['must be 1-128 chars: letters, digits, underscore, hyphen'],
      }),
    };
  }

  const authHeader = req.headers.get('authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (match && !match[1].startsWith('owk_')) {
    try {
      const decoded = await getAdminAuth().verifyIdToken(match[1]);
      if (decoded.role === 'agent') {
        if (decoded.site_id !== siteId) {
          return { ok: false, response: problemNotFound('site not found or no access') };
        }
        return {
          ok: true,
          userId: decoded.uid,
          isAgent: true,
          scopeCheck: { isLegacy: false },
        };
      }
    } catch {
      /* fall through */
    }
  }

  const operator = await requireSiteAuthAndScope(req, siteId, permission);
  if (!operator.ok) return operator;

  return {
    ok: true,
    userId: operator.userId,
    isAgent: false,
    scopeCheck: operator.scopeCheck,
  };
}

export { applyAuthDeprecations };
