/**
 * POST /api/cli/device-code/authorize — CLI device-code handshake, step 2 of 3
 * (browser side). A signed-in user at /cli/authorize?code=<phrase> picks scopes
 * + ttl; this mints an owk_* key and stashes it on `cli_device_codes/{phrase}`
 * for the CLI's /poll.
 *
 * Body: `{ code, name, scopes, ttlDays? (default 90, max 365), environment? }`
 * (`environment` is ignored — every key is minted 'live').
 * Returns `{ success: true, keyId, keyPrefix }`; session cookie required.
 *
 * Audits `api_key_mutated` / `create` on the same shape as POST /api/keys — the raw
 * key, its hash and the pairing phrase never reach the audit row.
 */
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { withRateLimit } from '@/lib/withRateLimit';
import { emitMutation } from '@/lib/auditLogClient';
import {
  ApiAuthError,
  assertActiveUser,
  assertUserHasSiteAccess,
  requireSessionOrIdToken,
} from '@/lib/apiAuth.server';
import { requireApiKeyMintPlan } from '@/app/api/_shared';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  DEVICE_CODE_WRAP_VERSION,
  encryptDeviceCodeCredentials,
} from '@/lib/deviceCodeCrypto';
import {
  ALL_RESOURCES,
  type ApiKeyLookup,
  type ApiKeyPermission,
  type ApiKeyRecord,
  type ApiKeyResource,
  type ApiKeyScope,
  DEFAULT_TTL_DAYS,
  MAX_TTL_DAYS,
  MINTED_API_KEY_ENVIRONMENT,
  SUPERADMIN_ONLY_RESOURCES,
} from '@/lib/apiKeyTypes';
import {
  problem,
  problemForbidden,
  problemFromError,
  problemNotFound,
  problemTokenExpired,
  problemUnauthorized,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';

const VALID_RESOURCES: readonly ApiKeyResource[] = ALL_RESOURCES;
const VALID_PERMISSIONS: readonly ApiKeyPermission[] = [
  'read',
  'write',
  'deploy',
  'rollback',
  'admin',
];
const MAX_SCOPES = 50;
const SITE_SCOPED_RESOURCES = new Set<ApiKeyResource>(['site', 'chat', 'deploy']);

interface AuthorizeBody {
  code?: unknown;
  name?: unknown;
  scopes?: unknown;
  ttlDays?: unknown;
  environment?: unknown;
}

type AuthorizeTransactionResult =
  | { ok: true; keyId: string; keyPrefix: string }
  | { ok: false; response: NextResponse };

function validateScopes(raw: unknown): ApiKeyScope[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'scopes must be a non-empty array';
  if (raw.length > MAX_SCOPES) return `scopes array too large (max ${MAX_SCOPES})`;
  const out: ApiKeyScope[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    if (!s || typeof s !== 'object') return `scopes[${i}] must be an object`;
    const scope = s as Record<string, unknown>;
    if (!VALID_RESOURCES.includes(scope.resource as ApiKeyResource)) {
      return `scopes[${i}].resource invalid`;
    }
    if (typeof scope.id !== 'string' || scope.id.length === 0 || scope.id.length > 128) {
      return `scopes[${i}].id must be a non-empty string (max 128 chars)`;
    }
    if (!Array.isArray(scope.permissions) || scope.permissions.length === 0) {
      return `scopes[${i}].permissions required`;
    }
    const perms = new Set<ApiKeyPermission>();
    for (const p of scope.permissions) {
      if (!VALID_PERMISSIONS.includes(p as ApiKeyPermission)) {
        return `scopes[${i}].permissions contains invalid value`;
      }
      perms.add(p as ApiKeyPermission);
    }
    out.push({
      resource: scope.resource as ApiKeyResource,
      id: scope.id,
      permissions: Array.from(perms),
    });
  }
  return out;
}

export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      const userId = await requireSessionOrIdToken(request);
      const activeUserData = await assertActiveUser(userId);

      const planError = await requireApiKeyMintPlan(userId);
      if (planError) return planError;

      const body = (await request.json().catch(() => ({}))) as AuthorizeBody;

      const code = typeof body.code === 'string' ? body.code.toLowerCase().trim() : '';
      if (!code) {
        return problemValidation('code is required', { 'body.code': ['required'] });
      }

      const name =
        typeof body.name === 'string' && body.name.trim().length > 0
          ? body.name.trim().slice(0, 100)
          : null;
      if (!name) {
        return problemValidation('name is required', { 'body.name': ['required'] });
      }

      const scopesResult = validateScopes(body.scopes);
      if (typeof scopesResult === 'string') {
        return problemValidation(scopesResult, { 'body.scopes': [scopesResult] });
      }
      const scopes = scopesResult;

      const superadminScopeWithConcreteId = scopes.find(
        (scope) =>
          SUPERADMIN_ONLY_RESOURCES.includes(scope.resource) &&
          scope.id !== '*',
      );
      if (superadminScopeWithConcreteId) {
        return problemValidation(
          `${superadminScopeWithConcreteId.resource} scopes must use id "*"`,
          {
            'body.scopes': [
              `${superadminScopeWithConcreteId.resource} scope must use id "*"`,
            ],
          },
        );
      }

      const db = getAdminDb();
      const needsSuperadminGrant = scopes.some((scope) =>
        SUPERADMIN_ONLY_RESOURCES.includes(scope.resource),
      );
      if (needsSuperadminGrant) {
        const role = activeUserData.role ?? null;
        if (role !== 'superadmin') {
          return problemForbidden(
            'superadmin access required to create user or installer scopes',
          );
        }
      }

      const rawTtl = body.ttlDays === undefined ? DEFAULT_TTL_DAYS : body.ttlDays;
      if (
        typeof rawTtl !== 'number' ||
        !Number.isFinite(rawTtl) ||
        !Number.isInteger(rawTtl) ||
        rawTtl < 1 ||
        rawTtl > MAX_TTL_DAYS
      ) {
        return problemValidation(
          `ttlDays must be an integer between 1 and ${MAX_TTL_DAYS}`,
          { 'body.ttlDays': [`must be an integer between 1 and ${MAX_TTL_DAYS}`] },
        );
      }
      const ttlDays = rawTtl;

      // `body.environment` is accepted and ignored, not rejected: shipped
      // @owlette/cli still sends it and nothing branches on the value.
      const environment = MINTED_API_KEY_ENVIRONMENT;

      // Defense-in-depth: validate site-scoped ids against the caller's access.
      for (const scope of scopes) {
        if (SITE_SCOPED_RESOURCES.has(scope.resource) && scope.id !== '*') {
          await assertUserHasSiteAccess(userId, scope.id);
        }
      }

      const codeRef = db.collection('cli_device_codes').doc(code);
      const transactionResult = await db.runTransaction(
        async (transaction): Promise<AuthorizeTransactionResult> => {
          const codeSnap = await transaction.get(codeRef);
          if (!codeSnap.exists) {
            return { ok: false, response: problemNotFound('invalid or expired pairing phrase') };
          }
          const codeData = codeSnap.data() ?? {};
          const expiresAtMs = codeData.expiresAt?.toMillis?.() ?? 0;
          if (Date.now() > expiresAtMs) {
            return {
              ok: false,
              response: problem({
                type: ProblemType.PreconditionFailed,
                title: 'pairing phrase expired',
                status: 410,
                detail: 'pairing phrase expired',
                code: 'pairing_phrase_expired',
              }),
            };
          }
          if (codeData.status !== 'pending') {
            return {
              ok: false,
              response: problem({
                type: ProblemType.Conflict,
                title: 'pairing phrase already authorised',
                status: 409,
                detail: 'pairing phrase has already been authorised',
                code: 'pairing_phrase_already_authorized',
              }),
            };
          }

          // Mint the scoped api key.
          const keyRandom = crypto.randomBytes(32).toString('base64url');
          const rawKey = `owk_${environment}_${keyRandom}`;
          const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
          const keyId = crypto.randomUUID();
          const keyPrefix = rawKey.slice(0, 15);
          const now = Date.now();
          const keyExpiresAt = now + ttlDays * 24 * 60 * 60 * 1000;

          const primarySite =
            scopes.find((s) => SITE_SCOPED_RESOURCES.has(s.resource) && s.id !== '*')?.id ??
            null;

          const record: Omit<ApiKeyRecord, 'createdAt'> & {
            createdAt: FirebaseFirestore.FieldValue;
          } = {
            name,
            keyHash,
            keyPrefix,
            environment,
            scopes,
            expiresAt: keyExpiresAt,
            createdAt: FieldValue.serverTimestamp(),
            lastUsedAt: null,
            // Null, never omitted — see the field's note in apiKeyTypes.ts; the
            // daily sweep's `== null` filter cannot match a document without it.
            expiredMarkedAt: null,
          };
          transaction.set(
            db.collection('users').doc(userId).collection('api_keys').doc(keyId),
            record,
          );

          const lookup: ApiKeyLookup = {
            userId,
            keyId,
            environment,
            scopes,
            expiresAt: keyExpiresAt,
          };
          transaction.set(db.collection('api_keys').doc(keyHash), lookup);

          // Encrypt the raw key + /poll metadata under a key derived from the
          // cli's polling deviceCode, and wipe the cleartext deviceCode in the
          // same write — so recovering the api key from the doc at rest requires
          // the cli's process memory.
          //
          // Docs without wrapVersion v1 (created before this shipped) carry no
          // deviceCode and cannot be encrypted: store rawKey cleartext and let
          // the legacy poll path return it.
          const supportsEncryption =
            codeData.wrapVersion === DEVICE_CODE_WRAP_VERSION &&
            typeof codeData.deviceCode === 'string' &&
            codeData.deviceCode.length > 0;

          if (supportsEncryption) {
            const encryptedCredentials = encryptDeviceCodeCredentials(
              {
                apiKey: rawKey,
                keyId,
                name,
                scopes,
                environment,
                expiresAt: keyExpiresAt,
                siteId: primarySite,
              },
              codeData.deviceCode,
              code,
            );
            transaction.update(codeRef, {
              status: 'authorized',
              authorizedBy: userId,
              authorizedAt: FieldValue.serverTimestamp(),
              keyId,
              name,
              scopes,
              environment,
              keyExpiresAt,
              siteId: primarySite,
              wrapVersion: DEVICE_CODE_WRAP_VERSION,
              encryptedCredentials,
              // Wipe key material from the doc at rest.
              deviceCode: FieldValue.delete(),
              rawKey: FieldValue.delete(),
            });
          } else {
            transaction.update(codeRef, {
              status: 'authorized',
              authorizedBy: userId,
              authorizedAt: FieldValue.serverTimestamp(),
              keyId,
              name,
              scopes,
              environment,
              keyExpiresAt,
              siteId: primarySite,
              rawKey,
            });
          }

          return { ok: true, keyId, keyPrefix };
        },
      );

      if (!transactionResult.ok) {
        return transactionResult.response;
      }

      // After the commit, never inside it: a retried transaction attempt would
      // otherwise emit a row for a key that was never persisted.
      emitMutation({
        kind: 'api_key_mutated',
        siteId: '',
        actor: `user:${userId}`,
        targetId: transactionResult.keyId,
        attributes: {
          verb: 'create',
          endpoint: request.nextUrl.pathname,
          method: request.method,
          environment,
          keyPrefix: transactionResult.keyPrefix,
          scopeCount: scopes.length,
          ttlDays,
          // Distinguishes this grant from a dashboard-minted key (POST /api/keys):
          // the holder is a CLI on another machine, authorized over a device code.
          grant: 'cli_device_code',
        },
      });

      return NextResponse.json({
        success: true,
        keyId: transactionResult.keyId,
        keyPrefix: transactionResult.keyPrefix,
      });
    } catch (error: unknown) {
      if (error instanceof ApiAuthError) {
        if (error.code === 'token_expired') {
          const expiredAt =
            typeof error.details?.expiredAt === 'number' ? error.details.expiredAt : undefined;
          return problemTokenExpired(expiredAt);
        }
        if (error.status === 401) {
          return problemUnauthorized(error.message);
        }
        if (error.status === 403) {
          return problemForbidden(error.message);
        }
        if (error.status === 404) {
          return problemNotFound(error.message);
        }
        return problem({
          type: ProblemType.ValidationFailed,
          title: 'request failed',
          status: error.status,
          detail: error.message,
        });
      }
      return problemFromError(error, 'cli/device-code/authorize');
    }
  },
  { strategy: 'user', identifier: 'ip' },
);
