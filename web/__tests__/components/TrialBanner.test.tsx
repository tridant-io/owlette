/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * TrialBanner: hidden while the account plan loads, with plans off, when every
 * owned site is on core or pro, and for a user who owns no site. An owner gets
 * one line: the trial and the day it ends, the prompt to verify their email
 * (with the resend, and a plan re-read once the tab comes back verified), or
 * the notice that their email already has a tridant account. On a page about
 * one site, anyone who views a site on owlette free is told so: its owner with
 * a link to the site's billing, anyone else to ask the owner. A page about no
 * site never says owlette free. A dismissal holds for seven days on the shared
 * device-prefs doc, and nothing shows until that stored value has been read.
 * Dismissing the prompt to verify leaves VerifyEmailBanner in its place: never
 * both, never neither.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  DISMISS_DAYS,
  DISMISSED_AT_FIELD,
  LINK_TRIDANT_HREF,
  planBannerKind,
  TrialBanner,
} from '@/components/plan/TrialBanner';
import type { AccountPlanOn, AccountPlanResponse, SiteTier } from '@/lib/planResponse';
import type { SitePlanResponse } from '@/lib/sitePlanResponse';
import { toast } from '@/lib/toast';

let mockPlan: AccountPlanResponse | undefined;
const mockRefresh = jest.fn(async () => undefined);
jest.mock('@/hooks/usePlan', () => ({
  usePlan: () => ({ plan: mockPlan, loading: false, error: null, refresh: mockRefresh }),
}));

let mockSitePlan: SitePlanResponse | undefined;
const mockUseSitePlan = jest.fn();
jest.mock('@/hooks/useSitePlan', () => ({
  useSitePlan: (siteId: string | undefined) => {
    mockUseSitePlan(siteId);
    return { plan: siteId ? mockSitePlan : undefined };
  },
}));

interface MockUser {
  uid: string;
  email: string;
  emailVerified?: boolean;
  providerData?: { providerId: string }[];
}
const OWNER: MockUser = { uid: 'owner-uid', email: 'owner@example.com' };
// what VerifyEmailBanner asks to verify: a password account that has not
const UNVERIFIED_OWNER: MockUser = { ...OWNER, emailVerified: false, providerData: [{ providerId: 'password' }] };
let mockUser = OWNER;
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: mockUser }),
}));

interface FakeAuthUser {
  emailVerified: boolean;
  reload: () => Promise<void>;
}
const mockFirebaseAuth: { currentUser: FakeAuthUser | null } = { currentUser: null };
jest.mock('@/lib/firebase', () => ({
  get auth() {
    return mockFirebaseAuth;
  },
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
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

const fetchMock = jest.fn();
const DAY_MS = 24 * 60 * 60 * 1000;
// local noon, so the day reads the same in any timezone.
const TRIAL_END = new Date(2026, 10, 25, 12).getTime();

/** the account plan of a user who owns one site on each of `tiers`. */
function owning(tiers: SiteTier[], over: Partial<AccountPlanOn> = {}): AccountPlanOn {
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
    siteCreation: { state: 'open', unpaidSite: null },
    foundersRemaining: null,
    linkAvailable: false,
    portalUrl: null,
    ...over,
  };
}

const FREE = owning(['free']);
const TRIAL = owning(['trial'], { trial: { status: 'active', endsAt: TRIAL_END } });
const UNVERIFIED = owning(['free'], { emailVerified: false, trial: { status: 'unverified', endsAt: null } });
const LINK_REQUIRED = owning(['free'], { trial: { status: 'link_required', endsAt: null } });
const OFF: AccountPlanResponse = { enforced: false, reason: 'enforcement_off' };

/** the page's site, the one FREE owns. */
const SITE = 'site-0';
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
/** the site plan of a site on owlette free, as its owner reads it. */
const FREE_SITE: SitePlanResponse = {
  enforced: true,
  tier: 'free',
  standing: 'expired',
  inGoodStanding: false,
  flags: NO_FLAGS,
  billing: null,
  period: null,
  isOwner: true,
  billedByPreviousOwner: false,
  freeMachines: null,
};
const CORE_SITE: SitePlanResponse = {
  ...FREE_SITE,
  tier: 'core',
  standing: 'active',
  inGoodStanding: true,
  flags: { ...NO_FLAGS, control: true },
  billing: { tier: 'core', founders: false, endsAt: null },
};

beforeEach(() => {
  mockPlan = FREE;
  mockSitePlan = FREE_SITE;
  mockUseSitePlan.mockClear();
  mockUser = OWNER;
  mockDismissal = { value: 0, ready: true };
  mockFirebaseAuth.currentUser = null;
  mockSetDismissedAt.mockReset();
  mockUseDevicePrefNumber.mockClear();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe('TrialBanner', () => {
  it.each([
    ['the plan is loading or failed', undefined],
    ['plans are off', OFF],
    ['every owned site is on core or pro', owning(['core', 'pro'])],
    ['the user owns no site', owning([])],
    ['an unverified user owns no site', owning([], { trial: { status: 'unverified', endsAt: null } })],
  ])('renders nothing when %s, and reads no dismissal', (_label, plan) => {
    mockPlan = plan;
    const { container } = render(<TrialBanner />);

    expect(container).toBeEmptyDOMElement();
    expect(mockUseDevicePrefNumber).not.toHaveBeenCalled();
  });

  it("tells the owner of the site on the page that it is on owlette free, with a link to its billing", () => {
    render(<TrialBanner siteId={SITE} />);

    const banner = screen.getByTestId('trial-banner');
    expect(banner).toHaveAttribute('data-banner-state', 'free');
    expect(banner).toHaveTextContent('this site is on owlette free — 1 machine, monitoring only.');
    expect(screen.getByText('— 1 machine, monitoring only')).toHaveClass('hidden', 'sm:inline');
    expect(banner).not.toHaveTextContent('ask the site owner');
    expect(screen.getByRole('link', { name: 'upgrade' })).toHaveAttribute('href', `/admin/sites/${SITE}?section=billing`);
    expect(mockUseSitePlan).toHaveBeenCalledWith(SITE);
  });

  it('tells anyone else on a site on owlette free to ask its owner, with no link', () => {
    mockPlan = owning([]);
    mockSitePlan = { ...FREE_SITE, isOwner: false };
    render(<TrialBanner siteId={SITE} />);

    const banner = screen.getByTestId('trial-banner');
    expect(banner).toHaveAttribute('data-banner-state', 'free');
    expect(banner).toHaveTextContent(
      'this site is on owlette free — 1 machine, monitoring only. ask the site owner to upgrade this site.',
    );
    expect(screen.getByText('ask the site owner to upgrade this site.', { exact: false })).toHaveClass(
      'hidden',
      'sm:inline',
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('says nothing of owlette free on a page about no site, or about a site on core', () => {
    const { container, rerender } = render(<TrialBanner />);
    expect(container).toBeEmptyDOMElement();
    expect(mockUseSitePlan).toHaveBeenCalledWith(undefined);

    mockSitePlan = CORE_SITE;
    rerender(<TrialBanner siteId={SITE} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('tells an owner on a pro trial the day it ends', () => {
    mockPlan = TRIAL;
    render(<TrialBanner />);

    const banner = screen.getByTestId('trial-banner');
    expect(banner).toHaveAttribute('data-banner-state', 'trial');
    expect(banner).toHaveTextContent("you're on a pro trial until nov 25.");
    expect(screen.getByText("you're on a")).toHaveClass('hidden', 'sm:inline');
    expect(screen.getByRole('link', { name: 'view plan' })).toHaveAttribute('href', '/settings/plan');
  });

  it('names the trial without a date when the account has none to give', () => {
    mockPlan = owning(['trial']);
    render(<TrialBanner />);

    expect(screen.getByTestId('trial-banner')).toHaveTextContent("you're on a pro trial.");
  });

  describe('with an unverified email', () => {
    beforeEach(() => {
      mockPlan = UNVERIFIED;
    });

    it('says verifying starts the trial, in place of the free line', () => {
      render(<TrialBanner />);

      const banner = screen.getByTestId('trial-banner');
      expect(banner).toHaveAttribute('data-banner-state', 'unverified');
      expect(screen.getByText('verify your email to start your 14-day pro trial.')).toHaveClass('hidden', 'sm:inline');
      expect(screen.getByText('verify to start your pro trial.')).toHaveClass('sm:hidden');
      expect(banner).not.toHaveTextContent('owlette free');
    });

    it('resends the verification email', async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 204 });
      render(<TrialBanner />);

      fireEvent.click(screen.getByRole('button', { name: 'send verification email' }));

      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith('verification email sent', {
          description: 'check owner@example.com',
        }),
      );
      expect(fetchMock).toHaveBeenCalledWith('/api/auth/verify-email', { method: 'POST' });
    });

    it('shows the problem detail when the resend is refused', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({ detail: 'try again in 600 seconds.' }) });
      render(<TrialBanner />);

      fireEvent.click(screen.getByRole('button', { name: 'send verification email' }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith('could not send the email', {
          description: 'try again in 600 seconds.',
        }),
      );
    });

    it('re-reads the plan once when the tab comes back verified', async () => {
      const current: FakeAuthUser = {
        emailVerified: false,
        reload: jest.fn(async () => {
          current.emailVerified = true;
        }),
      };
      mockFirebaseAuth.currentUser = current;
      render(<TrialBanner />);

      // a tab coming back fires both.
      await act(async () => {
        fireEvent.focus(window);
        fireEvent(document, new Event('visibilitychange'));
      });

      await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
      expect(current.reload).toHaveBeenCalledTimes(1);
    });

    it('re-reads the plan after verification even while dismissed', async () => {
      mockDismissal = { value: Date.now() - DAY_MS, ready: true };
      const current: FakeAuthUser = {
        emailVerified: false,
        reload: jest.fn(async () => {
          current.emailVerified = true;
        }),
      };
      mockFirebaseAuth.currentUser = current;
      const { container } = render(<TrialBanner />);
      expect(container).toBeEmptyDOMElement();

      await act(async () => {
        fireEvent.focus(window);
      });

      await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    });

    it('is the only prompt to verify while it is up', () => {
      mockUser = UNVERIFIED_OWNER;
      render(<TrialBanner />);

      expect(screen.getByTestId('trial-banner')).toHaveAttribute('data-banner-state', 'unverified');
      expect(screen.queryByTestId('verify-email-banner')).not.toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'send verification email' })).toHaveLength(1);
    });

    it('leaves the plain prompt to verify in its place once dismissed', () => {
      mockUser = UNVERIFIED_OWNER;
      render(<TrialBanner />);

      fireEvent.click(screen.getByRole('button', { name: 'dismiss' }));

      expect(screen.queryByTestId('trial-banner')).not.toBeInTheDocument();
      expect(screen.getByTestId('verify-email-banner')).toHaveTextContent('please verify your email address.');
      expect(screen.getAllByRole('button', { name: 'send verification email' })).toHaveLength(1);
    });

    it(`keeps the plain prompt up for the ${DISMISS_DAYS} days the dismissal holds`, () => {
      mockUser = UNVERIFIED_OWNER;
      mockDismissal = { value: Date.now() - DAY_MS, ready: true };
      render(<TrialBanner />);

      expect(screen.queryByTestId('trial-banner')).not.toBeInTheDocument();
      expect(screen.getByTestId('verify-email-banner')).toBeInTheDocument();
    });

    it('leaves the plan alone while the email is still unverified', async () => {
      const current: FakeAuthUser = { emailVerified: false, reload: jest.fn(async () => undefined) };
      mockFirebaseAuth.currentUser = current;
      render(<TrialBanner />);

      await act(async () => {
        fireEvent.focus(window);
      });

      expect(current.reload).toHaveBeenCalledTimes(1);
      expect(mockRefresh).not.toHaveBeenCalled();
    });
  });

  it('does not watch for verification in any other state', async () => {
    const current: FakeAuthUser = { emailVerified: true, reload: jest.fn(async () => undefined) };
    mockFirebaseAuth.currentUser = current;
    render(<TrialBanner siteId={SITE} />);

    await act(async () => {
      fireEvent.focus(window);
    });

    expect(current.reload).not.toHaveBeenCalled();
  });

  it('offers to link when the email already has a tridant account', () => {
    mockPlan = { ...LINK_REQUIRED, linkAvailable: true };
    render(<TrialBanner />);

    const banner = screen.getByTestId('trial-banner');
    expect(banner).toHaveAttribute('data-banner-state', 'link');
    expect(screen.getByText('this email already has a tridant account.')).toHaveClass('hidden', 'sm:inline');
    expect(screen.getByRole('link', { name: 'link it' })).toHaveAttribute('href', LINK_TRIDANT_HREF);
  });

  it('points at the plan page when linking is not available on this deployment', () => {
    mockPlan = LINK_REQUIRED;
    render(<TrialBanner />);

    expect(screen.queryByRole('link', { name: 'link it' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'view plan' })).toHaveAttribute('href', '/settings/plan');
  });

  it('stores the dismissal on the device-prefs doc and hides', () => {
    const before = Date.now();
    const { container } = render(<TrialBanner siteId={SITE} />);

    fireEvent.click(screen.getByRole('button', { name: 'dismiss' }));

    expect(mockUseDevicePrefNumber).toHaveBeenCalledWith(DISMISSED_AT_FIELD, 0, 0, Number.MAX_SAFE_INTEGER);
    expect(mockSetDismissedAt).toHaveBeenCalledTimes(1);
    expect(mockSetDismissedAt.mock.calls[0][0]).toBeGreaterThanOrEqual(before);
    expect(container).toBeEmptyDOMElement();
  });

  it(`stays hidden for ${DISMISS_DAYS} days after a dismissal`, () => {
    mockDismissal = { value: Date.now() - (DISMISS_DAYS * DAY_MS - 60_000), ready: true };
    const { container } = render(<TrialBanner siteId={SITE} />);
    expect(container).toBeEmptyDOMElement();
  });

  it(`comes back once ${DISMISS_DAYS} days have passed`, () => {
    mockDismissal = { value: Date.now() - (DISMISS_DAYS * DAY_MS + 60_000), ready: true };
    render(<TrialBanner siteId={SITE} />);
    expect(screen.getByTestId('trial-banner')).toBeInTheDocument();
  });

  it('ignores a dismissal stamped in the future', () => {
    mockDismissal = { value: Date.now() + DAY_MS, ready: true };
    render(<TrialBanner siteId={SITE} />);
    expect(screen.getByTestId('trial-banner')).toBeInTheDocument();
  });

  it('renders nothing until the stored dismissal has been read', () => {
    mockDismissal = { value: 0, ready: false };
    const { container } = render(<TrialBanner siteId={SITE} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('puts no prompt to verify in place of any other dismissed state', () => {
    mockUser = UNVERIFIED_OWNER;
    mockDismissal = { value: Date.now() - DAY_MS, ready: true };
    const { container } = render(<TrialBanner siteId={SITE} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('planBannerKind', () => {
  it.each([
    ['no plan', undefined, null],
    ['plans off', OFF, null],
    ['no owned site', owning([], { trial: { status: 'link_required', endsAt: null } }), null],
    ['an unverified email', UNVERIFIED, 'unverified'],
    ['an email with a tridant account', LINK_REQUIRED, 'link'],
    ['a site in the trial', owning(['pro', 'trial', 'free'], { trial: TRIAL.trial }), 'trial'],
    ['an owned free site, on a page about no site', owning(['core', 'free']), null],
    ['only billed sites', owning(['core', 'pro']), null],
    ['only a site whose plan is not enforced', { ...FREE, sites: [{ ...FREE.sites[0], tier: null }] }, null],
  ] as const)('is right for %s', (_label, plan, kind) => {
    expect(planBannerKind(plan as AccountPlanResponse | undefined)).toBe(kind);
  });

  it.each([
    ['the site on the page is on owlette free', owning(['core']), FREE_SITE, 'free'],
    ['a member of a site on owlette free who owns none', owning([]), { ...FREE_SITE, isOwner: false }, 'free'],
    ['the account plan unread and the site on owlette free', undefined, FREE_SITE, 'free'],
    ['the site on the page is on core', owning(['free']), CORE_SITE, null],
    ["the site on the page has no plan enforced", owning(['free']), { ...FREE_SITE, enforced: false, tier: null }, null],
    ['a trial, whatever the site on the page', owning(['trial'], { trial: TRIAL.trial }), FREE_SITE, 'trial'],
    ['an unverified email, whatever the site on the page', UNVERIFIED, FREE_SITE, 'unverified'],
  ] as const)('is right for %s', (_label, plan, site, kind) => {
    expect(planBannerKind(plan as AccountPlanResponse | undefined, site as SitePlanResponse)).toBe(kind);
  });
});
