/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * UpgradeGate on the real site plan store: the children stay up while the
 * site's plan is on its way and the gate never shows before the answer, two
 * gates on one site cost one request, and a refresh keeps the gate it has
 * rather than flashing the children back.
 */
import React from 'react';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { UpgradeGate } from '@/components/plan/UpgradeGate';
import { __resetSitePlansForTests, useSitePlan } from '@/hooks/useSitePlan';
import type { SitePlanResponse } from '@/lib/sitePlanResponse';

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { uid: 'u1' }, loading: false }),
}));
jest.mock('@/hooks/usePlan', () => ({
  usePlan: () => ({ plan: undefined, loading: false, error: null, refresh: jest.fn() }),
}));

const FLAGS = {
  control: false,
  deployments: false,
  swoop: false,
  hoot: false,
  roost: false,
  talons: false,
  webhooks: false,
  api_keys: false,
};
const FREE: SitePlanResponse = {
  enforced: true,
  tier: 'free',
  standing: 'expired',
  inGoodStanding: false,
  flags: FLAGS,
  billing: null,
  period: null,
  isOwner: false,
  billedByPreviousOwner: false,
};

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('UpgradeGate on the site plan store', () => {
  const fetchMock = jest.fn();
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    __resetSitePlansForTests();
    originalFetch = global.fetch;
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('shows the children until the plan is in, asks once for two gates, and holds the gate through a refresh', async () => {
    const first = deferred<Response>();
    fetchMock.mockReturnValueOnce(first.promise);
    render(
      <>
        <UpgradeGate flag="roost" siteId="site-a" variant="inline">
          <button type="button">create roost</button>
        </UpgradeGate>
        <UpgradeGate flag="talons" siteId="site-a" variant="inline">
          <button type="button">create talon</button>
        </UpgradeGate>
      </>,
    );

    expect(screen.getByRole('button', { name: 'create roost' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'create talon' })).toBeInTheDocument();
    expect(screen.queryByTestId('upgrade-gate-inline')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/sites/site-a/plan', { cache: 'no-store' });

    await act(async () => {
      first.resolve(jsonResponse(FREE));
      await first.promise;
    });
    await waitFor(() => expect(screen.getAllByTestId('upgrade-gate-inline')).toHaveLength(2));
    expect(screen.queryByRole('button', { name: 'create roost' })).not.toBeInTheDocument();

    const reload = deferred<Response>();
    fetchMock.mockReturnValueOnce(reload.promise);
    const { result } = renderHook(() => useSitePlan('site-a'));
    let refreshed!: Promise<void>;
    act(() => {
      refreshed = result.current.refresh();
    });
    expect(screen.getAllByTestId('upgrade-gate-inline')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'create roost' })).not.toBeInTheDocument();

    await act(async () => {
      reload.resolve(jsonResponse({ ...FREE, inGoodStanding: true, tier: 'pro', flags: { ...FLAGS, roost: true, talons: true } }));
      await refreshed;
    });
    expect(screen.getByRole('button', { name: 'create roost' })).toBeInTheDocument();
    expect(screen.queryByTestId('upgrade-gate-inline')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
