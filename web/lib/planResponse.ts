/**
 * the wire shape of `GET /api/account/plan`: the signed-in user's trial, the
 * sites they own with each one's plan, and how much of owlette free they use
 * (adr 0018). types only and no imports, so client code can use it.
 */

/**
 * why plans are not enforced. `unreachable`, `rejected` and `malformed_response`
 * are tridant id failing, which fails open. the same union as `PlanOffReason` in
 * `plan.server.ts`, which the route's assignments hold it to.
 */
export type PlanOffReason =
  | 'enforcement_off'
  | 'not_configured'
  | 'unreachable'
  | 'rejected'
  | 'malformed_response'
  | 'superadmin'
  | 'no_payer';

/** a site's plan as the api names it. */
export type SiteTier = 'free' | 'trial' | 'core' | 'pro';

export type AccountTrialStatus = 'none' | 'unverified' | 'active' | 'ended' | 'link_required';

export interface AccountPlanTrial {
  /**
   * `unverified`: verify the email and the trial starts on the next read.
   * `link_required`: the email already has a tridant account, which must be linked first.
   * `ended` also covers an account that paid before it ever had a trial.
   */
  status: AccountTrialStatus;
  /** epoch ms. null unless a trial was started. */
  endsAt: number | null;
}

/** what the site is billed as: the pointer on the site document, not tridant id's word. */
export interface AccountPlanSiteBilling {
  tier: 'core' | 'pro';
  founders: boolean;
  /** epoch ms the billing stops at, once the owner stopped it or transferred the site. */
  endsAt: number | null;
}

/** the site's billing period, epoch ms. */
export interface AccountPlanPeriod {
  start: number;
  end: number;
}

export interface AccountPlanSite {
  siteId: string;
  name: string;
  /** null when this site's plan is not enforced: it is unrestricted, and `reason` says why. */
  tier: SiteTier | null;
  /** tridant id's standing, such as `active`, `trialing`, `past_due`, `expired`. null with a null `tier`. */
  standing: string | null;
  /** false is a site on owlette free. */
  inGoodStanding: boolean;
  /** only with a null `tier`. */
  reason?: PlanOffReason;
  billing: AccountPlanSiteBilling | null;
  /** null for a site that is not billed. */
  period: AccountPlanPeriod | null;
  /**
   * distinct machines online since the period started, or since the 1st of this
   * month (UTC) for a site with no period. null when the count could not be read
   * or the site's plan is not enforced.
   */
  activeMachinesThisPeriod: number | null;
}

export interface AccountPlanLiveMachine {
  siteId: string;
  machineId: string;
}

/** owlette free is per account: counted across the free sites the caller owns. */
export interface AccountPlanFree {
  sitesUsed: number;
  /** null is unlimited. */
  sitesLimit: number | null;
  /** distinct machine ids on the caller's free sites. */
  machinesUsed: number;
  /** null is unlimited. */
  machinesLimit: number | null;
  /**
   * the machines the machine limit keeps live: the first `machinesLimit` on the
   * caller's free sites, earliest paired first, then by machine id. the
   * dashboard shows the rest of those sites' machines behind an upgrade notice.
   */
  liveMachines: AccountPlanLiveMachine[];
}

/** founders places left per plan. null is no cap. */
export interface AccountPlanFounders {
  core: number | null;
  pro: number | null;
}

export interface AccountPlanOff {
  enforced: false;
  reason: PlanOffReason;
}

export interface AccountPlanOn {
  enforced: true;
  emailVerified: boolean;
  trial: AccountPlanTrial;
  /** the sites the caller owns. */
  sites: AccountPlanSite[];
  free: AccountPlanFree;
  /** null when tridant id could not be asked. */
  foundersRemaining: AccountPlanFounders | null;
  /** whether "link your tridant account" can be offered on this deployment. */
  linkAvailable: boolean;
  /** the origin of the tridant portal, where the card and invoices are. null when this deployment does not know it. */
  portalUrl: string | null;
  /** entitlement keys a site's answer left out, which read as unrestricted. sent only when there are any. */
  missingKeys?: string[];
}

export type AccountPlanResponse = AccountPlanOff | AccountPlanOn;
