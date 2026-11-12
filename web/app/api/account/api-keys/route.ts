import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { withRateLimit } from '@/lib/withRateLimit';
import { emitMutation } from '@/lib/auditLogClient';
import { getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';
import { authorizedPlatformHandler } from '@/lib/authorizedHandler.server';
import {
  ALL_RESOURCES,
  DEFAULT_TTL_DAYS,
  type ApiKeyEnvironment,
  type ApiKeyLookup,
  type ApiKeyPermission,
  type ApiKeyRecord,
  type ApiKeyScope,
} from '@/lib/apiKeyTypes';

const ACCOUNT_ADMIN_PERMISSIONS: ApiKeyPermission[] = [
  'read',
  'write',
  'deploy',
  'rollback',
  'admin',
];

function defaultAccountScopes(): ApiKeyScope[] {
  return ALL_RESOURCES.map((resource) => ({
    resource,
    id: '*',
    permissions: [...ACCOUNT_ADMIN_PERMISSIONS],
  }));
}

function cloneScopes(scopes: ApiKeyScope[] | null | undefined): ApiKeyScope[] {
  if (!scopes || scopes.length === 0) {
    return defaultAccountScopes();
  }
  return scopes.map((scope) => ({
    resource: scope.resource,
    id: scope.id,
    permissions: [...scope.permissions],
  }));
}

function auditActor(userId: string, keyId?: string): string {
  return keyId ? `apiKey:${keyId}` : `user:${userId}`;
}

/**
 * GET /api/account/api-keys — active keys for the authenticated superadmin.
 * Metadata only; never the raw key or its hash.
 */
export const GET = withRateLimit(
  authorizedPlatformHandler({
    capability: 'GLOBAL_SETTINGS_WRITE',
  })(async (_request: NextRequest, ctx) => {
    try {
      const userId = ctx.actor.userId;
      const db = getAdminDb();

      const keysSnap = await db
        .collection('users')
        .doc(userId)
        .collection('api_keys')
        .orderBy('createdAt', 'desc')
        .get();

      const keys = keysSnap.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          name: data.name,
          keyPrefix: data.keyPrefix,
          environment: data.environment ?? null,
          scopes: data.scopes ?? null,
          expiresAt: data.expiresAt ?? null,
          createdAt: data.createdAt,
          lastUsedAt: data.lastUsedAt,
        };
      });

      return NextResponse.json({ success: true, keys });
    } catch (error: unknown) {
      return apiError(error, 'account/api-keys');
    }
  }),
  { strategy: 'api', identifier: 'ip' },
);

/**
 * POST /api/account/api-keys — mint a key for the authenticated superadmin.
 * The raw key is returned once; only its SHA-256 hash is stored.
 */
export const POST = withRateLimit(
  authorizedPlatformHandler({
    capability: 'GLOBAL_SETTINGS_WRITE',
  })(async (request: NextRequest, ctx) => {
    const userId = ctx.actor.userId;

    try {
      const body = await request.json().catch(() => ({}));
      const name = body.name || 'API Key';
      const environment: ApiKeyEnvironment = 'live';
      const scopes = cloneScopes(ctx.auth.keyContext?.scopes);

      const rawKey = `owk_${environment}_${crypto.randomBytes(32).toString('base64url')}`;
      const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
      const keyId = crypto.randomUUID();
      const keyPrefix = rawKey.slice(0, 15);
      const expiresAt = Date.now() + DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000;

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
        expiresAt,
        createdAt: FieldValue.serverTimestamp(),
        lastUsedAt: null,
        // Null, never omitted — see the field's note in apiKeyTypes.ts; the
        // daily sweep's `== null` filter cannot match a document without it.
        expiredMarkedAt: null,
      };

      batch.set(
        db.collection('users').doc(userId).collection('api_keys').doc(keyId),
        record,
      );

      const lookup: ApiKeyLookup = {
        userId,
        keyId,
        environment,
        scopes,
        expiresAt,
      };
      batch.set(
        db.collection('api_keys').doc(keyHash),
        lookup,
      );

      await batch.commit();

      emitMutation({
        kind: 'api_key_mutated',
        siteId: '',
        actor: auditActor(userId, ctx.auth.keyContext?.keyId),
        targetId: keyId,
        attributes: {
          verb: 'create',
          endpoint: request.nextUrl.pathname,
          method: request.method,
          environment,
          keyPrefix,
          scopeCount: scopes.length,
          inheritedFromCallerKey: Boolean(ctx.auth.keyContext),
        },
      });

      return NextResponse.json({
        success: true,
        key: rawKey,
        keyId,
        name,
        environment,
        scopes,
        expiresAt,
        keyPrefix,
      });
    } catch (error: unknown) {
      return apiError(error, 'account/api-keys:create');
    }
  }),
  { strategy: 'api', identifier: 'ip' },
);
