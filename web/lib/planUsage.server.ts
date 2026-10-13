/**
 * active machines per payer, and the plan snapshot cloud functions read
 * (plan.md decisions 10 and 13). `/api/cron/plan-daily` runs it at 03:00 UTC.
 *
 * - `billing_usage/{payerUid}/days/{YYYY-MM-DD}` = `{ machineIds, updatedAt }`:
 *   the machines whose `lastHeartbeat` fell in the 26 h before the run. a
 *   billing period's active machines are the union of its days.
 * - `plan_snapshot/{payerUid}` = `{ enforced, control, roost, resolvedAt }`:
 *   functions can't call tridant id, so they gate on this instead.
 *
 * both are server-only: the catch-all deny in `firestore.rules` covers them,
 * and `__tests__/rules/planCollections.test.ts` holds it there.
 */

import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { timestampToMs } from '@/lib/firestoreTime.server';
import logger from '@/lib/logger';
import { entitled, payerForSite, resolvePlan } from '@/lib/plan.server';

const DAY_MS = 24 * 60 * 60 * 1000;

/** two hours past a day, so a late run still overlaps the one before it. */
export const ACTIVE_WINDOW_MS = 26 * 60 * 60 * 1000;
export const USAGE_RETENTION_DAYS = 100;

const SITE_PAGE_SIZE = 100;
// payers resolved at once: each can be a tridant call with a 5 s timeout.
const PAYER_BATCH_SIZE = 10;

export interface PlanDailySummary {
  ok: true;
  /** the day doc this run stamped. */
  day: string;
  sites: number;
  payers: number;
  /** active machines stamped, summed over payers. */
  machines: number;
  snapshots: number;
  pruned: number;
  errors: number;
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

async function inBatches<T>(items: T[], run: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += PAYER_BATCH_SIZE) {
    await Promise.all(items.slice(i, i + PAYER_BATCH_SIZE).map(run));
  }
}

/** every payer with a site, and the machines across their sites seen since `cutoffMs`. */
async function activeMachinesByPayer(
  db: FirebaseFirestore.Firestore,
  cutoffMs: number,
  summary: PlanDailySummary,
): Promise<Map<string, Set<string>>> {
  const byPayer = new Map<string, Set<string>>();
  let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;

  for (;;) {
    let query = db.collection('sites').orderBy(FieldPath.documentId()).select('owner').limit(SITE_PAGE_SIZE);
    if (last) query = query.startAfter(last);
    const page = await query.get();
    summary.sites += page.size;

    await Promise.all(
      page.docs.map(async (site) => {
        const payer = await payerForSite(site.id, site.data());
        if (!payer) return;
        const active = byPayer.get(payer) ?? new Set<string>();
        byPayer.set(payer, active);
        try {
          const machines = await site.ref.collection('machines').select('lastHeartbeat').get();
          for (const machine of machines.docs) {
            const heartbeatMs = timestampToMs(machine.data().lastHeartbeat);
            if (heartbeatMs !== null && heartbeatMs >= cutoffMs) active.add(machine.id);
          }
        } catch (error) {
          fail(summary, `machines of site ${site.id}`, error);
        }
      }),
    );

    if (page.size < SITE_PAGE_SIZE) return byPayer;
    last = page.docs[page.docs.length - 1];
  }
}

async function stampPayer(
  db: FirebaseFirestore.Firestore,
  payerUid: string,
  machineIds: Set<string>,
  day: string,
  summary: PlanDailySummary,
): Promise<void> {
  if (machineIds.size > 0) {
    try {
      // a union, so a rerun or a second registration of the job adds nothing.
      await db
        .collection('billing_usage')
        .doc(payerUid)
        .collection('days')
        .doc(day)
        .set(
          { machineIds: FieldValue.arrayUnion(...Array.from(machineIds)), updatedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
      summary.machines += machineIds.size;
    } catch (error) {
      fail(summary, `usage of payer ${payerUid}`, error);
    }
  }

  try {
    // with enforcement off, or tridant failing open, every flag is entitled: functions allow.
    const plan = await resolvePlan(payerUid);
    await db.collection('plan_snapshot').doc(payerUid).set({
      enforced: plan.enforced,
      control: entitled(plan, 'owlette.control'),
      roost: entitled(plan, 'owlette.roost'),
      resolvedAt: FieldValue.serverTimestamp(),
    });
    summary.snapshots += 1;
  } catch (error) {
    fail(summary, `snapshot of payer ${payerUid}`, error);
  }
}

/** drops day docs older than the retention window, for every payer ever stamped. */
async function pruneUsage(
  db: FirebaseFirestore.Firestore,
  cutoffDay: string,
  summary: PlanDailySummary,
): Promise<void> {
  // listDocuments includes the parent paths that hold only subcollections, which is all of these.
  const payers = await db.collection('billing_usage').listDocuments();
  await inBatches(payers, async (payer) => {
    try {
      const stale = await payer.collection('days').where(FieldPath.documentId(), '<', cutoffDay).get();
      await Promise.all(stale.docs.map((day) => day.ref.delete()));
      summary.pruned += stale.size;
    } catch (error) {
      fail(summary, `pruning payer ${payer.id}`, error);
    }
  });
}

export async function runPlanDaily(now: Date = new Date()): Promise<PlanDailySummary> {
  const db = getAdminDb();
  // the 03:00 run stamps yesterday: most of its window is yesterday, and a machine
  // first seen on a period's last evening must count in that period.
  const day = usageDay(new Date(now.getTime() - DAY_MS));
  const summary: PlanDailySummary = {
    ok: true,
    day,
    sites: 0,
    payers: 0,
    machines: 0,
    snapshots: 0,
    pruned: 0,
    errors: 0,
  };

  const byPayer = await activeMachinesByPayer(db, now.getTime() - ACTIVE_WINDOW_MS, summary);
  summary.payers = byPayer.size;
  await inBatches(Array.from(byPayer), ([payerUid, machineIds]) =>
    stampPayer(db, payerUid, machineIds, day, summary),
  );

  try {
    await pruneUsage(db, usageDay(new Date(now.getTime() - USAGE_RETENTION_DAYS * DAY_MS)), summary);
  } catch (error) {
    fail(summary, 'listing payers to prune', error);
  }

  logger.info('[plan-daily] done', { context: 'planUsage', data: summary });
  return summary;
}

/** the payer's distinct active machines across the UTC days from `startDate` to `endDate`, inclusive. */
export async function activeMachinesBetween(payerUid: string, startDate: Date, endDate: Date): Promise<number> {
  const days = await getAdminDb()
    .collection('billing_usage')
    .doc(payerUid)
    .collection('days')
    .where(FieldPath.documentId(), '>=', usageDay(startDate))
    .where(FieldPath.documentId(), '<=', usageDay(endDate))
    .get();

  const machineIds = new Set<string>();
  for (const day of days.docs) {
    const ids: unknown = day.data().machineIds;
    if (!Array.isArray(ids)) continue;
    for (const id of ids) if (typeof id === 'string') machineIds.add(id);
  }
  return machineIds.size;
}
