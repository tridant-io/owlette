import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { getSessionFromRequest } from '@/lib/sessionManager.server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import { resolveSiteAccess } from '@/lib/sitePolicy.server';
import { type Actor, type Capability, hasCapability, siteStanding } from '@/lib/capabilities';
import {
  type ApiKeyEnvironment,
  type ApiKeyLookup,
  type ApiKeyPermission,
  type ApiKeyResource,
  type ApiKeyScope,
  scopeMatches,
} from '@/lib/apiKeyTypes';
import { emitApiKeyUsed, scopeFingerprint } from '@/lib/auditLogClient';

export class ApiAuthError extends Error {
  status: number;
  code?: string;
  details?: Record<string, unknown>;

  constructor(
    status: number,
    message: string,
    opts?: { code?: string; details?: Record<string, unknown> }
  ) {
    super(message);
    this.status = status;
    this.code = opts?.code;
    this.details = opts?.details;
  }
}

export interface ApiKeyContext {
  keyId: string;
  /** Empty when a temporarily allowlisted legacy key has no explicit scopes. */
  scopes: ApiKeyScope[] | null;
  environment: ApiKeyEnvironment | null;
  expiresAt: number | null;
  /** Deprecated: resolved keys no longer bypass scope checks. */
  isLegacy: boolean;
  retiresAt?: number;
}

export interface ResolvedAuth {
  userId: string;
  /** Set for `owk_*` API-key auth; null for session / ID-token. */
  keyContext: ApiKeyContext | null;
}

export interface ScopeCheckResult {
  /** True when the caller should receive a legacy-key deprecation advisory. */
  isLegacy: boolean;
  /** True when the request omitted Roost-Version. Caller should set X-Roost-Version-Missing. */
  missingVersion?: boolean;
}

// Module-level memos to log each deprecated key path only once per process.
const LEGACY_LOGGED = new Set<string>();
const QUERY_LOGGED = new Set<string>();

function hashApiKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

function isLegacyKeyAllowed(keyHash: string): boolean {
  if (process.env.LEGACY_API_KEY_BYPASS_ENABLED !== 'true') return false;
  const allow = (process.env.LEGACY_API_KEY_ALLOW_HASH_LIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allow.includes(keyHash);
}

function warnLegacyOnce(keyHash: string): void {
  if (LEGACY_LOGGED.has(keyHash)) return;
  LEGACY_LOGGED.add(keyHash);
  console.warn(
    `[apiAuth] DEPRECATED: API key ${keyHash.slice(0, 8)}... has empty/missing scopes. ` +
      'This key bypassed scope enforcement before security wave; backfill scopes or revoke. ' +
      `Currently ${
        isLegacyKeyAllowed(keyHash)
          ? 'permitted via LEGACY_API_KEY_BYPASS_ENABLED'
          : 'REJECTED'
      }.`,
  );
}

function warnQueryStringKeyOnce(keyHash: string): void {
  if (QUERY_LOGGED.has(keyHash)) return;
  QUERY_LOGGED.add(keyHash);
  console.warn(
    `[apiAuth] DEPRECATED: API key ${keyHash.slice(0, 8)}... supplied via query string. ` +
      'Migrate to Authorization: Bearer or x-api-key header. ' +
      'Query-string keys leak via logs, referrers, browser history.',
  );
}

export async function requireSession(request: NextRequest): Promise<string> {
  const session = await getSessionFromRequest(request);

  if (!session.userId || !session.expiresAt) {
    throw new ApiAuthError(401, 'Unauthorized: No valid session');
  }

  if (Date.now() > session.expiresAt) {
    session.destroy();
    throw new ApiAuthError(401, 'Unauthorized: Session expired');
  }

  return session.userId;
}

export async function requireSessionOrIdToken(
  request: NextRequest,
  options: { rejectAgentTokens?: boolean } = {}
): Promise<string> {
  try {
    return await requireSession(request);
  } catch (error) {
    const bearer = extractBearer(request);
    if (!bearer) {
      if (error instanceof ApiAuthError) {
        throw error;
      }
      throw new ApiAuthError(401, 'Unauthorized: No valid session');
    }

    try {
      const adminAuth = getAdminAuth();
      const decoded = await adminAuth.verifyIdToken(bearer);
      // Agents (role='agent', custom token) must never mint user-scoped API
      // keys. Opt-in per call; only the ID-token branch can be an agent.
      if (options.rejectAgentTokens && decoded.role === 'agent') {
        throw new ApiAuthError(403, 'Forbidden: agent credentials cannot create api keys');
      }
      return decoded.uid;
    } catch (e) {
      if (e instanceof ApiAuthError) throw e; // preserve the 403 above
      throw new ApiAuthError(401, 'Unauthorized: Invalid ID token');
    }
  }
}

export async function requireAdmin(request: NextRequest): Promise<string> {
  return requireAdminOrIdToken(request);
}

function extractBearer(request: NextRequest): string | null {
  const auth = request.headers.get('authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function extractApiKey(request: NextRequest): string | null {
  const queryKey = request.nextUrl.searchParams.get('api_key');
  if (queryKey) {
    if (queryKey.startsWith('owk_')) {
      warnQueryStringKeyOnce(hashApiKey(queryKey));
      return queryKey;
    }
  } else {
    const headerKey = request.headers.get('x-api-key');
    if (headerKey && headerKey.startsWith('owk_')) return headerKey;
  }

  const bearer = extractBearer(request);
  if (bearer && bearer.startsWith('owk_')) return bearer;

  return null;
}

/**
 * Resolve an `owk_*` key to userId + keyContext: one read of
 * api_keys/{keyHash}, plus a fire-and-forget lastUsedAt update.
 */
async function resolveApiKeyContext(
  rawKey: string,
  options: { updateLastUsed?: boolean } = {},
): Promise<{ userId: string; keyContext: ApiKeyContext }> {
  const keyHash = hashApiKey(rawKey);
  const db = getAdminDb();

  const lookupDoc = await db.collection('api_keys').doc(keyHash).get();

  if (!lookupDoc.exists) {
    throw new ApiAuthError(401, 'Unauthorized: Invalid API key');
  }

  const data = lookupDoc.data() as Partial<ApiKeyLookup> & {
    userId: string;
    keyId: string;
    revokedAt?: unknown;
  };

  const now = Date.now();

  if (data.revokedAt) {
    throw new ApiAuthError(401, 'Unauthorized: Invalid API key');
  }

  // Rotation grace: the old key's lookup entry carries `retiresAt`.
  if (typeof data.retiresAt === 'number' && now >= data.retiresAt) {
    throw new ApiAuthError(401, 'Unauthorized: Invalid API key');
  }

  // Expiration: every scoped key has a hard `expiresAt`.
  if (typeof data.expiresAt === 'number' && now >= data.expiresAt) {
    throw new ApiAuthError(
      401,
      'Unauthorized: API key expired',
      {
        code: 'token_expired',
        details: { expiredAt: data.expiresAt },
      },
    );
  }

  const hasLegacyScopes =
    !data.scopes || (Array.isArray(data.scopes) && data.scopes.length === 0);
  if (hasLegacyScopes) {
    warnLegacyOnce(keyHash);
    if (!isLegacyKeyAllowed(keyHash)) {
      throw new ApiAuthError(401, 'Unauthorized: Invalid API key');
    }
  }

  const scopes = Array.isArray(data.scopes) ? (data.scopes as ApiKeyScope[]) : [];

  const keyContext: ApiKeyContext = {
    keyId: data.keyId,
    scopes,
    environment: (data.environment as ApiKeyEnvironment) ?? null,
    expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : null,
    isLegacy: false,
    ...(typeof data.retiresAt === 'number' ? { retiresAt: data.retiresAt } : {}),
  };

  if (options.updateLastUsed !== false) {
    db.collection('users')
      .doc(data.userId)
      .collection('api_keys')
      .doc(data.keyId)
      .update({ lastUsedAt: Date.now() })
      .catch(() => {});
  }

  return { userId: data.userId, keyContext };
}

export async function resolveApiKeyRateLimitIdentity(
  request: NextRequest,
): Promise<string | null> {
  const apiKey = extractApiKey(request);
  if (!apiKey) return null;

  try {
    const { keyContext } = await resolveApiKeyContext(apiKey, { updateLastUsed: false });
    return `apiKey:${keyContext.keyId}`;
  } catch {
    return null;
  }
}

async function resolveApiKey(rawKey: string): Promise<string> {
  const { userId } = await resolveApiKeyContext(rawKey);
  return userId;
}

export async function requireAdminOrIdToken(request: NextRequest): Promise<string> {
  const apiKey = extractApiKey(request);

  let userId: string;

  if (apiKey) {
    userId = await resolveApiKey(apiKey);
  } else {
    userId = await requireSessionOrIdToken(request);
  }

  const db = getAdminDb();
  const userDoc = await db.collection('users').doc(userId).get();
  const userData = userDoc.exists ? userDoc.data() ?? null : null;
  assertUserDataActive(userData);
  const role = userData?.role ?? null;

  if (role !== 'superadmin') {
    throw new ApiAuthError(403, 'Forbidden: Superadmin access required');
  }

  return userId;
}

/** Unified auth context carrying API-key metadata when present. For public
 * routes that need scope enforcement. */
export async function resolveAuth(request: NextRequest): Promise<ResolvedAuth> {
  const apiKey = extractApiKey(request);

  if (apiKey) {
    const { userId, keyContext } = await resolveApiKeyContext(apiKey);
    return { userId, keyContext };
  }

  const userId = await requireSessionOrIdToken(request);
  return { userId, keyContext: null };
}

/**
 * Enforce the required scope. Session / ID-token auth is bypassed (per-resource
 * access is enforced elsewhere); a scoped API key needs a matching
 * (resource, id, permission) entry, with a stored id of '*' matching anything.
 *
 * Throws ApiAuthError(403, 'scope_insufficient') on mismatch.
 */
export function requireScope(
  auth: ResolvedAuth,
  resource: ApiKeyResource,
  id: string,
  permission: ApiKeyPermission
): ScopeCheckResult {
  if (!auth.keyContext) {
    return { isLegacy: false };
  }

  if (
    Array.isArray(auth.keyContext.scopes) &&
    scopeMatches(auth.keyContext.scopes, resource, id, permission)
  ) {
    return { isLegacy: false };
  }

  throw new ApiAuthError(
    403,
    `insufficient scope: requires ${permission} on ${resource}:${id}`,
    {
      code: 'scope_insufficient',
      details: { resource, id, permission },
    }
  );
}

/**
 * Attach the advisory headers a scope-check result asks for (legacy-key
 * deprecation, version-missing). Single sink for every public-API advisory, so
 * a new one is wired here rather than at each route.
 */
export function applyAuthDeprecations(
  response: NextResponse,
  check: ScopeCheckResult
): NextResponse {
  if (check.isLegacy) {
    response.headers.append('X-Roost-Deprecation', 'legacy-key-scope-missing');
  }
  if (check.missingVersion) {
    response.headers.set('X-Roost-Version-Missing', 'true');
  }
  return response;
}

/**
 * Fire-and-forget `api_key_used` audit event. No-op for session/id-token auth.
 */
export function auditApiKeyUse(
  auth: ResolvedAuth,
  siteId: string,
  request: NextRequest,
): void {
  const kc = auth.keyContext;
  if (!kc) return;
  emitApiKeyUsed({
    siteId,
    keyId: kc.keyId,
    scopeFingerprint: scopeFingerprint(kc.scopes),
    environment: kc.environment ?? 'unknown',
    endpoint: request.nextUrl.pathname,
    method: request.method,
    isLegacy: kc.isLegacy,
  });
}

export async function requireSessionUser(
  request: NextRequest,
  userId: string
): Promise<string> {
  const sessionUserId = await requireSession(request);
  if (sessionUserId !== userId) {
    throw new ApiAuthError(403, 'Forbidden: User mismatch');
  }
  return sessionUserId;
}

function assertUserDataActive(
  userData: FirebaseFirestore.DocumentData | null
): asserts userData is FirebaseFirestore.DocumentData {
  if (!userData || typeof userData.deletedAt === 'number') {
    throw new ApiAuthError(403, 'Forbidden: User is deleted or inactive', {
      code: 'user_inactive',
    });
  }
}

export async function assertActiveUser(
  uid: string
): Promise<FirebaseFirestore.DocumentData> {
  const db = getAdminDb();
  const userDoc = await db.collection('users').doc(uid).get();
  const userData = userDoc.exists ? userDoc.data() ?? null : null;
  assertUserDataActive(userData);
  return userData;
}

/**
 * Thin adapter over the decision core in `lib/sitePolicy.server.ts`.
 *
 * The decision itself moved to `resolveSiteAccess` in Wave 1 Task 1.2 so one
 * implementation could serve both wrappers. This function keeps its signature
 * and its throw behaviour exactly, because two routes call it directly
 * (`app/api/cli/device-code/authorize`, `app/api/keys/_shared`) and much of the
 * suite mocks it. The three enrolment routes that used to call it —
 * setup/generate-token, agent/generate-installer, agent device-code authorize —
 * moved to `assertUserHasSiteCapability` in 77edefde. Preserve both when touching
 * this: the statuses and messages below are asserted across the suite, and
 * `code: 'user_inactive'` is specifically what lets `authorizedSiteHandler`
 * answer 403 instead of collapsing to 404.
 */
export async function assertUserHasSiteAccess(
  userId: string,
  siteId: string
): Promise<{ siteId: string; siteData: Record<string, unknown> | null }> {
  const outcome = await resolveSiteAccess(userId, siteId);

  if (!outcome.ok) {
    switch (outcome.reason) {
      case 'site_not_found':
        throw new ApiAuthError(404, 'Site not found');
      case 'user_inactive':
        throw new ApiAuthError(403, 'Forbidden: User is deleted or inactive', {
          code: 'user_inactive',
        });
      case 'no_access':
        throw new ApiAuthError(403, 'Forbidden: You do not have access to this site');
    }
  }

  return { siteId, siteData: outcome.facts.siteData };
}

/**
 * Site access AND a capability, for routes outside the `authorizedSiteHandler`
 * stack that still need a role check.
 *
 * `assertUserHasSiteAccess` alone stopped being sufficient when the per-site-roles
 * migration made `member` read-only: every route gating on bare membership
 * silently became a grant to a read-only tier. Reuses the same decision core and
 * the same capability matrix as the wrappers, so there is one answer to
 * "may this user do this here", not two.
 */
export async function assertUserHasSiteCapability(
  userId: string,
  siteId: string,
  capability: Capability,
): Promise<{ siteId: string; siteData: Record<string, unknown> | null }> {
  const result = await assertUserHasSiteAccess(userId, siteId);
  const outcome = await resolveSiteAccess(userId, siteId);
  const actor: Actor = {
    type: 'user',
    userId,
    role: outcome.facts.globalRole,
    ...siteStanding([[siteId, { role: outcome.facts.membershipRole, swoopMode: outcome.facts.swoopMode }]]),
  };
  if (!hasCapability(actor, capability, siteId)) {
    throw new ApiAuthError(403, 'Forbidden: capability not granted');
  }
  return result;
}
