/**
 * Removes siteIds from `users/{uid}.sites[]`, then best-effort cancels the
 * user's pending commands on those sites. The arrayRemove is authoritative —
 * a failed cancel sweep does not roll back membership.
 *
 * Capability `SITE_MEMBER_MANAGE`, enforced by the wrapper.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';
import { removeMember } from '@/lib/membership.server';
import { revokeSwoopSessionsForUser } from '@/lib/swoop/revokeViewerSessions.server';
import type { Actor } from '@/lib/capabilities';
import { cancelUserCommandsOnSites } from '@/lib/userDeleteCascade.server';
import logger from '@/lib/logger';
import { SITE_ID_RE } from '@/lib/sitePolicy.server';

export const MAX_SITES_PER_REQUEST = 100;

export interface RemoveSiteFromUserInput {
  uid: string;
  siteIds: string[];
  /** Injected in tests; production omits both. */
  db?: Firestore;
  cancelCommands?: (uid: string, siteIds: string[]) => Promise<number>;
}

export interface RemoveSiteFromUserContext {
  auditActor: string;
  /** Whoever is removing the sites. They end any live swoop session on them. */
  actor: Actor;
  endpoint?: string;
  method?: string;
}

export type RemoveSiteFromUserResult =
  | { kind: 'not_found' }
  | { kind: 'invalid_format'; malformed: string[] }
  | { kind: 'too_many'; count: number; max: number }
  | { kind: 'owns_sites'; ownedSiteIds: string[] }
  /** A membership write was refused. Sites before this one were removed. */
  | { kind: 'remove_failed'; siteId: string; reason: string }
  | {
      kind: 'updated';
      removedSiteIds: string[];
      cancelledCommandCount: number;
    };

export async function removeSiteFromUser(
  ctx: RemoveSiteFromUserContext,
  input: RemoveSiteFromUserInput,
): Promise<RemoveSiteFromUserResult> {
  if (!input.uid) throw new Error('uid is required');
  if (!Array.isArray(input.siteIds) || input.siteIds.length === 0) {
    throw new Error('siteIds must be a non-empty array');
  }
  if (input.siteIds.length > MAX_SITES_PER_REQUEST) {
    return {
      kind: 'too_many',
      count: input.siteIds.length,
      max: MAX_SITES_PER_REQUEST,
    };
  }
  const malformed = input.siteIds.filter(
    (s) => typeof s !== 'string' || !SITE_ID_RE.test(s as string),
  );
  if (malformed.length > 0) {
    return { kind: 'invalid_format', malformed: malformed as string[] };
  }
  const validatedSiteIds = Array.from(new Set(input.siteIds));

  const db = input.db ?? getAdminDb();
  const userRef = db.collection('users').doc(input.uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    return { kind: 'not_found' };
  }

  // Refuse to strip membership from a site this user OWNS. Without this the
  // superadmin path can leave a site with no owner at all — unreachable through
  // the members endpoint, which returns 409 cannot_remove_owner for exactly this
  // case (app/api/sites/[siteId]/members/[uid]/route.ts). Ownership must be
  // transferred first. Reads are batched: one getAll over the named sites.
  const siteSnaps = await db.getAll(
    ...validatedSiteIds.map((id) => db.collection('sites').doc(id)),
  );
  const ownedSiteIds = siteSnaps
    .filter((snap) => snap.exists && snap.data()?.owner === input.uid)
    .map((snap) => snap.id);
  if (ownedSiteIds.length > 0) {
    return { kind: 'owns_sites', ownedSiteIds };
  }

  // Through the single membership writer (Wave 2 task 2.4), one site at a time.
  //
  // This was a single `arrayRemove` over every site. That is cheaper, and it is
  // given up for the same reason as the assign path: it touched ONLY the legacy
  // field, so the member document was left behind and the two shapes diverged.
  // removeMember also re-checks ownership INSIDE its transaction, which the
  // owner guard above cannot do — that guard reads its snapshot before this
  // loop, so a transfer landing in between would slip past it.
  for (const siteId of validatedSiteIds) {
    const result = await removeMember({ siteId, uid: input.uid, db: input.db });
    if (!result.ok && result.failure.kind !== 'site_not_found') {
      return { kind: 'remove_failed', siteId, reason: result.failure.kind };
    }
    // After the membership write and only when it landed, never awaited into
    // the response: the lease ends their sessions within five minutes on its
    // own (PROTOCOL.md §10) and this only closes that window to the kill path's
    // two seconds.
    if (result.ok) {
      void revokeSwoopSessionsForUser({
        siteId,
        uid: input.uid,
        actor: ctx.actor,
        auditActor: ctx.auditActor,
        reason: 'member_removed',
      });
    }
  }

  // Best-effort; errors don't block the response.
  let cancelledCommandCount = 0;
  const cancelFn = input.cancelCommands ?? cancelUserCommandsOnSites;
  try {
    cancelledCommandCount = await cancelFn(input.uid, validatedSiteIds);
  } catch (err) {
    logger.warn('removeSiteFromUser: command cancel sweep failed (non-fatal)', {
      context: 'actions/removeSiteFromUser',
      data: {
        uid: input.uid,
        siteIds: validatedSiteIds,
        err: err instanceof Error ? err.message : String(err),
      },
    });
  }

  emitMutation({
    kind: 'user_mutated',
    siteId: '',
    actor: ctx.auditActor,
    targetId: input.uid,
    attributes: {
      endpoint: ctx.endpoint ?? '',
      method: ctx.method ?? 'POST',
      verb: 'sites_removed',
      siteIds: validatedSiteIds,
      cancelledCommandCount,
    },
  });

  return {
    kind: 'updated',
    removedSiteIds: validatedSiteIds,
    cancelledCommandCount,
  };
}
