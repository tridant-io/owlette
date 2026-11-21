/**
 * removes a deleted site from tridant id (adr 0018). tridant refuses while a
 * licence or billing item still runs on the site, and a stopped site's billing
 * closes only once its period is invoiced, so a site it cannot remove yet gets a
 * retry record the daily job sweeps:
 *
 * - `tridant_site_removals/{siteId}` = `{ siteId, requestedAt, attempts, lastCode }`.
 *
 * server-only: the catch-all deny in `firestore.rules` covers it, and
 * `__tests__/rules/planCollections.test.ts` holds it there. never throws.
 */

import 'server-only';
import { getAdminDb } from '@/lib/firebase-admin';
import { inBatches } from '@/lib/inBatches';
import logger from '@/lib/logger';
import { tridantConfigured } from '@/lib/plan.server';
import { stopOpenBilling } from '@/lib/siteBilling.server';
import { removeSite, type BillingResult } from '@/lib/tridantBilling.server';

const COLLECTION = 'tridant_site_removals';
/** past a stopped site's last period and its invoice, so a record this old will not clear by itself. */
const GIVE_UP_MS = 45 * 24 * 60 * 60 * 1000;

export type SiteRemovalSweep = { removed: number; pending: number; dropped: number; errors: number };

type Removal = BillingResult<{ removed: boolean }>;
type Outcome = 'removed' | 'pending' | 'refused';

const records = () => getAdminDb().collection(COLLECTION);

function outcomeOf(result: Removal): Outcome {
  // 404 site_not_found: gone already.
  if (result.ok || result.status === 404) return 'removed';
  if (result.code === 'site_running' || result.reason === 'unreachable' || result.reason === 'malformed_response') {
    return 'pending';
  }
  return 'refused';
}

const codeOf = (result: Removal): string | null => (result.ok ? null : (result.code ?? result.reason));

function logRefusal(siteId: string, result: Removal): void {
  if (result.ok) return;
  logger.error('[plan] deleted site not removed from tridant id', {
    context: 'plan',
    data: { siteId, reason: result.reason, status: result.status, code: result.code },
  });
}

/** call once the site's billing is stopped; a site tridant still runs is retried by the daily job. */
export async function removeTridantSite(siteId: string): Promise<void> {
  try {
    if (!tridantConfigured()) return;
    const result = await removeSite(siteId);
    const outcome = outcomeOf(result);
    if (outcome === 'refused') logRefusal(siteId, result);
    if (outcome !== 'pending') return;
    await records().doc(siteId).set({ siteId, requestedAt: Date.now(), attempts: 0, lastCode: codeOf(result) });
  } catch (error) {
    logger.error('[plan] site removal not recorded', {
      context: 'plan',
      data: { siteId, error: error instanceof Error ? error.message : String(error) },
    });
  }
}

/** a stop before delete that did not land leaves the site billed with no end. */
async function stopRunningBilling(siteId: string): Promise<void> {
  const stopped = await stopOpenBilling(siteId);
  if (!stopped) return;
  logger.warn('[plan] billing still ran for a deleted site, stopped again', {
    context: 'plan',
    data: stopped.ok
      ? { siteId, stopped: true }
      : { siteId, stopped: false, reason: stopped.reason, status: stopped.status, code: stopped.code },
  });
}

async function retryRemoval(
  record: FirebaseFirestore.QueryDocumentSnapshot,
  nowMs: number,
): Promise<keyof SiteRemovalSweep> {
  const siteId = record.id;
  const result = await removeSite(siteId);
  const outcome = outcomeOf(result);
  if (outcome === 'removed') {
    await record.ref.delete();
    return 'removed';
  }
  if (!result.ok && result.code === 'site_running') await stopRunningBilling(siteId);

  const data = record.data();
  const attempts = (typeof data.attempts === 'number' ? data.attempts : 0) + 1;
  const lastCode = codeOf(result);
  const requestedAt = typeof data.requestedAt === 'number' ? data.requestedAt : 0;
  if (nowMs - requestedAt > GIVE_UP_MS) {
    await record.ref.delete();
    logger.error('[plan] deleted site still not removed from tridant id after 45 days, record dropped', {
      context: 'plan',
      data: { siteId, attempts, lastCode },
    });
    return 'dropped';
  }
  await record.ref.update({ attempts, lastCode });
  if (outcome === 'pending') return 'pending';
  logRefusal(siteId, result);
  return 'errors';
}

/** the daily job's retry of every recorded removal. */
export async function sweepSiteRemovals(nowMs: number): Promise<SiteRemovalSweep> {
  const counts: SiteRemovalSweep = { removed: 0, pending: 0, dropped: 0, errors: 0 };
  try {
    // the records wait for tridant id to be configured again.
    if (!tridantConfigured()) return counts;
    const { docs } = await records().get();
    await inBatches(docs, async (record) => {
      try {
        counts[await retryRemoval(record, nowMs)] += 1;
      } catch (error) {
        counts.errors += 1;
        logger.error('[plan] site removal retry failed', {
          context: 'plan',
          data: { siteId: record.id, error: error instanceof Error ? error.message : String(error) },
        });
      }
    });
  } catch (error) {
    counts.errors += 1;
    logger.error('[plan] site removals not read', {
      context: 'plan',
      data: { error: error instanceof Error ? error.message : String(error) },
    });
  }
  return counts;
}
