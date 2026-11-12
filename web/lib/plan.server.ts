/**
 * a site's plan from tridant id, and the gates built on it (adr 0018). owlette
 * free is per account, so the free limits are counted here across the sites an
 * account owns.
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
import {
  getEntitlements,
  getSiteEntitlements,
  type EntitlementsResult,
  type SiteBillingPeriod,
} from '@/lib/tridantEntitlements.server';

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
 * why a site is unrestricted. `not_configured`, `unreachable`, `rejected` and
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
  | {
      enforced: true;
      resolved: boolean;
      standing: string;
      /** tridant's in_good_standing: trialing, active, or past_due inside grace. when false, the site is on owlette free. */
      inGoodStanding: boolean;
      ent: Record<string, string>;
      billing: SiteBillingPeriod | null;
      orgId: string | null;
    };

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
  /**
   * the machines a counted machine limit keeps live (decision 9); the dashboard
   * overlays the rest. sent only when enforced with a machine limit.
   */
  liveMachines?: Array<{ siteId: string; machineId: string }>;
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
 * would otherwise read a site first check this.
 */
export function plansEnforced(): boolean {
  return offBeforeReads() === null;
}

/** a site document's data; null is a site that does not exist. */
type SiteData = Record<string, unknown> | null;

function ownerOf(siteData: SiteData): string | null {
  const owner = siteData?.owner;
  return typeof owner === 'string' && owner.length > 0 ? owner : null;
}

async function readSite(siteId: string, siteData?: SiteData): Promise<SiteData> {
  if (siteData !== undefined) return siteData;
  return (await getAdminDb().collection('sites').doc(siteId).get()).data() ?? null;
}

/** a failed read is "no": the owner is then held to what tridant says, where a throw would be a 500 on every gate. */
async function isSuperadmin(uid: string): Promise<boolean> {
  try {
    return (await getAdminDb().collection('users').doc(uid).get()).data()?.role === 'superadmin';
  } catch {
    return false;
  }
}

/** the site's owner, who pays for it. pass site data already read to skip the read. task 6.4 removes it. */
export async function payerForSite(siteId: string, siteData?: SiteData): Promise<string | null> {
  return ownerOf(await readSite(siteId, siteData));
}

/** tridant's answer as a plan. a failed read fails open. */
function planFromAnswer(answer: EntitlementsResult): Plan {
  if (!answer.ok) {
    if (answer.reason === 'rejected' && onceOnly('rejected')) {
      logger.error('[plan] tridant id refused the entitlement lookup; check TRIDANT_LICENSE_KEY. plans are not enforced', {
        context: 'plan',
      });
    }
    return { enforced: false, reason: answer.reason };
  }
  // a site or payer tridant does not know answers resolved:false with its defaults, which are owlette free.
  return {
    enforced: true,
    resolved: answer.resolved,
    standing: answer.standing,
    inGoodStanding: answer.inGoodStanding,
    ent: answer.ent,
    billing: answer.billing,
    orgId: answer.orgId,
  };
}

/** the site's plan. pass site data already read to skip the read. */
export async function resolveSitePlan(siteId: string, siteData?: SiteData): Promise<Plan> {
  const off = offBeforeReads();
  if (off) return { enforced: false, reason: off };
  const owner = ownerOf(await readSite(siteId, siteData));
  if (!owner) return { enforced: false, reason: 'no_payer' };

  const [answer, superadmin] = await Promise.all([getSiteEntitlements(siteId), isSuperadmin(owner)]);
  return superadmin ? { enforced: false, reason: 'superadmin' } : planFromAnswer(answer);
}

/** the owner-pays read: one plan per account, merged across its sites. task 6.4 removes it. */
export async function resolvePlan(payerUid: string | null): Promise<Plan> {
  const off = offBeforeReads();
  if (off) return { enforced: false, reason: off };
  if (!payerUid) return { enforced: false, reason: 'no_payer' };

  const [answer, superadmin] = await Promise.all([getEntitlements(payerUid), isSuperadmin(payerUid)]);
  return superadmin ? { enforced: false, reason: 'superadmin' } : planFromAnswer(answer);
}

/** a value as tridant sends it: a count, Infinity for `unlimited`, or null when absent or unreadable. */
function readLimit(value: string | undefined): number | null {
  if (value === 'unlimited') return Infinity;
  if (value !== undefined && /^\d+$/.test(value)) return Number(value);
  return null;
}

/** the plan's limit for `key`: a count, or Infinity when unrestricted. a flag is 0 or 1. */
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
 * names no tier, so it is derived: a site not in good standing is free, a
 * trialing one is on trial, otherwise deployments or roost mean pro and control
 * means core.
 */
export function planTier(plan: Plan): PlanTier | null {
  if (!plan.enforced) return null;
  if (!plan.inGoodStanding) return 'free';
  if (plan.standing === 'trialing') return 'trial';
  if (entitled(plan, 'owlette.deployments') || entitled(plan, 'owlette.roost')) return 'pro';
  if (entitled(plan, 'owlette.control')) return 'core';
  return 'free';
}

/** a 402 `plan_required` when the site's plan lacks `key`, else null. */
export async function requireEntitlement(
  siteId: string,
  key: PlanFlag,
  siteData?: SiteData,
): Promise<NextResponse | null> {
  const plan = await resolveSitePlan(siteId, siteData);
  return entitled(plan, key) ? null : problemPlanRequired(PLAN_REQUIRED_DETAIL[key], key);
}

/** a site whose plan cannot be read is not free: the free counts fail open per site. */
function isFree(plan: Plan): boolean {
  return plan.enforced && !plan.inGoodStanding;
}

/** a free limit as a free site's answer states it. tridant's default is 1, and so is ours when it sends none. */
function freeLimit(plan: Plan, key: PlanLimit): number {
  return (plan.enforced ? readLimit(plan.ent[key]) : null) ?? 1;
}

/** every site `ownerUid` owns, with its plan. for an owner known not to be a superadmin. */
async function ownedSitePlans(ownerUid: string) {
  const owned = await getAdminDb().collection('sites').where('owner', '==', ownerUid).select().get();
  return Promise.all(
    owned.docs.map(async (site) => ({ site, plan: planFromAnswer(await getSiteEntitlements(site.id)) })),
  );
}

/**
 * whether credentials may be minted for `machineId` on this site. a billed or
 * trialing site always fits. owlette free is per account (adr 0018): the owner's free sites
 * share one machine limit, counted as distinct ids, and an id already on any
 * site the owner has is a re-pair, which always fits.
 */
export async function machineSlotAvailable(
  siteId: string,
  machineId: string,
  siteData?: SiteData,
): Promise<boolean> {
  if (offBeforeReads()) return true;
  const data = await readSite(siteId, siteData);
  const owner = ownerOf(data);
  const plan = await resolveSitePlan(siteId, data);
  if (!owner || !isFree(plan)) return true;

  const owned = await ownedSitePlans(owner);
  const machineSnaps = await Promise.all(owned.map(({ site }) => site.ref.collection('machines').select().get()));
  const known = new Set<string>();
  const onFree = new Set<string>();
  owned.forEach(({ plan: sitePlan }, i) => {
    for (const machine of machineSnaps[i].docs) {
      known.add(machine.id);
      if (isFree(sitePlan)) onFree.add(machine.id);
    }
  });
  return known.has(machineId) || onFree.size < freeLimit(plan, 'owlette.machines');
}

/** whether `ownerUid` may own one more free site. billed and trialing sites never count. */
export async function siteSlotAvailable(ownerUid: string): Promise<boolean> {
  if (offBeforeReads() || (await isSuperadmin(ownerUid))) return true;
  const free = (await ownedSitePlans(ownerUid)).filter(({ plan }) => isFree(plan));
  return free.length === 0 || free.length < freeLimit(free[0].plan, 'owlette.sites');
}

export function __resetForTests(): void {
  loggedOnce.clear();
}
