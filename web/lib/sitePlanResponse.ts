/**
 * `GET /api/sites/{siteId}/plan` and the `billing` answer of the site billing
 * routes, as they go over the wire. types only, so client hooks import it.
 */

import type { AccountPlanSiteBilling, PlanOffReason, SiteTier } from '@/lib/planResponse';

/** what owlette believes tridant id bills for the site. `endsAt` is epoch ms once billing is stopped. */
export type SiteBilling = AccountPlanSiteBilling;

export interface SitePlanResponse {
  enforced: boolean;
  /** why the site is unrestricted; sent only when not enforced. */
  reason?: PlanOffReason;
  /** the site's plan; null when not enforced. */
  tier: SiteTier | null;
  standing: string | null;
  /** false is owlette free. true when not enforced. */
  inGoodStanding: boolean;
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
  billing: SiteBilling | null;
  /** the billing period of a billed site, epoch ms. */
  period: { start: number; end: number } | null;
  /** whether the caller owns the site, so may change its billing. */
  isOwner: boolean;
  /**
   * after an ownership transfer the outgoing owner pays until the billing ends:
   * the new owner can stop it, and upgrade or switch only once it has ended.
   */
  billedByPreviousOwner: boolean;
}
