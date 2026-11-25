/**
 * @jest-environment node
 */

/**
 * pausedByPlan — the runtime pauses behind alert recipients, webhook delivery
 * and talon matching. runs the real resolver over a fake firestore and a mocked
 * tridant answer, so "no reads while off" is asserted on the reads themselves.
 */

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGetSiteEntitlements = jest.fn();
jest.mock('@/lib/tridantEntitlements.server', () => ({
  getSiteEntitlements: (siteId: string) => mockGetSiteEntitlements(siteId),
}));

let mockSites: Record<string, Record<string, unknown>> = {};
let mockUsers: Record<string, Record<string, unknown>> = {};
const mockSiteGet = jest.fn(async (siteId: string) => ({ data: () => mockSites[siteId] }));
const mockUserGet = jest.fn(async (uid: string) => ({ data: () => mockUsers[uid] }));
const mockCollection = jest.fn((name: string) => {
  if (name === 'sites') return { doc: (id: string) => ({ get: () => mockSiteGet(id) }) };
  if (name === 'users') return { doc: (id: string) => ({ get: () => mockUserGet(id) }) };
  throw new Error(`unexpected collection ${name}`);
});
jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({ collection: mockCollection }),
}));

import logger from '@/lib/logger';
import { __resetForTests } from '@/lib/plan.server';
import { createPlanMemo, pausedByPlan } from '@/lib/planPause.server';
import { FREE_ENTITLEMENTS as FREE, PRO_ENTITLEMENTS as PRO } from '../api/helpers/planEnforcement';

const FLAGS = { control: 'owlette.control', webhooks: 'owlette.webhooks', talons: 'owlette.talons' } as const;

function expectNoReads() {
  expect(mockCollection).not.toHaveBeenCalled();
  expect(mockGetSiteEntitlements).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetForTests();
  mockSites = { a: { owner: 'owner' }, b: { owner: 'owner' }, orphan: {} };
  mockUsers = { owner: { role: 'user' }, root: { role: 'superadmin' } };
  mockGetSiteEntitlements.mockResolvedValue(FREE);
  process.env.PLAN_ENFORCEMENT = 'on';
  process.env.OWLETTE_E2E = '1';
});

afterAll(() => {
  delete process.env.PLAN_ENFORCEMENT;
  delete process.env.OWLETTE_E2E;
});

describe('pausedByPlan', () => {
  it.each(Object.values(FLAGS))('proceeds without a read when enforcement is off (%s)', async (key) => {
    delete process.env.PLAN_ENFORCEMENT;

    expect(await pausedByPlan('a', key)).toBe(false);
    expectNoReads();
  });

  it('proceeds without a read when tridant id is not configured', async () => {
    delete process.env.OWLETTE_E2E;
    delete process.env.TRIDANT_API_URL;

    expect(await pausedByPlan('a', 'owlette.control')).toBe(false);
    expectNoReads();
  });

  it.each(Object.values(FLAGS))('pauses a free site (%s)', async (key) => {
    expect(await pausedByPlan('a', key)).toBe(true);
    expect(mockGetSiteEntitlements).toHaveBeenCalledWith('a');
  });

  it.each(Object.values(FLAGS))('proceeds for a pro site (%s)', async (key) => {
    mockGetSiteEntitlements.mockResolvedValue(PRO);
    expect(await pausedByPlan('a', key)).toBe(false);
  });

  it('decides each site by its own plan, whoever owns both', async () => {
    mockGetSiteEntitlements.mockImplementation(async (siteId: string) => (siteId === 'b' ? PRO : FREE));

    expect(await pausedByPlan('a', 'owlette.control')).toBe(true);
    expect(await pausedByPlan('b', 'owlette.control')).toBe(false);
  });

  it('pauses on the one key a plan lacks, and only that one', async () => {
    mockGetSiteEntitlements.mockResolvedValue({ ...PRO, ent: { ...PRO.ent, 'owlette.webhooks': '0' } });

    expect(await pausedByPlan('a', 'owlette.webhooks')).toBe(true);
    expect(await pausedByPlan('a', 'owlette.control')).toBe(false);
    expect(await pausedByPlan('a', 'owlette.talons')).toBe(false);
  });

  it('proceeds for a site with no owner, and for a superadmin owner', async () => {
    expect(await pausedByPlan('orphan', 'owlette.control')).toBe(false);
    expect(mockGetSiteEntitlements).not.toHaveBeenCalled();

    mockSites.a = { owner: 'root' };
    expect(await pausedByPlan('a', 'owlette.control')).toBe(false);
  });

  it('proceeds when tridant fails open', async () => {
    mockGetSiteEntitlements.mockResolvedValue({ ok: false, reason: 'unreachable' });
    expect(await pausedByPlan('a', 'owlette.control')).toBe(false);
  });

  it('proceeds, logs and never throws when a read fails', async () => {
    mockSiteGet.mockRejectedValueOnce(new Error('firestore unavailable'));

    await expect(pausedByPlan('a', 'owlette.control')).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      '[plan] plan lookup failed; proceeding',
      expect.objectContaining({ data: expect.objectContaining({ siteId: 'a', key: 'owlette.control' }) }),
    );
  });

  it('uses site data the caller already read instead of reading the site', async () => {
    expect(await pausedByPlan('a', 'owlette.control', undefined, { owner: 'owner' })).toBe(true);
    expect(mockSiteGet).not.toHaveBeenCalled();

    // a missing site is null, not undefined, so it still skips the read.
    expect(await pausedByPlan('gone', 'owlette.control', undefined, null)).toBe(false);
    expect(mockSiteGet).not.toHaveBeenCalled();
  });

  it('resolves each site once across a batch, concurrent calls included', async () => {
    const memo = createPlanMemo();

    const answers = await Promise.all([
      pausedByPlan('a', 'owlette.control', memo),
      pausedByPlan('a', 'owlette.webhooks', memo),
      pausedByPlan('a', 'owlette.talons', memo),
      pausedByPlan('b', 'owlette.webhooks', memo),
    ]);
    await pausedByPlan('b', 'owlette.talons', memo);

    expect(answers).toEqual([true, true, true, true]);
    expect(mockSiteGet.mock.calls.map(([siteId]) => siteId)).toEqual(['a', 'b']);
    expect(mockGetSiteEntitlements.mock.calls.map(([siteId]) => siteId)).toEqual(['a', 'b']);
  });

  it('resolves again without a memo, and in a fresh batch', async () => {
    await pausedByPlan('a', 'owlette.control');
    await pausedByPlan('a', 'owlette.control');
    await pausedByPlan('a', 'owlette.control', createPlanMemo());

    expect(mockSiteGet).toHaveBeenCalledTimes(3);
    expect(mockGetSiteEntitlements).toHaveBeenCalledTimes(3);
  });
});
