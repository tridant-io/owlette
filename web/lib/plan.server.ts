/**
 * the payer's plan from tridant id, and the gates built on it (plan.md
 * decisions 1 and 3-6).
 *
 * a leaf module: it must not import `apiAuth.server`. the gates sit inside the
 * auth layer (`authorizedSiteHandler`, the `_shared` resolvers), so an import
 * back into it would be a cycle; the removed `billingSnapshot.server.ts` was
 * split out for the same reason.
 *
 * dormant by default: unless `PLAN_ENFORCEMENT` is `on` and tridant id is
 * configured, every gate answers "unrestricted" before any read.
 */

import type { NextResponse } from 'next/server';
import { problemPlanRequired } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';
import { tridantApiUrl } from '@/lib/tridant.server';
import { getEntitlements } from '@/lib/tridantEntitlements.server';

export const PLAN_LIMITS = ['owlette.machines', 'owlette.sites'] as const;
export const PLAN_FLAGS = [
  'owlette.control',
  'owlette.deployments',
  'owlette.swoop',
  'owlette.hoot',
  'owlette.roost',
  'owlette.talons',
  'owlette.webhooks',
  'owlette.api_keys',
] as const;

export type PlanLimit = (typeof PLAN_LIMITS)[number];
export type PlanFlag = (typeof PLAN_FLAGS)[number];
export type PlanKey = PlanLimit | PlanFlag;

/**
 * why a payer is unrestricted. `not_configured`, `unreachable`, `rejected` and
 * `malformed_response` are tridant failing, and fail open: a refused key is a
 * misconfiguration on our side, and must not lock every customer out.
 */
export type PlanOffReason =
  | 'enforcement_off'
  | 'not_configured'
  | 'unreachable'
  | 'rejected'
  | 'malformed_response'
  | 'superadmin'
  | 'no_payer';

export type Plan =
  | { enforced: false; reason: PlanOffReason }
  | { enforced: true; resolved: boolean; standing: string; ent: Record<string, string> };

export type PlanTier = 'trial' | 'free' | 'core' | 'pro';

/** `GET /api/account/plan`: the signed-in user's plan as a payer. */
export interface PlanResponse {
  enforced: boolean;
  /** why plans are off; when enforced, `keys_missing` while tridant sends no readable value for `missingKeys`. */
  reason?: PlanOffReason | 'keys_missing';
  missingKeys?: PlanKey[];
  /** whether the user owns a site, so pays for one; sent only when enforced. */
  ownsSites?: boolean;
  plan: PlanTier | null;
  standing: string | null;
  /** null is unrestricted. */
  limits: { machines: number | null; sites: number | null };
  flags: {
    control: boolean;
    deployments: boolean;
    swoop: boolean;
    hoot: boolean;
    roost: boolean;
    talons: boolean;
    webhooks: boolean;
    api_keys: boolean;
  };
  activeMachinesThisMonth: number | null;
}

export const PLAN_REQUIRED_DETAIL: Record<PlanFlag, string> = {
  'owlette.control': "your plan doesn't include remote control. upgrade to continue.",
  'owlette.deployments': "your plan doesn't include deployments. upgrade to continue.",
  'owlette.swoop': "your plan doesn't include swoop. upgrade to continue.",
  'owlette.hoot': "your plan doesn't include hoot. upgrade to continue.",
  'owlette.roost': "your plan doesn't include roost. upgrade to continue.",
  'owlette.talons': "your plan doesn't include talons. upgrade to continue.",
  'owlette.webhooks': "your plan doesn't include webhooks. upgrade to continue.",
  'owlette.api_keys': "your plan doesn't include API keys. upgrade to continue.",
};

// these states hold until the env changes, which redeploys, so once per process is enough.
const loggedOnce = new Set<string>();

function onceOnly(key: string): boolean {
  if (loggedOnce.has(key)) return false;
  loggedOnce.add(key);
  return true;
}

/** the reason plans are off that needs no read, or null when they are enforced. */
function offBeforeReads(): 'enforcement_off' | 'not_configured' | null {
  if (process.env.PLAN_ENFORCEMENT !== 'on') return 'enforcement_off';
  // the e2e seam stands in for tridant; otherwise this is tridantFetch's own check.
  if (process.env.OWLETTE_E2E === '1') return null;
  if (tridantApiUrl() && process.env.TRIDANT_LICENSE_KEY?.trim()) return null;
  if (onceOnly('not_configured')) {
    logger.warn('[plan] PLAN_ENFORCEMENT is on but tridant id is not configured; plans are not enforced', {
      context: 'plan',
    });
  }
  return 'not_configured';
}

/**
 * whether plans can be enforced at all, answered without a read. callers that
 * would otherwise read a payer or site first check this.
 */
export function plansEnforced(): boolean {
  return offBeforeReads() === null;
}

/** the site's payer, its owner (decision 1). pass site data already read to skip the read. */
export async function payerForSite(
  siteId: string,
  siteData?: Record<string, unknown> | null,
): Promise<string | null> {
  const data =
    siteData !== undefined ? siteData : (await getAdminDb().collection('sites').doc(siteId).get()).data();
  const owner = data?.owner;
  return typeof owner === 'string' && owner.length > 0 ? owner : null;
}

export async function resolvePlan(payerUid: string | null): Promise<Plan> {
  const off = offBeforeReads();
  if (off) return { enforced: false, reason: off };
  if (!payerUid) return { enforced: false, reason: 'no_payer' };

  const [answer, payerDoc] = await Promise.all([
    getEntitlements(payerUid),
    getAdminDb().collection('users').doc(payerUid).get(),
  ]);
  if (payerDoc.data()?.role === 'superadmin') return { enforced: false, reason: 'superadmin' };
  if (!answer.ok) {
    if (answer.reason === 'rejected' && onceOnly('rejected')) {
      logger.error('[plan] tridant id refused the entitlement lookup; check TRIDANT_LICENSE_KEY. plans are not enforced', {
        context: 'plan',
      });
    }
    return { enforced: false, reason: answer.reason };
  }
  // an unmapped payer answers resolved:false with tridant's defaults, which are owlette free.
  return { enforced: true, resolved: answer.resolved, standing: answer.standing, ent: answer.ent };
}

/** a value as tridant sends it: a count, Infinity for `unlimited`, or null when absent or unreadable. */
function readLimit(value: string | undefined): number | null {
  if (value === 'unlimited') return Infinity;
  if (value !== undefined && /^\d+$/.test(value)) return Number(value);
  return null;
}

/** the payer's limit for `key`: a count, or Infinity when unrestricted. a flag is 0 or 1. */
export function planLimit(plan: Plan, key: PlanKey): number {
  if (!plan.enforced) return Infinity;
  const value = plan.ent[key];
  const limit = readLimit(value);
  if (limit !== null) return limit;
  // until tridant-id#76 defines the owlette keys, a missing key must not lock anyone out. task 6.4 flips it.
  if (onceOnly(`unrestricted:${key}`)) {
    logger.warn(`[plan] tridant sent ${value === undefined ? 'no value' : 'an unreadable value'} for ${key}; treating it as unrestricted`, {
      context: 'plan',
    });
  }
  return Infinity;
}

export function entitled(plan: Plan, key: PlanKey): boolean {
  return planLimit(plan, key) > 0;
}

/** the keys `planLimit` treats as unrestricted only because tridant sent no readable value. */
export function missingPlanKeys(plan: Plan): PlanKey[] {
  if (!plan.enforced) return [];
  return [...PLAN_LIMITS, ...PLAN_FLAGS].filter((key) => readLimit(plan.ent[key]) === null);
}

/**
 * the tier a plan reads as, null when plans are not enforced. tridant's answer
 * names no tier, so it is derived: an unmapped or ended payer is free, a
 * trialing one is on trial, otherwise roost means pro and control means core.
 */
export function planTier(plan: Plan): PlanTier | null {
  if (!plan.enforced) return null;
  if (!plan.resolved || plan.standing === 'expired' || plan.standing === 'canceled') return 'free';
  if (plan.standing === 'trialing') return 'trial';
  if (entitled(plan, 'owlette.roost')) return 'pro';
  if (entitled(plan, 'owlette.control')) return 'core';
  return 'free';
}

/** a 402 `plan_required` when the site's payer lacks `key`, else null. */
export async function requireEntitlement(
  siteId: string,
  key: PlanFlag,
  siteData?: Record<string, unknown> | null,
): Promise<NextResponse | null> {
  if (offBeforeReads()) return null;
  const plan = await resolvePlan(await payerForSite(siteId, siteData));
  return entitled(plan, key) ? null : problemPlanRequired(PLAN_REQUIRED_DETAIL[key], key);
}

/**
 * whether the payer may mint credentials for `machineId` (decision 6). machines
 * are the distinct ids across the payer's sites, as billing counts them, and an
 * id already among them is a re-pair, which always fits.
 */
export async function machineSlotAvailable(payerUid: string | null, machineId: string): Promise<boolean> {
  const limit = planLimit(await resolvePlan(payerUid), 'owlette.machines');
  if (!payerUid || limit === Infinity) return true;

  const sites = await getAdminDb().collection('sites').where('owner', '==', payerUid).select().get();
  const machineSnaps = await Promise.all(
    sites.docs.map((site) => site.ref.collection('machines').select().get()),
  );
  const machineIds = new Set(machineSnaps.flatMap((snap) => snap.docs.map((doc) => doc.id)));
  return machineIds.has(machineId) || machineIds.size < limit;
}

export async function siteSlotAvailable(payerUid: string | null): Promise<boolean> {
  const limit = planLimit(await resolvePlan(payerUid), 'owlette.sites');
  if (!payerUid || limit === Infinity) return true;

  const owned = await getAdminDb().collection('sites').where('owner', '==', payerUid).count().get();
  return owned.data().count < limit;
}

export function __resetForTests(): void {
  loggedOnce.clear();
}
