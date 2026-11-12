/**
 * owlette entitlements from tridant id: a site's, ref `owlette:{siteId}`
 * (adr 0018). an unknown site still answers, as `resolved: false` with
 * tridant's defaults. never throws: plan.server.ts
 * decides what each failure reason means.
 */

import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';
import { tridantFetch, type TridantFailureReason } from '@/lib/tridant.server';

const CACHE_TTL_MS = 60_000;
const GOOD_STANDINGS = ['active', 'trialing', 'past_due'];

/** epoch ms. */
export type SiteBillingPeriod = {
  periodStart: number | null;
  periodEnd: number | null;
  endsAt: number | null;
  cancelAtPeriodEnd: boolean;
};

export type Entitlements = {
  ok: true;
  resolved: boolean;
  standing: string;
  inGoodStanding: boolean;
  /** epoch ms while past_due. */
  graceUntil: number | null;
  /** normalised to '0', '1', 'unlimited' or a count; a key tridant sends as null is left out. */
  ent: Record<string, string>;
  epoch: number | null;
  orgId: string | null;
  /** only a site billed per site has one; a site under a trial does not. */
  billing: SiteBillingPeriod | null;
};

export type EntitlementsResult = Entitlements | { ok: false; reason: TridantFailureReason };

type Cache = Map<string, { expiresAt: number; result: Promise<EntitlementsResult> }>;

// the promise is cached, so concurrent lookups for one key share a single call.
const siteCache: Cache = new Map();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

/**
 * tridant types a value by its feature's kind (boolean flag, numeric limit, null); plan.server.ts reads strings.
 * a value of any other shape (a `config` feature is parsed json) is left out like a null: rejecting the
 * whole answer over one key owlette never reads would turn every gate off.
 */
function normaliseEnt(ent: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(ent)) {
    if (typeof value === 'boolean') out[key] = value ? '1' : '0';
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = String(value);
    else if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function parseEntitlements(body: unknown): Entitlements | null {
  if (!isRecord(body)) return null;
  const { resolved, standing, in_good_standing, grace_until, ent, ent_epoch, org_id, billing } = body;
  if (
    typeof resolved !== 'boolean' ||
    typeof standing !== 'string' ||
    typeof in_good_standing !== 'boolean' ||
    !isRecord(ent)
  ) {
    return null;
  }
  return {
    ok: true,
    resolved,
    standing,
    inGoodStanding: in_good_standing,
    graceUntil: numberOrNull(grace_until),
    ent: normaliseEnt(ent),
    epoch: numberOrNull(ent_epoch),
    orgId: typeof org_id === 'string' ? org_id : null,
    billing: isRecord(billing)
      ? {
          periodStart: numberOrNull(billing.current_period_start),
          periodEnd: numberOrNull(billing.current_period_end),
          endsAt: numberOrNull(billing.ends_at),
          cancelAtPeriodEnd: billing.cancel_at_period_end === true,
        }
      : null,
  };
}

async function fetchEntitlements(path: string, subject: Record<string, string>): Promise<EntitlementsResult> {
  const response = await tridantFetch(path, {
    key: process.env.TRIDANT_LICENSE_KEY,
    keyName: 'TRIDANT_LICENSE_KEY',
  });
  if (!response.ok) return { ok: false, reason: response.reason };

  const entitlements = parseEntitlements(response.json);
  if (!entitlements) {
    logger.warn('[tridant] entitlement answer has an unexpected shape', {
      context: 'tridant',
      data: subject,
    });
    return { ok: false, reason: 'malformed_response' };
  }
  return entitlements;
}

function cached(cache: Cache, key: string, fetch: () => Promise<EntitlementsResult>): Promise<EntitlementsResult> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.result;

  // failures are cached too, so a tridant outage costs each key one timeout a minute, not one per request.
  const result = fetch();
  cache.delete(key);
  cache.set(key, { expiresAt: now + CACHE_TTL_MS, result });
  // a refresh re-inserts at the end, so the map stays in expiry order and the sweep stops at the first live entry.
  for (const [entryKey, entry] of cache) {
    if (entry.expiresAt > now) break;
    cache.delete(entryKey);
  }
  return result;
}

async function readE2eSeed(
  docId: string,
  toAnswer: (seed: Record<string, unknown>) => unknown,
): Promise<EntitlementsResult> {
  try {
    const snap = await getAdminDb().collection('e2e_entitlements').doc(docId).get();
    if (!snap.exists) return { ok: false, reason: 'not_configured' };
    return parseEntitlements(toAnswer(snap.data() ?? {})) ?? { ok: false, reason: 'malformed_response' };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

// a site seed is written in this module's names, so it goes back into tridant's before parsing.
function siteSeedToAnswer(seed: Record<string, unknown>): unknown {
  const { resolved, standing, inGoodStanding, ent, orgId, billing } = seed;
  return {
    resolved,
    standing,
    in_good_standing: inGoodStanding ?? (typeof standing === 'string' && GOOD_STANDINGS.includes(standing)),
    ent,
    org_id: orgId,
    ...(isRecord(billing)
      ? {
          billing: {
            current_period_start: billing.periodStart,
            current_period_end: billing.periodEnd,
            ends_at: billing.endsAt,
            cancel_at_period_end: billing.cancelAtPeriodEnd,
          },
        }
      : {}),
  };
}

export function getSiteEntitlements(siteId: string): Promise<EntitlementsResult> {
  // uncached, so a spec can change a site's plan between steps.
  if (process.env.OWLETTE_E2E === '1') return readE2eSeed(`site:${siteId}`, siteSeedToAnswer);

  return cached(siteCache, siteId, () =>
    fetchEntitlements(`/v1/sites/owlette:${encodeURIComponent(siteId)}/entitlements?app=owlette`, { siteId }),
  );
}

/** call after owlette changes a site's billing, so the next read asks tridant again. */
export function invalidateSiteEntitlements(siteId: string): void {
  siteCache.delete(siteId);
}

export function __resetForTests(): void {
  siteCache.clear();
}
