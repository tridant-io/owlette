/**
 * @jest-environment jsdom
 *
 * `useSitePlan` — a site's plan from `/api/sites/{siteId}/plan`, and what it
 * does to the site's machines. pins one fetch per site per sign-in shared by
 * every caller, nothing fetched before auth and the account plan settle (the
 * account read is what starts the trial), nothing locked while the
 * plan loads, after a failure or with plans off, control and swoop by the
 * site's flags for every viewer, the machine lock on a free site for its owner
 * alone (from the account plan's live machines), and a fresh account plan when
 * that site's machine set changes.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import type { AccountPlanOn, AccountPlanResponse } from '@/lib/planResponse';
import type { SitePlanResponse } from '@/lib/sitePlanResponse';

let mockAuth: { user: { uid: string } | null; loading: boolean } = { user: { uid: 'u1' }, loading: false };
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => mockAuth,
}));

let mockAccount: AccountPlanResponse | undefined;
let mockAccountLoading = false;
const mockRefreshAccount = jest.fn();
jest.mock('@/hooks/usePlan', () => ({
  usePlan: () => ({ plan: mockAccount, loading: mockAccountLoading, error: null, refresh: mockRefreshAccount }),
}));

import { __resetSitePlansForTests, sitePlan, useSitePlan } from '@/hooks/useSitePlan';

const NO_FLAGS = {
  control: false,
  deployments: false,
  swoop: false,
  hoot: false,
  roost: false,
  talons: false,
  webhooks: false,
  api_keys: false,
};
const ALL_FLAGS = {
  control: true,
  deployments: true,
  swoop: true,
  hoot: true,
  roost: true,
  talons: true,
  webhooks: true,
  api_keys: true,
};

const FREE: SitePlanResponse = {
  enforced: true,
  tier: 'free',
  standing: 'expired',
  inGoodStanding: false,
  flags: NO_FLAGS,
  billing: null,
  period: null,
  isOwner: true,
  billedByPreviousOwner: false,
};
const CORE: SitePlanResponse = {
  ...FREE,
  tier: 'core',
  standing: 'active',
  inGoodStanding: true,
  flags: { ...NO_FLAGS, control: true },
  billing: { tier: 'core', founders: false, endsAt: null },
  period: { start: 1_700_000_000_000, end: 1_702_000_000_000 },
};
const PRO: SitePlanResponse = {
  ...CORE,
  tier: 'pro',
  flags: ALL_FLAGS,
  billing: { tier: 'pro', founders: false, endsAt: null },
};
const OFF: SitePlanResponse = {
  enforced: false,
  reason: 'enforcement_off',
  tier: null,
  standing: null,
  inGoodStanding: true,
  flags: ALL_FLAGS,
  billing: null,
  period: null,
  isOwner: true,
  billedByPreviousOwner: false,
};

// an account whose free sites hold two machines, one over the limit.
const ACCOUNT: AccountPlanOn = {
  enforced: true,
  emailVerified: true,
  trial: { status: 'ended', endsAt: 1_700_000_000_000 },
  sites: [],
  free: {
    sitesUsed: 1,
    sitesLimit: 1,
    machinesUsed: 2,
    machinesLimit: 1,
    liveMachines: [{ siteId: 'site-a', machineId: 'kiosk-1' }],
  },
  siteCreation: { state: 'open', unpaidSite: null },
  foundersRemaining: null,
  linkAvailable: false,
  portalUrl: null,
};
const ACCOUNT_OFF: AccountPlanResponse = { enforced: false, reason: 'enforcement_off' };
const UNLIMITED: AccountPlanOn = { ...ACCOUNT, free: { ...ACCOUNT.free, machinesLimit: null } };

const ONE_MACHINE = 'kiosk-1';
const TWO_MACHINES = ['kiosk-1', 'kiosk-2'].join('\n');

describe('sitePlan', () => {
  it.each([
    ['plans are not enforced', OFF],
    ['the plan is loading or failed', undefined],
  ])('leaves everything alone when %s', (_, site) => {
    const state = sitePlan(site, ACCOUNT, 'site-a');

    expect(state.machineLimitFor('kiosk-2')).toBeNull();
    expect(state.controlLocked).toBe(false);
    expect(state.swoopLocked).toBe(false);
  });

  it('on a free site the viewer owns, keeps the live machine and locks the rest behind the limit', () => {
    const state = sitePlan(FREE, ACCOUNT, 'site-a');

    expect(state.machineLimitFor('kiosk-1')).toBeNull();
    expect(state.machineLimitFor('kiosk-2')).toBe(1);
    expect(state.controlLocked).toBe(true);
    expect(state.swoopLocked).toBe(true);
  });

  it("locks control and swoop for a member of a free site, but no machine: the count is its owner's", () => {
    const state = sitePlan({ ...FREE, isOwner: false }, ACCOUNT, 'site-a');

    expect(state.machineLimitFor('kiosk-2')).toBeNull();
    expect(state.controlLocked).toBe(true);
    expect(state.swoopLocked).toBe(true);
  });

  it('locks a machine whose id is live only on another site', () => {
    expect(sitePlan(FREE, ACCOUNT, 'site-b').machineLimitFor('kiosk-1')).toBe(1);
  });

  it('locks nothing while the account has a slot to spare, as for a machine paired after it loaded', () => {
    const account = { ...ACCOUNT, free: { ...ACCOUNT.free, machinesUsed: 0, liveMachines: [] } };
    const state = sitePlan(FREE, account, 'site-a');

    expect(state.machineLimitFor('kiosk-new')).toBeNull();
    expect(state.controlLocked).toBe(true);
  });

  it.each([
    ['is loading or failed', undefined],
    ['is not enforced', ACCOUNT_OFF],
    ['has no machine limit', UNLIMITED],
  ])('locks no machine while the account plan %s', (_, account) => {
    expect(sitePlan(FREE, account, 'site-a').machineLimitFor('kiosk-2')).toBeNull();
  });

  it('on core, leaves control and every machine alone, and locks swoop', () => {
    // the account's free sites are full, which says nothing about a billed one.
    const state = sitePlan(CORE, ACCOUNT, 'site-b');

    expect(state.machineLimitFor('kiosk-2')).toBeNull();
    expect(state.controlLocked).toBe(false);
    expect(state.swoopLocked).toBe(true);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('useSitePlan', () => {
  const fetchMock = jest.fn();
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    __resetSitePlansForTests();
    mockAuth = { user: { uid: 'u1' }, loading: false };
    mockAccount = ACCOUNT;
    mockAccountLoading = false;
    mockRefreshAccount.mockClear();
    originalFetch = global.fetch;
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse(FREE));
    global.fetch = fetchMock as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('fetches nothing while auth is loading, signed out, or without a site', () => {
    mockAuth = { user: { uid: 'u1' }, loading: true };
    const { result, rerender } = renderHook(({ siteId }: { siteId: string | null }) => useSitePlan(siteId), {
      initialProps: { siteId: 'site-a' as string | null },
    });
    expect(result.current).toMatchObject({ plan: undefined, loading: true, error: null });

    mockAuth = { user: null, loading: false };
    rerender({ siteId: 'site-a' });
    expect(result.current).toMatchObject({ plan: undefined, loading: false });

    mockAuth = { user: { uid: 'u1' }, loading: false };
    rerender({ siteId: '' });
    rerender({ siteId: null });
    expect(result.current).toMatchObject({ plan: undefined, loading: false, controlLocked: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks for no site until the account plan has loaded, locking nothing meanwhile, then asks once', async () => {
    // the account read starts the trial: a site read ahead of it would keep owlette free all session.
    mockAccountLoading = true;
    mockAccount = undefined;
    const { result, rerender } = renderHook(() => useSitePlan('site-a'));
    expect(result.current).toMatchObject({ plan: undefined, loading: true, controlLocked: false, swoopLocked: false });
    expect(result.current.machineLimitFor('kiosk-2')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    mockAccountLoading = false;
    mockAccount = ACCOUNT;
    rerender();
    await waitFor(() => expect(result.current.plan).toEqual(FREE));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // an account refresh later does not ask for the site again.
    mockAccountLoading = true;
    rerender();
    mockAccountLoading = false;
    rerender();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks for the site once the account plan read has failed', async () => {
    mockAccountLoading = true;
    mockAccount = undefined;
    const { result, rerender } = renderHook(() => useSitePlan('site-a'));
    expect(fetchMock).not.toHaveBeenCalled();

    mockAccountLoading = false;
    rerender();
    await waitFor(() => expect(result.current.plan).toEqual(FREE));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetches a site once for every caller, and locks nothing until the plan is in', async () => {
    const first = renderHook(() => useSitePlan('site-a'));
    const second = renderHook(() => useSitePlan('site-a'));
    expect(first.result.current).toMatchObject({ plan: undefined, loading: true, controlLocked: false, swoopLocked: false });
    expect(first.result.current.machineLimitFor('kiosk-2')).toBeNull();

    await waitFor(() => expect(first.result.current.plan).toEqual(FREE));
    expect(second.result.current.plan).toEqual(FREE);
    expect(first.result.current).toMatchObject({ loading: false, controlLocked: true, swoopLocked: true });
    expect(first.result.current.machineLimitFor('kiosk-2')).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/sites/site-a/plan', { cache: 'no-store' });

    // a later mount and a rerender read the cache.
    renderHook(() => useSitePlan('site-a'));
    first.rerender();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps one plan per site, and asks for neither again on a switch back', async () => {
    fetchMock.mockImplementation(async (url: string) => jsonResponse(url.includes('site%2Fb') ? PRO : FREE));
    const { result, rerender } = renderHook(({ siteId }: { siteId: string }) => useSitePlan(siteId), {
      initialProps: { siteId: 'site-a' },
    });
    await waitFor(() => expect(result.current.plan).toEqual(FREE));

    rerender({ siteId: 'site/b' });
    // the other site's plan is not this one's: nothing is locked while it loads.
    expect(result.current).toMatchObject({ plan: undefined, loading: true, controlLocked: false });
    await waitFor(() => expect(result.current.plan).toEqual(PRO));
    expect(fetchMock).toHaveBeenLastCalledWith('/api/sites/site%2Fb/plan', { cache: 'no-store' });

    rerender({ siteId: 'site-a' });
    expect(result.current).toMatchObject({ plan: FREE, loading: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('lands both answers when two sites load at once', async () => {
    const a = deferred<Response>();
    const b = deferred<Response>();
    fetchMock.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const first = renderHook(() => useSitePlan('site-a'));
    const second = renderHook(() => useSitePlan('site-b'));

    await act(async () => {
      b.resolve(jsonResponse(PRO));
      a.resolve(jsonResponse(FREE));
      await Promise.all([a.promise, b.promise]);
    });
    await waitFor(() => expect(first.result.current.plan).toEqual(FREE));
    expect(second.result.current.plan).toEqual(PRO);
  });

  it('leaves the plan undefined, locks nothing and surfaces the problem detail on a failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 403, detail: 'you are not a member of this site.' }, 403));

    const { result } = renderHook(() => useSitePlan('site-a'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({
      plan: undefined,
      error: 'you are not a member of this site.',
      controlLocked: false,
      swoopLocked: false,
    });
    expect(result.current.machineLimitFor('kiosk-2')).toBeNull();
  });

  it('locks nothing when plans are not enforced', async () => {
    fetchMock.mockResolvedValue(jsonResponse(OFF));

    const { result } = renderHook(() => useSitePlan('site-a'));

    await waitFor(() => expect(result.current.plan).toEqual(OFF));
    expect(result.current).toMatchObject({ controlLocked: false, swoopLocked: false });
    expect(result.current.machineLimitFor('kiosk-2')).toBeNull();
  });

  it('keeps the plan it has while a refresh reloads, then takes the new one', async () => {
    const { result } = renderHook(() => useSitePlan('site-a'));
    await waitFor(() => expect(result.current.plan).toEqual(FREE));

    const reload = deferred<Response>();
    fetchMock.mockReturnValueOnce(reload.promise);
    let refreshed!: Promise<void>;
    act(() => {
      refreshed = result.current.refresh();
    });
    expect(result.current).toMatchObject({ plan: FREE, loading: true, controlLocked: true });

    await act(async () => {
      reload.resolve(jsonResponse(PRO));
      await refreshed;
    });
    expect(result.current).toMatchObject({ plan: PRO, loading: false, controlLocked: false });
  });

  it('drops every site on sign-out and fetches again for the next account', async () => {
    const { result, rerender } = renderHook(() => useSitePlan('site-a'));
    await waitFor(() => expect(result.current.plan).toEqual(FREE));

    mockAuth = { user: null, loading: false };
    rerender();
    expect(result.current).toMatchObject({ plan: undefined, controlLocked: false });

    fetchMock.mockResolvedValue(jsonResponse(PRO));
    mockAuth = { user: { uid: 'u2' }, loading: false };
    rerender();
    await waitFor(() => expect(result.current.plan).toEqual(PRO));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never shows the last account's plan to the next one", async () => {
    const { result, rerender } = renderHook(() => useSitePlan('site-a'));
    await waitFor(() => expect(result.current.plan).toEqual(FREE));

    const next = deferred<Response>();
    fetchMock.mockReturnValueOnce(next.promise);
    mockAuth = { user: { uid: 'u2' }, loading: false };
    rerender();
    expect(result.current).toMatchObject({ plan: undefined, loading: true, controlLocked: false });

    await act(async () => {
      next.resolve(jsonResponse(PRO));
      await next.promise;
    });
    await waitFor(() => expect(result.current.plan).toEqual(PRO));
  });

  it("drops a refresh the last account still holds, leaving the next account's plan alone", async () => {
    const { result, rerender } = renderHook(() => useSitePlan('site-a'));
    await waitFor(() => expect(result.current.plan).toEqual(FREE));
    const staleRefresh = result.current.refresh;

    fetchMock.mockResolvedValue(jsonResponse(PRO));
    mockAuth = { user: { uid: 'u2' }, loading: false };
    rerender();
    await waitFor(() => expect(result.current.plan).toEqual(PRO));

    await act(async () => {
      await staleRefresh();
    });
    expect(result.current).toMatchObject({ plan: PRO, loading: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ignores an answer that lands after sign-out, so signing back in fetches afresh', async () => {
    const late = deferred<Response>();
    fetchMock.mockReturnValueOnce(late.promise);
    const { result, rerender } = renderHook(() => useSitePlan('site-a'));

    mockAuth = { user: null, loading: false };
    rerender();
    await act(async () => {
      late.resolve(jsonResponse(FREE));
      await late.promise;
    });
    expect(result.current).toMatchObject({ plan: undefined, loading: false });

    fetchMock.mockResolvedValue(jsonResponse(PRO));
    mockAuth = { user: { uid: 'u1' }, loading: false };
    rerender();
    await waitFor(() => expect(result.current.plan).toEqual(PRO));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  describe('when the machine set changes', () => {
    async function render(siteId: string, key: string | null) {
      const hook = renderHook((props: { siteId: string; key: string | null }) => useSitePlan(props.siteId, props.key), {
        initialProps: { siteId, key },
      });
      await waitFor(() => expect(hook.result.current.loading).toBe(false));
      return hook;
    }

    it('asks for the account plan again when a machine is paired or removed on a free site the viewer owns', async () => {
      const { rerender } = await render('site-a', null);
      rerender({ siteId: 'site-a', key: ONE_MACHINE });
      expect(mockRefreshAccount).not.toHaveBeenCalled();

      rerender({ siteId: 'site-a', key: TWO_MACHINES });
      expect(mockRefreshAccount).toHaveBeenCalledTimes(1);

      rerender({ siteId: 'site-a', key: 'kiosk-2' });
      expect(mockRefreshAccount).toHaveBeenCalledTimes(2);
      // the site's own plan does not change with its machines.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not ask again on a site switch or while machines load', async () => {
      const { result, rerender } = await render('site-a', ONE_MACHINE);
      rerender({ siteId: 'site-b', key: null });
      await waitFor(() => expect(result.current.loading).toBe(false));
      rerender({ siteId: 'site-b', key: 'kiosk-9' });

      expect(mockRefreshAccount).not.toHaveBeenCalled();
    });

    it.each([
      ['a site someone else owns', { ...FREE, isOwner: false }, ACCOUNT],
      ['a site in good standing', PRO, ACCOUNT],
      ['an account with no machine limit', FREE, UNLIMITED],
      ['plans not enforced', OFF, ACCOUNT_OFF],
    ])('does not ask again for %s', async (_, site, account) => {
      fetchMock.mockResolvedValue(jsonResponse(site));
      mockAccount = account;
      const { rerender } = await render('site-a', ONE_MACHINE);
      rerender({ siteId: 'site-a', key: TWO_MACHINES });

      expect(mockRefreshAccount).not.toHaveBeenCalled();
    });
  });
});
