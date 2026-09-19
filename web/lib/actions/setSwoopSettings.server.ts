/**
 * Write the per-site swoop policy document, `sites/{siteId}/settings/swoop`
 * (service-account only in the rules; clients read it directly through
 * `hooks/useSwoopSettings.ts`).
 *
 * The document is the site-level half of the three-layer decision in
 * `lib/swoop/policy.server.ts` — this module only writes it, and never decides
 * anything itself, so the read path stays the single interpreter of the fields.
 *
 * Toggling `enabled` fans a `swoop_refresh` command out to the site's ONLINE
 * machines. That is what makes a disable reach a machine that is already
 * connected: the agent re-dials immediately, its doorbell-token request comes
 * back 403 `swoop_disabled`, and it drops to the slow-retry path instead of
 * holding its socket until the next restart. Queued through
 * `requestSwoopSession` like every other swoop command — `swoop_refresh` names
 * no session, so it carries no `sid`.
 */

import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { emitMutation } from '@/lib/auditLogClient';
import logger from '@/lib/logger';
import {
  parseSwoopSettings,
  SWOOP_SETTINGS_DOC,
  type SwoopIndicator,
  type SwoopSiteSettings,
} from '@/lib/swoop/policy.server';
import { requestSwoopSession } from '@/lib/actions/requestSwoopSession.server';
import { ActionInputError, type ActionContext } from './createProcess.server';

const INDICATORS: ReadonlySet<string> = new Set<SwoopIndicator>(['banner', 'tray', 'none']);

/** Guards the document against an unbounded array; far above any real fleet. */
const MAX_EXCLUDED = 1000;

export interface SetSwoopSettingsInput {
  enabled?: boolean;
  excludedMachineIds?: string[];
  membersMayWatch?: boolean;
  indicator?: SwoopIndicator;
}

export interface SetSwoopSettingsResult {
  siteId: string;
  settings: SwoopSiteSettings;
  /** Machines told to re-dial. Empty unless `enabled` actually changed. */
  refreshed: string[];
}

export interface SetSwoopSettingsOptions {
  /** Injected Firestore for tests; production omits it. */
  db?: ReturnType<typeof getAdminDb>;
  /** Stamped on the fan-out so the commands correlate with the PATCH audit row. */
  correlationId?: string;
}

function validate(input: SetSwoopSettingsInput): void {
  const fields = ['enabled', 'excludedMachineIds', 'membersMayWatch', 'indicator'] as const;
  if (fields.every((f) => input[f] === undefined)) {
    throw new ActionInputError(
      400,
      'validation_failed',
      `at least one of ${fields.join(', ')} is required`,
    );
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new ActionInputError(400, 'validation_failed', 'field `enabled` must be a boolean');
  }
  if (input.membersMayWatch !== undefined && typeof input.membersMayWatch !== 'boolean') {
    throw new ActionInputError(
      400,
      'validation_failed',
      'field `membersMayWatch` must be a boolean',
    );
  }
  if (input.indicator !== undefined && !INDICATORS.has(input.indicator)) {
    throw new ActionInputError(
      400,
      'validation_failed',
      'field `indicator` must be one of banner, tray, none',
    );
  }
  if (input.excludedMachineIds !== undefined) {
    if (
      !Array.isArray(input.excludedMachineIds) ||
      input.excludedMachineIds.some((id) => typeof id !== 'string' || id.length === 0)
    ) {
      throw new ActionInputError(
        400,
        'validation_failed',
        'field `excludedMachineIds` must be an array of machine ids',
      );
    }
    if (input.excludedMachineIds.length > MAX_EXCLUDED) {
      throw new ActionInputError(
        400,
        'validation_failed',
        `field \`excludedMachineIds\` may hold at most ${MAX_EXCLUDED} machine ids`,
      );
    }
  }
}

export async function setSwoopSettings(
  ctx: ActionContext,
  input: SetSwoopSettingsInput,
  options: SetSwoopSettingsOptions = {},
): Promise<SetSwoopSettingsResult> {
  validate(input);

  const db = options.db ?? getAdminDb();
  const siteRef = db.collection('sites').doc(ctx.siteId);
  const settingsRef = siteRef.collection('settings').doc(SWOOP_SETTINGS_DOC);

  const snap = await settingsRef.get();
  const before = parseSwoopSettings(snap.exists ? snap.data() : null);

  const excluded =
    input.excludedMachineIds === undefined ? undefined : [...new Set(input.excludedMachineIds)];

  await settingsRef.set(
    {
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(excluded === undefined ? {} : { excludedMachineIds: excluded }),
      ...(input.membersMayWatch === undefined ? {} : { membersMayWatch: input.membersMayWatch }),
      ...(input.indicator === undefined ? {} : { indicator: input.indicator }),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  const settings: SwoopSiteSettings = {
    ...before,
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(excluded === undefined ? {} : { excludedMachineIds: excluded }),
    ...(input.membersMayWatch === undefined ? {} : { membersMayWatch: input.membersMayWatch }),
    ...(input.indicator === undefined ? {} : { indicator: input.indicator }),
  };

  const enablementChanged = input.enabled !== undefined && input.enabled !== before.enabled;
  const refreshed = enablementChanged ? await refreshOnlineMachines(ctx, db, options) : [];

  emitMutation({
    kind: 'site_mutated',
    siteId: ctx.siteId,
    actor: ctx.auditActor,
    targetId: ctx.siteId,
    attributes: {
      verb: 'set_swoop_settings',
      endpoint: 'swoop-settings',
      method: 'PATCH',
      enabled: settings.enabled,
      membersMayWatch: settings.membersMayWatch,
      indicator: settings.indicator,
      excludedCount: settings.excludedMachineIds.length,
      refreshedCount: refreshed.length,
    },
  });

  return { siteId: ctx.siteId, settings, refreshed };
}

/**
 * Only ONLINE machines: `requestSwoopSession` refuses `swoop_refresh` for an
 * offline one, and an offline machine re-reads its policy on reconnect anyway.
 * One machine's failure never aborts the rest — the fan-out is a nudge, and the
 * policy is enforced server-side regardless of who hears it.
 */
async function refreshOnlineMachines(
  ctx: ActionContext,
  db: ReturnType<typeof getAdminDb>,
  options: SetSwoopSettingsOptions,
): Promise<string[]> {
  const online = await db
    .collection('sites')
    .doc(ctx.siteId)
    .collection('machines')
    .where('online', '==', true)
    .get();
  const machineIds = online.docs.map((d) => d.id);

  const results = await Promise.allSettled(
    machineIds.map((machineId) =>
      requestSwoopSession(
        {
          type: 'swoop_refresh',
          siteId: ctx.siteId,
          machineId,
          actor: ctx.actor,
          auditActor: ctx.auditActor,
          ...(options.correlationId ? { correlationId: options.correlationId } : {}),
        },
        { db },
      ),
    ),
  );

  const delivered = machineIds.filter((_, i) => results[i].status === 'fulfilled');
  if (delivered.length !== machineIds.length) {
    logger.warn('[swoop/settings] some machines could not be told to re-dial', {
      context: 'actions/setSwoopSettings',
      data: { siteId: ctx.siteId, attempted: machineIds.length, delivered: delivered.length },
    });
  }
  return delivered;
}
