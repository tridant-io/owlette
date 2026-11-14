/**
 * write the site's fleet grant, `sites/{siteId}/settings/fleet` (service
 * account only in the rules; clients read it through `hooks/useFleetSettings.ts`).
 * `lib/fleet/grant.ts` is the one reading of the document; this module only
 * writes it (ADR 0017).
 *
 * `senders`, when given, is the whole new map: a sender left out is removed,
 * and each entry is written whole, so a removed sender or list cannot linger.
 *
 * the fleet routes rebuild a machine's reach from the live grant on every
 * call, so a narrowed grant needs no revocation, and cutting its sessions
 * would only kill calls still running on machines it may reach. sessions are
 * deleted for a sender removed from the grant, and for the whole site when the
 * feature turns off; a revocation that fails is logged rather than failing a
 * write that has already landed. a machine newly granted is told to fetch its
 * session now rather than at its next scheduled refresh.
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';
import { writeCommandFanOut } from '@/lib/commandLifecycle';
import logger from '@/lib/logger';
import { normalizeMachineIdsInput } from '@/lib/machineAccess';
import { own } from '@/lib/fleet/grant';
import {
  FLEET_SETTINGS_DOC,
  MAX_FLEET_SENDERS,
  parseFleetSettings,
  storedFleetGrant,
  type FleetGrant,
  type FleetSettings,
  type StoredFleetGrant,
} from '@/lib/fleet/policy.server';
import { revokeFleetSessions } from '@/lib/fleet/session.server';
import { SITE_SETTINGS_REFRESH_COMMAND } from './setDisplaySettings.server';
import { ActionInputError, type ActionContext } from './createProcess.server';

/** a new sender's tier when the request names none: bounded changes, never shell. */
const DEFAULT_SENDER_TIER = 2;

export interface FleetSenderInput {
  maxTier?: 1 | 2 | 3;
  machineIds?: string[];
  wholeSite?: boolean;
}

export interface SetFleetSettingsInput {
  enabled?: boolean;
  /** every sender the site keeps, by machine id. */
  senders?: Record<string, FleetSenderInput>;
}

export interface StoredFleetSettings {
  enabled: boolean;
  senders: Record<string, StoredFleetGrant>;
}

export interface SetFleetSettingsResult {
  siteId: string;
  settings: FleetSettings;
}

export interface SetFleetSettingsOptions {
  /** injected firestore for tests; production omits it. */
  db?: Firestore;
  /** stamped on the refresh commands so they correlate with the PATCH audit row. */
  correlationId?: string;
}

/** the settings in their stored shape, which is also what the api returns. */
export function storedFleetSettings(settings: FleetSettings): StoredFleetSettings {
  return {
    enabled: settings.enabled,
    // fromEntries defines own properties, so a sender named `__proto__` stays a key
    senders: Object.fromEntries(
      Object.entries(settings.senders).map(([id, grant]) => [id, storedFleetGrant(grant)]),
    ),
  };
}

function invalid(message: string): ActionInputError {
  return new ActionInputError(400, 'validation_failed', message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ParsedSender {
  maxTier: 1 | 2 | 3 | undefined;
  machineIds: string[] | null;
}

function parseSender(machineId: string, raw: unknown): ParsedSender {
  // the machine id rule lives in machine scope; one id at a time, since a site
  // may grant more senders than a scope may list
  const id = normalizeMachineIdsInput([machineId], { allowNull: false });
  if (!id.ok) throw invalid(id.error);
  const field = `senders.${machineId}`;
  if (!isObject(raw)) throw invalid(`field \`${field}\` must be an object`);

  const maxTier = own(raw, 'maxTier');
  if (maxTier !== undefined && maxTier !== 1 && maxTier !== 2 && maxTier !== 3) {
    throw invalid(`field \`${field}.maxTier\` must be 1, 2 or 3`);
  }
  const wholeSite = own(raw, 'wholeSite');
  if (wholeSite !== undefined && typeof wholeSite !== 'boolean') {
    throw invalid(`field \`${field}.wholeSite\` must be a boolean`);
  }
  const machineIds = own(raw, 'machineIds');
  if (wholeSite === true) {
    if (machineIds !== undefined) {
      throw invalid(`field \`${field}\` cannot name both wholeSite and machineIds`);
    }
    return { maxTier, machineIds: null };
  }
  // no machines named is a grant that reaches nothing, which normalize refuses
  if (machineIds === undefined || (Array.isArray(machineIds) && machineIds.length === 0)) {
    return { maxTier, machineIds: [] };
  }
  const targets = normalizeMachineIdsInput(machineIds, { allowNull: false });
  if (!targets.ok) throw invalid(`${field}: ${targets.error}`);
  return { maxTier, machineIds: targets.value ?? [] };
}

function parseInput(input: SetFleetSettingsInput): {
  enabled: boolean | undefined;
  senders: Array<[string, ParsedSender]> | undefined;
} {
  const raw: Record<string, unknown> = isObject(input) ? input : {};
  const enabled = own(raw, 'enabled');
  const senders = own(raw, 'senders');
  if (enabled === undefined && senders === undefined) {
    throw invalid('at least one of enabled, senders is required');
  }
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw invalid('field `enabled` must be a boolean');
  }
  if (senders === undefined) return { enabled, senders: undefined };
  if (!isObject(senders)) {
    throw invalid('field `senders` must be an object keyed by machine id');
  }
  const entries = Object.entries(senders);
  if (entries.length > MAX_FLEET_SENDERS) {
    throw invalid(`field \`senders\` may name at most ${MAX_FLEET_SENDERS} machines`);
  }
  return { enabled, senders: entries.map(([id, entry]) => [id, parseSender(id, entry)]) };
}

function ownGrant(senders: Record<string, FleetGrant>, machineId: string): FleetGrant | undefined {
  return Object.prototype.hasOwnProperty.call(senders, machineId) ? senders[machineId] : undefined;
}

/** a sender's tier after this write: the one asked for, else the one it holds, else a new sender's. */
function tierAfter(before: FleetSettings, machineId: string, sender: ParsedSender): FleetGrant['maxTier'] {
  return sender.maxTier ?? ownGrant(before.senders, machineId)?.maxTier ?? DEFAULT_SENDER_TIER;
}

/**
 * whether `input` gives any sender a higher tier than it holds now, a new
 * sender counting from 1. throws on input `setFleetSettings` would refuse.
 */
export function raisesFleetTier(before: FleetSettings, input: SetFleetSettingsInput): boolean {
  const { senders } = parseInput(input);
  return (senders ?? []).some(
    ([id, sender]) => tierAfter(before, id, sender) > (ownGrant(before.senders, id)?.maxTier ?? 1),
  );
}

/**
 * an id this write adds, as a sender or to a sender's list, must be a machine
 * of the site. one already stored that has since left the site is dropped from
 * what is written instead, so a removed machine never blocks the next write.
 */
async function dropRemovedMachines(
  db: Firestore,
  siteId: string,
  before: FleetSettings,
  senders: Array<[string, ParsedSender]>,
): Promise<{ senders: Array<[string, ParsedSender]>; dropped: string[] }> {
  const named = [...new Set(senders.flatMap(([id, sender]) => [id, ...(sender.machineIds ?? [])]))];
  if (named.length === 0) return { senders, dropped: [] };
  const machines = db.collection('sites').doc(siteId).collection('machines');
  const snaps = await db.getAll(...named.map((id) => machines.doc(id)));
  const gone = new Set(named.filter((_, i) => !snaps[i].exists));
  if (gone.size === 0) return { senders, dropped: [] };

  const added = senders.flatMap(([id, sender]) => {
    const stored = ownGrant(before.senders, id);
    // a whole-site grant listed nothing, so every id in its new list is added
    const storedList = stored?.machineIds ?? [];
    return [...(stored ? [] : [id]), ...(sender.machineIds ?? []).filter((m) => !storedList.includes(m))];
  });
  const unknown = [...new Set(added.filter((id) => gone.has(id)))].sort();
  if (unknown.length > 0) throw invalid(`not machines of this site: ${unknown.join(', ')}`);

  return {
    senders: senders
      .filter(([id]) => !gone.has(id))
      .map(([id, sender]) => [
        id,
        { ...sender, machineIds: sender.machineIds?.filter((m) => !gone.has(m)) ?? null },
      ]),
    dropped: [...gone].sort(),
  };
}

export async function setFleetSettings(
  ctx: ActionContext,
  input: SetFleetSettingsInput,
  options: SetFleetSettingsOptions = {},
): Promise<SetFleetSettingsResult> {
  const parsed = parseInput(input);

  const db = options.db ?? getAdminDb();
  const settingsRef = db
    .collection('sites')
    .doc(ctx.siteId)
    .collection('settings')
    .doc(FLEET_SETTINGS_DOC);
  const snap = await settingsRef.get();
  const before = parseFleetSettings(snap.exists ? snap.data() : null);

  const requested = parsed.senders
    ? await dropRemovedMachines(db, ctx.siteId, before, parsed.senders)
    : undefined;

  const settings: FleetSettings = {
    enabled: parsed.enabled ?? before.enabled,
    senders: requested
      ? Object.fromEntries(
          requested.senders.map(([id, sender]): [string, FleetGrant] => [
            id,
            { maxTier: tierAfter(before, id, sender), machineIds: sender.machineIds },
          ]),
        )
      : before.senders,
  };

  const write: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (parsed.enabled !== undefined) write.enabled = parsed.enabled;
  if (requested) write.senders = storedFleetSettings(settings).senders;
  // mergeFields, not merge: true. a merge write deep-merges a map, so a removed
  // sender, or a list beside a new wholeSite, would survive it. a named field
  // is replaced whole, and the fields this request left out stay as they are.
  await settingsRef.set(write, { mergeFields: Object.keys(write) });

  const siteCut = before.enabled && !settings.enabled;
  const removed = siteCut
    ? []
    : Object.keys(before.senders)
        .filter((id) => ownGrant(settings.senders, id) === undefined)
        .sort();
  await revokeSessions(db, ctx.siteId, siteCut, removed);

  // newly holding a live grant: added to an enabled site, or on a site this
  // write turned on
  const granted = settings.enabled
    ? Object.keys(settings.senders)
        .filter((id) => !before.enabled || ownGrant(before.senders, id) === undefined)
        .sort()
    : [];
  // a sender this write cut is refused by the server at once, but its agent
  // keeps the session file until it asks again, so it is told to ask now
  const cut = before.enabled ? (siteCut ? Object.keys(before.senders) : removed) : [];
  // a stored sender may have left the site since, and a command queued under
  // its name would create that machine a commands document
  const told = await machinesInSite(db, ctx.siteId, [...granted, ...cut].sort());
  await refreshSenders(ctx, db, told, options);

  // a sender this write added, or whose tier or machines it changed, as stored:
  // without it such a write leaves a row that says nothing changed
  const storedBefore = storedFleetSettings(before).senders;
  const changedSenders = Object.fromEntries(
    Object.entries(storedFleetSettings(settings).senders).filter(
      ([id, grant]) =>
        !Object.prototype.hasOwnProperty.call(storedBefore, id) ||
        JSON.stringify(grant) !== JSON.stringify(storedBefore[id]),
    ),
  );

  emitMutation({
    kind: 'site_mutated',
    siteId: ctx.siteId,
    actor: ctx.auditActor,
    targetId: ctx.siteId,
    attributes: {
      verb: 'set_fleet_settings',
      endpoint: 'fleet-settings',
      method: 'PATCH',
      enabled: settings.enabled,
      senderIds: Object.keys(settings.senders).sort(),
      changedSenders,
      revokedForSite: siteCut,
      revokedSenderIds: removed,
      refreshedSenderIds: told,
      droppedMachineIds: requested?.dropped ?? [],
    },
  });

  return { siteId: ctx.siteId, settings };
}

/** the ids among `machineIds` that are machines of the site, in the order given. */
async function machinesInSite(db: Firestore, siteId: string, machineIds: string[]): Promise<string[]> {
  if (machineIds.length === 0) return [];
  const machines = db.collection('sites').doc(siteId).collection('machines');
  const snaps = await db.getAll(...machineIds.map((id) => machines.doc(id)));
  return machineIds.filter((_, i) => snaps[i].exists);
}

/**
 * best-effort: a sender that misses the nudge fetches its session, or learns
 * it has none, at its next scheduled refresh anyway, so a failed queue is
 * logged and never fails the write.
 */
async function refreshSenders(
  ctx: ActionContext,
  db: Firestore,
  machineIds: string[],
  options: SetFleetSettingsOptions,
): Promise<void> {
  if (machineIds.length === 0) return;
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
  const failed = results.filter((r) => !r.ok).map((r) => r.machineId);
  if (failed.length > 0) {
    logger.warn('[fleet/settings] some senders could not be told to refresh their session', {
      context: 'actions/setFleetSettings',
      data: { siteId: ctx.siteId, failed },
    });
  }
}

async function revokeSessions(
  db: Firestore,
  siteId: string,
  siteCut: boolean,
  sendersCut: string[],
): Promise<void> {
  const revocations = siteCut
    ? [revokeFleetSessions(db, { siteId })]
    : sendersCut.map((machineId) => revokeFleetSessions(db, { siteId, machineId }));
  const results = await Promise.allSettled(revocations);
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed > 0) {
    logger.warn('[fleet/settings] some fleet sessions could not be revoked', {
      context: 'actions/setFleetSettings',
      data: { siteId, siteCut, sendersCut, failed },
    });
  }
}
