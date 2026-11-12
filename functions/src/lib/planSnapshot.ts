/**
 * the functions-side plan gate (adr 0018). functions can't reach tridant id,
 * so the web `plan-daily` cron writes each site's flags to
 * `plan_snapshot/{siteId}` and this only reads them back: a lapse reaches
 * functions within a day. only work that outlives the web's live check needs
 * it, which today is the scheduled rollouts (`rolloutScheduler.ts`).
 *
 * a deliberate mirror of the flag keys in `web/lib/plan.server.ts`, as the
 * removed `billingLogic.ts` was; functions can't import web code.
 *
 * fails open throughout: no snapshot, a failed read, or anything but an
 * explicit `false` lets the work proceed.
 */

/** `plan_snapshot/{siteId}` as the plan-daily cron writes it. */
export interface PlanSnapshot {
  /** false when plans weren't enforced for the site, which withholds nothing. */
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

/** `plan_snapshot/{siteId}`, or null when there is none or it can't be read. */
export async function readSitePlanSnapshot(
  db: FirebaseFirestore.Firestore,
  siteId: string,
): Promise<PlanSnapshot | null> {
  try {
    const data = (await db.collection('plan_snapshot').doc(siteId).get()).data();
    if (!data) return null;
    return {
      enforced: data.enforced === true,
      control: data.control !== false,
      roost: data.roost !== false,
      resolvedAt: data.resolvedAt,
    };
  } catch (err) {
    console.warn(
      `[planSnapshot] could not read the plan snapshot of site ${siteId}; proceeding (fail-open): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** why the snapshot withholds the first of `flags`, or null when the work may proceed. */
export function planBlockReason(
  snapshot: PlanSnapshot | null,
  flags: readonly PlanSnapshotFlag[],
): string | null {
  if (!snapshot?.enforced) return null;
  const withheld = flags.find((flag) => !snapshot[flag]);
  return withheld ? `this site's plan doesn't include ${FLAG_LABELS[withheld]}` : null;
}
