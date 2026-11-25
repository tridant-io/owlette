/**
 * runtime pauses: background paths that skip, rather than refuse, when a site's
 * plan lacks a key. alert recipients pause without `owlette.control`, webhook
 * delivery without `owlette.webhooks`, talon matching without `owlette.talons`.
 *
 * fails open: a lookup error proceeds. these run inside fan-outs that must never
 * throw, and a firestore hiccup must not silence a paying customer's alerts.
 */

import logger from '@/lib/logger';
import { entitled, plansEnforced, resolveSitePlan, type Plan, type PlanFlag } from '@/lib/plan.server';

/**
 * a per-batch memo, so a fan-out resolves each site's plan once. it holds
 * promises, so concurrent calls share one lookup. caller-owned rather than a
 * module cache: a site that upgrades is live again on the next batch. one per
 * batch; never share one across runs.
 */
export interface PlanMemo {
  /** siteId → the site's plan */
  readonly sites: Map<string, Promise<Plan>>;
}

export function createPlanMemo(): PlanMemo {
  return { sites: new Map() };
}

function sitePlan(siteId: string, memo: PlanMemo, siteData?: Record<string, unknown> | null): Promise<Plan> {
  let plan = memo.sites.get(siteId);
  if (!plan) {
    plan = resolveSitePlan(siteId, siteData);
    memo.sites.set(siteId, plan);
  }
  return plan;
}

/**
 * whether a background path should skip this site because its plan lacks
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
