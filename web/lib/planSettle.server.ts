/**
 * the month-end settle pass (adr 0018). tridant id bills the newest report it
 * holds for a period, and holds a closed period's invoice open for a day after
 * the period ends. `/api/cron/plan-settle` runs this at 06:00 UTC: each billed
 * site whose saved report (`billing_usage/{siteId}.report`, written by the daily
 * job) closed its period in the last day is stamped, recounted to the period's
 * last millisecond and sent again as of then. that covers a failed 23:30 run, a
 * report tridant id did not file, and machines last seen between 23:30 and
 * midnight.
 */

import { getAdminDb } from '@/lib/firebase-admin';
import { inBatches } from '@/lib/inBatches';
import logger from '@/lib/logger';
import { plansEnforced } from '@/lib/plan.server';
import { activeMachinesBetween, stampSiteMachines } from '@/lib/planUsage.server';
import { reportUsage, type UsageOutcome } from '@/lib/tridantBilling.server';

// tridant's site_settle_hours: past it, a report into the closed period answers period_closed.
const SETTLE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface PlanSettleSummary {
  ok: true;
  /** saved reports whose period ended in the last day, not yet settled. */
  candidates: number;
  /** of those, the ones recounted and sent to tridant id. */
  sent: number;
  /** of those, the ones tridant id now holds for the closed period. */
  settled: number;
  errors: number;
}

/** a site's closed period, recounted. */
interface Recount {
  ref: FirebaseFirestore.DocumentReference;
  siteId: string;
  /** with the floor applied: what is sent. */
  machines: number;
  asOfMs: number;
}

function fail(summary: PlanSettleSummary, siteId: string, what: string, error: unknown): void {
  summary.errors += 1;
  logger.error(`[plan-settle] ${what} failed`, {
    context: 'planSettle',
    data: { siteId, error: error instanceof Error ? error.message : String(error) },
  });
}

/** stamps the site's machines and counts its closed period to its last millisecond; null when either fails. */
async function recount(
  summary: PlanSettleSummary,
  nowMs: number,
  doc: FirebaseFirestore.QueryDocumentSnapshot,
): Promise<Recount | null> {
  try {
    const { periodEnd, countedFrom, floor } = doc.data().report ?? {};
    if (typeof periodEnd !== 'number' || typeof countedFrom !== 'number' || typeof floor !== 'number') {
      throw new Error('saved report is malformed');
    }
    await stampSiteMachines(doc.id, nowMs);
    // period_end is the next period's start, so this is the closed period's own, and tridant files it there.
    const asOfMs = periodEnd - 1;
    const machines = await activeMachinesBetween(doc.id, countedFrom, asOfMs);
    return { ref: doc.ref, siteId: doc.id, machines: Math.max(machines, floor), asOfMs };
  } catch (error) {
    // not sent: a short count would settle the period, and a rerun skips a settled report.
    fail(summary, doc.id, 'recount', error);
    return null;
  }
}

async function saveOutcome(summary: PlanSettleSummary, site: Recount, outcome: UsageOutcome, settled: boolean) {
  try {
    // dotted paths: the report's period and count basis stay, and the rest now describe this send.
    await site.ref.update({
      'report.settled': settled,
      'report.status': outcome.status,
      'report.recorded': outcome.recorded,
      'report.machines': site.machines,
      'report.asOf': site.asOfMs,
      'report.settlesAt': outcome.settlesAt,
    });
  } catch (error) {
    fail(summary, site.siteId, 'saving the outcome', error);
  }
}

/** one call for every recounted site, then each outcome saved onto its report. */
async function settleSites(summary: PlanSettleSummary, nowMs: number, sites: Recount[]): Promise<void> {
  summary.sent = sites.length;
  const answer = await reportUsage(
    sites.map(({ siteId, machines, asOfMs }) => ({ siteId, machines, asOfMs })),
    nowMs,
  );
  if (!answer.ok) {
    // every report stays unsettled; a rerun by hand inside the window sends them again.
    summary.errors += 1;
    logger.error('[plan-settle] usage report failed', {
      context: 'planSettle',
      data: { reason: answer.reason, sites: sites.length },
    });
    return;
  }
  // one outcome per entry, in the order sent.
  await inBatches(
    sites.map((site, index) => ({ site, outcome: answer.results[index] })),
    async ({ site, outcome }) => {
      // stale: tridant id already holds a newer report for the period. site_not_billed: the
      // site's billing ended with the period, and tridant id closed it when the invoice opened,
      // so the month bills on the daily run's report and a resend can add nothing.
      const settled = outcome.recorded || outcome.status === 'stale' || outcome.status === 'site_not_billed';
      if (settled) {
        summary.settled += 1;
      } else if (outcome.status === 'period_closed') {
        // the invoice is written without this report; tridant id flags the gap too.
        logger.error('[plan-settle] period closed before the resend', {
          context: 'planSettle',
          data: { siteId: site.siteId, status: outcome.status },
        });
      } else {
        logger.warn('[plan-settle] usage not settled', {
          context: 'planSettle',
          data: { siteId: site.siteId, status: outcome.status },
        });
      }
      await saveOutcome(summary, site, outcome, settled);
    },
  );
}

export async function runPlanSettle(now: Date = new Date()): Promise<PlanSettleSummary> {
  const summary: PlanSettleSummary = { ok: true, candidates: 0, sent: 0, settled: 0, errors: 0 };
  if (!plansEnforced()) return summary;
  const nowMs = now.getTime();

  const reports = await getAdminDb()
    .collection('billing_usage')
    .where('report.periodEnd', '>', nowMs - SETTLE_WINDOW_MS)
    .where('report.periodEnd', '<=', nowMs)
    .get();
  const candidates = reports.docs.filter((doc) => {
    const report = doc.data().report;
    // counted from the period's end or later: the trial covered the whole period, so nothing in it bills.
    return report?.settled !== true && !(report?.countedFrom >= report?.periodEnd);
  });
  summary.candidates = candidates.length;

  const sites = (await inBatches(candidates, (doc) => recount(summary, nowMs, doc))).filter(
    (site): site is Recount => site !== null,
  );
  if (sites.length > 0) await settleSites(summary, nowMs, sites);

  logger.info('[plan-settle] done', { context: 'planSettle', data: summary });
  return summary;
}
