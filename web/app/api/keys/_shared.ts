/**
 * Scope validation shared by POST /api/keys and PATCH /api/keys/{keyId}. They must agree
 * exactly: a looser PATCH is a privilege-escalation path, letting a caller edit into scopes
 * they could never be issued. One implementation makes that drift impossible.
 */
import type { NextResponse } from 'next/server';
import { assertUserHasSiteAccess } from '@/lib/apiAuth.server';
import { problemForbidden, problemValidation } from '@/lib/apiErrors';
import {
  ALL_RESOURCES,
  type ApiKeyPermission,
  type ApiKeyResource,
  type ApiKeyScope,
  SUPERADMIN_ONLY_RESOURCES,
  SUPERADMIN_ONLY_RESOURCES_LABEL,
} from '@/lib/apiKeyTypes';

export const VALID_RESOURCES: readonly ApiKeyResource[] = ALL_RESOURCES;
export const VALID_PERMISSIONS: readonly ApiKeyPermission[] = [
  'read',
  'write',
  'deploy',
  'rollback',
  'admin',
];
export const MAX_NAME_LENGTH = 100;
export const MAX_SCOPES = 50;
export const SITE_SCOPED_RESOURCES = new Set<ApiKeyResource>([
  'site',
  'chat',
  'deploy',
]);

/** Shape-check: returns normalised scopes, or a string describing the first problem (→ 400). */
export function validateScopes(raw: unknown): ApiKeyScope[] | string {
  if (!Array.isArray(raw) || raw.length === 0) {
    return 'scopes must be a non-empty array';
  }
  if (raw.length > MAX_SCOPES) {
    return `scopes array too large (max ${MAX_SCOPES})`;
  }
  const scopes: ApiKeyScope[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    if (!s || typeof s !== 'object') {
      return `scopes[${i}] must be an object`;
    }
    const scope = s as Record<string, unknown>;
    if (!VALID_RESOURCES.includes(scope.resource as ApiKeyResource)) {
      return `scopes[${i}].resource must be one of ${VALID_RESOURCES.join(', ')}`;
    }
    if (typeof scope.id !== 'string' || scope.id.length === 0 || scope.id.length > 128) {
      return `scopes[${i}].id must be a non-empty string (max 128 chars)`;
    }
    if (!Array.isArray(scope.permissions) || scope.permissions.length === 0) {
      return `scopes[${i}].permissions must be a non-empty array`;
    }
    const perms = new Set<ApiKeyPermission>();
    for (const p of scope.permissions) {
      if (!VALID_PERMISSIONS.includes(p as ApiKeyPermission)) {
        return `scopes[${i}].permissions contains invalid value (must be one of ${VALID_PERMISSIONS.join(', ')})`;
      }
      perms.add(p as ApiKeyPermission);
    }
    scopes.push({
      resource: scope.resource as ApiKeyResource,
      id: scope.id,
      permissions: Array.from(perms),
    });
  }
  return scopes;
}

/**
 * The three authorization gates a scope set must clear before it is written; returns a problem
 * response or null. Separate from {@link validateScopes} because these turn on *who is asking*
 * and hit Firestore.
 */
export async function assertScopesGrantable(
  userId: string,
  activeUserData: { role?: string | null },
  scopes: ApiKeyScope[],
): Promise<NextResponse | null> {
  // Platform-wide resources are all-or-nothing — a concrete id would imply scoping the
  // enforcement side doesn't model.
  const superadminScopeWithConcreteId = scopes.find(
    (scope) => SUPERADMIN_ONLY_RESOURCES.includes(scope.resource) && scope.id !== '*',
  );
  if (superadminScopeWithConcreteId) {
    return problemValidation(
      `${superadminScopeWithConcreteId.resource} scopes must use id "*"`,
    );
  }

  const needsSuperadminGrant = scopes.some((scope) =>
    SUPERADMIN_ONLY_RESOURCES.includes(scope.resource),
  );
  if (needsSuperadminGrant && (activeUserData.role ?? null) !== 'superadmin') {
    return problemForbidden(
      `superadmin access required to grant ${SUPERADMIN_ONLY_RESOURCES_LABEL} scopes`,
    );
  }

  // Runtime requireScope() enforces this too; checking here catches typos and keeps unusable
  // scopes out of storage.
  for (const scope of scopes) {
    if (SITE_SCOPED_RESOURCES.has(scope.resource) && scope.id !== '*') {
      await assertUserHasSiteAccess(userId, scope.id);
    }
  }

  return null;
}
