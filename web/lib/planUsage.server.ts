/**
 * active machines per site, the usage report to tridant id, and the plan
 * snapshot cloud functions read (adr 0018). `/api/cron/plan-daily` runs it at
 * 23:30 UTC: tridant id bills what it holds when the month ends, so the last
 * run of a month is the one that bills.
 *
 * - `billing_usage/{siteId}/days/{YYYY-MM-DD}` = `{ machineIds, updatedAt }`:
 *   the machines whose `lastHeartbeat` fell on that UTC day. a billing
 *   period's active machines are the union of its days.
 * - `plan_snapshot/{siteId}` = `{ enforced, control, roost, resolvedAt }`:
 *   functions can't call tridant id, so they gate on this instead.
 *
 * both are server-only: the catch-all deny in `firestore.rules` covers them,
 * and `__tests__/rules/planCollections.test.ts` holds it there.
 */

import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { timestampToMs } from '@/lib/firestoreTime.server';
import logger from '@/lib/logger';
import { plansEnforced, resolveSitePlan, type Plan } from '@/lib/plan.server';
import { PRICING_FACTS } from '@/lib/product-facts';
import { reportUsage, type UsageEntry } from '@/lib/tridantBilling.server';

const DAY_MS = 24 * 60 * 60 * 1000;

/** two hours past a day, so a late run still overlaps the one before it. */
export const ACTIVE_WINDOW_MS = 26 * 60 * 60 * 1000;
export const USAGE_RETENTION_DAYS = 100;

const SITE_PAGE_SIZE = 100;
// sites handled at once: with plans enforced each is a tridant call with a 5 s timeout.
const BATCH_SIZE = 10;

export interface PlanDailySummary {
  ok: true;
  /** the UTC day of the run, the last day the report counts. */
  day: string;
  sites: number;
  /** active machines stamped, summed over sites. */
  machines: number;
  snapshots: number;
  /** billed sites sent to tridant id; none while plans are not enforced. */
  reported: number;
  /** of those, the ones tridant id filed. */
  recorded: number;
  pruned: number;
  errors: number;
}

interface Run {
  db: FirebaseFirestore.Firestore;
  nowMs: number;
  enforced: boolean;
  summary: PlanDailySummary;
}

/** the UTC day, `YYYY-MM-DD`: a day doc's id. */
export function usageDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function fail(summary: PlanDailySummary, what: string, error: unknown): void {
  summary.errors += 1;
  logger.error(`[plan-daily] ${what} failed`, {
    context: 'planUsage',
    data: { error: error instanceof Error ? error.message : String(error) },
  });
}

async function inBatches<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    results.push(...(await Promise.all(items.slice(i, i + BATCH_SIZE).map(run))));
  }
  return results;
}

function usageDays(db: FirebaseFirestore.Firestore, siteId: string): FirebaseFirestore.CollectionReference {
  return db.collection('billing_usage').doc(siteId).collection('days');
}

/** unions the site's machines seen in the active window into the day doc of each one's heartbeat. */
async function stampSite(run: Run, site: FirebaseFirestore.QueryDocumentSnapshot): Promise<void> {
  const cutoffMs = run.nowMs - ACTIVE_WINDOW_MS;
  const byDay = new Map<string, string[]>();
  const machines = await site.ref.collection('machines').select('lastHeartbeat').get();
  for (const machine of machines.docs) {
    const heartbeatMs = timestampToMs(machine.data().lastHeartbeat);
    if (heartbeatMs === null || heartbeatMs < cutoffMs) continue;
    // the heartbeat's own day, not the run's: a machine last seen on a period's final
    // evening must not count in the next period when the run lands after midnight.
    const day = usageDay(new Date(heartbeatMs));
    byDay.set(day, [...(byDay.get(day) ?? []), machine.id]);
  }

  const days = usageDays(run.db, site.id);
  await Promise.all(
    Array.from(byDay, async ([day, machineIds]) => {
      // a union, so a rerun or a second registration of the job adds nothing.
      await days
        .doc(day)
        .set(
          { machineIds: FieldValue.arrayUnion(...machineIds), updatedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
      run.summary.machines += machineIds.length;
    }),
  );
}

/** stamps and snapshots one site; answers its usage entry when tridant id bills it. */
async function runSite(run: Run, site: FirebaseFirestore.QueryDocumentSnapshot): Promise<UsageEntry | null> {
  const { db, summary } = run;
  try {
    await stampSite(run, site);
  } catch (error) {
    fail(summary, `usage of site ${site.id}`, error);
  }

  // with enforcement off nothing is asked of tridant. the web's own resolver, so functions gate a
  // site exactly as the web does: a superadmin's or ownerless site and a failed read all allow.
  let plan: Extract<Plan, { enforced: true }> | null = null;
  if (run.enforced) {
    try {
      const resolved = await resolveSitePlan(site.id, site.data());
      if (resolved.enforced) plan = resolved;
    } catch (error) {
      // the resolver reads the owner's user doc. one site's read must not end the run: the last
      // run of a month is the one that bills every other site.
      fail(summary, `plan of site ${site.id}`, error);
    }
  }
  try {
    await db
      .collection('plan_snapshot')
      .doc(site.id)
      .set({
        enforced: plan !== null,
        // only an explicit '0' withholds, as plan.server.ts reads a missing key.
        control: plan?.ent['owlette.control'] !== '0',
        roost: plan?.ent['owlette.roost'] !== '0',
        resolvedAt: FieldValue.serverTimestamp(),
      });
    summary.snapshots += 1;
  } catch (error) {
    fail(summary, `snapshot of site ${site.id}`, error);
  }

  // a site under a trial, or on free, has no billing period and nothing to report.
  const periodStart = plan?.billing?.periodStart ?? null;
  if (plan === null || periodStart === null) return null;
  try {
    const machines = await activeMachinesBetween(site.id, periodStart, run.nowMs);
    // an explicit '1' only: the floor adds to a bill, so a key tridant left out never raises it.
    const pro = plan.ent['owlette.deployments'] === '1';
    return { siteId: site.id, machines: pro ? Math.max(machines, PRICING_FACTS.pro.minMachines) : machines };
  } catch (error) {
    fail(summary, `counting site ${site.id}`, error);
    return null;
  }
}

/** one call for every billed site. an entry tridant id does not file is logged, and the next run sends it again. */
async function reportBilledSites(run: Run, entries: UsageEntry[]): Promise<void> {
  const { summary } = run;
  if (entries.length === 0) return;
  summary.reported = entries.length;

  const answer = await reportUsage(entries, run.nowMs);
  if (!answer.ok) {
    summary.errors += 1;
    logger.error('[plan-daily] usage report failed', {
      context: 'planUsage',
      data: { reason: answer.reason, sites: entries.length },
    });
    return;
  }
  for (const { siteId, status, recorded } of answer.results) {
    if (recorded) {
      summary.recorded += 1;
      continue;
    }
    // expected for `site_not_billed` during a stripe trial and for `period_rolled_over`.
    logger.warn('[plan-daily] usage not recorded', { context: 'planUsage', data: { siteId, status } });
  }
}

/** drops day docs older than the retention window, under every parent ever stamped. */
async function pruneUsage(run: Run, cutoffDay: string): Promise<void> {
  const { db, summary } = run;
  // listDocuments includes the parent paths that hold only subcollections, which is all of these.
  const parents = await db.collection('billing_usage').listDocuments();
  await inBatches(parents, async (parent) => {
    try {
      const stale = await parent.collection('days').where(FieldPath.documentId(), '<', cutoffDay).get();
      await Promise.all(stale.docs.map((day) => day.ref.delete()));
      summary.pruned += stale.size;
    } catch (error) {
      fail(summary, `pruning usage of ${parent.id}`, error);
    }
  });
}

export async function runPlanDaily(now: Date = new Date()): Promise<PlanDailySummary> {
  const run: Run = {
    db: getAdminDb(),
    nowMs: now.getTime(),
    enforced: plansEnforced(),
    summary: {
      ok: true,
      day: usageDay(now),
      sites: 0,
      machines: 0,
      snapshots: 0,
      reported: 0,
      recorded: 0,
      pruned: 0,
      errors: 0,
    },
  };
  const { db, summary } = run;

  const entries: UsageEntry[] = [];
  let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let query = db.collection('sites').orderBy(FieldPath.documentId()).select('owner').limit(SITE_PAGE_SIZE);
    if (last) query = query.startAfter(last);
    const page = await query.get();
    summary.sites += page.size;

    for (const entry of await inBatches(page.docs, (site) => runSite(run, site))) {
      if (entry) entries.push(entry);
    }

    if (page.size < SITE_PAGE_SIZE) break;
    last = page.docs[page.docs.length - 1];
  }

  // before the prune: a report that reaches tridant id after the 1st counts for nothing.
  await reportBilledSites(run, entries);

  try {
    await pruneUsage(run, usageDay(new Date(run.nowMs - USAGE_RETENTION_DAYS * DAY_MS)));
  } catch (error) {
    fail(summary, 'listing usage to prune', error);
  }

  logger.info('[plan-daily] done', { context: 'planUsage', data: summary });
  return summary;
}

/** the site's distinct active machines across the UTC days from that of `startMs` to that of `endMs`, inclusive. */
export async function activeMachinesBetween(siteId: string, startMs: number, endMs: number): Promise<number> {
  const days = await usageDays(getAdminDb(), siteId)
    .where(FieldPath.documentId(), '>=', usageDay(new Date(startMs)))
    .where(FieldPath.documentId(), '<=', usageDay(new Date(endMs)))
    .get();

  const machineIds = new Set<string>();
  for (const day of days.docs) {
    const ids: unknown = day.data().machineIds;
    if (!Array.isArray(ids)) continue;
    for (const id of ids) if (typeof id === 'string') machineIds.add(id);
  }
  return machineIds.size;
}
