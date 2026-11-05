export type ApiKeyPermission = 'read' | 'write' | 'deploy' | 'rollback' | 'admin';
export type ApiKeyResource =
  | 'roost'
  | 'site'
  | 'machine'
  // api-sprint additions:
  | 'chat' // site-scoped hoot conversations
  | 'deploy' // site-scoped classic-installer deploys (distinct from the `deploy` permission on roosts)
  | 'process' // machine-scoped process management
  | 'user' // platform-wide user administration (superadmin)
  | 'installer' // platform-wide installer-binary management (superadmin)
  | 'issue'; // platform-wide issue triage (superadmin)
/**
 * `test` is kept in the union although nothing mints it: it is the second
 * component of the idempotency cache key (`hashCacheKey(userId, environment,
 * key, routeScope)`, lib/idempotency.ts), so narrowing would re-namespace
 * idempotency for every existing `owk_test_*` key and orphan its cached
 * responses. It never gated authorization. New mints are forced to `live`.
 */
export type ApiKeyEnvironment = 'live' | 'test';

/**
 * Environment for every newly minted key. Never read from user input — a request
 * may still send `environment` (the shipped CLI and both SDKs do) and it is
 * ignored rather than rejected. Rotation inherits the old key's value instead.
 */
export const MINTED_API_KEY_ENVIRONMENT: ApiKeyEnvironment = 'live';

/** Canonical accepted resource types; imported by route validators and the scope picker so the allowlist can't drift. */
export const ALL_RESOURCES: readonly ApiKeyResource[] = [
  'roost',
  'site',
  'machine',
  'chat',
  'deploy',
  'process',
  'user',
  'installer',
  'issue',
];

/** Resources only a superadmin may grant; route validators reject the rest. */
export const SUPERADMIN_ONLY_RESOURCES: readonly ApiKeyResource[] = ['user', 'installer', 'issue'];

/** The superadmin-only resources as prose ("user, installer or issue"), for 403 details. */
export const SUPERADMIN_ONLY_RESOURCES_LABEL = `${SUPERADMIN_ONLY_RESOURCES.slice(0, -1).join(', ')} or ${
  SUPERADMIN_ONLY_RESOURCES[SUPERADMIN_ONLY_RESOURCES.length - 1]
}`;

export interface ApiKeyScope {
  resource: ApiKeyResource;
  /** Specific resource ID or '*' for all resources of this type */
  id: string;
  permissions: ApiKeyPermission[];
}

/** Stored in users/{userId}/api_keys/{keyId}. Raw key is never stored — SHA-256 hash only. */
export interface ApiKeyRecord {
  name: string;
  keyHash: string;
  /** First 15 chars of raw key for display (e.g. "owk_live_XXXXXXX") */
  keyPrefix: string;
  environment: ApiKeyEnvironment;
  scopes: ApiKeyScope[];
  /** Unix milliseconds. Keys MUST have an expiration (default 90d, max 365d). */
  expiresAt: number;
  createdAt: FirebaseFirestore.Timestamp | number;
  lastUsedAt: FirebaseFirestore.Timestamp | number | null;
  /** Set when this key was rotated. The old key's retiresAt = rotatedAt + 24h. */
  rotatedAt?: number;
  rotatedFromKeyId?: string;
  /** When the old key stops working after rotation (rotatedAt + 24 hours). */
  retiresAt?: number;
  /** Set on revocation. Revoke is a soft delete — the record and its lookup both survive. */
  revokedAt?: number;
  /**
   * Expiry-notice ladder stages (days-before-expiry) already emailed for this key,
   * written by `GET /api/cron/api-key-expiry` BEFORE each send so a scheduler retry
   * cannot loop. Lives here and NEVER on {@link ApiKeyLookup}: that doc is read on
   * every authenticated API request and must not carry notification bookkeeping.
   */
  expiryNoticedStages?: number[];
  /**
   * Set by the daily `sweepExpiredApiKeys` function once it has reaped this key's
   * lookup doc. **Every mint path must write it as `null`**, and that is not
   * cosmetic: the sweep's query is `.where('expiredMarkedAt', '==', null)`, which
   * only matches documents where the field exists, and a document missing an
   * indexed field is absent from the composite index entirely. Omitting it makes
   * the whole sweep inert (it was, until this was added).
   */
  expiredMarkedAt?: number | null;
}

/** Stored in api_keys/{keyHash}: denormalized lookup table for O(1) auth, no join. */
export interface ApiKeyLookup {
  userId: string;
  keyId: string;
  environment: ApiKeyEnvironment;
  /** Denormalized copy of scopes for fast enforcement without a second read. */
  scopes: ApiKeyScope[];
  expiresAt: number;
  /** Set during rotation grace period. Old key valid until retiresAt. */
  retiresAt?: number;
}

export type ApiKeyScopePreset = 'readonly' | 'publisher' | 'operator' | 'admin';

/** Wildcard scopes for common operator resources. */
function wildcardScopes(permissions: ApiKeyPermission[]): ApiKeyScope[] {
  return (['roost', 'site', 'machine', 'chat'] as ApiKeyResource[]).map((resource) => ({
    resource,
    id: '*',
    permissions,
  }));
}

export const SCOPE_PRESETS: Record<ApiKeyScopePreset, ApiKeyScope[]> = {
  readonly: wildcardScopes(['read']),
  publisher: wildcardScopes(['read', 'write']),
  operator: wildcardScopes(['read', 'write', 'deploy', 'rollback']),
  admin: wildcardScopes(['read', 'write', 'deploy', 'rollback', 'admin']),
};

/** Ordered preset keys for scope pickers (excludes the synthetic "custom" option). */
export const SCOPE_PRESET_KEYS: readonly ApiKeyScopePreset[] = [
  'readonly',
  'publisher',
  'operator',
  'admin',
];

/**
 * Display labels. The keys are code identifiers (they index SCOPE_PRESETS and are
 * `<SelectItem value>`), and rendering them raw leaked `readonly` into the UI.
 * Purely presentational — a preset expands to `scopes` before the POST.
 */
export const SCOPE_PRESET_LABELS: Record<ApiKeyScopePreset, string> = {
  readonly: 'read only',
  publisher: 'publisher',
  operator: 'operator',
  admin: 'admin',
};

/** Human-readable descriptions of each preset, shared across every scope picker. */
export const SCOPE_PRESET_DESCRIPTIONS: Record<ApiKeyScopePreset, string> = {
  readonly: 'read access to roosts, sites, machines, and hoot chats — no mutations',
  publisher: 'read + write — can upload chunks, publish versions, and use hoot chats',
  operator: 'read, write, deploy, rollback — full day-to-day operations',
  admin: 'full access including admin permissions',
};

export const DEFAULT_TTL_DAYS = 90;
export const MAX_TTL_DAYS = 365;
export const ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * How far ahead of `expiresAt` a key counts as "expiring soon". Shared so the
 * dashboard badge and the expiry-notice cron cannot drift: it is both the amber
 * row state and the upper bound of the cron's enumeration window.
 */
export const EXPIRATION_WARNING_MS = 14 * 24 * 60 * 60 * 1000;

/** True if any scope matches (resource, id, permission); stored id '*' matches any id. */
export function scopeMatches(
  scopes: ApiKeyScope[],
  resource: ApiKeyResource,
  id: string,
  permission: ApiKeyPermission
): boolean {
  return scopes.some(
    (s) =>
      s.resource === resource &&
      (s.id === '*' || s.id === id) &&
      s.permissions.includes(permission)
  );
}

/**
 * The shape `GET /api/keys` returns, and the only shape the key UIs read.
 *
 * Shared rather than declared beside KeyCard.tsx, where it once described fields
 * the route never sent (`expired`, `retired`, `expiredMarkedAt` were always
 * undefined, so an expired key rendered under the active heading).
 *
 * Every instant is epoch milliseconds: the stored record mixes Firestore
 * Timestamps (`createdAt`, serverTimestamp) with plain numbers (`lastUsedAt`), so
 * the route normalises through {@link toEpochMillis} — a raw Timestamp made
 * `new Date(...)` yield "Invalid Date" in the dashboard.
 */
export interface ApiKeyListItem {
  id: string;
  name: string | null;
  keyPrefix: string | null;
  environment: ApiKeyEnvironment | null;
  scopes: ApiKeyScope[] | null;
  expiresAt: number | null;
  createdAt: number | null;
  lastUsedAt: number | null;
  rotatedAt: number | null;
  rotatedFromKeyId: string | null;
  retiresAt: number | null;
  revokedAt: number | null;
  expiredMarkedAt: number | null;
  /** Derived: past its expiry at the moment the list was built. */
  expired: boolean;
  /** Derived: a rotated key whose grace window has closed. */
  retired: boolean;
  /** Derived: revoked. Terminal — it outranks `expired` and `retired`. */
  revoked: boolean;
}

/**
 * Coerce any instant this codebase has stored into epoch milliseconds: plain
 * number, live Firestore Timestamp (`toMillis()`), or a JSON-round-tripped one
 * (`{_seconds,_nanoseconds}` / `{seconds,...}`). Anything else — including a
 * FieldValue sentinel read back before the write lands — returns null.
 */
export function toEpochMillis(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'object') {
    const t = value as {
      toMillis?: unknown;
      _seconds?: unknown;
      seconds?: unknown;
      _nanoseconds?: unknown;
      nanoseconds?: unknown;
    };
    if (typeof t.toMillis === 'function') {
      const ms = (t.toMillis as () => unknown)();
      return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
    }
    const secs = typeof t._seconds === 'number' ? t._seconds
      : typeof t.seconds === 'number' ? t.seconds : null;
    if (secs !== null) {
      const nanos = typeof t._nanoseconds === 'number' ? t._nanoseconds
        : typeof t.nanoseconds === 'number' ? t.nanoseconds : 0;
      return secs * 1000 + Math.floor(nanos / 1e6);
    }
  }
  return null;
}

/**
 * Build the list item the UIs consume. `now` is injected so one listing
 * classifies every key against a single instant, and to keep it testable.
 */
export function buildApiKeyListItem(
  id: string,
  data: Record<string, unknown>,
  now: number
): ApiKeyListItem {
  const expiresAt = toEpochMillis(data.expiresAt);
  const retiresAt = toEpochMillis(data.retiresAt);
  const rotatedAt = toEpochMillis(data.rotatedAt);
  const revokedAt = toEpochMillis(data.revokedAt);
  return {
    id,
    name: typeof data.name === 'string' ? data.name : null,
    keyPrefix: typeof data.keyPrefix === 'string' ? data.keyPrefix : null,
    environment:
      data.environment === 'live' || data.environment === 'test' ? data.environment : null,
    scopes: Array.isArray(data.scopes) ? (data.scopes as ApiKeyScope[]) : null,
    expiresAt,
    createdAt: toEpochMillis(data.createdAt),
    lastUsedAt: toEpochMillis(data.lastUsedAt),
    rotatedAt,
    rotatedFromKeyId:
      typeof data.rotatedFromKeyId === 'string' ? data.rotatedFromKeyId : null,
    retiresAt,
    revokedAt,
    expiredMarkedAt: toEpochMillis(data.expiredMarkedAt),
    expired: expiresAt !== null && expiresAt <= now,
    // No rotatedAt means no grace window, so the key is simply live.
    retired: rotatedAt !== null && retiresAt !== null && retiresAt <= now,
    // Presence, NOT `<= now`. The auth path's revocation check is a plain
    // truthiness test on revokedAt (apiAuth.server.ts), so a future-dated stamp
    // already 401s every request. Deriving this against `now` would render such a
    // key "active" in the dashboard while the API rejected it — the exact class of
    // badge-vs-behaviour divergence `expired` was added to close.
    revoked: revokedAt !== null,
  };
}
