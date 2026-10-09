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

const mockGetEntitlements = jest.fn();
jest.mock('@/lib/tridantEntitlements.server', () => ({
  getEntitlements: (uid: string) => mockGetEntitlements(uid),
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

const FLAGS = { control: 'owlette.control', webhooks: 'owlette.webhooks', talons: 'owlette.talons' } as const;

const FREE = {
  ok: true,
  resolved: false,
  standing: 'expired',
  inGoodStanding: false,
  ent: {
    'owlette.machines': '1',
    'owlette.sites': '1',
    'owlette.control': '0',
    'owlette.roost': '0',
    'owlette.talons': '0',
    'owlette.webhooks': '0',
    'owlette.api_keys': '0',
  },
  epoch: 0,
};

const PRO = {
  ...FREE,
  resolved: true,
  standing: 'active',
  inGoodStanding: true,
  ent: {
    'owlette.machines': 'unlimited',
    'owlette.sites': 'unlimited',
    'owlette.control': '1',
    'owlette.roost': '1',
    'owlette.talons': '1',
    'owlette.webhooks': '1',
    'owlette.api_keys': '1',
  },
};

function expectNoReads() {
  expect(mockCollection).not.toHaveBeenCalled();
  expect(mockGetEntitlements).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetForTests();
  mockSites = { a: { owner: 'payer' }, b: { owner: 'payer' }, orphan: {} };
  mockUsers = { payer: { role: 'user' }, root: { role: 'superadmin' } };
  mockGetEntitlements.mockResolvedValue(FREE);
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

  it.each(Object.values(FLAGS))('pauses a free payer (%s)', async (key) => {
    expect(await pausedByPlan('a', key)).toBe(true);
    expect(mockGetEntitlements).toHaveBeenCalledWith('payer');
  });

  it.each(Object.values(FLAGS))('proceeds for a pro payer (%s)', async (key) => {
    mockGetEntitlements.mockResolvedValue(PRO);
    expect(await pausedByPlan('a', key)).toBe(false);
  });

  it('pauses on the one key a plan lacks, and only that one', async () => {
    mockGetEntitlements.mockResolvedValue({ ...PRO, ent: { ...PRO.ent, 'owlette.webhooks': '0' } });

    expect(await pausedByPlan('a', 'owlette.webhooks')).toBe(true);
    expect(await pausedByPlan('a', 'owlette.control')).toBe(false);
    expect(await pausedByPlan('a', 'owlette.talons')).toBe(false);
  });

  it('proceeds for a site with no owner, and for a superadmin payer', async () => {
    expect(await pausedByPlan('orphan', 'owlette.control')).toBe(false);
    expect(mockGetEntitlements).not.toHaveBeenCalled();

    mockSites.a = { owner: 'root' };
    expect(await pausedByPlan('a', 'owlette.control')).toBe(false);
  });

  it('proceeds when tridant fails open', async () => {
    mockGetEntitlements.mockResolvedValue({ ok: false, reason: 'unreachable' });
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
    expect(await pausedByPlan('a', 'owlette.control', undefined, { owner: 'payer' })).toBe(true);
    expect(mockSiteGet).not.toHaveBeenCalled();

    // a missing site is null, not undefined, so it still skips the read.
    expect(await pausedByPlan('gone', 'owlette.control', undefined, null)).toBe(false);
    expect(mockSiteGet).not.toHaveBeenCalled();
  });

  it('resolves each site and each payer once across a batch, concurrent calls included', async () => {
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
    expect(mockUserGet).toHaveBeenCalledTimes(1);
    expect(mockGetEntitlements).toHaveBeenCalledTimes(1);
  });

  it('resolves again without a memo, and in a fresh batch', async () => {
    await pausedByPlan('a', 'owlette.control');
    await pausedByPlan('a', 'owlette.control');
    await pausedByPlan('a', 'owlette.control', createPlanMemo());

    expect(mockSiteGet).toHaveBeenCalledTimes(3);
    expect(mockGetEntitlements).toHaveBeenCalledTimes(3);
  });
});
