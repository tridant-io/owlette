/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * /settings/plan: with plans off it says so and nothing else; when enforced it
 * names the plan and its standing, shows the limits and this month's active
 * machines, lists what is included, and offers the tiers above the current one
 * behind disabled buttons until checkout exists.
 */
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import PlanSettingsPage from '@/app/settings/plan/page';
import type { PlanResponse } from '@/lib/plan.server';

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

let mockUser: { uid: string } | null = { uid: 'owner-uid' };
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: mockUser, loading: false }),
}));

const mockRefresh = jest.fn();
let mockPlanState: { plan: PlanResponse | undefined; loading: boolean; error: string | null };
jest.mock('@/hooks/usePlan', () => ({
  usePlan: () => ({ ...mockPlanState, refresh: mockRefresh }),
}));

jest.mock('@/components/PageHeader', () => ({
  PageHeader: ({ currentPage }: { currentPage: string }) => <header>{currentPage}</header>,
}));
jest.mock('@/components/PageCascade', () => ({
  PageCascade: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
const TRIAL: PlanResponse = {
  ...FREE,
  plan: 'trial',
  standing: 'trialing',
  limits: { machines: null, sites: null },
  flags: ALL_FLAGS,
  activeMachinesThisMonth: 4,
};
const CORE: PlanResponse = { ...TRIAL, plan: 'core', standing: 'active', limits: { machines: null, sites: 1 }, flags: { ...NO_FLAGS, control: true } };
const PRO: PlanResponse = { ...TRIAL, plan: 'pro', standing: 'active' };
const OFF: PlanResponse = {
  enforced: false,
  reason: 'enforcement_off',
  plan: null,
  standing: null,
  limits: { machines: null, sites: null },
  flags: ALL_FLAGS,
  activeMachinesThisMonth: null,
};

function show(plan: PlanResponse | undefined, over: Partial<typeof mockPlanState> = {}) {
  mockPlanState = { plan, loading: false, error: null, ...over };
  return render(<PlanSettingsPage />);
}

function usage(label: string): string | null {
  return screen.getByText(label, { selector: 'dt' }).nextElementSibling?.textContent ?? null;
}

function upgradeButtons(): string[] {
  return screen.queryAllByRole('button', { name: /^upgrade to/ }).map((b) => b.textContent ?? '');
}

beforeEach(() => {
  mockUser = { uid: 'owner-uid' };
  mockPush.mockReset();
  mockRefresh.mockReset();
});

describe('/settings/plan', () => {
  it('says plans are not active during beta when they are off', () => {
    show(OFF);

    expect(screen.getByTestId('plans-not-active')).toHaveTextContent(
      "plans aren't active during beta, so every feature is included.",
    );
    expect(screen.queryByTestId('current-plan')).not.toBeInTheDocument();
    expect(upgradeButtons()).toEqual([]);
  });

  it('shows owlette free with its limits, what is left out, and both upgrades disabled', () => {
    show(FREE);

    const current = screen.getByTestId('current-plan');
    expect(current).toHaveTextContent('owlette free');
    expect(within(current).getByText('expired')).toBeInTheDocument();
    expect(usage('machine limit')).toBe('1');
    expect(usage('active this month')).toBe('1');
    expect(usage('site limit')).toBe('1');
    expect(within(current).getByText('roost').parentElement).toHaveTextContent('roost (not included)');

    expect(upgradeButtons()).toEqual(['upgrade to core', 'upgrade to pro']);
    for (const button of screen.getAllByRole('button', { name: /^upgrade to/ })) {
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription('upgrade opens soon');
    }
  });

  it('shows a pro trial as unlimited, with what happens when it ends', () => {
    show(TRIAL);

    const current = screen.getByTestId('current-plan');
    expect(current).toHaveTextContent('pro trial');
    expect(current).toHaveTextContent('falls back to owlette free unless you pick core or pro');
    expect(within(current).getByText('trialing')).toBeInTheDocument();
    expect(usage('machine limit')).toBe('unlimited');
    expect(usage('active this month')).toBe('4');
    expect(within(current).getByText('roost').parentElement).toHaveTextContent('roost (included)');
    expect(upgradeButtons()).toEqual(['upgrade to core', 'upgrade to pro']);
  });

  it('offers only pro on core', () => {
    show(CORE);

    expect(screen.getByTestId('current-plan')).toHaveTextContent('core');
    expect(usage('site limit')).toBe('1');
    expect(upgradeButtons()).toEqual(['upgrade to pro']);
  });

  it('offers no upgrade on pro', () => {
    show(PRO);

    expect(screen.getByTestId('current-plan')).toHaveTextContent('pro');
    expect(within(screen.getByTestId('current-plan')).getByText('active')).toBeInTheDocument();
    expect(upgradeButtons()).toEqual([]);
    expect(screen.queryByRole('heading', { name: 'upgrade' })).not.toBeInTheDocument();
  });

  it('offers a retry when the plan failed to load', () => {
    show(undefined, { error: 'failed to load plan (500)' });

    expect(screen.getByText('failed to load plan (500)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'try again' }));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('spins while the plan loads', () => {
    show(undefined, { loading: true });

    expect(screen.getByLabelText('loading')).toBeInTheDocument();
    expect(screen.queryByTestId('current-plan')).not.toBeInTheDocument();
  });

  it('sends a signed-out visitor to login', () => {
    mockUser = null;
    const { container } = show(FREE);

    expect(container).toBeEmptyDOMElement();
    expect(mockPush).toHaveBeenCalledWith('/login');
  });
});
