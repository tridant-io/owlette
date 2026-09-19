/**
 * Two-layer per-capability rate limiter with isolated user and system buckets —
 * hoot bursts and scheduled jobs can't squeeze human operators out of quota.
 *
 * Layer 1: per-process token bucket keyed `{bucket}:{subject}:{capability}`,
 * refilling at `limit / 60s`. Best-effort CACHE, not enforcement — railway runs
 * N replicas each with its own Map, so a caller can pass it N times in parallel.
 *
 * Layer 2 (authoritative): 10-shard fixed-window counter at
 *   `sites/{siteId}/rate_limits/{bucket}/subjects/{subjectHash}/capabilities/{capability}/shards/{0..9}`
 * Each request increments one random shard in a transaction; the check sums all
 * 10. Sharding lifts firestore's 1 write/sec/doc contention ceiling to ~10.
 * Stale shards reset transactionally on read-modify-write, so it self-heals.
 *
 * `checkRateLimit(actor, capability, siteId)` fails fast on layer 1 so a hot
 * loop on one replica never reaches firestore.
 */

import crypto from 'crypto';
import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';
import {
  type Actor,
  type Capability,
  Capability as CapabilityEnum,
} from '@/lib/capabilities';
import type { RateLimitedReason } from '@/lib/rateLimit';
import { FieldValue } from 'firebase-admin/firestore';
import { emitSecurityBoundaryMetric } from '@/lib/securityBoundaryMetrics.server';

export interface CapabilityLimit {
  /** Tokens granted per 60-second window. */
  perMinute: number;
}

/**
 * Per-actor ceilings for humans (sessions + api keys): tight enough to blunt a
 * misconfigured CI loop, well above the fastest human dashboard user.
 */
export const USER_LIMITS: Readonly<Record<Capability, CapabilityLimit>> = {
  [CapabilityEnum.MACHINE_EXEC_COMMAND]: { perMinute: 60 },
  [CapabilityEnum.MACHINE_VIEW]: { perMinute: 60 },
  // swoop session starts and 5-minute lease renewals, never a per-frame path.
  // Tighter than MACHINE_VIEW's 60 because each start spawns a streamer process
  // on the machine itself — and because an unlisted capability would fail OPEN
  // below, so these two entries are the ceiling, not a formality.
  [CapabilityEnum.MACHINE_REMOTE_CONTROL]: { perMinute: 10 },
  [CapabilityEnum.MACHINE_REMOTE_VIEW]: { perMinute: 20 },
  // Keeps the ceiling the route carried while it was MACHINE_CONFIG_WRITE.
  [CapabilityEnum.SWOOP_SETTINGS_MANAGE]: { perMinute: 30 },
  [CapabilityEnum.MACHINE_CONFIG_WRITE]: { perMinute: 30 },
  [CapabilityEnum.MACHINE_REMOVE]: { perMinute: 5 },
  [CapabilityEnum.DEPLOYMENT_MANAGE]: { perMinute: 30 },
  [CapabilityEnum.DISTRIBUTION_MANAGE]: { perMinute: 30 },
  [CapabilityEnum.UNINSTALL_TRIGGER]: { perMinute: 30 },
  [CapabilityEnum.PRESET_MANAGE]: { perMinute: 60 },
  [CapabilityEnum.SITE_MEMBER_MANAGE]: { perMinute: 30 },
  // Destructive and rare — matches MACHINE_REMOVE rather than the 30/min admin verbs.
  [CapabilityEnum.SITE_DELETE]: { perMinute: 5 },
  [CapabilityEnum.WEBHOOK_MANAGE]: { perMinute: 30 },
  [CapabilityEnum.SITE_LOGS_MANAGE]: { perMinute: 30 },
  [CapabilityEnum.TALON_MANAGE]: { perMinute: 30 },
  [CapabilityEnum.ALERT_RULES_MANAGE]: { perMinute: 60 },
  [CapabilityEnum.AGENT_TOKEN_REVOKE]: { perMinute: 5 },
  [CapabilityEnum.MACHINE_ENROLL]: { perMinute: 5 },
  [CapabilityEnum.USER_ROLE_MANAGE]: { perMinute: 10 },
  [CapabilityEnum.USER_DELETE]: { perMinute: 5 },
  [CapabilityEnum.SYSTEM_PRESET_MANAGE]: { perMinute: 30 },
  [CapabilityEnum.INSTALLER_MANAGE]: { perMinute: 10 },
  [CapabilityEnum.GLOBAL_SETTINGS_WRITE]: { perMinute: 10 },
  [CapabilityEnum.USER_SELF_PREFS]: { perMinute: 120 },
  [CapabilityEnum.USER_SELF_DELETE]: { perMinute: 1 },
};

/**
 * System bucket — 5x user. Hoot autonomous mode and scheduled sweeps produce
 * legitimate bursts that human traffic never does.
 */
export const SYSTEM_LIMITS: Readonly<Record<Capability, CapabilityLimit>> = {
  [CapabilityEnum.MACHINE_EXEC_COMMAND]: { perMinute: 300 },
  [CapabilityEnum.MACHINE_VIEW]: { perMinute: 300 },
  [CapabilityEnum.MACHINE_REMOTE_CONTROL]: { perMinute: 50 },
  [CapabilityEnum.MACHINE_REMOTE_VIEW]: { perMinute: 100 },
  [CapabilityEnum.SWOOP_SETTINGS_MANAGE]: { perMinute: 150 },
  [CapabilityEnum.MACHINE_CONFIG_WRITE]: { perMinute: 150 },
  [CapabilityEnum.MACHINE_REMOVE]: { perMinute: 25 },
  [CapabilityEnum.DEPLOYMENT_MANAGE]: { perMinute: 150 },
  [CapabilityEnum.DISTRIBUTION_MANAGE]: { perMinute: 150 },
  [CapabilityEnum.UNINSTALL_TRIGGER]: { perMinute: 150 },
  [CapabilityEnum.PRESET_MANAGE]: { perMinute: 300 },
  [CapabilityEnum.SITE_MEMBER_MANAGE]: { perMinute: 150 },
  [CapabilityEnum.SITE_DELETE]: { perMinute: 25 },
  [CapabilityEnum.WEBHOOK_MANAGE]: { perMinute: 150 },
  [CapabilityEnum.SITE_LOGS_MANAGE]: { perMinute: 150 },
  [CapabilityEnum.TALON_MANAGE]: { perMinute: 150 },
  [CapabilityEnum.ALERT_RULES_MANAGE]: { perMinute: 300 },
  [CapabilityEnum.AGENT_TOKEN_REVOKE]: { perMinute: 25 },
  [CapabilityEnum.MACHINE_ENROLL]: { perMinute: 25 },
  [CapabilityEnum.USER_ROLE_MANAGE]: { perMinute: 50 },
  [CapabilityEnum.USER_DELETE]: { perMinute: 25 },
  [CapabilityEnum.SYSTEM_PRESET_MANAGE]: { perMinute: 150 },
  [CapabilityEnum.INSTALLER_MANAGE]: { perMinute: 50 },
  [CapabilityEnum.GLOBAL_SETTINGS_WRITE]: { perMinute: 50 },
  [CapabilityEnum.USER_SELF_PREFS]: { perMinute: 600 },
  [CapabilityEnum.USER_SELF_DELETE]: { perMinute: 5 },
};

export type Bucket = 'user' | 'system';
export const SHARD_COUNT = 10;
export const WINDOW_SEC = 60;

export interface RateLimitMetadata {
  limit: number;
  remaining: number;
  resetAtMs: number;
  rateLimitReason: RateLimitedReason;
}

export type RateLimitResult =
  | ({ ok: true } & Partial<RateLimitMetadata>)
  | ({ ok: false; reason: 'rate_limited'; retryAfterSec: number } & RateLimitMetadata);

type RateLimitObservationSource = 'in_memory' | 'firestore';

/** Sessions and api keys map to `'user'`; hoot / scheduled jobs to `'system'`. */
export function bucketForActor(actor: Actor): Bucket {
  return actor.type === 'system' ? 'system' : 'user';
}

/** Stable display identifier for an actor inside its bucket. */
export function actorIdentifier(actor: Actor): string {
  if (actor.type === 'system') return actor.name;
  return actor.apiKeyId ?? actor.userId;
}

/** Authoritative subject: sessions by uid, API-key calls by key id, system by name. */
export function rateLimitSubjectKey(actor: Actor): string {
  if (actor.type === 'system') return `system:${actor.name}`;
  if (actor.apiKeyId) return `apiKey:${actor.apiKeyId}`;
  return `user:${actor.userId}`;
}

export function rateLimitSubjectDocId(subjectKey: string): string {
  return crypto.createHash('sha256').update(subjectKey).digest('hex').slice(0, 32);
}

function rateLimitedReasonForActor(actor: Actor): RateLimitedReason {
  return actor.type === 'user' && actor.apiKeyId ? 'key-rate' : 'endpoint-rate';
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  if (result.limit === undefined || result.remaining === undefined || result.resetAtMs === undefined) {
    return {};
  }

  const resetDeltaSec = Math.max(0, Math.ceil((result.resetAtMs - Date.now()) / 1000));
  const headers: Record<string, string> = {
    'RateLimit-Limit': String(result.limit),
    'RateLimit-Remaining': String(result.remaining),
    'RateLimit-Reset': String(resetDeltaSec),
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(result.resetAtMs),
  };

  if (!result.ok) {
    headers['Retry-After'] = String(result.retryAfterSec);
    headers['Roost-Rate-Limited-Reason'] = result.rateLimitReason;
  }

  return headers;
}

// layer 1 — in-memory token bucket (best-effort)

interface TokenBucket {
  tokens: number;
  lastRefillMs: number;
}

/**
 * Per-process token buckets, keyed by bucket + stable subject so sessions, API
 * keys, and system actors never share one. NOT shared across replicas.
 */
const inMemoryBuckets = new Map<string, TokenBucket>();

function inMemoryKey(actor: Actor, capability: Capability): string {
  return `${bucketForActor(actor)}:${rateLimitSubjectKey(actor)}:${capability}`;
}

/**
 * Best-effort burst check; consumes a token if one is available. Refill =
 * `perMinute / 60`/s, capacity = `perMinute` (fresh actors start full).
 * Multi-replica deployments leak ~`replicas × perMinute` before layer 2 catches up.
 */
export function checkInMemoryBurst(
  actor: Actor,
  capability: Capability
): boolean {
  const limits = bucketForActor(actor) === 'system' ? SYSTEM_LIMITS : USER_LIMITS;
  const limit = limits[capability];
  if (!limit) return true; // no limit configured -> allow
  const capacity = limit.perMinute;
  const refillPerMs = capacity / (WINDOW_SEC * 1000);

  const key = inMemoryKey(actor, capability);
  const now = Date.now();
  const existing = inMemoryBuckets.get(key);

  if (!existing) {
    // Fresh actor: full bucket, consume one.
    inMemoryBuckets.set(key, { tokens: capacity - 1, lastRefillMs: now });
    return true;
  }

  const elapsedMs = Math.max(0, now - existing.lastRefillMs);
  const refilled = Math.min(capacity, existing.tokens + elapsedMs * refillPerMs);

  if (refilled < 1) {
    existing.tokens = refilled;
    existing.lastRefillMs = now;
    return false;
  }

  existing.tokens = refilled - 1;
  existing.lastRefillMs = now;
  return true;
}

/** Test-only hook: clears the in-memory bucket map between tests. */
export function __resetInMemoryBucketsForTests(): void {
  inMemoryBuckets.clear();
}

function isObserveOnly(): boolean {
  return process.env.RATE_LIMIT_OBSERVE_ONLY === 'true';
}

async function recordRateLimitObservation(params: {
  actor: Actor;
  bucket: Bucket;
  capability: Capability;
  configuredLimitPerMinute: number;
  siteId: string;
  source: RateLimitObservationSource;
  retryAfterSec: number;
}): Promise<void> {
  try {
    await getAdminDb().collection('rate_limit_observations').add({
      schemaVersion: 1,
      siteId: params.siteId,
      bucket: params.bucket,
      capability: params.capability,
      actorType: params.actor.type,
      actorId: actorIdentifier(params.actor),
      rateLimitSubject: rateLimitSubjectKey(params.actor),
      source: params.source,
      configuredLimitPerMinute: params.configuredLimitPerMinute,
      windowSec: WINDOW_SEC,
      retryAfterSec: params.retryAfterSec,
      observedMinuteMs: Math.floor(Date.now() / 60000) * 60000,
      observedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    logger.warn('[rateLimit] observe-only write failed; allowing request', {
      context: 'rateLimit',
      data: {
        err: err instanceof Error ? err.message : String(err),
        siteId: params.siteId,
        bucket: params.bucket,
        capability: params.capability,
      },
    });
  }
}

// layer 2 — firestore sharded counter (authoritative)

interface ShardDoc {
  count: number;
  windowStart: number; // epoch seconds
}

/** Random shard index; module-scoped so tests can stub it deterministically. */
export function pickShardIndex(): number {
  return Math.floor(Math.random() * SHARD_COUNT);
}

function shardsCollection(
  siteId: string,
  bucket: Bucket,
  subjectKey: string,
  capability: Capability,
) {
  return getAdminDb()
    .collection('sites')
    .doc(siteId)
    .collection('rate_limits')
    .doc(bucket)
    .collection('subjects')
    .doc(rateLimitSubjectDocId(subjectKey))
    .collection('capabilities')
    .doc(capability)
    .collection('shards');
}

/**
 * Increment one random shard and check the (siteId, bucket, capability) total
 * against `limit` for the active window. Rejections still write the increment so
 * observability sees the attempted load. `retryAfterSec` is the window remainder,
 * clamped to [1, windowSec].
 */
export async function checkFirestoreLimit(
  siteId: string,
  bucket: Bucket,
  capability: Capability,
  limit: number,
  windowSec: number = WINDOW_SEC,
  options: {
    subjectKey?: string;
    rateLimitReason?: RateLimitedReason;
  } = {},
): Promise<RateLimitResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const resetAtMs = (nowSec + windowSec) * 1000;
  const rateLimitReason = options.rateLimitReason ?? 'endpoint-rate';

  if (limit <= 0) {
    return {
      ok: false,
      reason: 'rate_limited',
      retryAfterSec: windowSec,
      limit,
      remaining: 0,
      resetAtMs,
      rateLimitReason,
    };
  }

  const db = getAdminDb();
  const shardIndex = pickShardIndex();
  const col = shardsCollection(siteId, bucket, options.subjectKey ?? bucket, capability);
  const targetRef = col.doc(String(shardIndex));

  // 1. Increment the chosen shard, rolling the window forward if stale.
  let chosenWindowStart = nowSec;
  try {
    chosenWindowStart = await db.runTransaction(async (tx) => {
      const snap = await tx.get(targetRef);
      const data = snap.exists ? (snap.data() as ShardDoc | undefined) : undefined;
      const prevStart = data?.windowStart ?? 0;
      const inWindow = data && nowSec - prevStart < windowSec;
      const nextStart = inWindow ? prevStart : nowSec;
      const nextCount = inWindow ? (data?.count ?? 0) + 1 : 1;
      tx.set(targetRef, { count: nextCount, windowStart: nextStart });
      return nextStart;
    });
  } catch (err) {
    // Fail open, loudly: fail-closed would punish legitimate traffic during a
    // firestore outage. Layer 1 still applies and the securityConfig kill-switch
    // (wave 2.1) is the operator's escape hatch.
    logger.error('[rateLimit] firestore increment failed; failing open', {
      context: 'rateLimit',
      data: {
        err: err instanceof Error ? err.message : String(err),
        siteId,
        bucket,
        capability,
      },
    });
    return {
      ok: true,
      limit,
      remaining: limit,
      resetAtMs,
      rateLimitReason,
    };
  }

  // 2. Sum the shards belonging to the window we just incremented into; stale
  //    shards are ignored and reset on their next write.
  let total = 0;
  try {
    const snapshot = await col.get();
    snapshot.forEach((doc) => {
      const data = doc.data() as ShardDoc | undefined;
      if (!data) return;
      if (data.windowStart === chosenWindowStart) {
        total += data.count ?? 0;
      } else if (data.windowStart > chosenWindowStart) {
        // A racing increment landed in a newer window — anything ≥ ours is live.
        total += data.count ?? 0;
      }
    });
  } catch (err) {
    logger.error('[rateLimit] firestore shard sum failed; failing open', {
      context: 'rateLimit',
      data: {
        err: err instanceof Error ? err.message : String(err),
        siteId,
        bucket,
        capability,
      },
    });
    return {
      ok: true,
      limit,
      remaining: limit,
      resetAtMs,
      rateLimitReason,
    };
  }

  const windowResetAtMs = (chosenWindowStart + windowSec) * 1000;
  if (total > limit) {
    const elapsed = nowSec - chosenWindowStart;
    const retryAfterSec = Math.max(1, Math.min(windowSec, windowSec - elapsed));
    return {
      ok: false,
      reason: 'rate_limited',
      retryAfterSec,
      limit,
      remaining: 0,
      resetAtMs: windowResetAtMs,
      rateLimitReason,
    };
  }

  return {
    ok: true,
    limit,
    remaining: Math.max(0, limit - total),
    resetAtMs: windowResetAtMs,
    rateLimitReason,
  };
}

/**
 * Rate-limit `actor` on `capability` within `siteId`. Buckets live at distinct
 * firestore paths and map slots, so a system actor can never consume a user
 * token. Capabilities absent from the bucket's map are allowed. Layer-1
 * rejections report `retryAfterSec = WINDOW_SEC` — per-bucket refill time isn't
 * tracked precisely enough for a tighter answer.
 */
export async function checkRateLimit(
  actor: Actor,
  capability: Capability,
  siteId: string
): Promise<RateLimitResult> {
  // E2E hits many capability-gated routes back-to-back as one actor; enforcement
  // stays on in production, so this needs the explicit Playwright env override.
  if (process.env.E2E_DISABLE_RATE_LIMIT === 'true') {
    return { ok: true };
  }

  const bucket = bucketForActor(actor);
  const limits = bucket === 'system' ? SYSTEM_LIMITS : USER_LIMITS;
  const limit = limits[capability];
  if (!limit) {
    // No limit configured for this capability/bucket pair — allow.
    return { ok: true };
  }

  const observeOnly = isObserveOnly();
  const rateLimitReason = rateLimitedReasonForActor(actor);
  const resetAtMs = Date.now() + WINDOW_SEC * 1000;

  if (!checkInMemoryBurst(actor, capability)) {
    const result: RateLimitResult = {
      ok: false,
      reason: 'rate_limited',
      retryAfterSec: WINDOW_SEC,
      limit: limit.perMinute,
      remaining: 0,
      resetAtMs,
      rateLimitReason,
    };
    emitRateLimitHit(actor, bucket, capability, siteId, 'in_memory', result);
    if (observeOnly) {
      await recordRateLimitObservation({
        actor,
        bucket,
        capability,
        configuredLimitPerMinute: limit.perMinute,
        siteId,
        source: 'in_memory',
        retryAfterSec: result.retryAfterSec,
      });
      return { ok: true };
    }
    return result;
  }

  const result = await checkFirestoreLimit(
    siteId,
    bucket,
    capability,
    limit.perMinute,
    WINDOW_SEC,
    {
      subjectKey: rateLimitSubjectKey(actor),
      rateLimitReason,
    },
  );
  if (!result.ok && observeOnly) {
    emitRateLimitHit(actor, bucket, capability, siteId, 'firestore', result);
    await recordRateLimitObservation({
      actor,
      bucket,
      capability,
      configuredLimitPerMinute: limit.perMinute,
      siteId,
      source: 'firestore',
      retryAfterSec: result.retryAfterSec,
    });
    return { ok: true };
  }

  if (!result.ok) {
    emitRateLimitHit(actor, bucket, capability, siteId, 'firestore', result);
  }

  return result;
}

function emitRateLimitHit(
  actor: Actor,
  bucket: Bucket,
  capability: Capability,
  siteId: string,
  source: RateLimitObservationSource,
  result: Extract<RateLimitResult, { ok: false }>,
): void {
  emitSecurityBoundaryMetric('rate_limit_hits_total', 1, {
    severity: bucket === 'system' ? 'warning' : 'info',
    labels: {
      bucket,
      capability,
      site: siteId,
      actorType: actor.type,
      source,
    },
    fields: {
      retryAfterSec: result.retryAfterSec,
      limit: result.limit,
      resetAtMs: result.resetAtMs,
      rateLimitReason: result.rateLimitReason,
      actorId: actorIdentifier(actor),
    },
  });
}
