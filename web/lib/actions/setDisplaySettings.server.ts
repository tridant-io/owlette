/**
 * write the per-site display policy, `sites/{siteId}/settings/display`
 * (`lib/display/settings.server.ts` reads it).
 *
 * changing `keepAwake` queues a `site_settings_refresh` command on the site's
 * ONLINE machines, so each re-reads `/api/agent/site` now rather than at its
 * next 15-minute refresh. an offline machine reads the setting when it
 * reconnects, so it is not queued one.
 */

import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { emitMutation } from '@/lib/auditLogClient';
import { writeCommandFanOut } from '@/lib/commandLifecycle';
import logger from '@/lib/logger';
import {
  DISPLAY_SETTINGS_DOC,
  parseDisplaySettings,
  type DisplaySiteSettings,
} from '@/lib/display/settings.server';
import { ActionInputError, type ActionContext } from './createProcess.server';

/** the agent command a change fans out. handled in `agent/src/site_commands.py`. */
export const SITE_SETTINGS_REFRESH_COMMAND = 'site_settings_refresh';

export interface SetDisplaySettingsInput {
  keepAwake: boolean;
}

export interface SetDisplaySettingsResult {
  siteId: string;
  settings: DisplaySiteSettings;
  /** machines told to re-read the site's settings. empty unless `keepAwake` changed. */
  refreshed: string[];
}

export interface SetDisplaySettingsOptions {
  /** injected firestore for tests; production omits it. */
  db?: ReturnType<typeof getAdminDb>;
  /** stamped on the fan-out so the commands correlate with the PATCH audit row. */
  correlationId?: string;
}

export async function setDisplaySettings(
  ctx: ActionContext,
  input: SetDisplaySettingsInput,
  options: SetDisplaySettingsOptions = {},
): Promise<SetDisplaySettingsResult> {
  if (typeof input.keepAwake !== 'boolean') {
    throw new ActionInputError(
      400,
      'validation_failed',
      'field `keepAwake` is required and must be a boolean',
    );
  }

  const db = options.db ?? getAdminDb();
  const settingsRef = db
    .collection('sites')
    .doc(ctx.siteId)
    .collection('settings')
    .doc(DISPLAY_SETTINGS_DOC);

  const snap = await settingsRef.get();
  const before = parseDisplaySettings(snap.exists ? snap.data() : null);

  await settingsRef.set(
    { keepAwake: input.keepAwake, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );

  const settings: DisplaySiteSettings = { ...before, keepAwake: input.keepAwake };
  const refreshed =
    input.keepAwake !== before.keepAwake ? await refreshOnlineMachines(ctx, db, options) : [];

  emitMutation({
    kind: 'site_mutated',
    siteId: ctx.siteId,
    actor: ctx.auditActor,
    targetId: ctx.siteId,
    attributes: {
      verb: 'set_display_settings',
      endpoint: 'display-settings',
      method: 'PATCH',
      keepAwake: settings.keepAwake,
      refreshedCount: refreshed.length,
    },
  });

  return { siteId: ctx.siteId, settings, refreshed };
}

/**
 * one machine's failed write never aborts the rest: the command is only a
 * nudge, and every agent re-reads the setting on its own schedule anyway.
 */
async function refreshOnlineMachines(
  ctx: ActionContext,
  db: ReturnType<typeof getAdminDb>,
  options: SetDisplaySettingsOptions,
): Promise<string[]> {
  const online = await db
    .collection('sites')
    .doc(ctx.siteId)
    .collection('machines')
    .where('online', '==', true)
    .get();
  const machineIds = online.docs.map((d) => d.id);

  const results = await writeCommandFanOut(
    ctx.siteId,
    machineIds,
    SITE_SETTINGS_REFRESH_COMMAND,
    {
      type: SITE_SETTINGS_REFRESH_COMMAND,
      siteId: ctx.siteId,
      timestamp: FieldValue.serverTimestamp(),
      status: 'pending',
      queuedBy: ctx.auditActor,
    },
    { db, auditCorrelationId: options.correlationId },
  );

  const delivered = results.filter((r) => r.ok).map((r) => r.machineId);
  if (delivered.length !== machineIds.length) {
    logger.warn('[display/settings] some machines could not be told to refresh', {
      context: 'actions/setDisplaySettings',
      data: { siteId: ctx.siteId, attempted: machineIds.length, delivered: delivered.length },
    });
  }
  return delivered;
}
