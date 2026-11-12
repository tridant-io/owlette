/**
 * GET /api/account/plan — the signed-in user's account as an owner who pays for
 * sites (adr 0018): the trial, every site they own with its plan, how much of
 * owlette free they use, and the founders places left.
 *
 * session or the user's own firebase id token; never an agent or an api key.
 * with plans off it answers `enforced: false` with the reason and reads nothing.
 * otherwise the first read by an account with a verified email starts its
 * trial. the runbook checks this route to confirm enforcement is live.
 */
import type { Timestamp } from 'firebase-admin/firestore';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { ApiAuthError, requireSessionOrIdToken } from '@/lib/apiAuth.server';
import { problemForbidden, problemFromError, problemUnauthorized } from '@/lib/apiErrors';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';
import {
  missingPlanKeys,
  planLimit,
  plansEnforced,
  planTier,
  resolveSitePlan,
  type Plan,
  type PlanLimit,
} from '@/lib/plan.server';
import { getPlanAccount, type PlanAccount } from '@/lib/planAccounts.server';
import type {
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

interface PairedMachine {
  siteId: string;
  machineId: string;
  pairedAt: number;
}

interface OwnedSite {
  entry: AccountPlanSite;
  plan: Plan;
  /** read only for a free site. */
  machines: PairedMachine[];
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
    // a started trial with no end is an account that already paid when it first read its plan.
    const endsAt = account.trialEndsAt;
    return { status: endsAt !== null && endsAt > now ? 'active' : 'ended', endsAt };
  }
  if (account?.linkRequired || start === 'link_required') return { status: 'link_required', endsAt: null };
  return { status: start === 'unverified' ? 'unverified' : 'none', endsAt: null };
}

/**
 * a free limit as the pairing and site gates read it (`freeLimit` in
 * plan.server.ts): tridant's count, 1 when it sends none, null for unlimited.
 */
function freeLimit(plan: Plan | undefined, key: PlanLimit): number | null {
  if (!plan || missingPlanKeys(plan).includes(key)) return 1;
  const limit = planLimit(plan, key);
  return limit === Infinity ? null : limit;
}

async function readOwnedSite(
  site: FirebaseFirestore.QueryDocumentSnapshot,
  monthStart: number,
  now: number,
): Promise<OwnedSite> {
  const data = site.data();
  const plan = await resolveSitePlan(site.id, data);
  const pointer = readBillingPointer(data);
  const base = {
    siteId: site.id,
    name: typeof data.name === 'string' && data.name ? data.name : site.id,
    billing: pointer ? billingSummary(pointer) : null,
  };
  if (!plan.enforced) {
    return {
      plan,
      machines: [],
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
      activeMachinesBetween(site.id, periodStart ?? monthStart, now),
    ),
    plan.inGoodStanding ? null : site.ref.collection('machines').select('pairedAt').get(),
  ]);
  return {
    plan,
    machines: (machines?.docs ?? []).map((doc) => ({
      siteId: site.id,
      machineId: doc.id,
      pairedAt: (doc.get('pairedAt') as Timestamp | undefined)?.toMillis() ?? Infinity,
    })),
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
      if (!plansEnforced()) {
        // plan.server.ts keeps its reason to itself: off is the switch, or tridant id not configured behind it.
        const reason = process.env.PLAN_ENFORCEMENT === 'on' ? 'not_configured' : 'enforcement_off';
        return NextResponse.json({ enforced: false, reason } satisfies AccountPlanResponse);
      }

      const [trialStart, user, founders] = await Promise.all([
        ensureTrial(uid),
        degrade('the auth read', () => getAdminAuth().getUser(uid)),
        foundersRemaining(),
      ]);
      // after the trial start: it registers the caller's sites, which then read as trialing.
      const [account, sites] = await Promise.all([
        degrade('the plan account read', () => getPlanAccount(uid)),
        getAdminDb().collection('sites').where('owner', '==', uid).select('name', 'owner', 'billing').get(),
      ]);

      const now = Date.now();
      const today = new Date(now);
      const monthStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1);
      const owned = await Promise.all(sites.docs.map((site) => readOwnedSite(site, monthStart, now)));

      // every owned site unrestricted (tridant id failing, or a superadmin's sites) is plans off for this account.
      const off = owned.length > 0 && owned.every(({ plan }) => !plan.enforced) ? owned[0].plan : null;
      if (off && !off.enforced) {
        return NextResponse.json({ enforced: false, reason: off.reason } satisfies AccountPlanResponse);
      }

      const freeSites = owned.filter(({ plan }) => plan.enforced && !plan.inGoodStanding);
      const machinesLimit = freeLimit(freeSites[0]?.plan, 'owlette.machines');
      const freeMachines = freeSites
        .flatMap(({ machines }) => machines)
        // infinity minus infinity is NaN, which falls through to the id like a tie.
        .sort((a, b) => a.pairedAt - b.pairedAt || (a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : 0));
      // the limit counts distinct ids, as pairing does: a machine left on two free sites is one machine.
      const machineIds = Array.from(new Set(freeMachines.map(({ machineId }) => machineId)));
      const liveIds = new Set(machineIds.slice(0, machinesLimit ?? undefined));
      const missingKeys = Array.from(new Set(owned.flatMap(({ plan }) => missingPlanKeys(plan))));

      const body: AccountPlanResponse = {
        enforced: true,
        // without the auth read, what the trial start saw.
        emailVerified: user ? user.emailVerified : trialStart.status !== 'unverified',
        trial: trialOf(trialStart.status, account, now),
        sites: owned.map(({ entry }) => entry),
        free: {
          sitesUsed: freeSites.length,
          sitesLimit: freeLimit(freeSites[0]?.plan, 'owlette.sites'),
          machinesUsed: machineIds.length,
          machinesLimit,
          liveMachines: freeMachines
            .filter(({ machineId }) => liveIds.has(machineId))
            .map(({ siteId, machineId }) => ({ siteId, machineId })),
        },
        foundersRemaining: founders.ok ? { core: founders.core, pro: founders.pro } : null,
        linkAvailable: oidcConfigured(),
        ...(missingKeys.length > 0 && { missingKeys }),
      };
      return NextResponse.json(body);
    } catch (error) {
      if (error instanceof ApiAuthError) {
        return error.status === 403
          ? problemForbidden('agent credentials cannot read an account plan')
          : problemUnauthorized();
      }
      return problemFromError(error, 'account/plan:GET');
    }
  },
  { strategy: 'api', identifier: 'ip' },
);
