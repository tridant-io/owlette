/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * UpgradeGate: the children render while the plan loads, after a failed
 * lookup, with plans off and when the flag is on; otherwise a lowercase
 * upgrade card or inline note links to /settings/plan.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { UpgradeGate } from '@/components/plan/UpgradeGate';
import type { PlanResponse } from '@/lib/plan.server';

let mockPlan: PlanResponse | undefined;
jest.mock('@/hooks/usePlan', () => ({
  usePlan: () => ({ plan: mockPlan, loading: false, error: null, refresh: jest.fn() }),
}));

const NO_FLAGS = { control: false, roost: false, talons: false, webhooks: false, api_keys: false };
const ALL_FLAGS = { control: true, roost: true, talons: true, webhooks: true, api_keys: true };

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
});
