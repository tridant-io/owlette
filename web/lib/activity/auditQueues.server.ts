import { FieldPath } from 'firebase-admin/firestore';
import { timestampToMs } from '@/lib/firestoreTime.server';
import type { QueuedAudit } from './rules';

type Db = FirebaseFirestore.Firestore;

// normally no site has anything queued for long; the cap only bounds a run when many do
const MAX_QUEUED_SITES = 200;

/**
 * each site with queued audit events and when its oldest was queued. one collection-group
 * read per such site, in document-name order only, so it needs no index: the scan resumes
 * past the end of each site's queue, as `drainQueuedSites` in functions/src/auditLog.ts does.
 */
export async function loadOldestQueued(db: Db): Promise<QueuedAudit[]> {
  const queues: QueuedAudit[] = [];
  let after = '';
  while (queues.length < MAX_QUEUED_SITES) {
    let scan = db.collectionGroup('audit_queue').orderBy(FieldPath.documentId()).limit(1);
    if (after) scan = scan.startAfter(after);
    const [doc] = (await scan.get()).docs;
    if (!doc) break;
    const queue = doc.ref.parent;
    const [oldest] = (await queue.orderBy('enqueuedAt').limit(1).get()).docs;
    // empty when the drainer took the queue between the two reads, so the scanned doc's own time
    // stands; a doc with no enqueuedAt is one the drainer never takes, so it counts as stuck
    queues.push({ siteId: queue.parent?.id ?? 'unknown', at: timestampToMs((oldest ?? doc).get('enqueuedAt')) });
    after = `${queue.path}/\uf8ff`;
  }
  return queues;
}
