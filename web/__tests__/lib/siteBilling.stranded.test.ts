/**
 * @jest-environment node
 */

// the daily job's repairs: stopStrandedBilling, for a billed site whose payer no longer owns it,
// adoptBilling, for a billed site whose checkout return never wrote a pointer, and closeEndedBilling,
// for a pointer that still says billed once tridant id bills nothing. and the stop before a delete.

jest.mock('server-only', () => ({}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__SERVER_TS__' },
}));

const mockUpdate = jest.fn();
jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: jest.fn(),
  getAdminDb: () => ({
    collection: () => ({ doc: (id: string) => ({ update: (data: unknown) => mockUpdate(id, data) }) }),
  }),
}));

jest.mock('@/lib/plan.server', () => ({
  plansEnforced: () => true,
  planTier: (plan: { ent: Record<string, string> }) => (plan.ent['owlette.deployments'] === '1' ? 'pro' : 'core'),
}));

const mockGetPlanAccount = jest.fn();
jest.mock('@/lib/planAccounts.server', () => ({
  getPlanAccount: (uid: string) => mockGetPlanAccount(uid),
}));
jest.mock('@/lib/resendClient.server', () => ({ trustedBaseUrl: () => 'https://dev.owlette.app' }));

const mockInvalidate = jest.fn();
const mockGetSiteEntitlements = jest.fn();
jest.mock('@/lib/tridantEntitlements.server', () => ({
  invalidateSiteEntitlements: (siteId: string) => mockInvalidate(siteId),
  getSiteEntitlements: (siteId: string) => mockGetSiteEntitlements(siteId),
}));

const mockStopSite = jest.fn();
jest.mock('@/lib/tridantBilling.server', () => ({
  PRODUCT: { core: 'prd_owlette_core', pro: 'prd_owlette_pro' },
  stopSite: (...args: unknown[]) => mockStopSite(...args),
}));

import logger from '@/lib/logger';
import type { Plan } from '@/lib/plan.server';
import {
  adoptBilling,
  closeEndedBilling,
  stopBillingBeforeDelete,
  stopStrandedBilling,
} from '@/lib/siteBilling.server';

const pointer = (payerUid: string, endsAt: number | null = null) => ({ tier: 'pro', founders: true, payerUid, endsAt });

type Billing = Extract<Plan, { enforced: true }>['billing'];

const BILLED = {
  periodStart: 1,
  periodEnd: 2,
  endsAt: null,
  cancelAtPeriodEnd: false,
  productId: 'prd_owlette_pro',
  founders: false,
};

const planWith = (billing: Billing, inGoodStanding = false): Plan => ({
  enforced: true,
  resolved: true,
  standing: inGoodStanding ? 'active' : 'expired',
  inGoodStanding,
  ent: {},
  orgId: 'org_1',
  billing,
  trialEndsAt: null,
});

/** tridant's site answer: the site under `orgId`, billed as `billing`. */
const answer = (billing: Billing, orgId = 'org_1') => ({ ok: true, ...planWith(billing), orgId, graceUntil: null, epoch: 1 });

const MISMATCH = { ok: false, reason: 'rejected', status: 409, code: 'payer_mismatch' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('stopStrandedBilling', () => {
  it('leaves a site its owner pays for alone', async () => {
    await stopStrandedBilling('site-1', { owner: 'alice', billing: pointer('alice') });
    expect(mockStopSite).not.toHaveBeenCalled();
  });

  it('leaves an unbilled site and an already stopped one alone', async () => {
    await stopStrandedBilling('site-1', { owner: 'alice' });
    await stopStrandedBilling('site-1', { owner: 'bob', billing: pointer('alice', 1_800_000_000_000) });
    expect(mockStopSite).not.toHaveBeenCalled();
  });

  it('stops a site still billed to an owner it no longer has, naming that payer, and records the end', async () => {
    mockStopSite.mockResolvedValue({ ok: true, endsAt: 1_800_000_000_000 });

    await stopStrandedBilling('site-1', { owner: 'bob', billing: pointer('alice') });

    expect(mockStopSite.mock.calls).toEqual([['site-1', 'alice']]);
    expect(mockInvalidate).toHaveBeenCalledWith('site-1');
    expect(mockUpdate).toHaveBeenCalledWith('site-1', {
      billing: { ...pointer('alice', 1_800_000_000_000), updatedAt: '__SERVER_TS__' },
    });
    expect(mockGetSiteEntitlements).not.toHaveBeenCalled();
  });

  describe('when tridant id says the recorded payer does not pay for the site', () => {
    const site = { owner: 'bob', billing: pointer('alice') };

    beforeEach(() => {
      mockStopSite.mockReset();
      mockGetSiteEntitlements.mockReset();
      mockGetPlanAccount.mockReset().mockResolvedValue({ orgId: 'org_bob' });
    });

    // the new owner upgraded once the old billing had ended, and the checkout return never loaded.
    it('writes the pointer for the owner when tridant bills the site under their organization', async () => {
      mockStopSite.mockResolvedValueOnce(MISMATCH);
      mockGetSiteEntitlements.mockResolvedValue(
        answer({ ...BILLED, productId: 'prd_owlette_core', founders: true, endsAt: 1_800_000_000_000 }, 'org_bob'),
      );

      await stopStrandedBilling('site-1', site);

      expect(mockStopSite.mock.calls).toEqual([['site-1', 'alice']]);
      expect(mockInvalidate).toHaveBeenCalledWith('site-1');
      expect(mockGetSiteEntitlements).toHaveBeenCalledWith('site-1');
      expect(mockInvalidate.mock.invocationCallOrder[0]).toBeLessThan(
        mockGetSiteEntitlements.mock.invocationCallOrder[0],
      );
      expect(mockGetPlanAccount).toHaveBeenCalledWith('bob');
      expect(mockUpdate.mock.calls).toEqual([
        [
          'site-1',
          {
            billing: {
              tier: 'core',
              founders: true,
              payerUid: 'bob',
              endsAt: 1_800_000_000_000,
              updatedAt: '__SERVER_TS__',
            },
          },
        ],
      ]);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("keeps the pointer's tier and rate when the answer names no product", async () => {
      mockStopSite.mockResolvedValueOnce(MISMATCH);
      mockGetSiteEntitlements.mockResolvedValue(answer({ ...BILLED, productId: null }, 'org_bob'));

      await stopStrandedBilling('site-1', site);

      expect(mockUpdate).toHaveBeenCalledWith('site-1', {
        billing: { tier: 'pro', founders: true, payerUid: 'bob', endsAt: null, updatedAt: '__SERVER_TS__' },
      });
    });

    it.each([
      ['bills it under another organization', answer(BILLED, 'org_other'), { orgId: 'org_bob' }],
      ['bills it, and the owner has no organization', answer(BILLED, 'org_bob'), { orgId: null }],
      ['bills it, and the owner has no plan account', answer(BILLED, 'org_bob'), null],
    ])('stops it without a payer when tridant %s, and warns', async (_case, read, account) => {
      mockStopSite.mockResolvedValueOnce(MISMATCH).mockResolvedValueOnce({ ok: true, endsAt: 1_800_000_000_000 });
      mockGetSiteEntitlements.mockResolvedValue(read);
      mockGetPlanAccount.mockResolvedValue(account);

      await stopStrandedBilling('site-1', site);

      expect(mockStopSite.mock.calls).toEqual([['site-1', 'alice'], ['site-1']]);
      expect(mockUpdate).toHaveBeenCalledWith('site-1', {
        billing: { ...pointer('alice', 1_800_000_000_000), updatedAt: '__SERVER_TS__' },
      });
      // the site and tridant's code, nothing of the payer.
      expect(logger.warn).toHaveBeenCalledWith('[billing] stranded billing stopped without its payer', {
        context: 'billing',
        data: { siteId: 'site-1', code: 'payer_mismatch' },
      });
    });

    it('closes the record, with no second stop, when tridant bills nothing for the site', async () => {
      mockStopSite.mockResolvedValueOnce(MISMATCH);
      mockGetSiteEntitlements.mockResolvedValue(answer(null, 'org_bob'));

      await stopStrandedBilling('site-1', site);

      expect(mockStopSite.mock.calls).toEqual([['site-1', 'alice']]);
      expect(mockUpdate).toHaveBeenCalledWith('site-1', {
        billing: expect.objectContaining({ payerUid: 'alice', endsAt: expect.any(Number) }),
      });
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('logs a stop without a payer that does not land, and leaves the pointer for the next run', async () => {
      mockStopSite.mockResolvedValueOnce(MISMATCH).mockResolvedValueOnce({ ok: false, reason: 'unreachable' });
      mockGetSiteEntitlements.mockResolvedValue(answer(BILLED, 'org_other'));

      await stopStrandedBilling('site-1', site);

      expect(mockUpdate).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith('[billing] stranded billing not stopped', expect.anything());
    });

    // unread, the owner's own billing cannot be told from another organization's.
    it('stops nothing more when the site answer cannot be read, and leaves it for the next run', async () => {
      mockStopSite.mockResolvedValueOnce(MISMATCH);
      mockGetSiteEntitlements.mockResolvedValue({ ok: false, reason: 'unreachable' });

      await stopStrandedBilling('site-1', site);

      expect(mockStopSite).toHaveBeenCalledTimes(1);
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        '[billing] stranded billing not stopped',
        expect.objectContaining({ data: { siteId: 'site-1', reason: 'unreachable', code: 'payer_mismatch' } }),
      );
    });
  });

  it('closes a stale pointer when tridant id bills nothing for the site', async () => {
    mockStopSite.mockResolvedValue({ ok: false, reason: 'rejected', status: 404, code: 'site_not_billed' });

    await stopStrandedBilling('site-1', { owner: 'bob', billing: pointer('alice') });

    expect(mockUpdate).toHaveBeenCalledWith('site-1', {
      billing: expect.objectContaining({ payerUid: 'alice', endsAt: expect.any(Number) }),
    });
  });

  it('logs and leaves the pointer for the next run when the stop does not land', async () => {
    mockStopSite.mockResolvedValue({ ok: false, reason: 'unreachable' });

    await stopStrandedBilling('site-1', { owner: 'bob', billing: pointer('alice') });

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('[billing] stranded billing not stopped', expect.anything());
  });

  it('never throws', async () => {
    mockStopSite.mockRejectedValue(new Error('boom'));
    await expect(stopStrandedBilling('site-1', { owner: 'bob', billing: pointer('alice') })).resolves.toBeUndefined();
  });
});

describe('adoptBilling', () => {
  const billedPlan = (orgId: string, deployments = '1', billing: Partial<typeof BILLED> = {}): Plan => ({
    enforced: true,
    resolved: true,
    standing: 'active',
    inGoodStanding: true,
    ent: { 'owlette.control': '1', 'owlette.deployments': deployments },
    orgId,
    billing: { ...BILLED, ...billing },
    trialEndsAt: null,
  });

  beforeEach(() => {
    mockGetPlanAccount.mockResolvedValue({ orgId: 'org_1' });
  });

  it('writes the pointer for a site billed under its owner\'s organization that has none', async () => {
    await adoptBilling('site-1', { owner: 'alice' }, billedPlan('org_1'));

    expect(mockUpdate).toHaveBeenCalledWith('site-1', {
      billing: { tier: 'pro', founders: false, payerUid: 'alice', endsAt: null, updatedAt: '__SERVER_TS__' },
    });
  });

  it('takes the tier and the rate from the product tridant bills, whatever the flags say', async () => {
    await adoptBilling('site-1', { owner: 'alice' }, billedPlan('org_1', '1', { productId: 'prd_owlette_core', founders: true }));

    expect(mockUpdate).toHaveBeenCalledWith('site-1', {
      billing: { tier: 'core', founders: true, payerUid: 'alice', endsAt: null, updatedAt: '__SERVER_TS__' },
    });
  });

  it('reads the plan from its flags, as core without deployments, when the answer names no product', async () => {
    await adoptBilling('site-1', { owner: 'alice' }, billedPlan('org_1', '0', { productId: null }));

    expect(mockUpdate).toHaveBeenCalledWith('site-1', { billing: expect.objectContaining({ tier: 'core', founders: false }) });
  });

  it('leaves a site that has a pointer, is not billed, or is billed under another organization', async () => {
    await adoptBilling('site-1', { owner: 'alice', billing: pointer('alice') }, billedPlan('org_1'));
    await adoptBilling('site-1', { owner: 'alice' }, { ...billedPlan('org_1'), billing: null } as Plan);
    await adoptBilling('site-1', { owner: 'alice' }, billedPlan('org_other'));
    await adoptBilling('site-1', { owner: 'alice' }, { enforced: false, reason: 'unreachable' });

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    mockGetPlanAccount.mockRejectedValue(new Error('boom'));
    await expect(adoptBilling('site-1', { owner: 'alice' }, billedPlan('org_1'))).resolves.toBeUndefined();
  });
});

describe('closeEndedBilling', () => {
  // stripe cancelled the subscription after failed payments: tridant's answer has no billing block.
  it('ends now a pointer that says billed once tridant id bills nothing for the site', async () => {
    const before = Date.now();

    await closeEndedBilling('site-1', { owner: 'alice', billing: pointer('alice') }, planWith(null));

    expect(mockUpdate).toHaveBeenCalledWith('site-1', {
      billing: { ...pointer('alice'), endsAt: expect.any(Number), updatedAt: '__SERVER_TS__' },
    });
    expect(mockUpdate.mock.calls[0][1].billing.endsAt).toBeGreaterThanOrEqual(before);
    expect(mockInvalidate).toHaveBeenCalledWith('site-1');
  });

  it('brings forward a stop that has not reached its end', async () => {
    await closeEndedBilling('site-1', { billing: pointer('alice', Date.now() + 86_400_000) }, planWith(null));

    expect(mockUpdate.mock.calls[0][1].billing.endsAt).toBeLessThanOrEqual(Date.now());
  });

  it('leaves a pointer alone while tridant id bills the site, whatever its standing', async () => {
    await closeEndedBilling('site-1', { billing: pointer('alice') }, planWith(BILLED));
    await closeEndedBilling('site-1', { billing: pointer('alice') }, planWith(BILLED, true));

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('leaves an ended pointer, a site with none, and an unread plan alone', async () => {
    await closeEndedBilling('site-1', { billing: pointer('alice', Date.now() - 1000) }, planWith(null));
    await closeEndedBilling('site-1', { owner: 'alice' }, planWith(null));
    await closeEndedBilling('site-1', { billing: pointer('alice') }, { enforced: false, reason: 'unreachable' });

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    mockUpdate.mockRejectedValueOnce(new Error('site gone'));
    await expect(
      closeEndedBilling('site-1', { billing: pointer('alice') }, planWith(null)),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith('[billing] ended billing not closed', expect.anything());
  });
});

describe('stopBillingBeforeDelete', () => {
  // without a payer, so it lands whoever pays.
  it('stops a site owlette has a record of, without asking tridant first', async () => {
    mockStopSite.mockResolvedValue({ ok: true, endsAt: 2 });

    await stopBillingBeforeDelete('site-1', { billing: pointer('alice') });

    expect(mockStopSite.mock.calls).toEqual([['site-1']]);
    expect(mockGetSiteEntitlements).not.toHaveBeenCalled();
  });

  // a paid checkout whose return never loaded leaves the site billed with no record.
  it('stops a site with no record when tridant id says it bills it, asking afresh', async () => {
    mockGetSiteEntitlements.mockResolvedValue(answer(BILLED));
    mockStopSite.mockResolvedValue({ ok: true, endsAt: 2 });

    await stopBillingBeforeDelete('site-1', { owner: 'alice' });

    expect(mockInvalidate).toHaveBeenCalledWith('site-1');
    expect(mockStopSite).toHaveBeenCalledWith('site-1');
  });

  it('stops nothing when tridant id bills nothing, has already stopped it, or cannot be asked', async () => {
    mockGetSiteEntitlements.mockResolvedValueOnce(answer(null));
    mockGetSiteEntitlements.mockResolvedValueOnce(answer({ ...BILLED, endsAt: 2 }));
    mockGetSiteEntitlements.mockResolvedValueOnce({ ok: false, reason: 'unreachable' });

    for (let i = 0; i < 3; i += 1) await stopBillingBeforeDelete('site-1', { owner: 'alice' });

    expect(mockStopSite).not.toHaveBeenCalled();
  });

  it('logs a stop that did not land, and ignores one tridant id says was not needed', async () => {
    mockStopSite.mockResolvedValueOnce({ ok: false, reason: 'rejected', status: 404, code: 'site_not_billed' });
    await stopBillingBeforeDelete('site-1', { billing: pointer('alice') });
    expect(logger.error).not.toHaveBeenCalled();

    mockStopSite.mockResolvedValueOnce({ ok: false, reason: 'unreachable' });
    await stopBillingBeforeDelete('site-1', { billing: pointer('alice') });
    expect(logger.error).toHaveBeenCalledWith(
      '[plan] billing not stopped for a deleted site',
      expect.objectContaining({ data: expect.objectContaining({ siteId: 'site-1', reason: 'unreachable' }) }),
    );
  });
});
