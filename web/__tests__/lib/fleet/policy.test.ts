/** @jest-environment node */

/**
 * the fleet grant: a granted machine is a new principal that can run commands,
 * so a malformed, missing or inherited field reads as less, never as more. the
 * loader runs against a path-keyed fake, so the document it reads is asserted
 * by path rather than answered by one stub for every `doc()`.
 */

import type { Firestore } from 'firebase-admin/firestore';

type Data = Record<string, unknown>;

const mockAdminDocs = new Map<string, Data>();
const mockReads: string[] = [];

function mockFirestore(docs: Map<string, Data>): Firestore {
  const doc = (path: string) => ({
    get: async () => {
      mockReads.push(path);
      return { exists: docs.has(path), data: () => docs.get(path) };
    },
    collection: (name: string) => collection(`${path}/${name}`),
  });
  const collection = (path: string) => ({ doc: (id: string) => doc(`${path}/${id}`) });
  return { collection: (name: string) => collection(name) } as unknown as Firestore;
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockFirestore(mockAdminDocs),
}));

import {
  FLEET_SETTINGS_DOC,
  MAX_FLEET_SENDERS,
  fleetGrantFor,
  grantCovers,
  loadFleetSettings,
  parseFleetSettings,
  type FleetGrant,
} from '@/lib/fleet/policy.server';

const SITE = 'site-a';
const SETTINGS_PATH = `sites/${SITE}/settings/fleet`;
const DEFAULTS = { enabled: false, senders: {} };

/** the grant one stored sender entry parses to. */
function grantOf(entry: unknown): FleetGrant | undefined {
  return parseFleetSettings({ enabled: true, senders: { m1: entry } }).senders.m1;
}

beforeEach(() => {
  mockAdminDocs.clear();
  mockReads.length = 0;
});

describe('parseFleetSettings', () => {
  it('defaults to off with no senders', () => {
    for (const raw of [null, undefined, 'fleet', 3, true, [], [{ enabled: true }]]) {
      expect(parseFleetSettings(raw)).toEqual(DEFAULTS);
    }
  });

  it('only the literal true enables', () => {
    for (const enabled of ['true', 1, {}, false, null]) {
      expect(parseFleetSettings({ enabled }).enabled).toBe(false);
    }
    expect(parseFleetSettings({ enabled: true }).enabled).toBe(true);
  });

  it('reads no senders from a senders field that is not a map', () => {
    for (const senders of [null, 'm1', 3, [{ maxTier: 3, wholeSite: true }]]) {
      expect(parseFleetSettings({ enabled: true, senders }).senders).toEqual({});
    }
  });

  it('drops a sender entry that is not an object', () => {
    const settings = parseFleetSettings({
      enabled: true,
      senders: { a: null, b: 'yes', c: 3, d: true, e: ['m1'], ok: { machineIds: ['m1'] } },
    });
    expect(settings.senders).toEqual({ ok: { maxTier: 1, machineIds: ['m1'] } });
  });

  it('reads a missing tier, or anything outside 1 to 3, as 1, the lowest', () => {
    expect(grantOf({})?.maxTier).toBe(1);
    for (const maxTier of [1, 2, 3] as const) {
      expect(grantOf({ maxTier })?.maxTier).toBe(maxTier);
    }
    for (const maxTier of [0, 4, -1, 2.5, '3', '2', null, true]) {
      expect(grantOf({ maxTier })?.maxTier).toBe(1);
    }
  });

  it('reads no field through the prototype, as a decoded `__proto__` key would supply one', () => {
    const inherited = Object.create({ enabled: true, senders: { m1: { maxTier: 3, wholeSite: true } } });
    expect(parseFleetSettings(inherited)).toEqual(DEFAULTS);

    const entry = Object.create({ maxTier: 3, wholeSite: true });
    expect(grantOf(entry)).toEqual({ maxTier: 1, machineIds: [] });
  });

  it('reads a sender with no list as reaching nothing, never the whole site', () => {
    expect(grantOf({})?.machineIds).toEqual([]);
    expect(grantOf({ maxTier: 3 })?.machineIds).toEqual([]);
  });

  it('reads wholeSite as the whole site only when it is the literal true', () => {
    expect(grantOf({ wholeSite: true })?.machineIds).toBeNull();
    for (const wholeSite of ['true', 1, {}, [], false, null]) {
      expect(grantOf({ wholeSite })?.machineIds).toEqual([]);
    }
  });

  it('parses a present list as machine scope does: strings only, de-duplicated', () => {
    expect(grantOf({ machineIds: ['m2', 'm1', 'm2', 7, null] })?.machineIds).toEqual(['m1', 'm2']);
  });

  it('reads a malformed list as no machines', () => {
    for (const machineIds of ['m1', null, 3, { m1: true }, undefined]) {
      expect(grantOf({ machineIds })?.machineIds).toEqual([]);
    }
  });

  it('takes the list over wholeSite when both are present, malformed or not', () => {
    expect(grantOf({ wholeSite: true, machineIds: ['m1'] })?.machineIds).toEqual(['m1']);
    expect(grantOf({ wholeSite: true, machineIds: [] })?.machineIds).toEqual([]);
    expect(grantOf({ wholeSite: true, machineIds: 'm1' })?.machineIds).toEqual([]);
  });

  it(`keeps at most ${MAX_FLEET_SENDERS} senders, the first in key order`, () => {
    const id = (i: number) => `m${String(i).padStart(3, '0')}`;
    const stored: Data = {};
    // written in reverse so key order, not insertion order, decides who stays
    for (let i = MAX_FLEET_SENDERS + 9; i >= 0; i--) stored[id(i)] = { machineIds: [id(i)] };

    const ids = Object.keys(parseFleetSettings({ enabled: true, senders: stored }).senders);
    expect(ids).toHaveLength(MAX_FLEET_SENDERS);
    expect(ids).toEqual(Array.from({ length: MAX_FLEET_SENDERS }, (_, i) => id(i)));
  });

  it('does not count a dropped entry against the cap', () => {
    const stored: Data = { a000: null };
    for (let i = 0; i < MAX_FLEET_SENDERS; i++) stored[`m${String(i).padStart(3, '0')}`] = {};

    const senders = parseFleetSettings({ enabled: true, senders: stored }).senders;
    expect(Object.keys(senders)).toHaveLength(MAX_FLEET_SENDERS);
    expect(senders).not.toHaveProperty('a000');
  });
});

describe('fleetGrantFor', () => {
  const settings = parseFleetSettings({
    enabled: true,
    senders: { m1: { maxTier: 3, machineIds: ['m2'] } },
  });

  it('returns the grant of a sender on an enabled site', () => {
    expect(fleetGrantFor(settings, 'm1')).toEqual({ maxTier: 3, machineIds: ['m2'] });
  });

  it('returns null when the feature is not on, whatever the senders say', () => {
    expect(fleetGrantFor({ ...settings, enabled: false }, 'm1')).toBeNull();
  });

  it('returns null for a machine that is not a sender', () => {
    expect(fleetGrantFor(settings, 'm2')).toBeNull();
  });

  it("does not read Object's own members as a grant", () => {
    for (const machineId of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(fleetGrantFor(settings, machineId)).toBeNull();
    }
  });

  it('keeps a sender whose id is __proto__ as an ordinary sender', () => {
    const parsed = parseFleetSettings(JSON.parse('{"enabled":true,"senders":{"__proto__":{"maxTier":1}}}'));
    expect(fleetGrantFor(parsed, '__proto__')).toEqual({ maxTier: 1, machineIds: [] });
  });
});

describe('grantCovers', () => {
  it('covers nothing, not even the sender, when no machines are named', () => {
    const grant = grantOf({ maxTier: 3 })!;
    expect(grantCovers(grant, 'm1')).toBe(false);
    expect(grantCovers(grant, 'm2')).toBe(false);
  });

  it('covers every machine, the sender included, on an explicit whole-site grant', () => {
    const grant = grantOf({ wholeSite: true })!;
    expect(grantCovers(grant, 'm1')).toBe(true);
    expect(grantCovers(grant, 'any-machine')).toBe(true);
  });

  it('covers the listed machines and no others, the sender only when listed', () => {
    const grant = grantOf({ machineIds: ['m2', 'm3'] })!;
    expect(grantCovers(grant, 'm2')).toBe(true);
    expect(grantCovers(grant, 'm3')).toBe(true);
    expect(grantCovers(grant, 'm4')).toBe(false);
    expect(grantCovers(grant, 'm1')).toBe(false);
    expect(grantCovers(grantOf({ machineIds: ['m1', 'm2'] })!, 'm1')).toBe(true);
  });
});

describe('loadFleetSettings', () => {
  it('reads the site settings document', async () => {
    mockAdminDocs.set(SETTINGS_PATH, { enabled: true, senders: { m1: { maxTier: 1, wholeSite: true } } });

    expect(await loadFleetSettings(SITE)).toEqual({
      enabled: true,
      senders: { m1: { maxTier: 1, machineIds: null } },
    });
    expect(mockReads).toEqual([`sites/${SITE}/settings/${FLEET_SETTINGS_DOC}`]);
  });

  it('reads defaults when the document does not exist', async () => {
    expect(await loadFleetSettings(SITE)).toEqual(DEFAULTS);
    expect(mockReads).toEqual([SETTINGS_PATH]);
  });

  it('reads through the db it is given rather than the admin db', async () => {
    const docs = new Map<string, Data>([[SETTINGS_PATH, { enabled: true }]]);

    expect(await loadFleetSettings(SITE, { db: mockFirestore(docs) })).toEqual({ enabled: true, senders: {} });
    expect(await loadFleetSettings(SITE)).toEqual(DEFAULTS);
  });
});
