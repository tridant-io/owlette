import { NextRequest, NextResponse } from 'next/server';
import {
  ApiAuthError,
  assertActiveUser,
  requireSessionOrIdToken,
} from '@/lib/apiAuth.server';
import { withRateLimit } from '@/lib/withRateLimit';
import {
  type ApiKeyRecord,
  type ApiKeyScope,
  buildApiKeyListItem,
  isToolTier,
  normalizeMaxToolTier,
} from '@/lib/apiKeyTypes';
import type { ToolTier } from '@/lib/mcp-tools';
import {
  assertScopesGrantable,
  INVALID_MAX_TOOL_TIER,
  MAX_NAME_LENGTH,
  requireVerifiedSessionForToolTier,
  validateScopes,
} from '../_shared';
import { emitMutation, scopeFingerprint } from '@/lib/auditLogClient';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  mfaChallengeProblem,
  problem,
  problemFromError,
  problemNotFound,
  problemTokenExpired,
  problemUnauthorized,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';

interface RouteParams {
  params: Promise<{ keyId: string }>;
}

/**
 * DELETE /api/keys/{keyId} — revoke the authenticated user's own API key.
 *
 * A soft delete: both the user subcollection doc and the top-level
 * `api_keys/{keyHash}` lookup survive, each stamped `revokedAt`. This fails closed
 * exactly as immediately as the old hard delete — `resolveApiKeyContext` reads the
 * lookup live with no cache and checks `revokedAt` *before* `retiresAt` and
 * `expiresAt` (apiAuth.server.ts) — while keeping the keyHash→userId mapping, so a
 * post-revocation replay is still attributable to the key and the owner it came
 * from. It is also the state the documented rollback in
 * docs/runbooks/upgrade-2.12.0.md restores from.
 *
 * The lookup write is a merge-set, never `update`: a batched `update()` against a
 * missing document fails the ENTIRE commit with NOT_FOUND, and the lookup can
 * legitimately be absent for very old keys (see the tolerated failure at
 * userDeleteCascade.server.ts). Splitting it out into a fire-and-forget `.catch()`
 * would be worse still — it can leave a key neither revoked nor deleted, fully
 * authenticating, while the UI reports success.
 *
 * `Date.now()`, not `serverTimestamp()`: `ApiKeyRecord.revokedAt` is a number, and
 * the auth path compares it as one.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const userId = await requireSessionOrIdToken(request);
    const { keyId } = await params;

    if (!keyId || typeof keyId !== 'string') {
      return problemValidation('keyId is required');
    }

    const db = getAdminDb();
    const keyRef = db
      .collection('users')
      .doc(userId)
      .collection('api_keys')
      .doc(keyId);
    const keySnap = await keyRef.get();

    if (!keySnap.exists) {
      return problemNotFound('api key not found');
    }

    const existing = keySnap.data() as Partial<ApiKeyRecord> | undefined;

    // Idempotent: a second revoke is a no-op, not a re-stamp. Truthiness rather
    // than a `typeof number` check, matching the auth path — anything already
    // stamped there is already failing closed, and overwriting it would move the
    // audit trail's answer to "when did this key stop working". No mutation
    // happened, so no mutation is emitted.
    if (existing?.revokedAt) {
      return NextResponse.json({ success: true });
    }

    const keyHash = existing?.keyHash;
    const revokedAt = Date.now();
    const batch = db.batch();
    batch.update(keyRef, { revokedAt });
    if (keyHash && typeof keyHash === 'string') {
      batch.set(db.collection('api_keys').doc(keyHash), { revokedAt }, { merge: true });
    }
    await batch.commit();

    emitMutation({
      kind: 'api_key_mutated',
      siteId: '',
      actor: `user:${userId}`,
      targetId: keyId,
      attributes: {
        verb: 'revoke',
        endpoint: request.nextUrl.pathname,
        method: request.method,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    if (error instanceof ApiAuthError) {
      const refused = mfaChallengeProblem(error);
      if (refused) return refused;
      if (error.code === 'token_expired') {
        const expiredAt =
          typeof error.details?.expiredAt === 'number' ? error.details.expiredAt : undefined;
        return problemTokenExpired(expiredAt);
      }
      if (error.status === 401) return problemUnauthorized(error.message);
      return problem({
        type: ProblemType.Forbidden,
        title: 'forbidden',
        status: error.status,
        detail: error.message,
      });
    }
    return problemFromError(error, 'api/keys/[keyId]:DELETE');
  }
}

/**
 * PATCH /api/keys/{keyId} — edit an existing key's scopes, name and/or tool tier in place
 * without reissuing the secret. Body `{ scopes?: Scope[], name?: string, maxToolTier?: 1|2|3 }`;
 * `scopes` is a full replacement, not a merge. Raising `maxToolTier` needs a verified session;
 * lowering it needs nothing more than the edit does.
 *
 * Both documents are written in one batch, and that is not optional: authorization reads
 * scopes exclusively from the denormalised `api_keys/{keyHash}` lookup
 * (apiAuth.server.ts:185,230), so updating only the user doc would leave the credential
 * on its old permissions while the dashboard claimed otherwise. No cache fronts the
 * lookup, so the commit takes effect on the very next request.
 *
 * Validation reuses POST's (`./_shared`) — a looser PATCH would be a privilege-escalation
 * path around the superadmin gate. Auth mirrors POST (`rejectAgentTokens` +
 * `assertActiveUser`), not DELETE, which has neither.
 *
 * 409 on a rotated or revoked key: both have a successor or terminal state to act on
 * instead, and editing inside a rotation grace window would change the predecessor's
 * powers out from under whoever still holds it.
 */
export const PATCH = withRateLimit(
  async (request: NextRequest, { params }: RouteParams) => {
    try {
      const userId = await requireSessionOrIdToken(request, { rejectAgentTokens: true });
      const activeUserData = await assertActiveUser(userId);
      const { keyId } = await params;

      if (!keyId || typeof keyId !== 'string') {
        return problemValidation('keyId is required');
      }

      let body: {
        scopes?: unknown;
        name?: unknown;
        environment?: unknown;
        ttlDays?: unknown;
        maxToolTier?: unknown;
      };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return problemValidation('request body must be valid json');
      }

      if (body.environment !== undefined) {
        return problemValidation('environment cannot be changed — rotate or create a new key');
      }
      if (body.ttlDays !== undefined) {
        return problemValidation('ttlDays cannot be changed — rotate to extend expiry');
      }

      const wantsScopes = body.scopes !== undefined;
      const wantsName = body.name !== undefined;
      const wantsToolTier = body.maxToolTier !== undefined;
      if (!wantsScopes && !wantsName && !wantsToolTier) {
        return problemValidation('nothing to update — provide scopes, name and/or maxToolTier');
      }

      let maxToolTier: ToolTier | null = null;
      if (wantsToolTier) {
        if (!isToolTier(body.maxToolTier)) {
          return problemValidation(INVALID_MAX_TOOL_TIER);
        }
        maxToolTier = body.maxToolTier;
      }

      let scopes: ApiKeyScope[] | null = null;
      if (wantsScopes) {
        const result = validateScopes(body.scopes);
        if (typeof result === 'string') {
          return problemValidation(result);
        }
        scopes = result;
        const notGrantable = await assertScopesGrantable(userId, activeUserData, scopes);
        if (notGrantable) return notGrantable;
      }

      let name: string | null = null;
      if (wantsName) {
        if (typeof body.name !== 'string' || body.name.trim().length === 0) {
          return problemValidation('name must be a non-empty string');
        }
        name = body.name.trim().slice(0, MAX_NAME_LENGTH);
      }

      const db = getAdminDb();
      const keyRef = db.collection('users').doc(userId).collection('api_keys').doc(keyId);
      const keySnap = await keyRef.get();
      if (!keySnap.exists) {
        return problemNotFound('api key not found');
      }
      const existing = keySnap.data() as Partial<ApiKeyRecord> & { revokedAt?: number };

      if (existing.revokedAt) {
        return problem({
          type: ProblemType.Conflict,
          title: 'key revoked',
          status: 409,
          detail: 'this key has been revoked and cannot be edited',
        });
      }
      if (existing.rotatedAt) {
        return problem({
          type: ProblemType.Conflict,
          title: 'key rotated',
          status: 409,
          detail: 'this key was rotated — edit its successor instead',
        });
      }
      if (!existing.keyHash) {
        return problemFromError(
          new Error(`api key ${keyId} has no keyHash; cannot update its lookup document`),
          'api/keys/[keyId]:PATCH',
        );
      }

      const toolTierBefore = normalizeMaxToolTier(existing.maxToolTier);
      if (maxToolTier !== null && maxToolTier > toolTierBefore) {
        const unverified = await requireVerifiedSessionForToolTier(request, userId);
        if (unverified) return unverified;
      }

      const patch: Record<string, unknown> = {};
      if (scopes) patch.scopes = scopes;
      if (name) patch.name = name;
      if (maxToolTier !== null) patch.maxToolTier = maxToolTier;

      const batch = db.batch();
      batch.update(keyRef, patch);
      // The lookup carries only the enforcement-relevant half. `name` is
      // display-only and is not denormalised there.
      const lookupPatch: Record<string, unknown> = {};
      if (scopes) lookupPatch.scopes = scopes;
      if (maxToolTier !== null) lookupPatch.maxToolTier = maxToolTier;
      if (Object.keys(lookupPatch).length > 0) {
        batch.update(db.collection('api_keys').doc(existing.keyHash), lookupPatch);
      }
      await batch.commit();

      emitMutation({
        kind: 'api_key_mutated',
        siteId: '',
        actor: `user:${userId}`,
        targetId: keyId,
        attributes: {
          verb: 'update',
          endpoint: request.nextUrl.pathname,
          method: request.method,
          changedFields: Object.keys(patch).sort().join(','),
          // Fingerprints, never raw scopes — the audit log is broadly readable and a scope list is
          // a map of what the key can reach. The counts ride along because the fingerprint is
          // opaque: they make a key going from one scope to nine visible on a scan.
          ...(scopes
            ? {
                scopeFingerprintBefore: scopeFingerprint(existing.scopes ?? null),
                scopeFingerprintAfter: scopeFingerprint(scopes),
                scopeCountBefore: (existing.scopes ?? []).length,
                scopeCountAfter: scopes.length,
              }
            : {}),
          ...(maxToolTier !== null
            ? { maxToolTierBefore: toolTierBefore, maxToolTierAfter: maxToolTier }
            : {}),
        },
      });

      const updated = buildApiKeyListItem(
        keyId,
        { ...existing, ...patch } as Record<string, unknown>,
        Date.now(),
      );
      return NextResponse.json({ success: true, key: updated });
    } catch (error: unknown) {
      if (error instanceof ApiAuthError) {
        const refused = mfaChallengeProblem(error);
        if (refused) return refused;
        if (error.code === 'token_expired') {
          const expiredAt =
            typeof error.details?.expiredAt === 'number' ? error.details.expiredAt : undefined;
          return problemTokenExpired(expiredAt);
        }
        if (error.status === 401) return problemUnauthorized(error.message);
        return problem({
          type: ProblemType.Forbidden,
          title: 'forbidden',
          status: error.status,
          detail: error.message,
        });
      }
      return problemFromError(error, 'api/keys/[keyId]:PATCH');
    }
  },
  { strategy: 'api', identifier: 'ip' },
);
