/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * TrialBanner: hidden while the plan loads, with plans off and on core or pro;
 * a pro trial and owlette free each get one line linking to /settings/plan. A
 * dismissal holds for seven days on the shared device-prefs doc, and nothing
 * shows until that stored value has been read.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { DISMISS_DAYS, DISMISSED_AT_FIELD, TrialBanner } from '@/components/plan/TrialBanner';
import type { PlanResponse } from '@/lib/plan.server';

let mockPlan: PlanResponse | undefined;
jest.mock('@/hooks/usePlan', () => ({
  usePlan: () => ({ plan: mockPlan, loading: false, error: null, refresh: jest.fn() }),
}));

// stateful like the real hook: a set value comes back on the next render.
const mockSetDismissedAt = jest.fn();
const mockUseDevicePrefNumber = jest.fn();
let mockDismissal: { value: number; ready: boolean };
jest.mock('@/hooks/useDevicePrefFlag', () => {
  const { useState } = jest.requireActual<typeof import('react')>('react');
  return {
    useDevicePrefNumber: (...args: unknown[]) => {
      mockUseDevicePrefNumber(...args);
      const [value, setValue] = useState(mockDismissal.value);
      return {
        value,
        ready: mockDismissal.ready,
        setValue: (next: number) => {
          mockSetDismissedAt(next);
          setValue(next);
        },
      };
    },
  };
});

const DAY_MS = 24 * 60 * 60 * 1000;
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
const TRIAL: PlanResponse = { ...FREE, plan: 'trial', standing: 'trialing', flags: ALL_FLAGS };
const CORE: PlanResponse = { ...FREE, plan: 'core', standing: 'active', flags: { ...NO_FLAGS, control: true } };
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

beforeEach(() => {
  mockPlan = FREE;
  mockDismissal = { value: 0, ready: true };
  mockSetDismissedAt.mockReset();
  mockUseDevicePrefNumber.mockClear();
});

describe('TrialBanner', () => {
  it.each([
    ['the plan is loading or failed', undefined],
    ['plans are off', OFF],
    ['on core', CORE],
    ['on pro', PRO],
  ])('renders nothing when %s, and reads no dismissal', (_label, plan) => {
    mockPlan = plan;
    const { container } = render(<TrialBanner />);

    expect(container).toBeEmptyDOMElement();
    expect(mockUseDevicePrefNumber).not.toHaveBeenCalled();
  });

  it('tells a payer on owlette free what it covers, with an upgrade link', () => {
    render(<TrialBanner />);

    const banner = screen.getByTestId('trial-banner');
    expect(banner).toHaveAttribute('data-banner-state', 'free');
    expect(banner).toHaveTextContent("you're on owlette free — 1 machine, monitoring only.");
    expect(screen.getByRole('link', { name: 'upgrade' })).toHaveAttribute('href', '/settings/plan');
  });

  it('tells a payer on a pro trial, without a countdown', () => {
    mockPlan = TRIAL;
    render(<TrialBanner />);

    const banner = screen.getByTestId('trial-banner');
    expect(banner).toHaveAttribute('data-banner-state', 'trial');
    expect(banner).toHaveTextContent("you're on a pro trial.");
    expect(banner).not.toHaveTextContent(/days? left/);
    expect(screen.getByRole('link', { name: 'view plan' })).toHaveAttribute('href', '/settings/plan');
  });

  it('stores the dismissal on the device-prefs doc and hides', () => {
    const before = Date.now();
    const { container } = render(<TrialBanner />);

    fireEvent.click(screen.getByRole('button', { name: 'dismiss' }));

    expect(mockUseDevicePrefNumber).toHaveBeenCalledWith(DISMISSED_AT_FIELD, 0, 0, Number.MAX_SAFE_INTEGER);
    expect(mockSetDismissedAt).toHaveBeenCalledTimes(1);
    expect(mockSetDismissedAt.mock.calls[0][0]).toBeGreaterThanOrEqual(before);
    expect(container).toBeEmptyDOMElement();
  });

  it(`stays hidden for ${DISMISS_DAYS} days after a dismissal`, () => {
    mockDismissal = { value: Date.now() - (DISMISS_DAYS * DAY_MS - 60_000), ready: true };
    const { container } = render(<TrialBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it(`comes back once ${DISMISS_DAYS} days have passed`, () => {
    mockDismissal = { value: Date.now() - (DISMISS_DAYS * DAY_MS + 60_000), ready: true };
    render(<TrialBanner />);
    expect(screen.getByTestId('trial-banner')).toBeInTheDocument();
  });

  it('ignores a dismissal stamped in the future', () => {
    mockDismissal = { value: Date.now() + DAY_MS, ready: true };
    render(<TrialBanner />);
    expect(screen.getByTestId('trial-banner')).toBeInTheDocument();
  });

  it('renders nothing until the stored dismissal has been read', () => {
    mockDismissal = { value: 0, ready: false };
    const { container } = render(<TrialBanner />);
    expect(container).toBeEmptyDOMElement();
  });
});
