import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { withRateLimit } from '@/lib/withRateLimit';
import { emitMutation } from '@/lib/auditLogClient';
import {
  ApiAuthError,
  assertActiveUser,
  requireSessionOrIdToken,
} from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  mfaChallengeProblem,
  problem,
  problemFromError,
  problemTokenExpired,
  problemUnauthorized,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import {
  assertScopesGrantable,
  INVALID_MAX_TOOL_TIER,
  MAX_NAME_LENGTH,
  requireVerifiedSessionForToolTier,
  validateScopes,
} from './_shared';
import {
  type ApiKeyLookup,
  type ApiKeyRecord,
  type ApiKeyListItem,
  buildApiKeyListItem,
  DEFAULT_MAX_TOOL_TIER,
  isToolTier,
  MINTED_API_KEY_ENVIRONMENT,
  DEFAULT_TTL_DAYS,
  MAX_TTL_DAYS,
} from '@/lib/apiKeyTypes';

interface CreateKeyBody {
  name?: unknown;
  scopes?: unknown;
  ttlDays?: unknown;
  environment?: unknown;
  maxToolTier?: unknown;
}

/**
 * POST /api/keys — create a scoped API key.
 * Body: `{ name, scopes: [{resource, id, permissions[]}], ttlDays? (1-365,
 * default 90), environment? (ignored — every key is minted 'live'), maxToolTier?
 * (1-3, default 1; above 1 needs a verified session) }`.
 * Returns the raw key ONCE; only its SHA-256 hash is stored.
 */
export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      const userId = await requireSessionOrIdToken(request, { rejectAgentTokens: true });
      const activeUserData = await assertActiveUser(userId);

      let body: CreateKeyBody;
      try {
        body = (await request.json()) as CreateKeyBody;
      } catch {
        return problemValidation('request body must be valid json');
      }

      const name =
        typeof body.name === 'string' && body.name.trim().length > 0
          ? body.name.trim().slice(0, MAX_NAME_LENGTH)
          : null;
      if (!name) {
        return problemValidation('name is required');
      }

      const scopesResult = validateScopes(body.scopes);
      if (typeof scopesResult === 'string') {
        return problemValidation(scopesResult);
      }
      const scopes = scopesResult;

      const notGrantable = await assertScopesGrantable(userId, activeUserData, scopes);
      if (notGrantable) return notGrantable;

      const rawTtl = body.ttlDays === undefined ? DEFAULT_TTL_DAYS : body.ttlDays;
      if (typeof rawTtl !== 'number' || !Number.isFinite(rawTtl) || !Number.isInteger(rawTtl)) {
        return problemValidation('ttlDays must be an integer');
      }
      if (rawTtl < 1 || rawTtl > MAX_TTL_DAYS) {
        return problemValidation(`ttlDays must be between 1 and ${MAX_TTL_DAYS}`);
      }
      const ttlDays = rawTtl;

      const maxToolTier = body.maxToolTier === undefined ? DEFAULT_MAX_TOOL_TIER : body.maxToolTier;
      if (!isToolTier(maxToolTier)) {
        return problemValidation(INVALID_MAX_TOOL_TIER);
      }
      if (maxToolTier > DEFAULT_MAX_TOOL_TIER) {
        const unverified = await requireVerifiedSessionForToolTier(request, userId);
        if (unverified) return unverified;
      }

      // `body.environment` is ignored, not rejected: the shipped CLI and both
      // SDKs still send it, and 400-ing would break them over a no-op field.
      const environment = MINTED_API_KEY_ENVIRONMENT;

      // owk_live_<43 base64url chars>
      const keyRandom = crypto.randomBytes(32).toString('base64url');
      const rawKey = `owk_${environment}_${keyRandom}`;
      const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
      const keyId = crypto.randomUUID();
      const keyPrefix = rawKey.slice(0, 15);
      const now = Date.now();
      const expiresAt = now + ttlDays * 24 * 60 * 60 * 1000;

      const db = getAdminDb();
      const batch = db.batch();

      const record: Omit<ApiKeyRecord, 'createdAt'> & {
        createdAt: FirebaseFirestore.FieldValue;
      } = {
        name,
        keyHash,
        keyPrefix,
        environment,
        scopes,
        maxToolTier,
        expiresAt,
        createdAt: FieldValue.serverTimestamp(),
        lastUsedAt: null,
        // Written as null, never omitted: sweepExpiredApiKeys queries
        // `.where('expiredMarkedAt', '==', null)`, and a document missing the
        // field is not in the composite index at all, so it can never match.
        expiredMarkedAt: null,
      };

      batch.set(
        db.collection('users').doc(userId).collection('api_keys').doc(keyId),
        record
      );

      const lookup: ApiKeyLookup = {
        userId,
        keyId,
        environment,
        scopes,
        maxToolTier,
        expiresAt,
      };
      batch.set(db.collection('api_keys').doc(keyHash), lookup);

      await batch.commit();

      emitMutation({
        kind: 'api_key_mutated',
        siteId: '',
        actor: `user:${userId}`,
        targetId: keyId,
        attributes: {
          verb: 'create',
          endpoint: request.nextUrl.pathname,
          method: request.method,
          environment,
          keyPrefix,
          scopeCount: scopes.length,
          maxToolTier,
          ttlDays,
        },
      });

      return NextResponse.json({
        success: true,
        key: rawKey,
        keyId,
        name,
        environment,
        scopes,
        maxToolTier,
        expiresAt,
        keyPrefix,
      });
    } catch (error: unknown) {
      if (error instanceof ApiAuthError) {
        const refused = mfaChallengeProblem(error);
        if (refused) return refused;
        if (error.code === 'token_expired') {
          const expiredAt =
            typeof error.details?.expiredAt === 'number' ? error.details.expiredAt : undefined;
          return problemTokenExpired(expiredAt);
        }
        if (error.status === 401) {
          return problemUnauthorized(error.message);
        }
        return problem({
          type:
            error.status === 403
              ? ProblemType.Forbidden
              : ProblemType.ValidationFailed,
          title: error.status === 403 ? 'forbidden' : 'validation failed',
          status: error.status,
          detail: error.message,
        });
      }
      return problemFromError(error, 'api/keys:POST');
    }
  },
  { strategy: 'api', identifier: 'ip' }
);

/**
 * GET /api/keys
 *
 * List the authenticated user's own API keys (metadata only — never the
 * raw key or hash).
 */
export const GET = withRateLimit(
  async (request: NextRequest) => {
    try {
      const userId = await requireSessionOrIdToken(request);
      const db = getAdminDb();

      const snap = await db
        .collection('users')
        .doc(userId)
        .collection('api_keys')
        .orderBy('createdAt', 'desc')
        .get();

      // One instant for the whole listing, so keys either side of the expiry
      // boundary aren't classified against different "now"s.
      const listedAt = Date.now();
      const keys: ApiKeyListItem[] = snap.docs.map((doc) =>
        buildApiKeyListItem(doc.id, doc.data() as Record<string, unknown>, listedAt)
      );

      return NextResponse.json({ success: true, keys });
    } catch (error: unknown) {
      if (error instanceof ApiAuthError) {
        const refused = mfaChallengeProblem(error);
        if (refused) return refused;
        if (error.code === 'token_expired') {
          const expiredAt =
            typeof error.details?.expiredAt === 'number' ? error.details.expiredAt : undefined;
          return problemTokenExpired(expiredAt);
        }
        if (error.status === 401) {
          return problemUnauthorized(error.message);
        }
        return problem({
          type: ProblemType.Forbidden,
          title: 'forbidden',
          status: error.status,
          detail: error.message,
        });
      }
      return problemFromError(error, 'api/keys:GET');
    }
  },
  { strategy: 'api', identifier: 'ip' }
);
