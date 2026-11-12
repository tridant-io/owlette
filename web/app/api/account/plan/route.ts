/**
 * GET /api/account/plan — the signed-in user's account as an owner who pays for
 * sites (adr 0018): the trial, every site they own with its plan, how much of
 * owlette free they use, whether they can create a site, and the founders
 * places left, or held.
 *
 * session or the user's own firebase id token; never an agent or an api key.
 * with plans off it answers `enforced: false` with the reason and reads nothing.
 * otherwise the first read by an account with a verified email starts its
 * trial. the runbook checks this route to confirm enforcement is live.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { ApiAuthError, requireSessionOrIdToken } from '@/lib/apiAuth.server';
import { mfaChallengeProblem, problemForbidden, problemFromError, problemUnauthorized } from '@/lib/apiErrors';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import { timestampToMs } from '@/lib/firestoreTime.server';
import logger from '@/lib/logger';
import {
  countsAsUnpaid,
  FREE_SITES,
  freeMachineUsage,
  missingPlanKeys,
  pairedMachines,
  planOffReason,
  planTier,
  resolveSitePlan,
  siteCreationState,
  type PairedMachine,
  type Plan,
} from '@/lib/plan.server';
import { billedFrom, getPlanAccount, trialActive, type PlanAccount } from '@/lib/planAccounts.server';
import type {
  AccountPlanFoundersHeld,
  AccountPlanResponse,
  AccountPlanSite,
  AccountPlanTrial,
} from '@/lib/planResponse';
import { ensureTrial, type TrialStatus } from '@/lib/planTrial.server';
import { activeMachinesBetween } from '@/lib/planUsage.server';
import { billingSummary, readBillingPointer } from '@/lib/siteBilling.server';
import { foundersRemaining } from '@/lib/tridantBilling.server';
import { oidcConfigured } from '@/lib/tridantOidc.server';
import { withRateLimit } from '@/lib/withRateLimit';

interface OwnedSite {
  entry: AccountPlanSite;
  plan: Plan;
  /** read only for a free site. */
  machines: PairedMachine[];
  /** epoch ms; 0 when the site has none. */
  createdAt: number;
}

/** a part of the answer that fails reads as null, so the plan page still loads. */
async function degrade<T>(what: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    logger.warn(`[account/plan] ${what} failed`, {
      context: 'plan',
      data: { error: error instanceof Error ? error.message : String(error) },
    });
    return null;
  }
}

function trialOf(start: TrialStatus, account: PlanAccount | null, now: number): AccountPlanTrial {
  if (account?.trialStartedAt) {
    return { status: trialActive(account, now) ? 'active' : 'ended', endsAt: account.trialEndsAt };
  }
  if (account?.linkRequired || start === 'link_required') return { status: 'link_required', endsAt: null };
  return { status: start === 'unverified' ? 'unverified' : 'none', endsAt: null };
}

/**
 * the plans an owned site is billed at the founders rate on, or was: tridant id
 * keeps the rate for an organization that has a founders site of that plan, past
 * the cap. owlette knows it only from its records on the sites the account still owns.
 */
function foundersHeld(sites: AccountPlanSite[]): AccountPlanFoundersHeld {
  const held = (tier: 'core' | 'pro') => sites.some(({ billing }) => billing?.founders === true && billing.tier === tier);
  return { core: held('core'), pro: held('pro') };
}

/** the tridant portal is tridant id's oidc issuer, so its origin needs no env var of its own. */
function portalUrl(): string | null {
  const issuer = process.env.TRIDANT_OIDC_ISSUER?.trim();
  if (!issuer) return null;
  try {
    return new URL(issuer).protocol === 'https:' ? issuer.replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}

async function readOwnedSite(
  site: FirebaseFirestore.QueryDocumentSnapshot,
  monthStart: number,
  account: PlanAccount | null,
  now: number,
): Promise<OwnedSite> {
  const data = site.data();
  const plan = await resolveSitePlan(site.id, data);
  const pointer = readBillingPointer(data);
  const createdAt = timestampToMs(data.createdAt) ?? 0;
  const base = {
    siteId: site.id,
    name: typeof data.name === 'string' && data.name ? data.name : site.id,
    billing: pointer ? billingSummary(pointer) : null,
  };
  if (!plan.enforced) {
    return {
      plan,
      machines: [],
      createdAt,
      entry: {
        ...base,
        tier: null,
        standing: null,
        inGoodStanding: true,
        reason: plan.reason,
        period: null,
        activeMachinesThisPeriod: null,
      },
    };
  }

  const periodStart = plan.billing?.periodStart ?? null;
  const periodEnd = plan.billing?.periodEnd ?? null;
  const [active, machines] = await Promise.all([
    degrade(`the usage count of site ${site.id}`, () =>
      // the count the daily job bills, which leaves out the trial.
      activeMachinesBetween(site.id, periodStart === null ? monthStart : billedFrom(periodStart, account), now),
    ),
    plan.inGoodStanding ? [] : pairedMachines(site.ref),
  ]);
  return {
    plan,
    machines,
    createdAt,
    entry: {
      ...base,
      tier: planTier(plan),
      standing: plan.standing,
      inGoodStanding: plan.inGoodStanding,
      period: periodStart !== null && periodEnd !== null ? { start: periodStart, end: periodEnd } : null,
      activeMachinesThisPeriod: active,
    },
  };
}

export const GET = withRateLimit(
  async (request: NextRequest) => {
    try {
      const uid = await requireSessionOrIdToken(request, { rejectAgentTokens: true });
      const offReason = planOffReason();
      if (offReason) {
        return NextResponse.json({ enforced: false, reason: offReason } satisfies AccountPlanResponse);
      }

      const [trialStart, user, founders] = await Promise.all([
        ensureTrial(uid),
        degrade('the auth read', () => getAdminAuth().getUser(uid)),
        foundersRemaining(),
      ]);
      // after the trial start: it registers the caller's sites, which then read as trialing.
      const [account, sites] = await Promise.all([
        degrade('the plan account read', () => getPlanAccount(uid)),
        getAdminDb().collection('sites').where('owner', '==', uid).select('name', 'owner', 'billing', 'createdAt').get(),
      ]);

      const now = Date.now();
      const today = new Date(now);
      const monthStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1);
      const owned = await Promise.all(
        sites.docs.map((site) => readOwnedSite(site, monthStart, account, now)),
      );

      // every owned site unrestricted (tridant id failing, or a superadmin's sites) is plans off for this account.
      const off = owned.length > 0 && owned.every(({ plan }) => !plan.enforced) ? owned[0].plan : null;
      if (off && !off.enforced) {
        return NextResponse.json({ enforced: false, reason: off.reason } satisfies AccountPlanResponse);
      }

      const unpaid = owned.filter(({ plan }) => countsAsUnpaid(plan));
      const missingKeys = Array.from(new Set(owned.flatMap(({ plan }) => missingPlanKeys(plan))));
      const entries = owned.map(({ entry }) => entry);

      const body: AccountPlanResponse = {
        enforced: true,
        // without the auth read, what the trial start saw.
        emailVerified: user ? user.emailVerified : trialStart.status !== 'unverified',
        trial: trialOf(trialStart.status, account, now),
        sites: entries,
        free: {
          sitesUsed: unpaid.length,
          sitesLimit: FREE_SITES,
          // the same rule every viewer's machine lock follows (GET /api/sites/{siteId}/plan).
          ...freeMachineUsage(owned.filter(({ plan }) => plan.enforced && !plan.inGoodStanding)),
        },
        // the same answer POST /api/sites gives, so the create dialog shows the step the server will ask for.
        siteCreation: siteCreationState(
          unpaid.map(({ entry: { siteId, name }, createdAt }) => ({ siteId, name, createdAt })),
          trialActive(account, now),
        ),
        foundersRemaining: founders.ok ? { core: founders.core, pro: founders.pro } : null,
        foundersHeld: foundersHeld(entries),
        linkAvailable: oidcConfigured(),
        portalUrl: portalUrl(),
        ...(missingKeys.length > 0 && { missingKeys }),
      };
      return NextResponse.json(body);
    } catch (error) {
      if (error instanceof ApiAuthError) {
        return mfaChallengeProblem(error) ?? (error.status === 403
          ? problemForbidden('agent credentials cannot read an account plan')
          : problemUnauthorized());
      }
      return problemFromError(error, 'account/plan:GET');
    }
  },
  { strategy: 'api', identifier: 'ip' },
);
