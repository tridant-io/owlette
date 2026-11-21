/**
 * Server-side replacement for the client `updateDoc` in
 * `useFirestore.ts:updateSite`. Whitelisted fields only (`name`, `timezone`,
 * `timeFormat`, `schedulesFollowSiteTime`); an empty payload yields
 * `kind: 'no_changes'` so the route can 200 without writing. Validation matches
 * the legacy hook: non-empty name and the `timeFormat` union, timezone passed
 * through as given.
 *
 * `schedulesFollowSiteTime: true` is refused unless the site ends the write with
 * a non-empty timezone — turning it on without one would hand every agent at the
 * site a null timezone and silently leave schedules on machine-local clocks
 * while the dashboard claimed otherwise. `false` is always accepted: it is the
 * escape hatch, and a site that declines does not need a timezone at all.
 *
 * Capability: site-scoped `SITE_MEMBER_MANAGE`.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';
import { tridantConfigured } from '@/lib/plan.server';
import { registerSite } from '@/lib/planTrial.server';

const NAME_MAX_LENGTH = 200;
const ALLOWED_TIME_FORMATS = new Set<'12h' | '24h'>(['12h', '24h']);

export interface UpdateSiteInput {
  siteId: string;
  name?: string;
  timezone?: string;
  timeFormat?: '12h' | '24h';
  /**
   * Opt process schedules into site time (`true`) or back onto each machine's
   * own clock (`false`). Omitting it leaves the stored state alone — including
   * the "never asked" state, which is the absence of the field.
   */
  schedulesFollowSiteTime?: boolean;
  /** Inject a Firestore instance; tests pass a mock, production omits. */
  db?: Firestore;
}

export interface UpdateSiteContext {
  auditActor: string;
  endpoint?: string;
  method?: string;
}

export type UpdateSiteResult =
  | { kind: 'not_found' }
  | { kind: 'invalid_name'; reason: string }
  | { kind: 'invalid_timezone'; reason: string }
  | { kind: 'invalid_time_format'; reason: string }
  | { kind: 'invalid_schedule_tz_flag'; reason: string }
  | { kind: 'no_changes' }
  | { kind: 'updated'; updated: Record<string, string | boolean> };

export async function updateSite(
  ctx: UpdateSiteContext,
  input: UpdateSiteInput,
): Promise<UpdateSiteResult> {
  if (!input.siteId) throw new Error('siteId is required');

  const updates: Record<string, string | boolean> = {};

  if (input.name !== undefined) {
    if (typeof input.name !== 'string') {
      return { kind: 'invalid_name', reason: 'name must be a string' };
    }
    const trimmed = input.name.trim();
    if (trimmed.length === 0) {
      return { kind: 'invalid_name', reason: 'site name cannot be empty' };
    }
    if (trimmed.length > NAME_MAX_LENGTH) {
      return {
        kind: 'invalid_name',
        reason: `site name must be ${NAME_MAX_LENGTH} characters or fewer`,
      };
    }
    updates.name = trimmed;
  }

  if (input.timezone !== undefined) {
    if (typeof input.timezone !== 'string') {
      return { kind: 'invalid_timezone', reason: 'timezone must be a string' };
    }
    updates.timezone = input.timezone;
  }

  if (input.timeFormat !== undefined) {
    if (!ALLOWED_TIME_FORMATS.has(input.timeFormat)) {
      return {
        kind: 'invalid_time_format',
        reason: `timeFormat must be one of: ${[...ALLOWED_TIME_FORMATS].join(', ')}`,
      };
    }
    updates.timeFormat = input.timeFormat;
  }

  if (input.schedulesFollowSiteTime !== undefined) {
    if (typeof input.schedulesFollowSiteTime !== 'boolean') {
      return {
        kind: 'invalid_schedule_tz_flag',
        reason: 'schedulesFollowSiteTime must be a boolean',
      };
    }
    updates.schedulesFollowSiteTime = input.schedulesFollowSiteTime;
  }

  if (Object.keys(updates).length === 0) {
    return { kind: 'no_changes' };
  }

  const db = input.db ?? getAdminDb();
  const siteRef = db.collection('sites').doc(input.siteId);
  const existing = await siteRef.get();
  if (!existing.exists) {
    return { kind: 'not_found' };
  }

  // Evaluate the timezone the document would have AFTER this write, so a single
  // PATCH may set the timezone and flip the flag on together. Only `true` is
  // gated — turning site time off never needs a timezone.
  if (updates.schedulesFollowSiteTime === true) {
    const storedTimezone = existing.data()?.timezone;
    const resultingTimezone =
      typeof updates.timezone === 'string'
        ? updates.timezone
        : typeof storedTimezone === 'string'
          ? storedTimezone
          : '';
    if (resultingTimezone.trim().length === 0) {
      return {
        kind: 'invalid_schedule_tz_flag',
        reason:
          'schedulesFollowSiteTime cannot be enabled until the site has a timezone',
      };
    }
  }

  await siteRef.update(updates);

  emitMutation({
    kind: 'site_mutated',
    siteId: input.siteId,
    actor: ctx.auditActor,
    targetId: input.siteId,
    attributes: {
      endpoint: ctx.endpoint ?? '',
      method: ctx.method ?? 'PATCH',
      verb: 'updated',
      fields: Object.keys(updates),
    },
  });

  // a billed site's invoice line carries the name tridant id holds, so a rename is
  // registered again. best effort, as at creation: registerSite never throws.
  const { owner, name: previousName } = existing.data() ?? {};
  const renamedTo = typeof updates.name === 'string' && updates.name !== previousName ? updates.name : null;
  if (renamedTo && typeof owner === 'string' && owner && tridantConfigured()) {
    await registerSite(owner, input.siteId, renamedTo);
  }

  return { kind: 'updated', updated: updates };
}
