/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * /settings/plan: with plans off it says so and nothing else. When enforced it
 * is the account overview: the trial card in each of its states, how much of
 * owlette free is used, each owned site with a link to its billing section, and
 * the prices. It has no purchase action of its own. A `?link=` result from
 * linking a tridant account is shown once and dropped from the url; the list of
 * accounts to choose from comes out of the url, so it is read defensively.
 */
import React from 'react';
import { TextDecoder } from 'node:util';
import { fireEvent, render, screen, within } from '@testing-library/react';
import PlanSettingsPage from '@/app/settings/plan/page';
import type { AccountPlanOn, AccountPlanResponse, AccountPlanSite } from '@/lib/planResponse';
import { toast } from '@/lib/toast';

// jsdom has no TextDecoder.
Object.assign(globalThis, { TextDecoder });

const mockPush = jest.fn();
const mockReplace = jest.fn();
let mockSearch = new URLSearchParams();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useSearchParams: () => mockSearch,
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

const mockSend = jest.fn();
jest.mock('@/components/plan/TrialBanner', () => ({
  LINK_TRIDANT_HREF: '/api/auth/tridant/link?return=/settings/plan',
}));
jest.mock('@/hooks/useSendVerification', () => ({
  useSendVerification: () => ({ send: mockSend, sending: false }),
}));
jest.mock('@/components/plan/UpgradeGate', () => ({
  siteBillingPath: (siteId: string) => `/admin/sites/${siteId}?section=billing`,
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

jest.mock('@/components/PageHeader', () => ({
  PageHeader: ({ currentPage }: { currentPage: string }) => <header>{currentPage}</header>,
}));
jest.mock('@/components/PageCascade', () => ({
  PageCascade: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// local noon, so the day reads the same in any timezone.
const NOV_25 = new Date(2026, 10, 25, 12).getTime();
const NOV_1_UTC = Date.UTC(2026, 10, 1);
const DEC_1_UTC = Date.UTC(2026, 11, 1);

function site(over: Partial<AccountPlanSite> = {}): AccountPlanSite {
  return {
    siteId: 'site-a',
    name: 'gallery north',
    tier: 'free',
    standing: 'expired',
    inGoodStanding: false,
    billing: null,
    period: null,
    activeMachinesThisPeriod: 1,
    ...over,
  };
}

function enforced(over: Partial<AccountPlanOn> = {}): AccountPlanOn {
  return {
    enforced: true,
    emailVerified: true,
    trial: { status: 'none', endsAt: null },
    sites: [],
    free: { sitesUsed: 0, sitesLimit: 1, machinesUsed: 0, machinesLimit: 1, liveMachines: [] },
    siteCreation: { state: 'open', unpaidSite: null },
    foundersRemaining: null,
    linkAvailable: false,
    portalUrl: null,
    ...over,
  };
}
const OFF: AccountPlanResponse = { enforced: false, reason: 'enforcement_off' };

function show(plan: AccountPlanResponse | undefined, over: Partial<typeof mockPlanState> = {}) {
  mockPlanState = { plan, loading: false, error: null, ...over };
  return render(<PlanSettingsPage />);
}

function encodeOrgs(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

beforeEach(() => {
  mockUser = { uid: 'owner-uid' };
  mockSearch = new URLSearchParams();
  mockPush.mockReset();
  mockReplace.mockReset();
  mockRefresh.mockReset();
});

describe('/settings/plan', () => {
  it('says plans are not active during beta when they are off, and nothing else', () => {
    mockSearch = new URLSearchParams('link=failed&code=state_missing');
    show(OFF);

    expect(screen.getByTestId('plans-not-active')).toHaveTextContent(
      "plans aren't active during beta, so every feature is included.",
    );
    expect(screen.queryByTestId('trial-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('free-usage')).not.toBeInTheDocument();
    expect(screen.queryByTestId('link-failed')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
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
    const { container } = show(enforced());

    expect(container).toBeEmptyDOMElement();
    expect(mockPush).toHaveBeenCalledWith('/login');
  });

  describe('trial card', () => {
    function trialCard(over: Partial<AccountPlanOn>) {
      show(enforced(over));
      return screen.getByTestId('trial-card');
    }

    it('names the day a running trial ends', () => {
      const card = trialCard({ trial: { status: 'active', endsAt: NOV_25 } });

      expect(card).toHaveAttribute('data-trial-state', 'active');
      expect(card).toHaveTextContent('pro trial until nov 25, 2026');
      expect(within(card).queryByRole('button')).not.toBeInTheDocument();
      expect(within(card).queryByRole('link')).not.toBeInTheDocument();
    });

    it('asks an unverified account to verify, with the resend', () => {
      const card = trialCard({ emailVerified: false, trial: { status: 'unverified', endsAt: null } });

      expect(card).toHaveAttribute('data-trial-state', 'unverified');
      expect(card).toHaveTextContent('verify your email to start your 14-day pro trial');
      fireEvent.click(within(card).getByRole('button', { name: 'send verification email' }));
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('offers to link an email that already has a tridant account', () => {
      const card = trialCard({ trial: { status: 'link_required', endsAt: null }, linkAvailable: true });

      expect(card).toHaveAttribute('data-trial-state', 'link_required');
      expect(card).toHaveTextContent('this email already has a tridant account');
      expect(within(card).getByRole('link', { name: 'link it' })).toHaveAttribute(
        'href',
        '/api/auth/tridant/link?return=/settings/plan',
      );
    });

    it('points at support when linking is not available on this deployment', () => {
      const card = trialCard({ trial: { status: 'link_required', endsAt: null }, linkAvailable: false });

      expect(within(card).queryByRole('link', { name: 'link it' })).not.toBeInTheDocument();
      expect(within(card).getByRole('link', { name: 'contact support' })).toHaveAttribute(
        'href',
        'mailto:support@tridant.io',
      );
    });

    it('says a finished trial left the account on owlette free', () => {
      const card = trialCard({ trial: { status: 'ended', endsAt: NOV_25 } });

      expect(card).toHaveTextContent('your pro trial ended nov 25, 2026');
      expect(card).toHaveTextContent("a site you haven't upgraded is on owlette free.");
    });

    it('says no trial started for an account that was already paying', () => {
      const card = trialCard({ trial: { status: 'ended', endsAt: null } });

      expect(card).toHaveTextContent('no pro trial');
      expect(card).toHaveTextContent('owlette free');
    });

    it('says a trial that has not started leaves the account on owlette free', () => {
      const card = trialCard({ trial: { status: 'none', endsAt: null } });

      expect(card).toHaveAttribute('data-trial-state', 'none');
      expect(card).toHaveTextContent("your pro trial hasn't started");
      expect(card).toHaveTextContent('owlette free');
    });
  });

  it('shows how much of owlette free the account uses', () => {
    show(enforced({ free: { sitesUsed: 1, sitesLimit: 1, machinesUsed: 2, machinesLimit: null, liveMachines: [] } }));

    const usage = screen.getByTestId('free-usage');
    expect(within(usage).getByText('sites').nextElementSibling).toHaveTextContent('1 of 1');
    expect(within(usage).getByText('machines').nextElementSibling).toHaveTextContent('2 (unlimited)');
    expect(usage).toHaveTextContent(
      "the sites you own that aren't billed or in a trial share this allowance. every further site you create goes on core or pro.",
    );
  });

  describe('owned sites', () => {
    it('lists each site with its plan, period, active machines and a link to its billing section', () => {
      show(
        enforced({
          sites: [
            site(),
            site({
              siteId: 'site-b',
              name: 'gallery south',
              tier: 'pro',
              standing: 'active',
              inGoodStanding: true,
              billing: { tier: 'pro', founders: true, endsAt: null },
              period: { start: NOV_1_UTC, end: DEC_1_UTC },
              activeMachinesThisPeriod: 4,
            }),
          ],
        }),
      );

      const free = screen.getByTestId('plan-site-site-a');
      expect(free).toHaveTextContent('gallery north');
      expect(free).toHaveTextContent('owlette free');
      expect(free).toHaveTextContent('1 active machine this month');
      expect(within(free).getByRole('link', { name: 'billing for gallery north' })).toHaveAttribute(
        'href',
        '/admin/sites/site-a?section=billing',
      );

      const billed = screen.getByTestId('plan-site-site-b');
      expect(billed).toHaveTextContent('pro');
      expect(billed).toHaveTextContent('billing period nov 1 – nov 30');
      expect(billed).toHaveTextContent('4 active machines this period');
      expect(billed).not.toHaveTextContent('billed as');
      expect(within(billed).getByRole('link', { name: 'billing for gallery south' })).toHaveAttribute(
        'href',
        '/admin/sites/site-b?section=billing',
      );
    });

    it('says when a site is past due, stopping, or billed as another plan than it reads', () => {
      show(
        enforced({
          sites: [
            site({
              tier: 'trial',
              standing: 'past_due',
              inGoodStanding: true,
              billing: { tier: 'core', founders: false, endsAt: DEC_1_UTC },
              period: { start: NOV_1_UTC, end: DEC_1_UTC },
            }),
          ],
        }),
      );

      const row = screen.getByTestId('plan-site-site-a');
      expect(row).toHaveTextContent('pro trial');
      expect(row).toHaveTextContent('past due');
      expect(row).toHaveTextContent('billed as core');
      expect(row).toHaveTextContent('billed until nov 30');
    });

    it('shows a site whose plan is not enforced as unrestricted, with no plan badge', () => {
      show(
        enforced({
          sites: [
            site({ tier: null, standing: null, inGoodStanding: true, reason: 'unreachable', activeMachinesThisPeriod: null }),
          ],
        }),
      );

      const row = screen.getByTestId('plan-site-site-a');
      expect(row).toHaveTextContent("unrestricted: its plan couldn't be read just now");
      expect(row).not.toHaveTextContent('owlette free');
      expect(row.querySelector('[data-slot="badge"]')).toBeNull();
      expect(within(row).getByRole('link', { name: 'billing for gallery north' })).toBeInTheDocument();
    });

    it('says so when the account owns no site', () => {
      show(enforced());

      expect(screen.getByText("you don't own a site yet.")).toBeInTheDocument();
    });
  });

  describe('prices', () => {
    it('quotes each plan per active machine', () => {
      show(enforced());

      const prices = screen.getByTestId('plan-prices');
      expect(prices).toHaveTextContent('core$20/machine/month');
      expect(prices).toHaveTextContent('pro$60/machine/month, 3-machine minimum');
      expect(prices).toHaveTextContent('per active machine per month');
      expect(prices).not.toHaveTextContent('founders');
    });

    it('adds the founders price only where places are left', () => {
      show(enforced({ foundersRemaining: { core: 12, pro: 0 } }));

      const prices = screen.getByTestId('plan-prices');
      expect(prices).toHaveTextContent('founders price $10/machine/month, 12 places left');
      expect(prices).not.toHaveTextContent('$30/machine/month');
    });

    it('names the founders price an owner holds, places left or not', () => {
      show(enforced({ foundersRemaining: { core: 12, pro: 0 }, foundersHeld: { core: true, pro: true } }));

      const prices = screen.getByTestId('plan-prices');
      expect(prices).toHaveTextContent('core$20/machine/monthyour founders price $10/machine/month');
      expect(prices).toHaveTextContent('pro$60/machine/month, 3-machine minimumyour founders price $30/machine/month');
      expect(prices).not.toHaveTextContent('places left');
    });

    it('says where the invoices and the card are, linking the tridant portal in a new tab', () => {
      show(enforced({ portalUrl: 'https://id-staging.tridant.io' }));

      const prices = screen.getByTestId('plan-prices');
      expect(prices).toHaveTextContent('invoices and your card are in your tridant account.');
      const link = within(prices).getByRole('link', { name: 'your tridant account' });
      expect(link).toHaveAttribute('href', 'https://id-staging.tridant.io/billing');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('leaves that line out when the portal is not known', () => {
      show(enforced());

      const prices = screen.getByTestId('plan-prices');
      expect(prices).not.toHaveTextContent('invoices');
      expect(within(prices).queryByRole('link')).toBeNull();
    });
  });

  it('has no purchase action of its own', () => {
    show(enforced({ trial: { status: 'active', endsAt: NOV_25 }, sites: [site()] }));

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText(/upgrade opens soon/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      '/admin/sites/site-a?section=billing',
    ]);
  });

  describe('a ?link= result', () => {
    const LINK_REQUIRED = enforced({ trial: { status: 'link_required', endsAt: null }, linkAvailable: true });

    it('confirms a finished link, re-reads a plan it already had, and drops the result from the url', () => {
      mockSearch = new URLSearchParams('link=done');
      const { rerender } = show(LINK_REQUIRED);

      expect(toast.success).toHaveBeenCalledWith('your tridant account is linked');
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith('/settings/plan', { scroll: false });

      rerender(<PlanSettingsPage />);
      expect(toast.success).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledTimes(1);
    });

    it('does not start a second plan read beside the first one', () => {
      mockSearch = new URLSearchParams('link=done');
      show(undefined, { loading: true });

      expect(toast.success).toHaveBeenCalledWith('your tridant account is linked');
      expect(mockRefresh).not.toHaveBeenCalled();
      expect(mockReplace).toHaveBeenCalledWith('/settings/plan', { scroll: false });
    });

    it('lists the tridant accounts to choose from, each sending its id back through the link route', () => {
      mockSearch = new URLSearchParams({
        link: 'choose',
        orgs: encodeOrgs([
          { id: 'org_abc', name: 'north studio' },
          { id: 'org_x-y_9', name: 'süd & söhne <b>' },
        ]),
      });
      show(LINK_REQUIRED);

      const notice = screen.getByTestId('link-choose');
      expect(notice).toHaveTextContent('you own more than one tridant account. choose the one to link:');
      expect(within(notice).getByRole('link', { name: 'north studio' })).toHaveAttribute(
        'href',
        '/api/auth/tridant/link?return=/settings/plan&org=org_abc',
      );
      // a name is text, never markup.
      expect(within(notice).getByRole('link', { name: 'süd & söhne <b>' })).toHaveAttribute(
        'href',
        '/api/auth/tridant/link?return=/settings/plan&org=org_x-y_9',
      );
      expect(notice.querySelector('b')).toBeNull();
      expect(mockReplace).toHaveBeenCalledWith('/settings/plan', { scroll: false });
      expect(toast.success).not.toHaveBeenCalled();
    });

    it('drops entries that are not a tridant account, and caps the list at 20', () => {
      const good = Array.from({ length: 25 }, (_, i) => ({ id: `org_${i}`, name: `account ${i}` }));
      mockSearch = new URLSearchParams({
        link: 'choose',
        orgs: encodeOrgs([
          { id: 'javascript:alert(1)', name: 'bad scheme' },
          { id: 'org_ok&return=//evil.example', name: 'bad characters' },
          { id: `org_${'a'.repeat(65)}`, name: 'too long' },
          { id: 42, name: 'not a string' },
          null,
          'org_string',
          { id: 'org_noname' },
          ...good,
        ]),
      });
      show(LINK_REQUIRED);

      const links = within(screen.getByTestId('link-choose')).getAllByRole('link');
      expect(links).toHaveLength(20);
      // a missing name falls back to the id.
      expect(links[0]).toHaveTextContent('org_noname');
      expect(links[1]).toHaveTextContent('account 0');
      for (const link of links) {
        expect(link.getAttribute('href')).toMatch(
          /^\/api\/auth\/tridant\/link\?return=\/settings\/plan&org=org_[A-Za-z0-9_-]{1,64}$/,
        );
      }
    });

    it.each([
      ['base64 that is not base64', '!!!not base64!!!'],
      ['base64 that is not json', Buffer.from('{not json', 'utf8').toString('base64url')],
      ['bytes that are not utf-8', Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url')],
      ['json that is not a list', encodeOrgs({ id: 'org_abc', name: 'north studio' })],
      ['a list with no usable entry', encodeOrgs([{ id: 'nope' }])],
    ])('shows the failed message for %s', (_label, orgs) => {
      mockSearch = new URLSearchParams({ link: 'choose', orgs });
      show(LINK_REQUIRED);

      expect(screen.queryByTestId('link-choose')).not.toBeInTheDocument();
      expect(screen.getByTestId('link-failed')).toHaveTextContent('linking your tridant account failed. try again.');
    });

    it('shows the failed message when choose arrives with no list', () => {
      mockSearch = new URLSearchParams('link=choose');
      show(LINK_REQUIRED);

      expect(screen.getByTestId('link-failed')).toBeInTheDocument();
    });

    it('says when the tridant sign-in owns no tridant account', () => {
      mockSearch = new URLSearchParams('link=no_org');
      show(LINK_REQUIRED);

      expect(screen.getByTestId('link-no-org')).toHaveTextContent(
        "that tridant sign-in doesn't own a tridant account, so there was nothing to link.",
      );
      expect(mockReplace).toHaveBeenCalledWith('/settings/plan', { scroll: false });
    });

    it.each([
      ['org_not_owned', "you don't own that tridant account"],
      ['owner_required', "you don't own that tridant account"],
      ['id_token_not_fresh', 'more than 10 minutes old'],
      ['subject_linked_elsewhere', 'already linked to another tridant account'],
      ['access_denied', 'the tridant sign-in was cancelled'],
      ['state_missing', 'the link attempt expired'],
      ['state_mismatch', 'the link attempt expired'],
      ['session_mismatch', 'a different owlette account'],
    ])('explains a failed link with code %s in plain words', (code, words) => {
      mockSearch = new URLSearchParams({ link: 'failed', code });
      show(LINK_REQUIRED);

      const notice = screen.getByTestId('link-failed');
      expect(notice).toHaveTextContent(words);
      expect(notice).not.toHaveTextContent(code);
      expect(mockReplace).toHaveBeenCalledWith('/settings/plan', { scroll: false });
    });

    it('shows the code of a failure it has no sentence for', () => {
      mockSearch = new URLSearchParams('link=failed&code=token_exchange_failed');
      show(LINK_REQUIRED);

      expect(screen.getByTestId('link-failed')).toHaveTextContent(
        'linking your tridant account failed (token_exchange_failed). try again, or contact support with that code.',
      );
    });

    it.each([
      ['no code', 'link=failed'],
      ['a code that is not a code', `link=failed&code=${encodeURIComponent('<img src=x onerror=1>')}`],
      ['a property name of every object', 'link=failed&code=constructor'],
    ])('shows a plain failure for %s', (_label, query) => {
      mockSearch = new URLSearchParams(query);
      show(LINK_REQUIRED);

      const notice = screen.getByTestId('link-failed');
      expect(notice).toHaveTextContent(/^linking your tridant account failed/);
      expect(notice).not.toHaveTextContent('onerror');
      expect(notice).not.toHaveTextContent('function');
    });

    it('ignores a link value it does not know', () => {
      mockSearch = new URLSearchParams('link=surprise');
      show(LINK_REQUIRED);

      expect(screen.queryByTestId('link-failed')).not.toBeInTheDocument();
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('keeps the notice after the url is cleaned', () => {
      mockSearch = new URLSearchParams('link=no_org');
      const { rerender } = show(LINK_REQUIRED);

      mockSearch = new URLSearchParams();
      rerender(<PlanSettingsPage />);

      expect(screen.getByTestId('link-no-org')).toBeInTheDocument();
      expect(mockReplace).toHaveBeenCalledTimes(1);
    });
  });
});
