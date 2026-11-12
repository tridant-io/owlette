/**
 * a site's plan from tridant id, and the gates built on it (adr 0018). owlette
 * free is per account, so its limits are counted here across the sites an
 * account owns: one free site, one machine across the free sites, and every
 * further site created on core or pro.
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
import { timestampToMs } from '@/lib/firestoreTime.server';
import logger from '@/lib/logger';
import { getPlanAccount, trialActive } from '@/lib/planAccounts.server';
import type { AccountPlanFree, AccountPlanSiteCreation, PlanOffReason, SiteTier } from '@/lib/planResponse';
import { PRICING_FACTS } from '@/lib/product-facts';
import { tridantApiUrl } from '@/lib/tridant.server';
import {
  getSiteEntitlements,
  type EntitlementsResult,
  type SiteBillingPeriod,
} from '@/lib/tridantEntitlements.server';

// the site limit is owlette's own rule, not a tridant value: tridant reads one site at a time.
export const PLAN_LIMITS = ['owlette.machines'] as const;
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

export type PlanTier = SiteTier;

export const PLAN_REQUIRED_DETAIL: Record<PlanFlag, string> = {
  'owlette.control': "this site's plan doesn't include remote control. upgrade to continue.",
  'owlette.deployments': "this site's plan doesn't include deployments. upgrade to continue.",
  'owlette.swoop': "this site's plan doesn't include swoop. upgrade to continue.",
  'owlette.hoot': "this site's plan doesn't include hoot. upgrade to continue.",
  'owlette.roost': "this site's plan doesn't include roost. upgrade to continue.",
  'owlette.talons': "this site's plan doesn't include talons. upgrade to continue.",
  'owlette.webhooks': "this site's plan doesn't include webhooks. upgrade to continue.",
  'owlette.api_keys': "this site's plan doesn't include API keys. upgrade to continue.",
};

// these states hold until the env changes, which redeploys, so once per process is enough.
const loggedOnce = new Set<string>();

function onceOnly(key: string): boolean {
  if (loggedOnce.has(key)) return false;
  loggedOnce.add(key);
  return true;
}

/** whether owlette can ask tridant id anything, whatever the enforcement switch says. */
export function tridantConfigured(): boolean {
  // the e2e seam stands in for tridant; otherwise this is tridantFetch's own check.
  if (process.env.OWLETTE_E2E === '1') return true;
  return !!(tridantApiUrl() && process.env.TRIDANT_LICENSE_KEY?.trim());
}

/** the reason plans are off that needs no read, or null when they are enforced. */
export function planOffReason(): 'enforcement_off' | 'not_configured' | null {
  if (process.env.PLAN_ENFORCEMENT !== 'on') return 'enforcement_off';
  if (tridantConfigured()) return null;
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
  return planOffReason() === null;
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
  // a site tridant does not know answers resolved:false with its defaults, which are owlette free.
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
  const off = planOffReason();
  if (off) return { enforced: false, reason: off };
  const owner = ownerOf(await readSite(siteId, siteData));
  if (!owner) return { enforced: false, reason: 'no_payer' };

  const [answer, superadmin] = await Promise.all([getSiteEntitlements(siteId), isSuperadmin(owner)]);
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
  // until tridant-id#76 defines the owlette keys, a missing key must not lock anyone out.
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
  const owned = await getAdminDb()
    .collection('sites')
    .where('owner', '==', ownerUid)
    .select('name', 'createdAt')
    .get();
  return Promise.all(
    owned.docs.map(async (site) => ({ site, plan: planFromAnswer(await getSiteEntitlements(site.id)) })),
  );
}

/**
 * whether credentials may be minted for `machineId` on this site. a billed or
 * trialing site always fits. owlette free is per account (adr 0018): the owner's
 * free sites share one machine limit, counted as distinct ids. an id already on
 * one of them is a re-pair or a move between them, which always fits; one that
 * comes from a billed or trialing site is new to owlette free, so a further site
 * on owlette free cannot be filled from a billed one.
 */
export async function machineSlotAvailable(
  siteId: string,
  machineId: string,
  siteData?: SiteData,
): Promise<boolean> {
  if (planOffReason()) return true;
  const data = await readSite(siteId, siteData);
  const owner = ownerOf(data);
  const plan = await resolveSitePlan(siteId, data);
  if (!owner || !isFree(plan)) return true;

  const free = (await ownedSitePlans(owner)).filter(({ plan: sitePlan }) => isFree(sitePlan));
  const machineSnaps = await Promise.all(free.map(({ site }) => site.ref.collection('machines').select().get()));
  const onFree = new Set(machineSnaps.flatMap((snap) => snap.docs.map((machine) => machine.id)));
  return onFree.has(machineId) || onFree.size < freeLimit(plan, 'owlette.machines');
}

/** a machine on a free site. `pairedAt` is epoch ms, Infinity for one paired before it was stamped. */
export interface PairedMachine {
  siteId: string;
  machineId: string;
  pairedAt: number;
}

export async function pairedMachines(site: FirebaseFirestore.DocumentReference): Promise<PairedMachine[]> {
  const snap = await site.collection('machines').select('pairedAt').get();
  return snap.docs.map((machine) => ({
    siteId: site.id,
    machineId: machine.id,
    pairedAt: timestampToMs(machine.get('pairedAt')) ?? Infinity,
  }));
}

export type FreeMachineUsage = Pick<AccountPlanFree, 'machinesUsed' | 'machinesLimit' | 'liveMachines'>;

/**
 * owlette free's machine limit across an account's free sites (adr 0018). it
 * counts distinct ids, as pairing does, and keeps the first `machinesLimit` live,
 * earliest paired first, then by machine id. every other machine on those sites
 * is locked on the dashboard, for everyone who views the site.
 */
export function freeMachineUsage(freeSites: { plan: Plan; machines: PairedMachine[] }[]): FreeMachineUsage {
  const limit = freeSites.length > 0 ? freeLimit(freeSites[0].plan, 'owlette.machines') : 1;
  const machinesLimit = limit === Infinity ? null : limit;
  const machines = freeSites
    .flatMap((site) => site.machines)
    // infinity minus infinity is NaN, which falls through to the id like a tie.
    .sort((a, b) => a.pairedAt - b.pairedAt || (a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : 0));
  // a machine left on two free sites is one machine.
  const machineIds = Array.from(new Set(machines.map(({ machineId }) => machineId)));
  const liveIds = new Set(machineIds.slice(0, machinesLimit ?? undefined));
  return {
    machinesUsed: machineIds.length,
    machinesLimit,
    liveMachines: machines
      .filter(({ machineId }) => liveIds.has(machineId))
      .map(({ siteId, machineId }) => ({ siteId, machineId })),
  };
}

/** `freeMachineUsage` across the sites `ownerUid` owns. for an owner known not to be a superadmin. */
export async function ownerFreeMachines(ownerUid: string): Promise<FreeMachineUsage> {
  const free = (await ownedSitePlans(ownerUid)).filter(({ plan }) => isFree(plan));
  return freeMachineUsage(
    await Promise.all(free.map(async ({ site, plan }) => ({ plan, machines: await pairedMachines(site.ref) }))),
  );
}

/** owlette free covers one site per account; every further site is created on core or pro. */
export const FREE_SITES = PRICING_FACTS.free.sites;

/**
 * whether a site counts as unpaid when the account creates another (adr 0018):
 * not billed, and no trial covers it. tridant id's answer decides: its billing
 * block is there while the site's billing runs, whatever the standing, so a
 * site whose card failed is never unpaid, since its owner has nothing to
 * upgrade (the free machine count still includes it). the block is gone once
 * the subscription is cancelled, whatever owlette's record on the site says.
 */
export function countsAsUnpaid(plan: Plan): boolean {
  return plan.enforced && !plan.inGoodStanding && !plan.billing;
}

interface UnpaidSite {
  siteId: string;
  name: string;
  /** epoch ms; 0 when the site has none. */
  createdAt: number;
}

const OPEN: AccountPlanSiteCreation = { state: 'open', unpaidSite: null };

/**
 * where creating a site stands for an account, from its unpaid sites
 * (`countsAsUnpaid`). the first is the account's free site. with it taken, a
 * site is created only on its way to core or pro, which leaves at most one more
 * if its checkout is abandoned; with that one too, none. the newest is named,
 * since it is the one the owner meant to put on a plan. during the trial every
 * create is allowed.
 */
export function siteCreationState(unpaid: UnpaidSite[], inTrial: boolean): AccountPlanSiteCreation {
  if (unpaid.length < FREE_SITES || inTrial) return OPEN;
  const [newest] = [...unpaid].sort(
    (a, b) => b.createdAt - a.createdAt || (a.siteId < b.siteId ? -1 : a.siteId > b.siteId ? 1 : 0),
  );
  return {
    state: unpaid.length > FREE_SITES ? 'blocked' : 'choose_plan',
    unpaidSite: { siteId: newest.siteId, name: newest.name },
  };
}

/** where creating a site stands for `ownerUid`. with plans off, and for a superadmin, every create is allowed. */
export async function siteCreation(ownerUid: string): Promise<AccountPlanSiteCreation> {
  if (planOffReason() || (await isSuperadmin(ownerUid))) return OPEN;
  const unpaid = (await ownedSitePlans(ownerUid))
    .filter(({ plan }) => countsAsUnpaid(plan))
    .map(({ site }): UnpaidSite => {
      const { name, createdAt } = site.data();
      return {
        siteId: site.id,
        name: typeof name === 'string' && name ? name : site.id,
        createdAt: timestampToMs(createdAt) ?? 0,
      };
    });
  // the trial is read only when it can change the answer.
  if (unpaid.length < FREE_SITES) return OPEN;
  return siteCreationState(unpaid, trialActive(await getPlanAccount(ownerUid)));
}

export function __resetForTests(): void {
  loggedOnce.clear();
}
