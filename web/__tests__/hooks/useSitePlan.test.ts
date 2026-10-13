/**
 * @jest-environment jsdom
 *
 * `useSitePlan` — what the viewer's own plan does to one site's machines. pins
 * that it applies only to a site the viewer owns while plans are enforced, the
 * live machine from the server's list, no lock while a slot is spare (a machine
 * paired after the plan loaded), control and swoop by flag, and a fresh plan
 * when the site's machine set changes, but not when it first loads or the site
 * switches.
 */

import { renderHook } from '@testing-library/react';
import type { PlanResponse } from '@/lib/plan.server';

let mockUid: string | null = 'u1';
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: mockUid ? { uid: mockUid } : null }),
}));

let mockPlan: PlanResponse | undefined;
const mockRefresh = jest.fn();
jest.mock('@/hooks/usePlan', () => ({
  usePlan: () => ({ plan: mockPlan, loading: false, error: null, refresh: mockRefresh }),
}));

import { sitePlan, useSitePlan } from '@/hooks/useSitePlan';

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
const FREE: PlanResponse = {
  enforced: true,
  plan: 'free',
  standing: 'expired',
  limits: { machines: 1, sites: 1 },
  flags: NO_FLAGS,
  activeMachinesThisMonth: 1,
  ownsSites: true,
  liveMachines: [{ siteId: 'site-a', machineId: 'kiosk-1' }],
};
const CORE: PlanResponse = {
  ...FREE,
  plan: 'core',
  standing: 'active',
  limits: { machines: null, sites: 1 },
  flags: { ...NO_FLAGS, control: true },
  liveMachines: undefined,
};
const OFF: PlanResponse = {
  enforced: false,
  reason: 'enforcement_off',
  plan: null,
  standing: null,
  limits: { machines: null, sites: null },
  flags: { ...NO_FLAGS, control: true, swoop: true },
  activeMachinesThisMonth: null,
};

describe('sitePlan', () => {
  it.each([
    ['plans are not enforced', OFF, 'u1', 'u1'],
    ['the plan is still loading', undefined, 'u1', 'u1'],
    ['someone else owns the site', FREE, 'u1', 'u2'],
    ['the site has no owner on record', FREE, 'u1', undefined],
    ['nobody is signed in', FREE, null, undefined],
  ])('leaves everything alone when %s', (_, plan, uid, owner) => {
    const state = sitePlan(plan, uid, 'site-a', owner);

    expect(state.machineLimitFor('kiosk-2')).toBeNull();
    expect(state.controlLocked).toBe(false);
    expect(state.swoopLocked).toBe(false);
  });

  it('on free, keeps the live machine and locks the rest behind the limit', () => {
    const state = sitePlan(FREE, 'u1', 'site-a', 'u1');

    expect(state.machineLimitFor('kiosk-1')).toBeNull();
    expect(state.machineLimitFor('kiosk-2')).toBe(1);
    expect(state.controlLocked).toBe(true);
    expect(state.swoopLocked).toBe(true);
  });

  it('locks a machine whose id is live only on another site', () => {
    const state = sitePlan(FREE, 'u1', 'site-b', 'u1');

    expect(state.machineLimitFor('kiosk-1')).toBe(1);
  });

  it('locks nothing while the plan has a slot to spare, as for a machine paired after it loaded', () => {
    const state = sitePlan({ ...FREE, liveMachines: [] }, 'u1', 'site-a', 'u1');

    expect(state.machineLimitFor('kiosk-new')).toBeNull();
    expect(state.controlLocked).toBe(true);
  });

  it('locks nothing without a live list', () => {
    expect(sitePlan({ ...FREE, liveMachines: undefined }, 'u1', 'site-a', 'u1').machineLimitFor('kiosk-2')).toBeNull();
  });

  it('on core, leaves control and every machine alone, and locks swoop', () => {
    const state = sitePlan(CORE, 'u1', 'site-a', 'u1');

    expect(state.machineLimitFor('kiosk-2')).toBeNull();
    expect(state.controlLocked).toBe(false);
    expect(state.swoopLocked).toBe(true);
  });
});

describe('useSitePlan', () => {
  beforeEach(() => {
    mockUid = 'u1';
    mockPlan = FREE;
    mockRefresh.mockClear();
  });

  function render(siteId: string, key: string | null, owner = 'u1') {
    return renderHook((props: { siteId: string; key: string | null; owner: string }) =>
      useSitePlan(props.siteId, props.owner, props.key),
    { initialProps: { siteId, key, owner } });
  }

  it('asks for the plan again when a machine is paired or removed on the site', () => {
    const { rerender } = render('site-a', null);
    rerender({ siteId: 'site-a', key: 'kiosk-1', owner: 'u1' });
    expect(mockRefresh).not.toHaveBeenCalled();

    rerender({ siteId: 'site-a', key: 'kiosk-1\nkiosk-2', owner: 'u1' });
    expect(mockRefresh).toHaveBeenCalledTimes(1);

    rerender({ siteId: 'site-a', key: 'kiosk-2', owner: 'u1' });
    expect(mockRefresh).toHaveBeenCalledTimes(2);
  });

  it('does not ask again on a site switch, while machines load, or without a machine limit', () => {
    const { rerender } = render('site-a', 'kiosk-1');
    rerender({ siteId: 'site-b', key: null, owner: 'u1' });
    rerender({ siteId: 'site-b', key: 'kiosk-9', owner: 'u1' });
    expect(mockRefresh).not.toHaveBeenCalled();

    mockPlan = CORE;
    rerender({ siteId: 'site-b', key: 'kiosk-9\nkiosk-10', owner: 'u1' });
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('does not ask again for a site the viewer does not own', () => {
    const { rerender } = render('site-a', 'kiosk-1', 'u2');
    rerender({ siteId: 'site-a', key: 'kiosk-1\nkiosk-2', owner: 'u2' });

    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
