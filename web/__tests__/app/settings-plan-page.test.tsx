/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * /settings/plan: with plans off it says so and nothing else; when enforced it
 * shows its heading alone until the account overview is built; a failed read
 * offers a retry.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import PlanSettingsPage from '@/app/settings/plan/page';
import type { AccountPlanResponse } from '@/lib/planResponse';

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

let mockUser: { uid: string } | null = { uid: 'owner-uid' };
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: mockUser, loading: false }),
}));

const mockRefresh = jest.fn();
let mockPlanState: { plan: AccountPlanResponse | undefined; loading: boolean; error: string | null };
jest.mock('@/hooks/usePlan', () => ({
  usePlan: () => ({ ...mockPlanState, refresh: mockRefresh }),
}));

jest.mock('@/components/PageHeader', () => ({
  PageHeader: ({ currentPage }: { currentPage: string }) => <header>{currentPage}</header>,
}));
jest.mock('@/components/PageCascade', () => ({
  PageCascade: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const ENFORCED: AccountPlanResponse = {
  enforced: true,
  emailVerified: true,
  trial: { status: 'none', endsAt: null },
  sites: [],
  free: { sitesUsed: 0, sitesLimit: 1, machinesUsed: 0, machinesLimit: 1, liveMachines: [] },
  foundersRemaining: null,
  linkAvailable: false,
};
const OFF: AccountPlanResponse = { enforced: false, reason: 'enforcement_off' };

function show(plan: AccountPlanResponse | undefined, over: Partial<typeof mockPlanState> = {}) {
  mockPlanState = { plan, loading: false, error: null, ...over };
  return render(<PlanSettingsPage />);
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
  });

  it('shows the heading alone when plans are enforced', () => {
    show(ENFORCED);

    expect(screen.getByRole('heading', { name: 'plan' })).toBeInTheDocument();
    expect(screen.queryByTestId('plans-not-active')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
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
  });

  it('sends a signed-out visitor to login', () => {
    mockUser = null;
    const { container } = show(ENFORCED);

    expect(container).toBeEmptyDOMElement();
    expect(mockPush).toHaveBeenCalledWith('/login');
  });
});
