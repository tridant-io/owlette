/**
 * deleteSite action core, replacing the client-side `deleteDoc` in
 * `useFirestore.ts:deleteSite`.
 *
 * It CASCADES. Firestore does not delete subcollections with a document, so the
 * original narrow delete left every machine, roost, talon, webhook, setting and —
 * after the per-site-roles migration — every `members/{uid}` row alive under a
 * site id nobody could reach. Ordering is the whole design:
 *
 *   1. audit to the PLATFORM sink, blocking and fail-closed. The site's own
 *      audit_log is a subcollection of the doc below, so a row written there dies
 *      with the evidence of who destroyed it.
 *   2. tombstone the id, so the slug cannot be re-registered mid-cascade. then
 *      stop the site's billing with tridant id (adr 0018), best effort: the
 *      delete goes on when tridant id cannot be reached.
 *   3. revoke `agent_refresh_tokens` for the site. FIRST among the destructive
 *      steps: a refresh token outlives the site document, so revoking last leaves
 *      a window where the site is gone and an agent can still mint access tokens
 *      against it. The site's fleet sessions and call records (ADR 0017) go with
 *      them: top-level collections too, which step 5 never reaches.
 *   4. clear `users/{uid}.sites[]` for every member — read from the member rows,
 *      so it has to happen BEFORE they are deleted. Skipping it also strands a
 *      dead site id in the client's union, which reports as `membership_fallback`
 *      drift forever and blocks the wave 6.1 strip.
 *   5. recursively delete `config/{siteId}` (the site's process configs, display
 *      layouts, restart schedules and presets live there, outside the site
 *      document), then the site document and every subcollection under it.
 *
 * R2 IS NOT DELETED HERE, and the cascade makes that worse in a way worth stating.
 * The nightly chunk GC (functions/src/chunkGc.ts) enumerates sites with
 * `listDocuments()` SPECIFICALLY because that also returns parents which exist only
 * as a subcollection holder — its own comment says so. Before this cascade a deleted
 * site still had subcollections, so GC kept finding it and could still reclaim its
 * chunks. Once the last subcollection goes, `listDocuments()` stops returning the ref
 * and that R2 prefix becomes unreachable forever.
 *
 * So step 6 records the orphan instead of leaking it silently: `deleted_sites/{siteId}`
 * names the prefixes a future sweep must reclaim. Bulk-deleting R2 inline was the
 * alternative and was rejected — the GC is deliberately fail-closed and still in
 * dry-run, and a destructive path is the wrong place to add an untested bulk delete.
 * This turns "orphaned and undiscoverable" into "orphaned, recorded, reclaimable".
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';
import {
  generateCorrelationId,
  writeGlobalAuditEntryBlocking,
  type AuditActor,
} from '@/lib/auditLog.server';
import { deleteFleetCalls } from '@/lib/fleet/calls.server';
import { revokeFleetSessions } from '@/lib/fleet/session.server';
import logger from '@/lib/logger';
import { stopSite } from '@/lib/tridantBilling.server';

export interface DeleteSiteInput {
  siteId: string;
  /** Inject a Firestore instance — tests pass a mock; production omits. */
  db?: Firestore;
}

export interface DeleteSiteContext {
  auditActor: string;
  endpoint?: string;
  method?: string;
  /**
   * The resolved actor, for the platform-sink audit row. Optional only so existing
   * callers and tests compile; when absent the row records an unattributed delete,
   * which is worse than useless in an investigation — pass it.
   */
  actor?: AuditActor;
  /**
   * The request's correlation id, so the surviving platform row joins to the
   * authorization decision that permitted it. A fresh id here would be
   * unjoinable to anything.
   */
  correlationId?: string;
}

/** Firestore caps a write batch at 500 operations. */
const CASCADE_BATCH = 400;

export type DeleteSiteResult =
  | { kind: 'not_found' }
  | { kind: 'deleted'; siteId: string };

export async function deleteSite(
  ctx: DeleteSiteContext,
  input: DeleteSiteInput,
): Promise<DeleteSiteResult> {
  if (!input.siteId) throw new Error('siteId is required');

  const db = input.db ?? getAdminDb();
  const siteRef = db.collection('sites').doc(input.siteId);
  const existing = await siteRef.get();
  if (!existing.exists) {
    return { kind: 'not_found' };
  }

  // Record the deletion in the PLATFORM sink BEFORE destroying anything. The site's
  // own audit_log is a subcollection of the document below, so a row written there
  // would be destroyed along with the evidence of who destroyed it. Blocking and
  // fail-closed: if the record cannot be written, the site is not deleted.
  if (ctx.actor) {
    const siteData = existing.data() ?? {};
    const owner = typeof siteData.owner === 'string' ? siteData.owner : null;
    // "Override" means a superadmin destroyed someone else's site — the case worth
    // finding in an investigation. A superadmin deleting their own site is an
    // ordinary owner delete and is not flagged as one.
    const superadminOverride =
      ctx.actor.type === 'user' &&
      ctx.actor.role === 'superadmin' &&
      owner !== ctx.actor.userId;

    await writeGlobalAuditEntryBlocking({
      correlationId: ctx.correlationId ?? generateCorrelationId(),
      actor: ctx.actor,
      capability: 'SITE_DELETE',
      target: { kind: 'site', id: input.siteId },
      outcome: 'allow',
      metadata: {
        endpoint: ctx.endpoint ?? '',
        method: ctx.method ?? 'DELETE',
        verb: 'deleted',
        siteName: typeof siteData.name === 'string' ? siteData.name : null,
        owner,
        superadminOverride,
      },
    }, db);
  }

  // Tombstone the id BEFORE freeing it. Site ids are caller-supplied slugs, and
  // step 4 below clears `users/{uid}.sites[]` only for members whose user doc
  // still exists — a stale entry can outlive the delete on a hard-deleted or
  // non-member account. So without this, a later site reusing the slug could
  // inherit a leftover holder: a cross-tenant grant nobody performed. Written
  // first, because a tombstone with no delete is harmless and a delete with no
  // tombstone is the bug.
  // Timestamp only. The deleting principal is already in the platform audit row
  // written just above, which is admin-gated; this document is client-readable
  // for the id-availability check and must carry nothing else.
  await db.collection('site_ids').doc(input.siteId).set({
    deletedAt: FieldValue.serverTimestamp(),
  });

  // stop billing before anything is destroyed. nothing retries once the site is
  // gone, but a stop that did not land costs no more than one that did: with no
  // usage reported for it, tridant id writes no line for the site after this period.
  // it is logged at error so the leftover item can be closed by hand.
  const billing = existing.data()?.billing;
  if (typeof billing === 'object' && billing !== null) {
    const stopped = await stopSite(input.siteId);
    if (!stopped.ok && stopped.code !== 'site_not_billed') {
      logger.error('[plan] billing not stopped for a deleted site', {
        context: 'plan',
        data: { siteId: input.siteId, reason: stopped.reason, status: stopped.status, code: stopped.code },
      });
    }
  }

  // 3. Agent credentials first — see the ordering note above.
  const tokenSnap = await db
    .collection('agent_refresh_tokens')
    .where('siteId', '==', input.siteId)
    .get();
  for (let i = 0; i < tokenSnap.docs.length; i += CASCADE_BATCH) {
    const batch = db.batch();
    for (const doc of tokenSnap.docs.slice(i, i + CASCADE_BATCH)) batch.delete(doc.ref);
    await batch.commit();
  }
  // A fleet session (ADR 0017) is an agent credential too. It and the call
  // records live outside the site document, so the cascade below never reaches them.
  await revokeFleetSessions(db, { siteId: input.siteId });
  await deleteFleetCalls(db, { siteId: input.siteId });

  // 4. Clear the legacy membership pointer while the rows that name the members
  //    still exist.
  //
  //    Only for members whose user document ACTUALLY EXISTS. A member row can
  //    outlive its user — a hard-deleted account, or a fixture owner that was
  //    never a real user — and `update()` on a missing document fails the whole
  //    batch with NOT_FOUND, which would abort the delete and leave the site
  //    half-dismantled. `set(..., {merge:true})` is the wrong fix: it would
  //    resurrect a user document for an account that does not exist.
  const memberSnap = await siteRef.collection('members').get();
  const memberRefs = memberSnap.docs.map((doc) => db.collection('users').doc(doc.id));
  const memberUsers = memberRefs.length > 0 ? await db.getAll(...memberRefs) : [];
  const liveMemberRefs = memberUsers
    .filter((snap) => snap.exists)
    .map((snap) => snap.ref);
  for (let i = 0; i < liveMemberRefs.length; i += CASCADE_BATCH) {
    const batch = db.batch();
    for (const ref of liveMemberRefs.slice(i, i + CASCADE_BATCH)) {
      batch.update(ref, { sites: FieldValue.arrayRemove(input.siteId) });
    }
    await batch.commit();
  }

  // 6. Record the R2 prefixes BEFORE the cascade makes the site undiscoverable to
  //    the chunk GC. Server-only: no rule matches this path, so the default
  //    deny-all applies and the Admin SDK is unaffected.
  await db.collection('deleted_sites').doc(input.siteId).set({
    siteId: input.siteId,
    deletedAt: FieldValue.serverTimestamp(),
    r2PrefixesToReclaim: [`project-content/${input.siteId}`, `project-manifests/${input.siteId}`],
    reclaimed: false,
  });

  // 5. The site's process configs, display layouts, restart schedules and presets,
  //    which live outside it under config/{siteId}, then the document and
  //    everything beneath it. Config goes first: a retry after a failure there
  //    still finds the site, and a retry after the site is gone would not.
  await db.recursiveDelete(db.collection('config').doc(input.siteId));
  await db.recursiveDelete(siteRef);

  emitMutation({
    kind: 'site_mutated',
    siteId: input.siteId,
    actor: ctx.auditActor,
    targetId: input.siteId,
    attributes: {
      endpoint: ctx.endpoint ?? '',
      method: ctx.method ?? 'DELETE',
      verb: 'deleted',
    },
  });

  return { kind: 'deleted', siteId: input.siteId };
}
