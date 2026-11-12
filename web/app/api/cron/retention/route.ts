/**
 * GET /api/cron/retention — deletes time-series data past its retention window.
 * This is what actually enforces the privacy policy's §6 commitment.
 *
 * Prunes `metrics_history/{bucketId}` by document-id range (bucket ids encode
 * UTC time, so no timestamp field and no composite index needed; the hourly
 * `YYYY-MM-DD-HH` and legacy daily `YYYY-MM-DD` shapes sort correctly against
 * a `YYYY-MM-DD` cutoff), `sites/{siteId}/logs` by indexed `timestamp`, and
 * `sites/{siteId}/talon_runs` by indexed `startedAt`.
 *
 * Only HISTORY is swept. `sites/{siteId}/talons` and `sites/{siteId}/talon_secrets`
 * are configuration — a talon that has not fired in 400 days is still armed, and
 * deleting its webhook signing secret would silently break the next fire — so
 * neither is ever touched here.
 *
 * NOT a Firestore TTL policy: TTL needs an `expireAt` on every document, i.e.
 * changing every write path plus a backfill. This runs on cron-job.org.
 *
 * Bounded: each collection drains page by page, oldest-first, until empty or
 * MAX_DELETES_PER_RUN is spent. Hitting the budget is the ONLY thing that sets
 * `truncated: true` — that flag is how an operator knows stale data remains,
 * so anything that can leave documents behind while reporting `false`
 * reintroduces the silent-underdelivery bug this job was written to remove.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cronSecretMatches } from '@/lib/secretMatches.server';
import { FieldPath, Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { formatDayBucketId } from '@/lib/metricsHistoryBuckets';

/**
 * Retention windows in days. A PUBLIC COMMITMENT mirrored in privacy policy §6
 * — the constant and the policy text move together.
 *
 * 400, not 365: MetricsDetailPanel's "year" range is exactly `now - 365 days`
 * (useHistoricalMetrics.getStartDate), so anything lower silently truncates
 * the chart, and 365 exactly would sit the oldest bucket on the deletion
 * boundary between cron runs. The extra ~5 weeks keeps the year view backed.
 */
export const METRICS_RETENTION_DAYS = 400;
export const LOGS_RETENTION_DAYS = 400;
export const TALON_RUNS_RETENTION_DAYS = 400;

/** Ceiling on documents removed per invocation, across every swept collection. */
const MAX_DELETES_PER_RUN = 2_000;
/** Documents fetched per query. Not a commit size — see deleteRefs(). */
const QUERY_PAGE_SIZE = 400;
/** Retry budget per document before a delete is counted as failed. */
const MAX_WRITE_ATTEMPTS = 5;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/**
 * Delete `refs` via BulkWriter, NOT db.batch(): a batched commit of 400 deletes
 * failed in production with `3 INVALID_ARGUMENT: Transaction too big` — the
 * 500-writes-per-commit figure is a ceiling and the backend counts more than
 * one unit per document. Returns the count actually removed, so a partial
 * failure shrinks the total instead of inflating it.
 */
async function deleteRefs(
  db: FirebaseFirestore.Firestore,
  refs: FirebaseFirestore.DocumentReference[]
): Promise<number> {
  if (refs.length === 0) return 0;

  const writer = db.bulkWriter();
  let failed = 0;

  writer.onWriteError(error => {
    if (error.failedAttempts < MAX_WRITE_ATTEMPTS) return true;
    failed += 1;
    console.error(
      `[retention] gave up deleting ${error.documentRef.path}: ${error.message}`
    );
    return false;
  });

  for (const ref of refs) {
    // Rejects once onWriteError stops retrying — already counted above, so
    // swallow it to avoid an unhandled rejection.
    void writer.delete(ref).catch(() => undefined);
  }

  await writer.close();
  return refs.length - failed;
}

export async function GET(request: NextRequest) {
  if (!cronSecretMatches(request.headers.get('x-cron-secret'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const db = getAdminDb();
    const metricsCutoffBucket = formatDayBucketId(daysAgo(METRICS_RETENTION_DAYS));
    const logsCutoff = Timestamp.fromDate(daysAgo(LOGS_RETENTION_DAYS));
    const talonRunsCutoff = Timestamp.fromDate(daysAgo(TALON_RUNS_RETENTION_DAYS));

    let budget = MAX_DELETES_PER_RUN;
    let metricsDeleted = 0;
    let logsDeleted = 0;
    let talonRunsDeleted = 0;

    const sites = await db.collection('sites').get();

    for (const site of sites.docs) {
      if (budget <= 0) break;

      // Drain in pages, not one page per site: a single page left older data
      // behind while still reporting truncated:false.
      while (budget > 0) {
        const pageSize = Math.min(budget, QUERY_PAGE_SIZE);
        const staleLogs = await site.ref
          .collection('logs')
          .where('timestamp', '<', logsCutoff)
          .orderBy('timestamp', 'asc')
          .limit(pageSize)
          .get();

        if (staleLogs.empty) break;

        const removed = await deleteRefs(db, staleLogs.docs.map(d => d.ref));
        logsDeleted += removed;
        budget -= removed;

        // A short page means the collection is drained for this cutoff.
        if (staleLogs.size < pageSize) break;
      }

      // Talon run history, same drain shape as logs. `startedAt` is present on
      // every run doc — executions and the `pending` deferral crumbs alike (see
      // TalonRunDoc) — so nothing escapes the sweep by lacking the field.
      while (budget > 0) {
        const pageSize = Math.min(budget, QUERY_PAGE_SIZE);
        const staleRuns = await site.ref
          .collection('talon_runs')
          .where('startedAt', '<', talonRunsCutoff)
          .orderBy('startedAt', 'asc')
          .limit(pageSize)
          .get();

        if (staleRuns.empty) break;

        const removed = await deleteRefs(db, staleRuns.docs.map(d => d.ref));
        talonRunsDeleted += removed;
        budget -= removed;

        if (staleRuns.size < pageSize) break;
      }

      if (budget <= 0) break;

      const machines = await site.ref.collection('machines').get();
      for (const machine of machines.docs) {
        if (budget <= 0) break;

        while (budget > 0) {
          const pageSize = Math.min(budget, QUERY_PAGE_SIZE);
          const staleBuckets = await machine.ref
            .collection('metrics_history')
            .where(FieldPath.documentId(), '<', metricsCutoffBucket)
            .orderBy(FieldPath.documentId(), 'asc')
            .limit(pageSize)
            .get();

          if (staleBuckets.empty) break;

          const removed = await deleteRefs(db, staleBuckets.docs.map(d => d.ref));
          metricsDeleted += removed;
          budget -= removed;

          if (staleBuckets.size < pageSize) break;
        }
      }
    }

    const truncated = budget <= 0;
    console.log(
      `[retention] metrics=${metricsDeleted} logs=${logsDeleted} ` +
        `talonRuns=${talonRunsDeleted} truncated=${truncated}`
    );

    return NextResponse.json({
      ok: true,
      deleted: { metrics: metricsDeleted, logs: logsDeleted, talonRuns: talonRunsDeleted },
      cutoffs: {
        metricsBucket: metricsCutoffBucket,
        logs: logsCutoff.toDate().toISOString(),
        talonRuns: talonRunsCutoff.toDate().toISOString(),
      },
      retentionDays: {
        metrics: METRICS_RETENTION_DAYS,
        logs: LOGS_RETENTION_DAYS,
        talonRuns: TALON_RUNS_RETENTION_DAYS,
      },
      // true => ceiling hit, older data remains; next run resumes oldest-first.
      truncated,
    });
  } catch (error) {
    console.error('[retention] failed:', error);
    return NextResponse.json({ error: 'Retention sweep failed' }, { status: 500 });
  }
}
