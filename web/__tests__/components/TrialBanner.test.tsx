/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * TrialBanner: hidden while the account plan loads, with plans off, when every
 * owned site is on core or pro, and for a user who owns no site; an owned site
 * on a pro trial or on owlette free gets one line linking to /settings/plan. A
 * dismissal holds for seven days on the shared device-prefs doc, and nothing
 * shows until that stored value has been read.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { DISMISS_DAYS, DISMISSED_AT_FIELD, TrialBanner } from '@/components/plan/TrialBanner';
import type { AccountPlanOn, AccountPlanResponse, SiteTier } from '@/lib/planResponse';

let mockPlan: AccountPlanResponse | undefined;
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

/** the account plan of a user who owns one site on each of `tiers`. */
function owning(...tiers: SiteTier[]): AccountPlanOn {
  return {
    enforced: true,
    emailVerified: true,
    trial: { status: 'none', endsAt: null },
    sites: tiers.map((tier, i) => ({
      siteId: `site-${i}`,
      name: `site ${i}`,
      tier,
      standing: tier === 'free' ? 'expired' : tier === 'trial' ? 'trialing' : 'active',
      inGoodStanding: tier !== 'free',
      billing: null,
      period: null,
      activeMachinesThisPeriod: 1,
    })),
    free: { sitesUsed: 0, sitesLimit: 1, machinesUsed: 0, machinesLimit: 1, liveMachines: [] },
    foundersRemaining: null,
    linkAvailable: false,
  };
}

const FREE = owning('free');
const TRIAL = owning('trial');
const OFF: AccountPlanResponse = { enforced: false, reason: 'enforcement_off' };

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
    ['every owned site is on core or pro', owning('core', 'pro')],
    ['the user owns no site', owning()],
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
