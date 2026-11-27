/**
 * assignSiteToUser action core (security-boundary-migration wave 3.9).
 *
 * Adds each siteId through `lib/membership.server.ts`, the single membership writer, which
 * dual-writes the member document and the legacy `users/{uid}.sites[]` entry. Every id is
 * checked against `sites/{id}` first; if any are unknown the whole request is rejected with
 * `unknown_sites` and nothing is added — partial assignments confuse callers.
 *
 * Capability `SITE_MEMBER_MANAGE` is enforced handler-side; this core only validates and
 * writes.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';
import { addMember } from '@/lib/membership.server';
import { SITE_ID_RE } from '@/lib/sitePolicy.server';

export const MAX_SITES_PER_REQUEST = 100;

export interface AssignSiteToUserInput {
  uid: string;
  siteIds: string[];
  /** Test seam — production omits. */
  db?: Firestore;
}

export interface AssignSiteToUserContext {
  /** Audit actor string ("user:<uid>" or "apiKey:<keyId>"). */
  auditActor: string;
  endpoint?: string;
  method?: string;
}

export type AssignSiteToUserResult =
  | { kind: 'not_found' }
  | { kind: 'deleted' }
  | { kind: 'invalid_format'; malformed: string[] }
  | { kind: 'too_many'; count: number; max: number }
  | { kind: 'unknown_sites'; unknownSites: string[] }
  /** A membership write was refused. Sites before this one were assigned. */
  | { kind: 'assign_failed'; siteId: string; reason: string }
  | { kind: 'updated'; assignedSiteIds: string[] };

export async function assignSiteToUser(
  ctx: AssignSiteToUserContext,
  input: AssignSiteToUserInput,
): Promise<AssignSiteToUserResult> {
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
  const userData = userSnap.data() ?? {};
  if (typeof userData.deletedAt === 'number') {
    return { kind: 'deleted' };
  }

  // Validate every site exists. Reject the whole batch if any are unknown.
  const unknownSites: string[] = [];
  await Promise.all(
    validatedSiteIds.map(async (siteId) => {
      const snap = await db.collection('sites').doc(siteId).get();
      if (!snap.exists) unknownSites.push(siteId);
    }),
  );
  if (unknownSites.length > 0) {
    return { kind: 'unknown_sites', unknownSites };
  }

  // Through the single membership writer (Wave 2 task 2.4), one site at a time.
  //
  // This was a single `arrayUnion` over every site — one write instead of N,
  // which is genuinely cheaper, and it is given up on purpose. That write
  // touched ONLY the legacy field, so a user assigned in bulk got no member
  // document and was invisible in the new shape; and a second membership-write
  // path is precisely what this wave exists to remove.
  //
  // `already_member` is not an error. This action is bulk and idempotent by
  // contract — re-assigning a site someone already has is a no-op — and
  // `create()` refusing means nothing was overwritten, so there is nothing to
  // report.
  for (const siteId of validatedSiteIds) {
    const result = await addMember({
      siteId,
      uid: input.uid,
      role: 'member',
      addedBy: ctx.auditActor,
      db: input.db,
    });
    if (!result.ok && result.failure.kind !== 'already_member') {
      return { kind: 'assign_failed', siteId, reason: result.failure.kind };
    }
    // in the site's own audit log too, where its owner reads who joined: the
    // platform row below is staff-only (adr 0021)
    if (result.ok) {
      emitMutation({
        kind: 'site_member_mutated',
        siteId,
        actor: ctx.auditActor,
        targetId: input.uid,
        attributes: {
          endpoint: ctx.endpoint ?? '',
          method: ctx.method ?? 'POST',
          verb: 'member_added',
          requestedRole: 'member',
        },
      });
    }
  }

  emitMutation({
    kind: 'user_mutated',
    siteId: '',
    actor: ctx.auditActor,
    targetId: input.uid,
    attributes: {
      endpoint: ctx.endpoint ?? '',
      method: ctx.method ?? 'POST',
      verb: 'sites_assigned',
      siteIds: validatedSiteIds,
    },
  });

  return { kind: 'updated', assignedSiteIds: validatedSiteIds };
}
