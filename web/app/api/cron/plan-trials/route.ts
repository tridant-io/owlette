import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/apiErrorResponse';
import { problem, ProblemType } from '@/lib/apiErrors';
import { getAdminAuth } from '@/lib/firebase-admin';
import logger from '@/lib/logger';
import { tridantConfigured } from '@/lib/plan.server';
import { ensureTrial, nameFor } from '@/lib/planTrial.server';
import { cronSecretMatches } from '@/lib/secretMatches.server';
import { checkTridantKeys } from '@/lib/tridant.server';
import { previewTrial } from '@/lib/tridantBilling.server';

// an account costs one trial call and then one round of site registrations per ten sites it owns, each
// round up to tridant's 5 s timeout. at 10 accounts in parallel, a page of accounts that own ten sites
// or fewer takes at most PAGE_SIZE / 10 * 10 s: 100 s of the 300 s limit. every further ten sites an
// account owns adds 5 s to its worker. a dry run costs one preview call per account, 50 s a page at
// most, and the key check ahead of either mode up to 5 s more.
export const maxDuration = 300;

const PAGE_SIZE = 100;
const PARALLEL = 10;

type EligibleUser = { uid: string; email: string; displayName?: string };

async function inPool(users: EligibleUser[], task: (user: EligibleUser) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < users.length) await task(users[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, users.length) }, worker));
}

async function startTrials(users: EligibleUser[]) {
  const counts = { started: 0, alreadyStarted: 0, linkRequired: 0, subscribed: 0, trialUsed: 0, busy: 0, failed: 0 };
  await inPool(users, async ({ uid }) => {
    const { status } = await ensureTrial(uid, { beforeEnforcement: true });
    switch (status) {
      case 'started': counts.started++; break;
      case 'already_started': counts.alreadyStarted++; break;
      case 'link_required': counts.linkRequired++; break;
      case 'subscribed': counts.subscribed++; break;
      case 'trial_used': counts.trialUsed++; break;
      case 'busy': counts.busy++; break;
      default: counts.failed++;
    }
  });
  return counts;
}

async function previewTrials(users: EligibleUser[]) {
  const counts = { wouldStart: 0, already: 0, alreadySubscribed: 0, used: 0, linkRequired: 0, failed: 0 };
  const linkRequired: string[] = [];
  const used: string[] = [];
  await inPool(users, async ({ uid, email, displayName }) => {
    const preview = await previewTrial({ uid, email, name: nameFor(displayName, email) });
    if (!preview.ok) {
      counts.failed++;
    } else if (preview.payer === 'link_required') {
      counts.linkRequired++;
      linkRequired.push(uid);
    } else {
      switch (preview.trial) {
        case 'would_start': counts.wouldStart++; break;
        case 'already': counts.already++; break;
        case 'already_subscribed': counts.alreadySubscribed++; break;
        case 'used': counts.used++; used.push(uid); break;
        default: counts.failed++;
      }
    }
  });
  // uids only: these are the accounts an operator follows up before the bulk start.
  logger.info('[plan] trial preview', { context: 'plan', data: { linkRequired, used } });
  return counts;
}

/**
 * GET /api/cron/plan-trials — starts the free trial for the existing accounts
 * (adr 0018), one page of Firebase Auth users per call; ?pageToken= continues
 * from the previous answer's nextPageToken. a dry run unless ?apply=1: tridant
 * id previews each account's trial, nothing is written, and the uids that must
 * link first or already used a trial are logged. both modes answer `keys`, what
 * tridant id says each of owlette's keys can do; ?apply=1 answers 503 while the
 * license key fails that check, and the release key is only reported.
 * run by hand, not scheduled, before PLAN_ENFORCEMENT is on: it needs only
 * tridant id configured. auth: X-Cron-Secret must equal CRON_SECRET.
 */
export async function GET(request: NextRequest) {
  if (!cronSecretMatches(request.headers.get('x-cron-secret'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!tridantConfigured()) {
    return problem({
      type: ProblemType.ServiceUnavailable,
      title: 'service unavailable',
      status: 503,
      detail: 'tridant id is not configured, so there is no trial to start',
    });
  }

  try {
    const { searchParams } = request.nextUrl;
    const apply = searchParams.get('apply') === '1';

    const keys = await checkTridantKeys();
    const license = keys.find(({ keyName }) => keyName === 'TRIDANT_LICENSE_KEY');
    if (apply && license?.ok !== true) {
      const why = !license
        ? 'it was not checked'
        : license.reason
          ? `its scopes could not be read: ${license.reason}`
          : `it lacks ${license.missing.join(', ')}`;
      return problem({
        type: ProblemType.ServiceUnavailable,
        title: 'service unavailable',
        status: 503,
        detail: `TRIDANT_LICENSE_KEY failed its check (${why}), so no trial is started`,
        keys,
      });
    }

    const page = await getAdminAuth().listUsers(PAGE_SIZE, searchParams.get('pageToken') || undefined);
    const eligible = page.users.flatMap((user) =>
      !user.disabled && user.emailVerified && user.email && !user.uid.startsWith('agent_')
        ? [{ uid: user.uid, email: user.email, displayName: user.displayName }]
        : [],
    );

    return NextResponse.json({
      ok: true,
      apply,
      scanned: page.users.length,
      eligible: eligible.length,
      ...(apply ? await startTrials(eligible) : await previewTrials(eligible)),
      keys,
      nextPageToken: page.pageToken ?? null,
    });
  } catch (error) {
    return apiError(error, 'cron/plan-trials');
  }
}
