/**
 * active machines per site, the usage report to tridant id, and the plan
 * snapshot cloud functions read (adr 0018). `/api/cron/plan-daily` runs it at
 * 23:30 UTC. tridant id bills a period's newest report and holds the closed
 * period's invoice open for a day, so the settle pass (`/api/cron/plan-settle`)
 * resends each billed site's month from the report saved here the morning after.
 *
 * - `billing_usage/{siteId}/days/{YYYY-MM-DD}` = `{ machineIds, updatedAt }`:
 *   the machines whose `lastHeartbeat` fell on that UTC day. a billing
 *   period's active machines are the union of its days.
 * - `billing_usage/{siteId}.report` = `{ periodStart, periodEnd, countedFrom,
 *   floor, machines, asOf, status, recorded, settled, at }`: a billed site's
 *   last report, what the settle pass resends. the settle pass updates its
 *   send fields in place and adds `settlesAt`.
 * - `plan_snapshot/{siteId}` = `{ enforced, control, roost, resolvedAt }`:
 *   functions can't call tridant id, so they gate on this instead.
 *
 * both are server-only: the catch-all deny in `firestore.rules` covers them,
 * and `__tests__/rules/planCollections.test.ts` holds it there.
 */

import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { timestampToMs } from '@/lib/firestoreTime.server';
import { inBatches } from '@/lib/inBatches';
import logger from '@/lib/logger';
import { plansEnforced, resolveSitePlan, tridantConfigured, type Plan } from '@/lib/plan.server';
import { billedFrom, getPlanAccount, movedTrialEnd, recordTrialEnd, type PlanAccount } from '@/lib/planAccounts.server';
import { reconcileSiteRegistration } from '@/lib/planTrial.server';
import { PRICING_FACTS } from '@/lib/product-facts';
import { adoptBilling, closeEndedBilling, stopStrandedBilling } from '@/lib/siteBilling.server';
import { checkTridantKeys, type TridantKeyCheck } from '@/lib/tridant.server';
import { PRODUCT, reportUsage } from '@/lib/tridantBilling.server';
import { primeSiteEntitlements } from '@/lib/tridantEntitlements.server';
import { sweepSiteRemovals, type SiteRemovalSweep } from '@/lib/tridantSiteRemoval.server';

const DAY_MS = 24 * 60 * 60 * 1000;

/** two hours past a day, so a late run still overlaps the one before it. */
export const ACTIVE_WINDOW_MS = 26 * 60 * 60 * 1000;
export const USAGE_RETENTION_DAYS = 100;

const SITE_PAGE_SIZE = 100;

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
  /** the retry of deleted sites tridant id still held. */
  removals: SiteRemovalSweep;
  /** each tridant key's scopes and expiry, or why its scopes could not be read; empty while tridant id is not configured. */
  keys: TridantKeyCheck[];
}

/** a billed site's count and the period it counts in. */
interface BilledSite {
  siteId: string;
  /** with the floor applied: what is sent. */
  machines: number;
  periodStart: number;
  periodEnd: number | null;
  countedFrom: number;
  /** the plan's minimum (pro's three machines), 0 when it has none. */
  floor: number;
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

function usageDays(db: FirebaseFirestore.Firestore, siteId: string): FirebaseFirestore.CollectionReference {
  return db.collection('billing_usage').doc(siteId).collection('days');
}

/**
 * unions the site's machines seen in the active window into the day doc of each
 * one's heartbeat; answers how many it stamped.
 */
export async function stampSiteMachines(siteId: string, nowMs: number): Promise<number> {
  const db = getAdminDb();
  const cutoffMs = nowMs - ACTIVE_WINDOW_MS;
  const byDay = new Map<string, string[]>();
  const machines = await db.collection('sites').doc(siteId).collection('machines').select('lastHeartbeat').get();
  for (const machine of machines.docs) {
    const heartbeatMs = timestampToMs(machine.data().lastHeartbeat);
    if (heartbeatMs === null || heartbeatMs < cutoffMs) continue;
    // the heartbeat's own day, not the run's: a machine last seen on a period's final
    // evening must not count in the next period when the run lands after midnight.
    const day = usageDay(new Date(heartbeatMs));
    byDay.set(day, [...(byDay.get(day) ?? []), machine.id]);
  }

  const days = usageDays(db, siteId);
  const stamped = await Promise.all(
    Array.from(byDay, async ([day, machineIds]) => {
      // a union, so a rerun or a second registration of the job adds nothing.
      await days
        .doc(day)
        .set(
          { machineIds: FieldValue.arrayUnion(...machineIds), updatedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
      return machineIds.length;
    }),
  );
  return stamped.reduce((sum, count) => sum + count, 0);
}

/**
 * the site owner's plan account, with a trial end tridant id moved (an extension)
 * recorded and applied: without it the added days would count as billed until the
 * owner next opens the plan page.
 */
async function ownerAccount(
  run: Run,
  site: FirebaseFirestore.QueryDocumentSnapshot,
  plan: Plan,
): Promise<PlanAccount | null> {
  const owner = site.data().owner;
  if (typeof owner !== 'string') return null;
  const stored = await getPlanAccount(owner);
  const trialEnd = movedTrialEnd([plan], stored);
  if (stored === null || trialEnd === null) return stored;
  try {
    await recordTrialEnd(owner, trialEnd);
  } catch (error) {
    // this count still starts at the new end, and the next run records it again.
    fail(run.summary, `recording the trial end for site ${site.id}`, error);
  }
  return { ...stored, trialEndsAt: trialEnd };
}

/** stamps, snapshots and re-registers one site; answers its count when tridant id bills it. */
async function runSite(run: Run, site: FirebaseFirestore.QueryDocumentSnapshot): Promise<BilledSite | null> {
  const { db, summary } = run;
  try {
    // awaited before the sum: `+= await` reads the total first, and sites run ten at a time.
    const stamped = await stampSiteMachines(site.id, run.nowMs);
    summary.machines += stamped;
  } catch (error) {
    fail(summary, `usage of site ${site.id}`, error);
  }

  // whatever the enforcement switch says: someone is being billed for a site that is no longer theirs.
  await stopStrandedBilling(site.id, site.data());

  // with enforcement off nothing is asked of tridant. the web's own resolver, so functions gate a
  // site exactly as the web does: a superadmin's or ownerless site and a failed read all allow.
  let plan: Extract<Plan, { enforced: true }> | null = null;
  if (run.enforced) {
    try {
      const resolved = await resolveSitePlan(site.id, site.data());
      if (resolved.enforced) plan = resolved;
    } catch (error) {
      // the resolver reads the owner's user doc. one site's read must not end the run, or no other
      // site is snapshotted or reported.
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

  // a site tridant id holds under another organization than its owner's (a transfer) moves once it is idle there.
  if (plan) await reconcileSiteRegistration(site.id, site.data(), plan);
  // a site billed with no pointer on it: its checkout was paid and the return never loaded.
  if (plan) await adoptBilling(site.id, site.data(), plan);
  // a pointer that says billed on a site tridant id no longer bills: stripe cancelled the subscription.
  if (plan) await closeEndedBilling(site.id, site.data(), plan);

  // a site under a trial, or on free, has no billing period and nothing to report.
  const billing = plan?.billing ?? null;
  if (plan === null || billing === null || billing.periodStart === null) return null;
  try {
    const countedFrom = billedFrom(billing.periodStart, await ownerAccount(run, site, plan));
    const machines = await activeMachinesBetween(site.id, countedFrom, run.nowMs);
    // the billed product, not the flags: a site bought at core during its owner's trial reads pro until the trial ends.
    const floor = billing.productId === PRODUCT.pro ? PRICING_FACTS.pro.minMachines : 0;
    return {
      siteId: site.id,
      machines: Math.max(machines, floor),
      periodStart: billing.periodStart,
      periodEnd: billing.periodEnd,
      countedFrom,
      floor,
    };
  } catch (error) {
    fail(summary, `counting site ${site.id}`, error);
    return null;
  }
}

/**
 * `billing_usage/{siteId}.report`. replaced whole, so a field the settle pass
 * adds for one period never lingers into the next.
 */
async function saveReport(run: Run, site: BilledSite, status: string, recorded: boolean): Promise<void> {
  try {
    await run.db
      .collection('billing_usage')
      .doc(site.siteId)
      .set(
        {
          report: {
            periodStart: site.periodStart,
            periodEnd: site.periodEnd,
            countedFrom: site.countedFrom,
            floor: site.floor,
            machines: site.machines,
            asOf: run.nowMs,
            status,
            recorded,
            settled: false,
            at: FieldValue.serverTimestamp(),
          },
        },
        { mergeFields: ['report'] },
      );
  } catch (error) {
    fail(run.summary, `saving the report of site ${site.siteId}`, error);
  }
}

/**
 * one call for every billed site, then each site's report saved with its outcome.
 * an entry tridant id does not file is logged, and the next run sends it again.
 */
async function reportBilledSites(run: Run, billed: BilledSite[]): Promise<void> {
  const { summary } = run;
  if (billed.length === 0) return;
  summary.reported = billed.length;

  const answer = await reportUsage(billed.map(({ siteId, machines }) => ({ siteId, machines })), run.nowMs);
  if (!answer.ok) {
    summary.errors += 1;
    logger.error('[plan-daily] usage report failed', {
      context: 'planUsage',
      data: { reason: answer.reason, sites: billed.length },
    });
    await inBatches(billed, (site) => saveReport(run, site, answer.reason, false));
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
  // one outcome per entry, in the order sent.
  await inBatches(
    billed.map((site, index) => ({ site, outcome: answer.results[index] })),
    ({ site, outcome }) => saveReport(run, site, outcome.status, outcome.recorded),
  );
}

/**
 * what tridant id says each key can do, in the summary; a key that cannot do its job logs at error.
 * a key left blank is a choice (no releases registered from here), so it is in the summary only.
 */
async function checkKeys(run: Run): Promise<void> {
  for (const check of await checkTridantKeys()) {
    run.summary.keys.push(check);
    const { keyName, ok, reason, missing } = check;
    if (!ok && reason !== 'not_configured') {
      logger.error('[plan-daily] tridant key not usable', { context: 'planUsage', data: { keyName, reason, missing } });
    }
  }
}

/** drops day docs older than the retention window, under every parent ever stamped. */
async function pruneUsage(run: Run, cutoffDay: string): Promise<void> {
  const { db, summary } = run;
  // listDocuments includes the parent paths that hold only subcollections, as most of these do.
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
      removals: { removed: 0, pending: 0, dropped: 0, errors: 0 },
      keys: [],
    },
  };
  const { db, summary } = run;

  const billed: BilledSite[] = [];
  let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    // owner for the plan, name for the registration.
    let query = db.collection('sites').orderBy(FieldPath.documentId()).select('owner', 'name', 'billing').limit(SITE_PAGE_SIZE);
    if (last) query = query.startAfter(last);
    const page = await query.get();
    summary.sites += page.size;

    // one call fills the entitlement cache for the page; a site it missed is read on its own.
    if (run.enforced) await primeSiteEntitlements(page.docs.map((site) => site.id));
    for (const counted of await inBatches(page.docs, (site) => runSite(run, site))) {
      if (counted) billed.push(counted);
    }

    if (page.size < SITE_PAGE_SIZE) break;
    last = page.docs[page.docs.length - 1];
  }

  // a report that does not land is sent again by the next run, and a month's last one by the settle
  // pass the morning after.
  await reportBilledSites(run, billed);

  summary.removals = await sweepSiteRemovals(run.nowMs);
  if (tridantConfigured()) {
    try {
      await checkKeys(run);
    } catch (error) {
      fail(summary, 'tridant key check', error);
    }
  }

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
