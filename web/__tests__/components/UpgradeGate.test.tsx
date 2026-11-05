/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * UpgradeGate: the children render while the plan loads, after a failed
 * lookup, with plans off and when the flag is on; otherwise a lowercase
 * upgrade card or inline note links to /settings/plan. A site feature gates
 * only on the viewer's own sites: anyone else's runs on its owner's plan.
 */
import React from 'react';
import { render, renderHook, screen } from '@testing-library/react';
import { UpgradeGate, governingPlan, usePlanGated } from '@/components/plan/UpgradeGate';
import type { PlanResponse } from '@/lib/plan.server';

let mockPlan: PlanResponse | undefined;
jest.mock('@/hooks/usePlan', () => ({
  usePlan: () => ({ plan: mockPlan, loading: false, error: null, refresh: jest.fn() }),
}));

const VIEWER = 'viewer-uid';
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { uid: 'viewer-uid' } }),
}));

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

const FREE: PlanResponse = {
  enforced: true,
  plan: 'free',
  standing: 'expired',
  limits: { machines: 1, sites: 1 },
  flags: NO_FLAGS,
  activeMachinesThisMonth: 1,
};
const CORE: PlanResponse = { ...FREE, plan: 'core', standing: 'active', flags: { ...NO_FLAGS, control: true } };
const TRIAL: PlanResponse = { ...FREE, plan: 'trial', standing: 'trialing', flags: ALL_FLAGS };
const PRO: PlanResponse = { ...FREE, plan: 'pro', standing: 'active', flags: ALL_FLAGS };
const OFF: PlanResponse = {
  enforced: false,
  reason: 'enforcement_off',
  plan: null,
  standing: null,
  limits: { machines: null, sites: null },
  flags: ALL_FLAGS,
  activeMachinesThisMonth: null,
};

function renderGate(props: Partial<React.ComponentProps<typeof UpgradeGate>> = {}) {
  return render(
    <UpgradeGate flag="roost" {...props}>
      <button type="button">create roost</button>
    </UpgradeGate>,
  );
}

describe('UpgradeGate', () => {
  it.each([
    ['loading or failed', undefined],
    ['plans off', OFF],
    ['on a trial', TRIAL],
    ['on pro', PRO],
  ])('renders the children when %s', (_label, plan) => {
    mockPlan = plan;
    renderGate();

    expect(screen.getByRole('button', { name: 'create roost' })).toBeInTheDocument();
    expect(screen.queryByTestId('upgrade-gate')).not.toBeInTheDocument();
  });

  it('shows the upgrade card on free in place of the children', () => {
    mockPlan = FREE;
    renderGate();

    expect(screen.queryByRole('button', { name: 'create roost' })).not.toBeInTheDocument();
    expect(screen.getByTestId('upgrade-gate')).toHaveTextContent("your plan doesn't include roost");
    expect(screen.getByTestId('upgrade-gate')).toHaveTextContent('upgrade to pro to use it.');
    expect(screen.getByRole('link', { name: 'upgrade' })).toHaveAttribute('href', '/settings/plan');
  });

  it('gates on the named flag only', () => {
    mockPlan = CORE;
    const { unmount } = renderGate({ flag: 'control' });
    expect(screen.getByRole('button', { name: 'create roost' })).toBeInTheDocument();
    unmount();

    renderGate({ flag: 'webhooks' });
    expect(screen.getByTestId('upgrade-gate')).toHaveTextContent("your plan doesn't include webhooks");
  });

  it.each([
    ['deployments', 'deployments'],
    ['swoop', 'swoop'],
    ['hoot', 'hoot'],
  ] as const)('gates %s on core, naming pro as the upgrade', (flag, name) => {
    mockPlan = CORE;
    renderGate({ flag });

    expect(screen.queryByRole('button', { name: 'create roost' })).not.toBeInTheDocument();
    expect(screen.getByTestId('upgrade-gate')).toHaveTextContent(`your plan doesn't include ${name}`);
    expect(screen.getByTestId('upgrade-gate')).toHaveTextContent('upgrade to pro to use it.');
  });

  it('names core as the upgrade for remote control', () => {
    mockPlan = FREE;
    renderGate({ flag: 'control' });

    expect(screen.getByTestId('upgrade-gate')).toHaveTextContent("your plan doesn't include remote control");
    expect(screen.getByTestId('upgrade-gate')).toHaveTextContent('upgrade to core to use it.');
  });

  it('renders the inline note in place of a create control', () => {
    mockPlan = FREE;
    renderGate({ flag: 'api_keys', variant: 'inline' });

    expect(screen.queryByRole('button', { name: 'create roost' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('upgrade-gate')).not.toBeInTheDocument();
    expect(screen.getByTestId('upgrade-gate-inline')).toHaveTextContent("your plan doesn't include API keys.");
    expect(screen.getByRole('link', { name: 'upgrade' })).toHaveAttribute('href', '/settings/plan');
  });

  it('names the feature when the flag covers more than one', () => {
    mockPlan = FREE;
    renderGate({ flag: 'control', feature: 'alert rules', variant: 'inline' });

    expect(screen.getByTestId('upgrade-gate-inline')).toHaveTextContent("your plan doesn't include alert rules.");
  });

  describe('on a site', () => {
    it("gates the viewer's own site on their plan", () => {
      mockPlan = FREE;
      renderGate({ siteOwner: VIEWER });

      expect(screen.queryByRole('button', { name: 'create roost' })).not.toBeInTheDocument();
      expect(screen.getByTestId('upgrade-gate')).toBeInTheDocument();
    });

    it.each([
      ["another account's site", 'owner-uid'],
      ['a site whose owner is not known yet', null],
    ])('renders the children on %s', (_label, siteOwner) => {
      mockPlan = FREE;
      renderGate({ siteOwner });

      expect(screen.getByRole('button', { name: 'create roost' })).toBeInTheDocument();
      expect(screen.queryByTestId('upgrade-gate')).not.toBeInTheDocument();
    });
  });
});

describe('usePlanGated', () => {
  it.each([
    ['loading or failed', undefined, undefined, false],
    ['plans off', OFF, undefined, false],
    ['the flag on', PRO, undefined, false],
    ['an account feature on free', FREE, undefined, true],
    ["the viewer's own site on free", FREE, VIEWER, true],
    ["another account's site on free", FREE, 'owner-uid', false],
    ['an unknown site owner on free', FREE, null, false],
  ] as const)('with %s', (_label, plan, siteOwner, gated) => {
    mockPlan = plan;
    const { result } = renderHook(() => usePlanGated('roost', siteOwner));

    expect(result.current).toBe(gated);
  });
});

// the one owner rule, which useSitePlan builds on too.
describe('governingPlan', () => {
  it.each([
    ['loading or failed', undefined, undefined, null],
    ['plans off', OFF, undefined, null],
    ['an account feature', FREE, undefined, FREE],
    ["the viewer's own site", FREE, VIEWER, FREE],
    ["another account's site", FREE, 'owner-uid', null],
    ['an unknown site owner', FREE, null, null],
  ] as const)('with %s', (_label, plan, siteOwner, expected) => {
    expect(governingPlan(plan, VIEWER, siteOwner)).toBe(expected);
  });

  it('governs no site for a signed-out viewer', () => {
    expect(governingPlan(FREE, undefined, VIEWER)).toBeNull();
  });
});
