/**
 * createSite action core. Replaces the client-side `setDoc` in
 * `useFirestore.ts:createSite`: validates the site id, refuses to overwrite an
 * existing site, and writes the site doc with the caller as `owner`.
 *
 * The site doc and the creator's membership MUST stay in one batch. Ownership
 * alone isn't enough — the server honours it, but the client site list resolves
 * membership only (`useSites` iterates `users/{uid}.sites[]` and never queries
 * by `owner`). A site without the membership entry is invisible to the user who
 * created it, with no self-service recovery; that stranded every self-serve
 * signup between 1756e5f (2026-03-20) and this fix.
 *
 * Capability `SITE_MEMBER_MANAGE` via the platform route wrapper — there is no
 * existing site id to authorize against, so this is a platform-level mutation.
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';
import { validateSiteId } from '@/lib/validators';
import { addOwnerToBatch } from '@/lib/membership.server';
import { siteSlotAvailable } from '@/lib/plan.server';

const NAME_MAX_LENGTH = 200;

export interface CreateSiteInput {
  siteId: string;
  name: string;
  ownerUid: string;
  timezone?: string;
  /**
   * Opt the site's process schedules into site time instead of each machine's
   * own clock. Three-state by design and NOT defaulted here: omit and the field
   * is left off the document entirely, which is what "never asked" looks like —
   * `false` means the operator declined and must not be confused with it.
   */
  schedulesFollowSiteTime?: boolean;
  /** Tests pass a mock; production omits. */
  db?: Firestore;
  /** Tests pass a fixed clock; production omits. */
  now?: () => Date;
}

export interface CreateSiteContext {
  auditActor: string;
  endpoint?: string;
  method?: string;
}

export type CreateSiteResult =
  | { kind: 'invalid_site_id'; reason: string }
  | { kind: 'invalid_name'; reason: string }
  | { kind: 'already_exists' }
  | { kind: 'id_retired' }
  | { kind: 'plan_limit' }
  | {
      kind: 'created';
      siteId: string;
      name: string;
      timezone: string;
      owner: string;
      createdAt: number;
      /**
       * Effective value, not the stored one: the document keeps three states
       * (absent / false / true) but callers only ever act on "is site time on",
       * so an omitted flag reports `false` here.
       */
      schedulesFollowSiteTime: boolean;
    };

export async function createSite(
  ctx: CreateSiteContext,
  input: CreateSiteInput,
): Promise<CreateSiteResult> {
  if (!input.ownerUid) throw new Error('ownerUid is required');

  const idCheck = validateSiteId(input.siteId);
  if (!idCheck.isValid) {
    return { kind: 'invalid_site_id', reason: idCheck.error ?? 'invalid site id' };
  }

  const trimmedName = typeof input.name === 'string' ? input.name.trim() : '';
  if (trimmedName.length === 0) {
    return { kind: 'invalid_name', reason: 'site name is required' };
  }
  if (trimmedName.length > NAME_MAX_LENGTH) {
    return {
      kind: 'invalid_name',
      reason: `site name must be ${NAME_MAX_LENGTH} characters or fewer`,
    };
  }

  const timezone =
    typeof input.timezone === 'string' && input.timezone.length > 0
      ? input.timezone
      : 'UTC';

  // Write the flag only when the caller stated one. Stamping `false` on every
  // new site would spend its "never asked" state at creation and permanently
  // suppress the opt-in prompt for sites nobody ever asked.
  const schedulesFollowSiteTime =
    typeof input.schedulesFollowSiteTime === 'boolean'
      ? input.schedulesFollowSiteTime
      : undefined;

  const db = input.db ?? getAdminDb();
  const siteRef = db.collection('sites').doc(input.siteId);

  const existing = await siteRef.get();
  if (existing.exists) {
    return { kind: 'already_exists' };
  }

  // A retired id is not free. deleteSite clears `users/{uid}.sites[]` only for
  // members whose user doc still exists, so a stale entry can survive a delete
  // and reusing the slug could hand the new site's data to a leftover holder.
  // Refused rather than silently reused.
  const tombstone = await db.collection('site_ids').doc(input.siteId).get();
  if (tombstone.exists) {
    return { kind: 'id_retired' };
  }

  // outside the batch, so two creates racing for the last slot can both land;
  // the plan accepts that overshoot.
  if (!(await siteSlotAvailable(input.ownerUid))) {
    return { kind: 'plan_limit' };
  }

  const nowDate = (input.now ?? (() => new Date()))();

  // `update`, not `set(..., {merge:true})`: the route already ran
  // `assertActiveUser`, so the doc exists. If that invariant breaks, failing the
  // whole batch is correct — an invisible site is exactly the bug fixed here.
  const batch = db.batch();
  batch.set(siteRef, {
    name: trimmedName,
    createdAt: nowDate,
    owner: input.ownerUid,
    timezone,
    ...(schedulesFollowSiteTime !== undefined ? { schedulesFollowSiteTime } : {}),
  });
  batch.update(db.collection('users').doc(input.ownerUid), {
    sites: FieldValue.arrayUnion(input.siteId),
  });
  // The owner's member document rides the SAME batch, so a new site is created
  // in both shapes atomically or not at all. Without this, every site created
  // after the Wave 3 backfill would be missing its owner row — the backfill
  // target would move under it and Wave 4's fallback counter could never reach
  // zero, which is the gate Wave 6 waits on.
  addOwnerToBatch(batch, {
    siteId: input.siteId,
    ownerUid: input.ownerUid,
    now: nowDate,
    db,
  });
  await batch.commit();

  emitMutation({
    kind: 'site_mutated',
    siteId: input.siteId,
    actor: ctx.auditActor,
    targetId: input.siteId,
    attributes: {
      endpoint: ctx.endpoint ?? '',
      method: ctx.method ?? 'POST',
      verb: 'created',
      owner: input.ownerUid,
      timezone,
      // `null` distinguishes "flag not written" from an explicit `false` in the
      // audit trail, which is the same distinction the document keeps.
      schedulesFollowSiteTime: schedulesFollowSiteTime ?? null,
    },
  });

  return {
    kind: 'created',
    siteId: input.siteId,
    name: trimmedName,
    timezone,
    owner: input.ownerUid,
    createdAt: nowDate.getTime(),
    schedulesFollowSiteTime: schedulesFollowSiteTime === true,
  };
}
