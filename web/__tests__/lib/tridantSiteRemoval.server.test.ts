/** @jest-environment node */

/**
 * tridantSiteRemoval.server — a deleted site removed from tridant id at once or
 * recorded for the daily job, and that job's sweep of the records.
 */

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockStore = new Map<string, Record<string, unknown>>();
let mockWritesFail = false;

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => {
      const doc = (id: string) => {
        const key = `${name}/${id}`;
        return {
          set: async (data: Record<string, unknown>) => {
            if (mockWritesFail) throw new Error('firestore down');
            mockStore.set(key, structuredClone(data));
          },
          update: async (patch: Record<string, unknown>) => {
            mockStore.set(key, { ...mockStore.get(key), ...patch });
          },
          delete: async () => {
            mockStore.delete(key);
          },
        };
      };
      return {
        doc,
        get: async () => ({
          docs: [...mockStore]
            .filter(([key]) => key.startsWith(`${name}/`))
            .map(([key, data]) => {
              const id = key.slice(name.length + 1);
              return { id, data: () => data, ref: doc(id) };
            }),
        }),
      };
    },
  }),
}));

const mockConfigured = jest.fn();
jest.mock('@/lib/plan.server', () => ({ tridantConfigured: () => mockConfigured() }));

const mockRemoveSite = jest.fn();
const mockStopSite = jest.fn();
jest.mock('@/lib/tridantBilling.server', () => ({
  removeSite: (...args: unknown[]) => mockRemoveSite(...args),
  stopSite: (...args: unknown[]) => mockStopSite(...args),
}));

const mockGetSiteEntitlements = jest.fn();
const mockInvalidateSiteEntitlements = jest.fn();
jest.mock('@/lib/tridantEntitlements.server', () => ({
  getSiteEntitlements: (...args: unknown[]) => mockGetSiteEntitlements(...args),
  invalidateSiteEntitlements: (...args: unknown[]) => mockInvalidateSiteEntitlements(...args),
}));

import logger from '@/lib/logger';
import { removeTridantSite, sweepSiteRemovals } from '@/lib/tridantSiteRemoval.server';

const NOW = Date.UTC(2026, 10, 20);
const DAY_MS = 24 * 60 * 60 * 1000;
const REMOVED = { ok: true, removed: true };
const RUNNING = { ok: false, reason: 'rejected', status: 409, code: 'site_running' };
const NOT_FOUND = { ok: false, reason: 'rejected', status: 404, code: 'site_not_found' };

const billing = (endsAt: number | null) => ({
  ok: true,
  billing: { periodStart: NOW - DAY_MS, periodEnd: NOW + DAY_MS, endsAt, cancelAtPeriodEnd: endsAt !== null },
});

function seedRecord(siteId: string, requestedAt: number, attempts = 0): void {
  mockStore.set(`tridant_site_removals/${siteId}`, { siteId, requestedAt, attempts, lastCode: 'site_running' });
}

const record = (siteId: string) => mockStore.get(`tridant_site_removals/${siteId}`);
const nowSpy = jest.spyOn(Date, 'now');

beforeEach(() => {
  mockStore.clear();
  mockWritesFail = false;
  nowSpy.mockReturnValue(NOW);
  mockConfigured.mockReturnValue(true);
  mockRemoveSite.mockResolvedValue(REMOVED);
  mockGetSiteEntitlements.mockResolvedValue({ ok: true, billing: null });
});

afterAll(() => nowSpy.mockRestore());

describe('removeTridantSite', () => {
  it('does nothing when tridant id is not configured', async () => {
    mockConfigured.mockReturnValue(false);

    await removeTridantSite('site-a');

    expect(mockRemoveSite).not.toHaveBeenCalled();
    expect(mockStore.size).toBe(0);
  });

  it('records nothing once tridant has removed the site', async () => {
    await removeTridantSite('site-a');

    expect(mockRemoveSite).toHaveBeenCalledWith('site-a');
    expect(mockStore.size).toBe(0);
  });

  it('takes a site tridant does not know as removed', async () => {
    mockRemoveSite.mockResolvedValue(NOT_FOUND);

    await removeTridantSite('site-a');

    expect(mockStore.size).toBe(0);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each([
    ['still runs', RUNNING, 'site_running'],
    ['cannot be reached', { ok: false, reason: 'unreachable', status: 503 }, 'unreachable'],
    ['answers in an unexpected shape', { ok: false, reason: 'malformed_response', status: 200 }, 'malformed_response'],
  ])('records the site for the daily job when tridant %s', async (_when, answer, lastCode) => {
    mockRemoveSite.mockResolvedValue(answer);

    await removeTridantSite('site-a');

    expect(record('site-a')).toEqual({ siteId: 'site-a', requestedAt: NOW, attempts: 0, lastCode });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs any other refusal and records nothing', async () => {
    mockRemoveSite.mockResolvedValue({ ok: false, reason: 'rejected', status: 409, code: 'site_is_default' });

    await removeTridantSite('site-a');

    expect(mockStore.size).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(
      '[plan] deleted site not removed from tridant id',
      expect.objectContaining({ data: { siteId: 'site-a', reason: 'rejected', status: 409, code: 'site_is_default' } }),
    );
  });

  it('never throws when the record cannot be written', async () => {
    mockRemoveSite.mockResolvedValue(RUNNING);
    mockWritesFail = true;

    await expect(removeTridantSite('site-a')).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith('[plan] site removal not recorded', expect.anything());
  });
});

describe('sweepSiteRemovals', () => {
  it('deletes the record of each site tridant has removed or no longer knows', async () => {
    seedRecord('site-a', NOW - DAY_MS);
    seedRecord('site-b', NOW - DAY_MS);
    mockRemoveSite.mockImplementation(async (siteId: string) => (siteId === 'site-a' ? REMOVED : NOT_FOUND));

    const counts = await sweepSiteRemovals(NOW);

    expect(counts).toEqual({ removed: 2, pending: 0, dropped: 0, errors: 0 });
    expect(mockStore.size).toBe(0);
  });

  it('stops again, without a payer, a billing that still runs with no end, and keeps the record', async () => {
    seedRecord('site-a', NOW - DAY_MS, 2);
    mockRemoveSite.mockResolvedValue(RUNNING);
    mockGetSiteEntitlements.mockResolvedValue(billing(null));
    mockStopSite.mockResolvedValue({ ok: true, endsAt: NOW + DAY_MS });

    const counts = await sweepSiteRemovals(NOW);

    expect(counts).toEqual({ removed: 0, pending: 1, dropped: 0, errors: 0 });
    expect(mockInvalidateSiteEntitlements).toHaveBeenCalledWith('site-a');
    expect(mockInvalidateSiteEntitlements.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetSiteEntitlements.mock.invocationCallOrder[0],
    );
    expect(mockStopSite).toHaveBeenCalledWith('site-a');
    expect(logger.warn).toHaveBeenCalledWith(
      '[plan] billing still ran for a deleted site, stopped again',
      expect.objectContaining({ data: { siteId: 'site-a', stopped: true } }),
    );
    expect(record('site-a')).toEqual({ siteId: 'site-a', requestedAt: NOW - DAY_MS, attempts: 3, lastCode: 'site_running' });
  });

  it('leaves a stopped billing to run to its end', async () => {
    seedRecord('site-a', NOW - DAY_MS);
    mockRemoveSite.mockResolvedValue(RUNNING);
    mockGetSiteEntitlements.mockResolvedValue(billing(NOW + DAY_MS));

    await sweepSiteRemovals(NOW);

    expect(mockStopSite).not.toHaveBeenCalled();
    expect(record('site-a')).toMatchObject({ attempts: 1 });
  });

  it('drops a record older than 45 days with an error log', async () => {
    seedRecord('site-a', NOW - 46 * DAY_MS, 45);
    seedRecord('site-b', NOW - 44 * DAY_MS);
    mockRemoveSite.mockResolvedValue(RUNNING);

    const counts = await sweepSiteRemovals(NOW);

    expect(counts).toEqual({ removed: 0, pending: 1, dropped: 1, errors: 0 });
    expect(record('site-a')).toBeUndefined();
    expect(record('site-b')).toMatchObject({ attempts: 1 });
    expect(logger.error).toHaveBeenCalledWith(
      '[plan] deleted site still not removed from tridant id after 45 days, record dropped',
      expect.objectContaining({ data: { siteId: 'site-a', attempts: 46, lastCode: 'site_running' } }),
    );
  });

  it('counts any other refusal as an error and keeps the record', async () => {
    seedRecord('site-a', NOW - DAY_MS);
    mockRemoveSite.mockResolvedValue({ ok: false, reason: 'rejected', status: 403, code: 'scope_insufficient' });

    const counts = await sweepSiteRemovals(NOW);

    expect(counts).toEqual({ removed: 0, pending: 0, dropped: 0, errors: 1 });
    expect(record('site-a')).toMatchObject({ attempts: 1, lastCode: 'scope_insufficient' });
    expect(logger.error).toHaveBeenCalledWith('[plan] deleted site not removed from tridant id', expect.anything());
  });

  it("goes on past one record's failure", async () => {
    seedRecord('site-a', NOW - DAY_MS);
    seedRecord('site-b', NOW - DAY_MS);
    mockRemoveSite.mockImplementation(async (siteId: string) => {
      if (siteId === 'site-a') throw new Error('boom');
      return REMOVED;
    });

    const counts = await sweepSiteRemovals(NOW);

    expect(counts).toEqual({ removed: 1, pending: 0, dropped: 0, errors: 1 });
    expect(record('site-a')).toBeDefined();
    expect(record('site-b')).toBeUndefined();
  });

  it('keeps every record while tridant id is not configured', async () => {
    seedRecord('site-a', NOW - 46 * DAY_MS);
    mockConfigured.mockReturnValue(false);

    const counts = await sweepSiteRemovals(NOW);

    expect(counts).toEqual({ removed: 0, pending: 0, dropped: 0, errors: 0 });
    expect(mockRemoveSite).not.toHaveBeenCalled();
    expect(record('site-a')).toBeDefined();
  });
});
