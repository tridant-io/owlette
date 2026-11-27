import { NextRequest, NextResponse } from 'next/server';
import { cronSecretMatches } from '@/lib/secretMatches.server';
import { runAlertDigest } from '@/lib/alerts/digestJob.server';
import { apiError } from '@/lib/apiErrorResponse';

/**
 * GET /api/cron/alert-digest — sends each person's alert digest once its period
 * is due: 08:00 in their zone daily, monday 08:00 weekly, on the whole UTC hour
 * hourly, and at once for someone who switched to each alert as it happens.
 * Auth: X-Cron-Secret must equal CRON_SECRET.
 *
 * Runs on cron-job.org (infra/cron-jobs.json), every 15 minutes with a 60s
 * timeout. Safe to run twice at once: each period is claimed in a transaction.
 */
export async function GET(request: NextRequest) {
  if (!cronSecretMatches(request.headers.get('x-cron-secret'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const report = await runAlertDigest();
    return NextResponse.json({ ok: true, ...report });
  } catch (error) {
    return apiError(error, 'cron/alert-digest');
  }
}
