/**
 * @jest-environment jsdom
 *
 * `usePlan` — the signed-in user's plan from `/api/account/plan`. pins one fetch
 * per sign-in shared by every caller, nothing fetched before auth settles,
 * `plan` undefined while loading and after a failure (gates render children
 * then), and a refresh that keeps the plan it has while it reloads.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import type { PlanResponse } from '@/lib/plan.server';

let mockAuth: { user: { uid: string } | null; loading: boolean } = { user: null, loading: true };
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => mockAuth,
}));

import { __resetPlanForTests, usePlan } from '@/hooks/usePlan';

const FREE: PlanResponse = {
  enforced: true,
  plan: 'free',
  standing: 'expired',
  limits: { machines: 1, sites: 1 },
  flags: {
    control: false,
    deployments: false,
    swoop: false,
    hoot: false,
    roost: false,
    talons: false,
    webhooks: false,
    api_keys: false,
  },
  activeMachinesThisMonth: 1,
};
const PRO: PlanResponse = {
  ...FREE,
  plan: 'pro',
  standing: 'active',
  limits: { machines: null, sites: null },
  flags: {
    control: true,
    deployments: true,
    swoop: true,
    hoot: true,
    roost: true,
    talons: true,
    webhooks: true,
    api_keys: true,
  },
};

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

describe('usePlan', () => {
  const fetchMock = jest.fn();
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    __resetPlanForTests();
    mockAuth = { user: { uid: 'u1' }, loading: false };
    originalFetch = global.fetch;
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse(FREE));
    global.fetch = fetchMock as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('fetches nothing while auth is loading or signed out', () => {
    mockAuth = { user: { uid: 'u1' }, loading: true };
    const { result, rerender } = renderHook(() => usePlan());
    expect(result.current).toMatchObject({ plan: undefined, loading: true, error: null });

    mockAuth = { user: null, loading: false };
    rerender();
    expect(result.current).toMatchObject({ plan: undefined, loading: false, error: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches once for every caller and hands each the same plan', async () => {
    const first = renderHook(() => usePlan());
    const second = renderHook(() => usePlan());
    expect(first.result.current).toMatchObject({ plan: undefined, loading: true });

    await waitFor(() => expect(first.result.current.plan).toEqual(FREE));
    expect(second.result.current.plan).toEqual(FREE);
    expect(first.result.current.loading).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/account/plan', { cache: 'no-store' });

    renderHook(() => usePlan());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves the plan undefined and surfaces the problem detail on a failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 500, detail: 'an internal error occurred.' }, 500));

    const { result } = renderHook(() => usePlan());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.plan).toBeUndefined();
    expect(result.current.error).toBe('an internal error occurred.');
  });

  it('keeps the plan it has while a refresh reloads, then takes the new one', async () => {
    const { result } = renderHook(() => usePlan());
    await waitFor(() => expect(result.current.plan).toEqual(FREE));

    const reload = deferred<Response>();
    fetchMock.mockReturnValueOnce(reload.promise);
    let refreshed!: Promise<void>;
    act(() => {
      refreshed = result.current.refresh();
    });
    expect(result.current).toMatchObject({ plan: FREE, loading: true });

    await act(async () => {
      reload.resolve(jsonResponse(PRO));
      await refreshed;
    });
    expect(result.current).toMatchObject({ plan: PRO, loading: false });
  });

  it('drops the plan on sign-out and fetches again for the next account', async () => {
    const { result, rerender } = renderHook(() => usePlan());
    await waitFor(() => expect(result.current.plan).toEqual(FREE));

    mockAuth = { user: null, loading: false };
    rerender();
    expect(result.current.plan).toBeUndefined();

    fetchMock.mockResolvedValue(jsonResponse(PRO));
    mockAuth = { user: { uid: 'u2' }, loading: false };
    rerender();
    await waitFor(() => expect(result.current.plan).toEqual(PRO));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ignores an answer that lands after sign-out, so signing back in fetches afresh', async () => {
    const late = deferred<Response>();
    fetchMock.mockReturnValueOnce(late.promise);
    const { result, rerender } = renderHook(() => usePlan());

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
});
