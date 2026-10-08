/**
 * GET /api/account/plan — the signed-in user's own plan, as the payer for the
 * sites they own (plan.md decision 1): tier, standing, limits, flags, this
 * month's active machines, and whether they own a site to pay for.
 *
 * session or the user's own firebase id token; never an agent or an api key.
 * with plans not enforced it answers `enforced: false` with the reason, every
 * flag on and no limits, and reads no usage. the runbook checks this route to
 * confirm enforcement is live.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { ApiAuthError, requireSessionOrIdToken } from '@/lib/apiAuth.server';
import { problemForbidden, problemFromError, problemUnauthorized } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  entitled,
  missingPlanKeys,
  planLimit,
  planTier,
  resolvePlan,
  type Plan,
  type PlanLimit,
  type PlanResponse,
} from '@/lib/plan.server';
import { activeMachinesBetween } from '@/lib/planUsage.server';
import { withRateLimit } from '@/lib/withRateLimit';

/** infinity doesn't serialize, so unrestricted goes out as null. */
function wireLimit(plan: Plan, key: PlanLimit): number | null {
  const limit = planLimit(plan, key);
  return limit === Infinity ? null : limit;
}

export const GET = withRateLimit(
  async (request: NextRequest) => {
    try {
      const uid = await requireSessionOrIdToken(request, { rejectAgentTokens: true });
      const plan = await resolvePlan(uid);

      const body: PlanResponse = {
        enforced: plan.enforced,
        plan: planTier(plan),
        standing: plan.enforced ? plan.standing : null,
        limits: { machines: wireLimit(plan, 'owlette.machines'), sites: wireLimit(plan, 'owlette.sites') },
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
        activeMachinesThisMonth: null,
      };
      if (!plan.enforced) {
        body.reason = plan.reason;
        return NextResponse.json(body);
      }

      const missingKeys = missingPlanKeys(plan);
      if (missingKeys.length > 0) {
        body.reason = 'keys_missing';
        body.missingKeys = missingKeys;
      }
      // the calendar month in UTC until tridant id sends the subscription period (tridant-id#76).
      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const [activeMachines, owned] = await Promise.all([
        activeMachinesBetween(uid, monthStart, now),
        getAdminDb().collection('sites').where('owner', '==', uid).limit(1).select().get(),
      ]);
      body.activeMachinesThisMonth = activeMachines;
      body.ownsSites = !owned.empty;
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
