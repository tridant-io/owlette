/**
 * a payer's owlette entitlements from tridant id, subject `owlette:{uid}`
 * (plan.md decision 2). an unmapped subject still answers, as
 * `resolved: false` with tridant's defaults. never throws: plan.server.ts
 * decides what each failure reason means.
 */

import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';
import { tridantFetch, type TridantFailureReason } from '@/lib/tridant.server';

const CACHE_TTL_MS = 60_000;

export type Entitlements = {
  ok: true;
  resolved: boolean;
  standing: string;
  inGoodStanding: boolean;
  /** as tridant sends them: '0', '1', 'unlimited' or a count. */
  ent: Record<string, string>;
  epoch: number | null;
};

export type EntitlementsResult = Entitlements | { ok: false; reason: TridantFailureReason };

// the promise is cached, so concurrent lookups for one uid share a single call.
const cache = new Map<string, { expiresAt: number; result: Promise<EntitlementsResult> }>();

function parseEntitlements(body: unknown): Entitlements | null {
  if (typeof body !== 'object' || body === null) return null;
  const { resolved, standing, in_good_standing, ent, ent_epoch } = body as Record<string, unknown>;
  if (
    typeof resolved !== 'boolean' ||
    typeof standing !== 'string' ||
    typeof in_good_standing !== 'boolean' ||
    typeof ent !== 'object' ||
    ent === null ||
    Array.isArray(ent)
  ) {
    return null;
  }
  const entries = Object.entries(ent).map(([key, value]) => [
    key,
    typeof value === 'number' && Number.isFinite(value) ? String(value) : value,
  ]);
  if (entries.some(([, value]) => typeof value !== 'string')) return null;
  return {
    ok: true,
    resolved,
    standing,
    inGoodStanding: in_good_standing,
    ent: Object.fromEntries(entries),
    epoch: typeof ent_epoch === 'number' ? ent_epoch : null,
  };
}

async function fetchEntitlements(uid: string): Promise<EntitlementsResult> {
  const response = await tridantFetch(
    `/v1/licenses/owlette:${encodeURIComponent(uid)}/entitlements?app=owlette`,
    { key: process.env.TRIDANT_LICENSE_KEY },
  );
  if (!response.ok) return { ok: false, reason: response.reason };

  const entitlements = parseEntitlements(response.json);
  if (!entitlements) {
    logger.warn('[tridant] entitlement answer has an unexpected shape', {
      context: 'tridant',
      data: { uid },
    });
    return { ok: false, reason: 'malformed_response' };
  }
  return entitlements;
}

async function readE2eEntitlements(uid: string): Promise<EntitlementsResult> {
  try {
    const snap = await getAdminDb().collection('e2e_entitlements').doc(uid).get();
    if (!snap.exists) return { ok: false, reason: 'not_configured' };
    const seed = snap.data() ?? {};
    // the seed is { resolved, standing, ent }, so the two fields it leaves out get stand-ins.
    return (
      parseEntitlements({ in_good_standing: seed.standing !== 'expired', ent_epoch: null, ...seed }) ?? {
        ok: false,
        reason: 'malformed_response',
      }
    );
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

export function getEntitlements(uid: string): Promise<EntitlementsResult> {
  // uncached, so a spec can change a payer's plan between steps.
  if (process.env.OWLETTE_E2E === '1') return readE2eEntitlements(uid);

  const now = Date.now();
  const hit = cache.get(uid);
  if (hit && hit.expiresAt > now) return hit.result;

  // failures are cached too, so a tridant outage costs each uid one timeout a minute, not one per request.
  const result = fetchEntitlements(uid);
  cache.delete(uid);
  cache.set(uid, { expiresAt: now + CACHE_TTL_MS, result });
  // a refresh re-inserts at the end, so the map stays in expiry order and the sweep stops at the first live entry.
  for (const [key, entry] of cache) {
    if (entry.expiresAt > now) break;
    cache.delete(key);
  }
  return result;
}

export function __resetForTests(): void {
  cache.clear();
}
