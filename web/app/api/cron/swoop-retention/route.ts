/**
 * GET /api/cron/swoop-retention — closes abandoned swoop session records and
 * deletes the ones past their retention window.
 *
 * A page reload starts a new session, so `swoop_sessions` grows with use and
 * nothing else ever removes a document from it. Two passes per machine:
 *
 *  1. CLOSE. A session past its absolute 12-hour cap cannot be running — the
 *     cap is absolute and the lease route refuses to renew past it — so one
 *     still recorded `pending` or `live` is a record nobody closed, left by a
 *     browser that went away without its teardown reaching us. Until it is
 *     closed it answers as live to `listUnendedSwoopSessionsForUser`, and every
 *     membership change re-kills a session that ended months ago.
 *
 *  2. DELETE. Every session document that started before the window, whatever
 *     state it is in.
 *
 * Why 30 days and not the 400 of `/api/cron/retention`: the session document is
 * operational state, not the record. A session is evidenced in
 * `sites/{siteId}/audit_log` as `session_started` / `session_ended`, which is
 * deliberately the one place a site admin cannot bulk-delete, and that is what
 * anyone actually queries. A second copy of who watched which machine when,
 * kept for over a year in a collection whose only reader is the running
 * session, is retention with no purpose behind it. 30 days is sixty times the
 * 12-hour cap, so nothing live is ever near the cutoff, and it comfortably
 * covers the window in which a session is still being asked about. The 400-day
 * commitment is a ceiling, not a target.
 *
 * NOT a Firestore TTL policy, for the same reason `/api/cron/retention` is not:
 * TTL needs an `expireAt` on every document, i.e. a new field on every write
 * path plus a backfill. This runs on cron-job.org.
 *
 * Bounded: each machine drains page by page, oldest-first, until empty or the
 * run's budget is spent. `truncated: true` means work remains — a ceiling was
 * hit, or a delete failed its retries — and the next run resumes oldest-first.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  endSwoopSession,
  listExpiredUnendedSwoopSessions,
  listSwoopSessionRefsStartedBefore,
} from '@/lib/swoop/sessionStore.server';

/**
 * How long a swoop session document outlives the session. Far under the 400-day
 * public commitment in privacy policy §6 on purpose — see the header.
 */
export const SWOOP_SESSION_RETENTION_DAYS = 30;

/** Ceiling on documents removed per invocation, across every machine. */
const MAX_DELETES_PER_RUN = 2_000;
/** Ceiling on records closed per invocation. Unended sessions are a handful. */
const MAX_CLOSES_PER_RUN = 200;
/** Documents fetched per query. Not a commit size — see deleteRefs(). */
const QUERY_PAGE_SIZE = 400;
/** Retry budget per document before a delete is counted as failed. */
const MAX_WRITE_ATTEMPTS = 5;

function daysAgo(days: number): number {
  return Date.now() - days * 24 * 60 * 60 * 1000;
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
      `[swoop-retention] gave up deleting ${error.documentRef.path}: ${error.message}`
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
  const cronSecret = request.headers.get('x-cron-secret');
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const db = getAdminDb();
    const now = Date.now();
    const startedBefore = daysAgo(SWOOP_SESSION_RETENTION_DAYS);

    let closeBudget = MAX_CLOSES_PER_RUN;
    let deleteBudget = MAX_DELETES_PER_RUN;
    let closed = 0;
    let deleted = 0;
    // A delete that exhausted its retries leaves documents behind, so the run
    // has to say so rather than report an all-clear it did not achieve.
    let incomplete = false;

    const sites = await db.collection('sites').get();

    for (const site of sites.docs) {
      if (closeBudget <= 0 && deleteBudget <= 0) break;

      const machines = await site.ref.collection('machines').get();
      for (const machine of machines.docs) {
        if (closeBudget <= 0 && deleteBudget <= 0) break;

        // One page per machine per run: a machine with more unended sessions
        // than this has a bigger problem than retention, and the next run takes
        // the rest. Closing them is what keeps the query cheap.
        if (closeBudget > 0) {
          const abandoned = await listExpiredUnendedSwoopSessions({
            siteId: site.id,
            machineId: machine.id,
            nowMs: now,
            limit: Math.min(closeBudget, QUERY_PAGE_SIZE),
          });

          for (const session of abandoned) {
            await endSwoopSession({
              siteId: site.id,
              machineId: machine.id,
              sid: session.sid,
              // The cap is what ended it; nobody was left to say so.
              endReason: 'session_cap',
            });
            closed += 1;
            closeBudget -= 1;
          }
        }

        // Drain in pages, not one page per machine: a single page would leave
        // older data behind while still reporting truncated:false.
        while (deleteBudget > 0) {
          const pageSize = Math.min(deleteBudget, QUERY_PAGE_SIZE);
          const refs = await listSwoopSessionRefsStartedBefore({
            siteId: site.id,
            machineId: machine.id,
            beforeMs: startedBefore,
            limit: pageSize,
          });

          if (refs.length === 0) break;

          const removed = await deleteRefs(db, refs);
          deleted += removed;
          deleteBudget -= removed;

          // The same page would be served again, so stop rather than spin.
          if (removed < refs.length) {
            incomplete = true;
            break;
          }
          // A short page means the collection is drained for this cutoff.
          if (refs.length < pageSize) break;
        }
      }
    }

    const truncated = closeBudget <= 0 || deleteBudget <= 0 || incomplete;
    console.log(
      `[swoop-retention] closed=${closed} deleted=${deleted} truncated=${truncated}`
    );

    return NextResponse.json({
      ok: true,
      closed,
      deleted: { swoopSessions: deleted },
      cutoffs: { startedBefore: new Date(startedBefore).toISOString() },
      retentionDays: { swoopSessions: SWOOP_SESSION_RETENTION_DAYS },
      // true => a ceiling was hit or a delete failed; older data remains.
      truncated,
    });
  } catch (error) {
    console.error('[swoop-retention] failed:', error);
    return NextResponse.json({ error: 'Swoop retention sweep failed' }, { status: 500 });
  }
}
