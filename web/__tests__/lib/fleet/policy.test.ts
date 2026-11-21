/** @jest-environment node */

/**
 * the fleet grant loader. the reading itself is pinned in `grant.test.ts`; the
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

import * as grant from '@/lib/fleet/grant';
import * as policy from '@/lib/fleet/policy.server';
import { FLEET_SETTINGS_DOC, loadFleetSettings } from '@/lib/fleet/policy.server';

const SITE = 'site-a';
const SETTINGS_PATH = `sites/${SITE}/settings/fleet`;
const DEFAULTS = { enabled: false, senders: {} };

beforeEach(() => {
  mockAdminDocs.clear();
  mockReads.length = 0;
});

describe('policy.server re-exports', () => {
  it('hands server callers the one reading in grant.ts, not a copy', () => {
    for (const name of [
      'MAX_FLEET_SENDERS',
      'fleetGrantFor',
      'grantCovers',
      'parseFleetSettings',
      'storedFleetGrant',
    ] as const) {
      expect(policy[name]).toBe(grant[name]);
    }
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
