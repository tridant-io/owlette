/**
 * Every 5 minutes, fails deployments stuck in non-terminal states — an agent
 * that crashes or loses network never reports back, so nothing else would ever
 * move them. Targets time out at 15min (pending) / 30min (active), counted from
 * the deployment's creation or the target's retry, then the deployment status is
 * recalculated; writes only happen on a real change.
 *
 * Scale guard: only sites with `lastDeploymentActivityAt` inside the 30-minute
 * window are scanned.
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import {
  getFirestore,
  type DocumentReference,
  type Firestore,
} from 'firebase-admin/firestore';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import {
  calculateDeploymentStatus,
  DEPLOYMENT_TERMINAL_STATUSES,
  instantMs,
  timeOutStaleTargets,
  type DeploymentTarget,
} from './lib/deploymentUtils';

/** Sites without deployment activity in this window are skipped. */
const RECENT_DEPLOYMENT_ACTIVITY_MS = 30 * 60 * 1000; // 30 minutes

export const sweepStaleDeployments = onSchedule(
  { schedule: 'every 5 minutes', timeoutSeconds: 60 },
  async () => {
    // resolved here, not at import, so tests can import sweepDeployment without an app.
    const db = getFirestore();
    const now = Date.now();
    let totalUpdated = 0;

    const sitesToSweep = await getSitesToSweep(db, now);

    for (const siteDoc of sitesToSweep) {
      const siteId = siteDoc.id;

      const deploymentsSnap = await db
        .collection('sites')
        .doc(siteId)
        .collection('deployments')
        .where('status', 'in', ['pending', 'in_progress'])
        .get();

      if (!deploymentsSnap.empty) {
        await siteDoc.ref.set(
          { lastDeploymentActivityAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
      }

      for (const deploymentDoc of deploymentsSnap.docs) {
        const newStatus = await sweepDeployment(db, deploymentDoc.ref, now);
        if (newStatus === null) continue;
        totalUpdated++;

        console.log(
          `Sweeper: deployment ${deploymentDoc.id} (site ${siteId}) -> ${newStatus}`
        );
      }
    }

    if (totalUpdated > 0) {
      console.log(`Sweeper: updated ${totalUpdated} stale deployment(s)`);
    }
  }
);

/** Fails one deployment's stale targets. Returns its new status, or null when nothing changed. */
export async function sweepDeployment(
  db: Firestore,
  deploymentRef: DocumentReference,
  nowMs: number,
): Promise<string | null> {
  // re-read in a transaction: the query snapshot can be older than a result the
  // reconciler just wrote, and failing that target from it would undo the result.
  return db.runTransaction(async (tx) => {
    const data = (await tx.get(deploymentRef)).data() ?? {};
    const targets: DeploymentTarget[] = data.targets || [];

    const updatedTargets = timeOutStaleTargets(
      targets,
      instantMs(data.createdAt),
      nowMs,
      Timestamp.now(),
    );
    if (!updatedTargets) return null;

    const newStatus = calculateDeploymentStatus(updatedTargets);
    const wasTerminal = DEPLOYMENT_TERMINAL_STATUSES.has(data.status);

    const updatePayload: Record<string, unknown> = {
      targets: updatedTargets,
      status: newStatus,
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (!wasTerminal && DEPLOYMENT_TERMINAL_STATUSES.has(newStatus)) {
      updatePayload.completedAt = FieldValue.serverTimestamp();
    }

    tx.update(deploymentRef, updatePayload);
    return newStatus;
  });
}

async function getSitesToSweep(
  db: Firestore,
  nowMs: number,
): Promise<FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>[]> {
  const cutoff = Timestamp.fromMillis(nowMs - RECENT_DEPLOYMENT_ACTIVITY_MS);
  const recentSitesSnap = await db
    .collection('sites')
    .where('lastDeploymentActivityAt', '>=', cutoff)
    .get();
  return recentSitesSnap.docs;
}
