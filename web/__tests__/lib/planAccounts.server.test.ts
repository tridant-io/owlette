/**
 * @jest-environment node
 */

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__SERVER_TS__' },
}));

type Doc = Record<string, unknown>;
let mockStore = new Map<string, Doc>();

function mockRef(path: string) {
  return {
    path,
    get: async () => ({ exists: mockStore.has(path), data: () => mockStore.get(path) }),
    set: async (data: Doc, options?: { merge?: boolean }) => {
      mockStore.set(path, { ...(options?.merge ? mockStore.get(path) ?? {} : {}), ...data });
    },
  };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => ({ doc: (id: string) => mockRef(`${name}/${id}`) }),
    runTransaction: async (fn: (t: unknown) => Promise<unknown>) =>
      fn({
        get: (ref: ReturnType<typeof mockRef>) => ref.get(),
        set: (ref: ReturnType<typeof mockRef>, data: Doc, options?: { merge?: boolean }) => ref.set(data, options),
      }),
  }),
}));

import {
  TRIAL_CLAIM_WINDOW_MS,
  claimTrialStart,
  clearLinkRequired,
  getCheckout,
  getPlanAccount,
  markLinkRequired,
  movedTrialEnd,
  recordCheckout,
  recordOrg,
  recordSubscribed,
  recordTrial,
  recordTrialEnd,
  recordTrialError,
  recordTrialUsed,
  type PlanAccount,
} from '@/lib/planAccounts.server';
import type { Plan } from '@/lib/plan.server';

beforeEach(() => {
  mockStore = new Map();
});

describe('plan_accounts', () => {
  it('reads null for an unknown account', async () => {
    expect(await getPlanAccount('u1')).toBeNull();
  });

  it('claims once, then refuses a claim younger than the window', async () => {
    expect(await claimTrialStart('u1', 1000)).toBe(true);
    expect(await claimTrialStart('u1', 1000 + TRIAL_CLAIM_WINDOW_MS - 1)).toBe(false);
    expect(await claimTrialStart('u1', 1000 + TRIAL_CLAIM_WINDOW_MS)).toBe(true);
  });

  it('refuses a claim once a trial is recorded, and stores its end as given', async () => {
    await recordTrial('u1', { orgId: 'org_1', endsAtMs: 5000 });
    expect(await claimTrialStart('u1', Date.now() + 10 * TRIAL_CLAIM_WINDOW_MS)).toBe(false);
    const account = await getPlanAccount('u1');
    expect(account).toMatchObject({ orgId: 'org_1', trialEndsAt: 5000, linkRequired: false, trialError: null });
    expect(account?.trialStartedAt).toEqual(expect.any(Number));
  });

  it('refuses a claim while a link is required, and allows it again once cleared', async () => {
    // the attempt that tridant refused with link_required left a fresh claim behind.
    expect(await claimTrialStart('u1', 1000)).toBe(true);
    await markLinkRequired('u1');
    expect(await claimTrialStart('u1', 1000)).toBe(false);
    expect((await getPlanAccount('u1'))?.linkRequired).toBe(true);
    await clearLinkRequired('u1');
    expect(await claimTrialStart('u1', 1000)).toBe(true);
  });

  it('settles an account that already pays, keeping its org', async () => {
    await recordOrg('u1', 'org_9');
    await recordSubscribed('u1');
    expect(await getPlanAccount('u1')).toMatchObject({ orgId: 'org_9', trialEndsAt: null, trialError: null });
    expect(await claimTrialStart('u1', Date.now() + 10 * TRIAL_CLAIM_WINDOW_MS)).toBe(false);
  });

  it('settles an account whose trial was used on an earlier tridant account, with no end', async () => {
    await recordTrialError('u1', 'boom');
    await recordTrialUsed('u1');
    const account = await getPlanAccount('u1');
    expect(account).toMatchObject({ trialUsed: true, trialEndsAt: null, trialError: null });
    expect(account?.trialStartedAt).toEqual(expect.any(Number));
    expect(await claimTrialStart('u1', Date.now() + 10 * TRIAL_CLAIM_WINDOW_MS)).toBe(false);
  });

  it('reads trialUsed as false for an account that never hit it', async () => {
    await recordOrg('u1', 'org_9');
    expect((await getPlanAccount('u1'))?.trialUsed).toBe(false);
  });

  it('records an org without starting a trial', async () => {
    await recordOrg('u1', 'org_9');
    expect(await getPlanAccount('u1')).toMatchObject({ orgId: 'org_9', trialStartedAt: null, linkRequired: false });
    expect(await claimTrialStart('u1', 1000)).toBe(true);
  });

  it('records a trial error without disturbing the rest', async () => {
    await recordOrg('u1', 'org_9');
    await recordTrialError('u1', 'boom');
    expect(await getPlanAccount('u1')).toMatchObject({ orgId: 'org_9', trialError: 'boom' });
  });

  it('records a moved trial end without disturbing the rest', async () => {
    await recordTrial('u1', { orgId: 'org_1', endsAtMs: 5000 });
    const started = (await getPlanAccount('u1'))?.trialStartedAt;
    await recordTrialEnd('u1', 9000);
    expect(await getPlanAccount('u1')).toMatchObject({ orgId: 'org_1', trialEndsAt: 9000, trialStartedAt: started });
    expect(mockStore.get('plan_accounts/u1')?.updatedAt).toBe('__SERVER_TS__');
  });
});

describe('movedTrialEnd', () => {
  const ACCOUNT: PlanAccount = {
    trialStartedAt: 1000,
    trialEndsAt: 5000,
    orgId: 'org_1',
    linkRequired: false,
    trialUsed: false,
    trialError: null,
    claimedAt: null,
  };
  const planOf = (orgId: string | null, trialEndsAt: number | null, standing = 'trialing'): Plan => ({
    enforced: true,
    resolved: true,
    standing,
    inGoodStanding: true,
    ent: {},
    billing: null,
    orgId,
    trialEndsAt,
  });

  it('answers the end tridant id moved the trial to', () => {
    expect(movedTrialEnd([planOf('org_1', 9000)], ACCOUNT)).toBe(9000);
  });

  it('answers null when the end is the recorded one', () => {
    expect(movedTrialEnd([planOf('org_1', 5000)], ACCOUNT)).toBeNull();
  });

  it('ignores a site trialing under another organization', () => {
    expect(movedTrialEnd([planOf('org_2', 9000)], ACCOUNT)).toBeNull();
  });

  it('answers null for an account with no organization, or none at all', () => {
    expect(movedTrialEnd([planOf('org_1', 9000)], { ...ACCOUNT, orgId: null })).toBeNull();
    expect(movedTrialEnd([planOf('org_1', 9000)], null)).toBeNull();
  });

  it('ignores a site that is not trialing, and plans that are off', () => {
    expect(movedTrialEnd([planOf('org_1', 9000, 'active'), { enforced: false, reason: 'unreachable' }], ACCOUNT)).toBeNull();
  });

  it('answers the latest end among the account’s own trialing sites', () => {
    const plans = [planOf('org_1', 7000), planOf('org_1', 9000), planOf('org_2', 12000), planOf('org_1', null)];
    expect(movedTrialEnd(plans, ACCOUNT)).toBe(9000);
  });
});

describe('billing_checkouts', () => {
  it('round-trips a checkout', async () => {
    await recordCheckout('cs_1', { uid: 'u1', siteId: 's1', tier: 'pro', founders: true });
    expect(await getCheckout('cs_1')).toEqual({ uid: 'u1', siteId: 's1', tier: 'pro', founders: true });
    expect(mockStore.get('billing_checkouts/cs_1')?.createdAt).toBe('__SERVER_TS__');
  });

  it('reads null for an unknown or malformed checkout', async () => {
    expect(await getCheckout('nope')).toBeNull();
    mockStore.set('billing_checkouts/bad', { uid: 'u1', siteId: 's1', tier: 'gold' });
    expect(await getCheckout('bad')).toBeNull();
  });
});
