/**
 * the functions-side plan gate (plan.md decision 13). functions can't reach
 * tridant id, so the web `plan-daily` cron writes each payer's flags to
 * `plan_snapshot/{payerUid}` and this only reads them back: a lapse reaches
 * functions within a day. only work that outlives the web's live check needs
 * it, which today is the scheduled rollouts (`rolloutScheduler.ts`).
 *
 * a deliberate mirror of `payerForSite` and the flag keys in
 * `web/lib/plan.server.ts`, as the removed `billingLogic.ts` was; functions
 * can't import web code.
 *
 * fails open throughout: no owner, no snapshot, a failed read, or anything but
 * an explicit `false` lets the work proceed.
 */

/** `plan_snapshot/{payerUid}` as the plan-daily cron writes it. */
export interface PlanSnapshot {
  /** false when plans weren't enforced for the payer, which withholds nothing. */
  enforced: boolean;
  control: boolean;
  roost: boolean;
  /** as stored: a firestore Timestamp, or anything else on a hand-written doc. */
  resolvedAt: unknown;
}

export type PlanSnapshotFlag = 'control' | 'roost';

// the wording of `PLAN_REQUIRED_DETAIL` web-side, so a skip reads like the 402.
const FLAG_LABELS: Record<PlanSnapshotFlag, string> = {
  control: 'remote control',
  roost: 'roost',
};

/** `plan_snapshot/{payerUid}`, or null when there is none or it can't be read. */
export async function readPlanSnapshot(
  db: FirebaseFirestore.Firestore,
  payerUid: string,
): Promise<PlanSnapshot | null> {
  try {
    const data = (await db.collection('plan_snapshot').doc(payerUid).get()).data();
    if (!data) return null;
    return {
      enforced: data.enforced === true,
      control: data.control !== false,
      roost: data.roost !== false,
      resolvedAt: data.resolvedAt,
    };
  } catch (err) {
    console.warn(
      `[planSnapshot] could not read the plan snapshot of ${payerUid}; proceeding (fail-open): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** the snapshot of the site's payer, its owner (decision 1); null for an ownerless site. */
export async function readSitePlanSnapshot(
  db: FirebaseFirestore.Firestore,
  siteId: string,
): Promise<PlanSnapshot | null> {
  let owner: unknown;
  try {
    owner = (await db.collection('sites').doc(siteId).get()).data()?.owner;
  } catch (err) {
    console.warn(
      `[planSnapshot] could not read the owner of site ${siteId}; proceeding (fail-open): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  if (typeof owner !== 'string' || owner.length === 0) return null;
  return readPlanSnapshot(db, owner);
}

/** why the snapshot withholds the first of `flags`, or null when the work may proceed. */
export function planBlockReason(
  snapshot: PlanSnapshot | null,
  flags: readonly PlanSnapshotFlag[],
): string | null {
  if (!snapshot?.enforced) return null;
  const withheld = flags.find((flag) => !snapshot[flag]);
  return withheld ? `the site owner's plan doesn't include ${FLAG_LABELS[withheld]}` : null;
}
