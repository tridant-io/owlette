import { NextRequest, NextResponse } from 'next/server';
import { cronSecretMatches } from '@/lib/secretMatches.server';
import { apiError } from '@/lib/apiErrorResponse';
import { runPlanSettle } from '@/lib/planSettle.server';

/**
 * GET /api/cron/plan-settle — the month-end settle pass (adr 0018; the work is
 * in `@/lib/planSettle.server`): each billed site whose period ended in the last
 * day is recounted to the period's last millisecond and reported to tridant id
 * again, while tridant id still holds that period's invoice open. answers the
 * run's counts. auth: X-Cron-Secret must equal CRON_SECRET.
 *
 * runs on cron-job.org, not railway — register once per environment, in UTC:
 *   0 6 * * *  GET https://<app>/api/cron/plan-settle
 *   header: X-Cron-Secret: <that environment's CRON_SECRET>
 */
export async function GET(request: NextRequest) {
  if (!cronSecretMatches(request.headers.get('x-cron-secret'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    return NextResponse.json(await runPlanSettle());
  } catch (error) {
    return apiError(error, 'cron/plan-settle');
  }
}
