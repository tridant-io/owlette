/**
 * GET /api/sites/{siteId}/plan — the site's plan as tridant id states it (adr
 * 0018): tier, standing, what the plan includes, the billing owlette recorded
 * for the site and its billing period, and which machines owlette free covers.
 * with plans not enforced it answers `enforced: false` with the reason and
 * every flag on.
 *
 * any member of the site reads it, a machine-scoped one included: every gate in
 * the dashboard follows it, so everyone on the site sees the same locks.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { applyAuthDeprecations, requireSiteAuthAndScope } from '@/app/api/_shared';
import { problemFromError, problemNotFound } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { entitled, ownerFreeMachines, planTier, resolveSitePlan, type Plan } from '@/lib/plan.server';
import { siteBillingView } from '@/lib/siteBilling.server';
import type { SitePlanResponse } from '@/lib/sitePlanResponse';

function periodOf(plan: Plan): SitePlanResponse['period'] {
  const billing = plan.enforced ? plan.billing : null;
  return billing && billing.periodStart !== null && billing.periodEnd !== null
    ? { start: billing.periodStart, end: billing.periodEnd }
    : null;
}

/** the machines this site's owner's owlette free leaves live here, when it locks any. */
async function freeMachinesOf(siteId: string, owner: unknown, plan: Plan): Promise<SitePlanResponse['freeMachines']> {
  if (!plan.enforced || plan.inGoodStanding || typeof owner !== 'string') return null;
  const { machinesUsed, machinesLimit, liveMachines } = await ownerFreeMachines(owner);
  // with a slot to spare, a machine paired after this answer fits too.
  if (machinesLimit === null || machinesUsed < machinesLimit) return null;
  return {
    limit: machinesLimit,
    live: liveMachines.filter((machine) => machine.siteId === siteId).map((machine) => machine.machineId),
  };
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ siteId: string }> }) {
  try {
    const { siteId } = await params;
    const auth = await requireSiteAuthAndScope(request, siteId, 'read', { machineScope: 'admit' });
    if (!auth.ok) return auth.response;

    const siteData = (await getAdminDb().collection('sites').doc(siteId).get()).data();
    if (!siteData) return problemNotFound(`site ${siteId} not found`);

    const plan = await resolveSitePlan(siteId, siteData);
    const body: SitePlanResponse = {
      enforced: plan.enforced,
      ...(plan.enforced ? {} : { reason: plan.reason }),
      tier: planTier(plan),
      standing: plan.enforced ? plan.standing : null,
      inGoodStanding: !plan.enforced || plan.inGoodStanding,
      flags: {
        control: entitled(plan, 'owlette.control'),
        deployments: entitled(plan, 'owlette.deployments'),
        swoop: entitled(plan, 'owlette.swoop'),
        hoot: entitled(plan, 'owlette.hoot'),
        roost: entitled(plan, 'owlette.roost'),
        talons: entitled(plan, 'owlette.talons'),
        webhooks: entitled(plan, 'owlette.webhooks'),
        api_keys: entitled(plan, 'owlette.api_keys'),
      },
      period: periodOf(plan),
      isOwner: siteData.owner === auth.userId,
      // the same rule the billing routes refuse an upgrade on, so the ui can say it before the owner asks.
      ...siteBillingView(siteData, plan),
      freeMachines: await freeMachinesOf(siteId, siteData.owner, plan),
    };
    return applyAuthDeprecations(NextResponse.json(body), auth.scopeCheck);
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/plan:GET');
  }
}
