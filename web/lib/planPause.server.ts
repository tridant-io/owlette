/**
 * runtime pauses (plan.md decisions 7 and 8): background paths that skip, rather
 * than refuse, when a site's payer lacks a key. alert recipients pause without
 * `owlette.control`, webhook delivery without `owlette.webhooks`, talon matching
 * without `owlette.talons`.
 *
 * fails open: a lookup error proceeds. these run inside fan-outs that must never
 * throw, and a firestore hiccup must not silence a paying customer's alerts.
 */

import logger from '@/lib/logger';
import { entitled, payerForSite, plansEnforced, resolvePlan, type Plan, type PlanFlag } from '@/lib/plan.server';

/**
 * a per-batch memo, so a fan-out resolves each site's payer, and each payer's
 * plan, once. it holds promises, so concurrent calls share one lookup.
 * caller-owned rather than a module cache: a payer who upgrades is live again on
 * the next batch. one per batch; never share one across runs.
 */
export interface PlanMemo {
  /** siteId → its payer's plan */
  readonly sites: Map<string, Promise<Plan>>;
  /** payer uid → plan, shared by every site that payer owns */
  readonly payers: Map<string, Promise<Plan>>;
}

export function createPlanMemo(): PlanMemo {
  return { sites: new Map(), payers: new Map() };
}

function payerPlan(payer: string | null, memo: PlanMemo): Promise<Plan> {
  if (!payer) return resolvePlan(null);
  let plan = memo.payers.get(payer);
  if (!plan) {
    plan = resolvePlan(payer);
    memo.payers.set(payer, plan);
  }
  return plan;
}

function sitePlan(siteId: string, memo: PlanMemo, siteData?: Record<string, unknown> | null): Promise<Plan> {
  let plan = memo.sites.get(siteId);
  if (!plan) {
    plan = payerForSite(siteId, siteData).then((payer) => payerPlan(payer, memo));
    memo.sites.set(siteId, plan);
  }
  return plan;
}

/**
 * whether a background path should skip this site because its payer lacks
 * `key`. never throws. pass site data already read to skip the site read.
 */
export async function pausedByPlan(
  siteId: string,
  key: PlanFlag,
  memo: PlanMemo = createPlanMemo(),
  siteData?: Record<string, unknown> | null,
): Promise<boolean> {
  try {
    if (!plansEnforced()) return false;
    return !entitled(await sitePlan(siteId, memo, siteData), key);
  } catch (error) {
    logger.warn('[plan] plan lookup failed; proceeding', {
      context: 'plan',
      data: { siteId, key, error: String(error) },
    });
    return false;
  }
}
