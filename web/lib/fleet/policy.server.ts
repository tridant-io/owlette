/**
 * which machines of a site may act on its machines, and how far: the
 * `sites/{siteId}/settings/fleet` document (ADR 0017). each sender's stored
 * entry is `{ maxTier, machineIds?: string[], wholeSite?: true }`.
 *
 * a granted machine is a new principal that can run commands, so its grant
 * fails closed. a member row (`lib/machineAccess.ts`) reads an absent list as
 * the whole site to keep old rows working; a grant has no old rows, so here an
 * absent or malformed list is no machines, and the whole site is only ever the
 * literal `wholeSite: true`. the writer always stores a tier, so a missing or
 * malformed one reads as 1, the lowest.
 *
 * every field is read as an own property: the firestore sdk decodes a map key
 * named `__proto__` by assigning it, so an inherited value could otherwise be
 * read as the document's.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { parseMachineIds, scopeCovers } from '@/lib/machineAccess';

/** `sites/{siteId}/settings/fleet`. */
export const FLEET_SETTINGS_DOC = 'fleet';

export const MAX_FLEET_SENDERS = 64;

export interface FleetGrant {
  maxTier: 1 | 2 | 3;
  /** what `scopeCovers` takes: null only for an explicit whole-site grant. */
  machineIds: readonly string[] | null;
}

export interface FleetSettings {
  enabled: boolean;
  senders: Record<string, FleetGrant>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function own(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function grantedMachineIds(entry: Record<string, unknown>): readonly string[] | null {
  // a present list wins over wholeSite, as the narrower of the two
  if (Object.prototype.hasOwnProperty.call(entry, 'machineIds')) return parseMachineIds(entry) ?? [];
  return own(entry, 'wholeSite') === true ? null : [];
}

function parseGrant(entry: Record<string, unknown>): FleetGrant {
  const tier = own(entry, 'maxTier');
  return {
    maxTier: tier === 1 || tier === 2 || tier === 3 ? tier : 1,
    machineIds: grantedMachineIds(entry),
  };
}

export function parseFleetSettings(raw: unknown): FleetSettings {
  const d = asRecord(raw) ?? {};
  const stored = asRecord(own(d, 'senders')) ?? {};
  // sorted so the cap keeps the same senders whatever order the map arrives in
  const senders = Object.keys(stored)
    .sort()
    .flatMap((machineId): Array<[string, FleetGrant]> => {
      const entry = asRecord(stored[machineId]);
      return entry ? [[machineId, parseGrant(entry)]] : [];
    })
    .slice(0, MAX_FLEET_SENDERS);
  // fromEntries defines own properties, so a sender named `__proto__` stays a key
  return { enabled: own(d, 'enabled') === true, senders: Object.fromEntries(senders) };
}

export async function loadFleetSettings(
  siteId: string,
  opts: { db?: Firestore } = {},
): Promise<FleetSettings> {
  const snap = await (opts.db ?? getAdminDb())
    .collection('sites')
    .doc(siteId)
    .collection('settings')
    .doc(FLEET_SETTINGS_DOC)
    .get();
  return parseFleetSettings(snap.exists ? snap.data() : null);
}

export function fleetGrantFor(settings: FleetSettings, machineId: string): FleetGrant | null {
  // own keys only: a machine named `constructor` must not read Object's as its grant
  if (!settings.enabled || !Object.prototype.hasOwnProperty.call(settings.senders, machineId)) {
    return null;
  }
  return settings.senders[machineId];
}

export function grantCovers(grant: FleetGrant, machineId: string): boolean {
  return scopeCovers(grant.machineIds, machineId);
}
