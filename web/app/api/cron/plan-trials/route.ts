import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/apiErrorResponse';
import { problem, ProblemType } from '@/lib/apiErrors';
import { getAdminAuth } from '@/lib/firebase-admin';
import { tridantConfigured } from '@/lib/plan.server';
import { ensureTrial } from '@/lib/planTrial.server';

// at 10 in parallel and a 5 s tridant timeout a page takes at most PAGE_SIZE / 10 * 5 s: 125 s of the 300 s limit.
export const maxDuration = 300;

const PAGE_SIZE = 250;
const PARALLEL = 10;

/**
 * GET /api/cron/plan-trials — starts the free trial for the existing accounts
 * (adr 0018), one page of Firebase Auth users per call. a dry run unless
 * ?apply=1; ?pageToken= continues from the previous answer's nextPageToken.
 * run by hand, not scheduled, before PLAN_ENFORCEMENT is on: it needs only
 * tridant id configured. auth: X-Cron-Secret must equal CRON_SECRET.
 */
export async function GET(request: NextRequest) {
  const cronSecret = request.headers.get('x-cron-secret');
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!tridantConfigured()) {
    return problem({
      type: ProblemType.ServiceUnavailable,
      title: 'Service unavailable',
      status: 503,
      detail: 'tridant id is not configured, so there is no trial to start',
    });
  }

  try {
    const { searchParams } = request.nextUrl;
    const apply = searchParams.get('apply') === '1';
    const page = await getAdminAuth().listUsers(PAGE_SIZE, searchParams.get('pageToken') || undefined);

    const eligible = page.users
      .filter((user) => !user.disabled && user.emailVerified && !!user.email && !user.uid.startsWith('agent_'))
      .map((user) => user.uid);

    const counts = { started: 0, alreadyStarted: 0, linkRequired: 0, subscribed: 0, busy: 0, failed: 0 };
    if (apply) {
      let next = 0;
      const worker = async () => {
        while (next < eligible.length) {
          const { status } = await ensureTrial(eligible[next++], { beforeEnforcement: true });
          switch (status) {
            case 'started': counts.started++; break;
            case 'already_started': counts.alreadyStarted++; break;
            case 'link_required': counts.linkRequired++; break;
            case 'subscribed': counts.subscribed++; break;
            case 'busy': counts.busy++; break;
            default: counts.failed++;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, eligible.length) }, worker));
    }

    return NextResponse.json({
      ok: true,
      apply,
      scanned: page.users.length,
      eligible: eligible.length,
      ...counts,
      nextPageToken: page.pageToken ?? null,
    });
  } catch (error) {
    return apiError(error, 'cron/plan-trials');
  }
}
