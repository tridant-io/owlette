/** @jest-environment node */

/**
 * `recordPairing` (web/lib/pairingPlan.server.ts): every pairing stamps `pairedAt`
 * once, and a machine whose doc did not exist leaves every machine scope on its
 * site. machine ids start as hostnames and get reused, and the desktop app's own
 * leave-site deletes the doc without reaching `removeMachine`, so a machine that
 * pairs anew must start with no member's grant. one still on the site keeps them.
 */

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' },
}));

const mockPrune = jest.fn(async (..._a: unknown[]) => 0);
jest.mock('@/lib/membership.server', () => ({
  pruneMachineFromMembers: (...a: unknown[]) => mockPrune(...a),
}));

type Doc = Record<string, unknown>;
// the fake store, keyed by document path
let mockDocs: Record<string, Doc> = {};
const mockTxSet = jest.fn();
const mockRunTransaction = jest.fn();

function mockRef(path: string): Record<string, unknown> {
  return {
    path,
    collection: (sub: string) => ({ doc: (id: string) => mockRef(`${path}/${sub}/${id}`) }),
  };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => ({ doc: (id: string) => mockRef(`${name}/${id}`) }),
    runTransaction: (fn: (tx: unknown) => Promise<unknown>) => mockRunTransaction(fn),
  }),
}));

import logger from '@/lib/logger';
import { recordPairing } from '@/lib/pairingPlan.server';

const MACHINE = 'sites/site-1/machines/kiosk-01';

beforeEach(() => {
  mockDocs = {};
  mockRunTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      get: async (ref: { path: string }) => {
        const data = mockDocs[ref.path];
        return { exists: data !== undefined, data: () => data };
      },
      set: (ref: { path: string }, data: Doc, options?: unknown) => mockTxSet(ref.path, data, options),
    }),
  );
});

describe('recordPairing', () => {
  it('stamps pairedAt on a machine doc that did not exist, and prunes its id from every scope once', async () => {
    await recordPairing('site-1', 'kiosk-01');

    expect(mockTxSet).toHaveBeenCalledWith(MACHINE, { pairedAt: 'SERVER_TIMESTAMP' }, { merge: true });
    expect(mockPrune).toHaveBeenCalledTimes(1);
    expect(mockPrune).toHaveBeenCalledWith({ siteId: 'site-1', machineId: 'kiosk-01' });
  });

  it('keeps the grants and the first pairedAt of a machine still on the site', async () => {
    mockDocs[MACHINE] = { pairedAt: 'FIRST' };

    await recordPairing('site-1', 'kiosk-01');

    expect(mockTxSet).not.toHaveBeenCalled();
    expect(mockPrune).not.toHaveBeenCalled();
  });

  it('stamps a legacy machine doc with no pairedAt, and keeps its grants', async () => {
    mockDocs[MACHINE] = { online: true };

    await recordPairing('site-1', 'kiosk-01');

    expect(mockTxSet).toHaveBeenCalledWith(MACHINE, { pairedAt: 'SERVER_TIMESTAMP' }, { merge: true });
    expect(mockPrune).not.toHaveBeenCalled();
  });

  it('logs a failed prune and still resolves, with pairedAt stamped', async () => {
    mockPrune.mockRejectedValueOnce(new Error('members query down'));

    await expect(recordPairing('site-1', 'kiosk-01')).resolves.toBeUndefined();

    expect(mockTxSet).toHaveBeenCalledWith(MACHINE, { pairedAt: 'SERVER_TIMESTAMP' }, { merge: true });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('machine scopes not pruned'),
      expect.objectContaining({ context: 'pairing', data: { error: 'members query down' } }),
    );
  });

  it('prunes nothing when the machine doc could not be read, which proves nothing', async () => {
    mockRunTransaction.mockRejectedValueOnce(new Error('contention'));

    await expect(recordPairing('site-1', 'kiosk-01')).resolves.toBeUndefined();

    expect(mockPrune).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('pairedAt not stamped'),
      expect.objectContaining({ context: 'pairing' }),
    );
  });

  it('returns early for a machine id with a slash, touching no doc and no scope', async () => {
    await recordPairing('site-1', 'pc/commands/pending');

    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(mockTxSet).not.toHaveBeenCalled();
    expect(mockPrune).not.toHaveBeenCalled();
  });
});
