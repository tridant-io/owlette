/**
 * @jest-environment jsdom
 *
 * `useSitePlan` — a site's plan from `/api/sites/{siteId}/plan`, and what it
 * does to the site's machines. pins one fetch per site per sign-in shared by
 * every caller, nothing fetched before auth and the account plan settle (the
 * account read is what starts the trial), nothing locked while the
 * plan loads, after a failure or with plans off, control and swoop by the
 * site's flags for every viewer, the machine lock on a free site the same for
 * every viewer (from the site plan's `freeMachines`), and a fresh site plan
 * when that free site's machine set changes.
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

// a free site whose owner's free sites hold two machines, one over the limit.
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
  freeMachines: { limit: 1, live: ['kiosk-1'] },
};
const CORE: SitePlanResponse = {
  ...FREE,
  tier: 'core',
  standing: 'active',
  inGoodStanding: true,
  flags: { ...NO_FLAGS, control: true },
  billing: { tier: 'core', founders: false, endsAt: null },
  period: { start: 1_700_000_000_000, end: 1_702_000_000_000 },
  freeMachines: null,
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
  freeMachines: null,
};

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
  foundersHeld: { core: false, pro: false },
  linkAvailable: false,
  portalUrl: null,
};

const ONE_MACHINE = 'kiosk-1';
const TWO_MACHINES = ['kiosk-1', 'kiosk-2'].join('\n');

describe('sitePlan', () => {
  it.each([
    ['plans are not enforced', OFF],
    ['the plan is loading or failed', undefined],
  ])('leaves everything alone when %s', (_, site) => {
    const state = sitePlan(site);

    expect(state.machineLimitFor('kiosk-2')).toBeNull();
    expect(state.controlLocked).toBe(false);
    expect(state.swoopLocked).toBe(false);
    expect(state.hootLocked).toBe(false);
  });

  // the server counts the owner's free sites, so the owner, a site admin and a member see one lock.
  it.each([
    ['its owner', true],
    ['anyone else on the site', false],
  ])('on a free site, keeps the live machine and locks the rest behind the limit for %s', (_, isOwner) => {
    const state = sitePlan({ ...FREE, isOwner });

    expect(state.machineLimitFor('kiosk-1')).toBeNull();
    expect(state.machineLimitFor('kiosk-2')).toBe(1);
    expect(state.controlLocked).toBe(true);
    expect(state.swoopLocked).toBe(true);
    expect(state.hootLocked).toBe(true);
  });

  it('locks every machine when the one the limit covers is on another site', () => {
    expect(sitePlan({ ...FREE, freeMachines: { limit: 1, live: [] } }).machineLimitFor('kiosk-1')).toBe(1);
  });

  it('locks no machine while the owner has one to spare, or no limit', () => {
    const state = sitePlan({ ...FREE, freeMachines: null });

    expect(state.machineLimitFor('kiosk-new')).toBeNull();
    expect(state.controlLocked).toBe(true);
  });

  it('on core, leaves control and every machine alone, and locks swoop and hoot', () => {
    const state = sitePlan(CORE);

    expect(state.machineLimitFor('kiosk-2')).toBeNull();
    expect(state.controlLocked).toBe(false);
    expect(state.swoopLocked).toBe(true);
    expect(state.hootLocked).toBe(true);
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

    // the owner's account plan counts the same machines for the plan page, so it is asked again too.
    it.each([
      ['its owner', true, 2],
      ['anyone else on the site', false, 0],
    ])(
      'asks for the site plan again when a machine is paired or removed on a free site, for %s',
      async (_, isOwner, accountReads) => {
        fetchMock.mockResolvedValue(jsonResponse({ ...FREE, isOwner }));
        const { rerender } = await render('site-a', null);
        rerender({ siteId: 'site-a', key: ONE_MACHINE });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        rerender({ siteId: 'site-a', key: TWO_MACHINES });
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

        rerender({ siteId: 'site-a', key: 'kiosk-2' });
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
        expect(mockRefreshAccount).toHaveBeenCalledTimes(accountReads);
      },
    );

    it('does not ask again on a site switch or while machines load', async () => {
      const { result, rerender } = await render('site-a', ONE_MACHINE);
      rerender({ siteId: 'site-b', key: null });
      await waitFor(() => expect(result.current.loading).toBe(false));
      rerender({ siteId: 'site-b', key: 'kiosk-9' });

      // one read per site, and no more.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['a site in good standing', PRO],
      ['plans not enforced', OFF],
    ])('does not ask again for %s', async (_, site) => {
      fetchMock.mockResolvedValue(jsonResponse(site));
      const { rerender } = await render('site-a', ONE_MACHINE);
      rerender({ siteId: 'site-a', key: TWO_MACHINES });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
