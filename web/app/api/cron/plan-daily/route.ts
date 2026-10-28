import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/apiErrorResponse';
import { runPlanDaily } from '@/lib/planUsage.server';

/**
 * GET /api/cron/plan-daily — stamps each payer's active machines for the day
 * and refreshes their plan snapshot (plan.md decision 10; the work is in
 * `@/lib/planUsage.server`). auth: X-Cron-Secret must equal CRON_SECRET.
 *
 * runs on cron-job.org, not railway — register once per environment:
 *   0 3 * * *  GET https://<app>/api/cron/plan-daily
 *   header: X-Cron-Secret: <that environment's CRON_SECRET>
 */
export async function GET(request: NextRequest) {
  const cronSecret = request.headers.get('x-cron-secret');
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    return NextResponse.json(await runPlanDaily());
  } catch (error) {
    return apiError(error, 'cron/plan-daily');
  }
}
