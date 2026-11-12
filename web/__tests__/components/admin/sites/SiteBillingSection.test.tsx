/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * site settings → billing: each state of a site's plan (loading, unreadable,
 * unrestricted, owlette free, trial, billed, stopping, past due, billed to the
 * previous owner, which the plan says and a refusal can too), the owner's
 * actions on it (upgrade, switch plan, stop, resume), the link to the tridant
 * portal, and the return from checkout, which is confirmed every 2 s for up to
 * 30 s and then dropped from the url. the plan picker is a stub with its own
 * test.
 */

import React from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AccountPlanOn, AccountPlanResponse, AccountPlanSite } from '@/lib/planResponse';
import type { SitePlanResponse } from '@/lib/sitePlanResponse';

const mockReplace = jest.fn();
// one object, as next's router is: the checkout effect depends on it
const mockRouter = { replace: mockReplace, push: jest.fn() };
let mockSearch = '';
jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

let mockSitePlan: { plan: SitePlanResponse | undefined; loading: boolean; error: string | null };
const mockRefresh = jest.fn();
const mockUseSitePlan = jest.fn();
jest.mock('@/hooks/useSitePlan', () => ({
  useSitePlan: (siteId: string) => {
    mockUseSitePlan(siteId);
    return { ...mockSitePlan, refresh: mockRefresh };
  },
}));

let mockAccount: AccountPlanResponse | undefined;
jest.mock('@/hooks/usePlan', () => ({
  usePlan: () => ({ plan: mockAccount }),
}));

const mockUpgrade = jest.fn();
const mockStop = jest.fn();
const mockConfirmCheckout = jest.fn();
jest.mock('@/hooks/useSiteBilling', () => ({
  useSiteBilling: () => ({ upgrade: mockUpgrade, stop: mockStop, confirmCheckout: mockConfirmCheckout }),
}));

interface PickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  site: { id: string; name: string };
  current?: 'core' | 'pro';
}
jest.mock('@/components/plan/UpgradeSiteDialog', () => ({
  UpgradeSiteDialog: ({ open, site, current }: PickerProps) =>
    open ? <div data-testid="plan-picker" data-site={site.id} data-current={current ?? ''} /> : null,
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

import { SiteBillingSection } from '@/components/admin/sites/SiteBillingSection';
import { toast } from '@/lib/toast';

const assign = jest.fn();

beforeAll(() => {
  // jsdom's own location would attempt a real navigation and warn
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { assign, href: 'http://localhost/admin/sites/site-a', origin: 'http://localhost' },
  });
});

/** as the section writes a date: "nov 1, 2026" in every browser language. */
function day(ms: number, timeZone?: 'UTC'): string {
  return new Date(ms)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone })
    .toLowerCase();
}

const NOV_1 = Date.UTC(2026, 10, 1);
const DEC_1 = Date.UTC(2026, 11, 1);
// a period is named by its first and last day in UTC, wherever the viewer is
const NOV_30 = day(Date.UTC(2026, 10, 30, 12), 'UTC');
const PERIOD = `${day(Date.UTC(2026, 10, 1, 12), 'UTC')} to ${NOV_30}`;
const FAR = Date.UTC(2099, 0, 1);
const TRIAL_ENDS = Date.UTC(2099, 5, 15, 12);

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

const FREE: SitePlanResponse = {
  enforced: true,
  tier: 'free',
  standing: 'expired',
  inGoodStanding: false,
  flags: NO_FLAGS,
  billing: null,
  period: null,
  isOwner: true,
  billedByPreviousOwner: false,
};
const TRIAL: SitePlanResponse = { ...FREE, tier: 'trial', standing: 'trialing', inGoodStanding: true, flags: ALL_FLAGS };
const PRO: SitePlanResponse = {
  ...FREE,
  tier: 'pro',
  standing: 'active',
  inGoodStanding: true,
  flags: ALL_FLAGS,
  billing: { tier: 'pro', founders: true, endsAt: null },
  period: { start: NOV_1, end: DEC_1 },
};
const CORE: SitePlanResponse = {
  ...PRO,
  tier: 'core',
  flags: { ...NO_FLAGS, control: true },
  billing: { tier: 'core', founders: false, endsAt: null },
};
// stopped, and still running to a period end far ahead of the test's clock
const STOPPING: SitePlanResponse = {
  ...PRO,
  billing: { tier: 'pro', founders: true, endsAt: FAR },
  period: { start: NOV_1, end: FAR },
};
const FAR_LAST_DAY = day(FAR - 1, 'UTC');
const OFF: SitePlanResponse = {
  enforced: false,
  reason: 'unreachable',
  tier: null,
  standing: null,
  inGoodStanding: true,
  flags: ALL_FLAGS,
  billing: null,
  period: null,
  isOwner: true,
  billedByPreviousOwner: false,
};

function owned(activeMachinesThisPeriod: number | null): AccountPlanSite {
  return {
    siteId: 'site-a',
    name: 'Alpha',
    tier: 'pro',
    standing: 'active',
    inGoodStanding: true,
    billing: null,
    period: null,
    activeMachinesThisPeriod,
  };
}

const ACCOUNT: AccountPlanOn = {
  enforced: true,
  emailVerified: true,
  trial: { status: 'active', endsAt: TRIAL_ENDS },
  sites: [owned(2)],
  free: { sitesUsed: 0, sitesLimit: 1, machinesUsed: 0, machinesLimit: 1, liveMachines: [] },
  foundersRemaining: { core: 0, pro: 0 },
  linkAvailable: true,
  portalUrl: null,
};

const SITE = { id: 'site-a', name: 'Alpha' };
const refused = (code: string, detail: string, status = 409) => ({ ok: false, status, code, detail });

beforeEach(() => {
  mockSearch = '';
  mockSitePlan = { plan: FREE, loading: false, error: null };
  mockAccount = ACCOUNT;
  // clearMocks keeps a queued answer, and one left over would land in the next test
  mockUpgrade.mockReset();
  mockStop.mockReset();
  mockConfirmCheckout.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

function show(plan?: SitePlanResponse) {
  if (plan) mockSitePlan = { plan, loading: false, error: null };
  const user = userEvent.setup();
  render(<SiteBillingSection site={SITE} />);
  return user;
}

const panel = () => screen.getByRole('region', { name: 'billing' });
const buttons = () => within(panel()).queryAllByRole('button').map((button) => button.textContent);

describe('reading the plan', () => {
  it("is a panel that reads this site's plan", () => {
    show();

    expect(within(panel()).getByRole('heading', { level: 2 })).toHaveAttribute('id', 'site-section-billing');
    expect(panel()).toHaveTextContent("this site's plan, and what you are billed for it.");
    expect(mockUseSitePlan).toHaveBeenCalledWith('site-a');
  });

  it('says it is loading, with nothing to act on', () => {
    mockSitePlan = { plan: undefined, loading: true, error: null };
    show();

    expect(screen.getByRole('status')).toHaveTextContent("loading this site's plan…");
    expect(buttons()).toEqual([]);
  });

  it('says the plan could not be read, with the reason and a way to ask again', async () => {
    mockSitePlan = { plan: undefined, loading: false, error: 'failed to load plan (500)' };
    const user = show();

    expect(screen.getByTestId('billing-error')).toHaveTextContent(
      "could not read this site's plan. failed to load plan (500)",
    );
    expect(buttons()).toEqual(['try again']);
    await user.click(screen.getByRole('button', { name: 'try again' }));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('says nothing is limited, and offers no change, while the plan is not enforced for the site', () => {
    show(OFF);

    expect(screen.getByTestId('billing-unrestricted')).toHaveTextContent(
      "this site's plan can't be read right now, so nothing on it is limited and its billing can't be changed here.",
    );
    expect(buttons()).toEqual(['try again']);
  });
});

describe('a site on owlette free', () => {
  it('says what owlette free covers, and opens the plan picker to upgrade', async () => {
    const user = show(FREE);

    expect(within(panel()).getByText('owlette free')).toBeInTheDocument();
    expect(panel()).toHaveTextContent(
      'this site is on owlette free. it covers 1 machine and 1 site, with live status, metrics, crash-restart and updates.',
    );
    expect(buttons()).toEqual(['upgrade']);
    expect(screen.queryByTestId('plan-picker')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'upgrade' }));

    const picker = screen.getByTestId('plan-picker');
    expect(picker).toHaveAttribute('data-site', 'site-a');
    expect(picker).toHaveAttribute('data-current', '');
  });

  it('reads a site whose billing ran out as free again', () => {
    show({ ...FREE, billing: { tier: 'pro', founders: false, endsAt: 1_000 } });

    expect(within(panel()).getByText('owlette free')).toBeInTheDocument();
    expect(panel()).not.toHaveTextContent('billed until');
    expect(buttons()).toEqual(['upgrade']);
  });
});

describe('a site under the trial', () => {
  it("says when the trial ends, from the account plan, and what follows", () => {
    show(TRIAL);

    expect(within(panel()).getByText('pro')).toBeInTheDocument();
    expect(within(panel()).getByText(`trial until ${day(TRIAL_ENDS)}`)).toBeInTheDocument();
    expect(panel()).toHaveTextContent(
      `this site is on the pro trial until ${day(TRIAL_ENDS)}. when the trial ends it goes to owlette free, unless you upgrade it.`,
    );
    expect(buttons()).toEqual(['upgrade']);
  });

  it('names no date while the account plan has none', () => {
    mockAccount = undefined;
    show(TRIAL);

    expect(within(panel()).getByText('trial')).toBeInTheDocument();
    expect(panel()).toHaveTextContent(
      'this site is on the pro trial. when the trial ends it goes to owlette free, unless you upgrade it.',
    );
  });
});

describe('a billed site', () => {
  it('shows the plan, the founders rate, the period, the machines and the price', () => {
    show(PRO);

    expect(within(panel()).getByText('pro')).toBeInTheDocument();
    expect(within(panel()).getByText('founders rate')).toBeInTheDocument();
    expect(screen.getByText('billing period').nextElementSibling).toHaveTextContent(PERIOD);
    expect(screen.getByText('active machines this period').nextElementSibling).toHaveTextContent('2, billed as 3');
    expect(screen.getByText('price').nextElementSibling).toHaveTextContent(
      '$30 per active machine per month, founders rate. pro bills at least 3 machines.',
    );
    expect(buttons()).toEqual(['switch plan', 'stop billing']);
  });

  it('writes its dates the same way for a viewer west of UTC whose browser is in another language', () => {
    // what the browser falls back to there, wherever this test runs
    const real = Date.prototype.toLocaleDateString;
    const spy = jest
      .spyOn(Date.prototype, 'toLocaleDateString')
      .mockImplementation(function (this: Date, locales, options) {
        return real.call(this, locales ?? 'de-DE', {
          ...options,
          timeZone: options?.timeZone ?? 'Pacific/Honolulu',
        });
      });
    try {
      show(PRO);

      // the period starts 2026-11-01T00:00Z, which is still oct 31 in honolulu
      expect(screen.getByText('billing period').nextElementSibling).toHaveTextContent('nov 1, 2026 to nov 30, 2026');
    } finally {
      spy.mockRestore();
    }
  });

  it('shows core at the list price, with no minimum', () => {
    show(CORE);

    expect(within(panel()).getByText('core')).toBeInTheDocument();
    expect(screen.queryByText('founders rate')).toBeNull();
    expect(screen.getByText('active machines this period').nextElementSibling).toHaveTextContent(/^2$/);
    expect(screen.getByText('price').nextElementSibling).toHaveTextContent(/^\$20 per active machine per month\.$/);
  });

  it('counts pro machines as they are from three up, and leaves the row out when they could not be counted', () => {
    mockSitePlan = { plan: PRO, loading: false, error: null };
    mockAccount = { ...ACCOUNT, sites: [owned(7)] };
    const counted = render(<SiteBillingSection site={SITE} />);
    expect(screen.getByText('active machines this period').nextElementSibling).toHaveTextContent(/^7$/);
    counted.unmount();

    mockAccount = { ...ACCOUNT, sites: [owned(null)] };
    render(<SiteBillingSection site={SITE} />);
    expect(screen.queryByText('active machines this period')).toBeNull();
    expect(screen.getByText('billing period')).toBeInTheDocument();
  });

  it('opens the plan picker as a switch from the plan it is on', async () => {
    const user = show(CORE);

    await user.click(screen.getByRole('button', { name: 'switch plan' }));

    expect(screen.getByTestId('plan-picker')).toHaveAttribute('data-current', 'core');
  });

  it('says a trial still covers a site bought during it', () => {
    show({ ...CORE, tier: 'trial', standing: 'trialing' });

    expect(within(panel()).getByText('core')).toBeInTheDocument();
    expect(within(panel()).getByText(`trial until ${day(TRIAL_ENDS)}`)).toBeInTheDocument();
    expect(panel()).toHaveTextContent(`the pro trial covers this site until ${day(TRIAL_ENDS)}.`);
    expect(buttons()).toEqual(['switch plan', 'stop billing']);
  });

  it('treats a core or pro site with no billing recorded as billed, and claims no price for it', () => {
    show({ ...PRO, billing: null });

    expect(within(panel()).getByText('pro')).toBeInTheDocument();
    expect(screen.getByText('billing period').nextElementSibling).toHaveTextContent(PERIOD);
    expect(screen.queryByText('price')).toBeNull();
    expect(screen.queryByText('founders rate')).toBeNull();
    expect(buttons()).toEqual(['switch plan', 'stop billing']);
  });
});

describe('stopping billing', () => {
  it('asks first, saying the site runs to the period end and is billed for it', async () => {
    const user = show(PRO);

    await user.click(screen.getByRole('button', { name: 'stop billing' }));

    const dialog = screen.getByRole('dialog', { name: 'stop billing' });
    expect(dialog).toHaveTextContent(
      `stop billing Alpha? it stays on pro until ${NOV_30}, and that billing period is still billed. after that it goes to owlette free.`,
    );
    expect(mockStop).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mockStop).not.toHaveBeenCalled();
  });

  it('stops on the confirm, says until when, and closes', async () => {
    mockStop.mockResolvedValue({ ok: true, billing: { tier: 'pro', founders: true, endsAt: DEC_1 } });
    const user = show(PRO);

    await user.click(screen.getByRole('button', { name: 'stop billing' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'stop billing' }));

    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('billing stopped', { description: `Alpha is billed until ${NOV_30}.` });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('leaves the dialog open on a refusal, with its detail as a toast', async () => {
    mockStop.mockResolvedValue(refused('billing_unavailable', 'billing is not available right now. try again later.', 503));
    const user = show(PRO);

    await user.click(screen.getByRole('button', { name: 'stop billing' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'stop billing' }));

    expect(toast.error).toHaveBeenCalledWith('could not stop billing', {
      description: 'billing is not available right now. try again later.',
    });
    expect(screen.getByRole('dialog', { name: 'stop billing' })).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('a site whose billing is stopping', () => {
  it('says until when it is billed, and offers only to resume', () => {
    show(STOPPING);

    expect(within(panel()).getByText(`ends ${FAR_LAST_DAY}`)).toBeInTheDocument();
    expect(panel()).toHaveTextContent(
      `billed until ${FAR_LAST_DAY}. this site stays on pro until then, then goes to owlette free.`,
    );
    expect(buttons()).toEqual(['resume billing']);
  });

  it('resumes at the plan and rate it had', async () => {
    mockUpgrade.mockResolvedValue({ ok: true, added: true });
    const user = show(STOPPING);

    await user.click(screen.getByRole('button', { name: 'resume billing' }));

    expect(mockUpgrade).toHaveBeenCalledWith('pro', true);
    expect(toast.success).toHaveBeenCalledWith('billing resumed', { description: 'Alpha stays on pro.' });
    expect(assign).not.toHaveBeenCalled();
  });

  it('leaves for checkout when resuming needs one', async () => {
    mockUpgrade.mockResolvedValue({ ok: true, checkoutUrl: 'https://checkout.example/c/2' });
    const user = show(STOPPING);

    await user.click(screen.getByRole('button', { name: 'resume billing' }));

    expect(assign).toHaveBeenCalledWith('https://checkout.example/c/2');
    expect(screen.getByRole('button', { name: 'resuming…' })).toBeDisabled();
  });

  it("toasts any other refusal's detail", async () => {
    mockUpgrade.mockResolvedValue(refused('subscription_paused', 'your subscription is paused. resume it before adding a site.'));
    const user = show(STOPPING);

    await user.click(screen.getByRole('button', { name: 'resume billing' }));

    expect(toast.error).toHaveBeenCalledWith('could not resume billing', {
      description: 'your subscription is paused. resume it before adding a site.',
    });
    expect(buttons()).toEqual(['resume billing']);
  });
});

describe('a site billed to its previous owner', () => {
  it('says so straight away, until when, with no resume to be refused', () => {
    show({ ...STOPPING, billedByPreviousOwner: true });

    expect(screen.getByTestId('billing-previous-owner')).toHaveTextContent(
      `this site is billed to its previous owner until ${FAR_LAST_DAY}. you can upgrade it after that billing period ends.`,
    );
    expect(buttons()).toEqual([]);
    expect(mockUpgrade).not.toHaveBeenCalled();
  });

  it('says it is still billed while the stop has not landed, and offers only to stop it', async () => {
    const user = show({ ...PRO, billedByPreviousOwner: true });

    expect(screen.getByTestId('billing-previous-owner')).toHaveTextContent(
      /^this site is still billed to its previous owner\. you can upgrade it once that billing has ended\.$/,
    );
    expect(buttons()).toEqual(['stop billing']);

    await user.click(screen.getByRole('button', { name: 'stop billing' }));
    expect(screen.getByRole('dialog', { name: 'stop billing' })).toBeInTheDocument();
    expect(screen.queryByTestId('plan-picker')).toBeNull();
  });

  it('tells someone who is not the owner only that the owner changes billing', () => {
    show({ ...PRO, billedByPreviousOwner: true, isOwner: false });

    expect(screen.queryByTestId('billing-previous-owner')).toBeNull();
    expect(screen.getByTestId('billing-not-owner')).toBeInTheDocument();
    expect(buttons()).toEqual([]);
  });

  it('says so once a resume is refused for it, and offers nothing more', async () => {
    mockUpgrade.mockResolvedValue(
      refused('billed_by_previous_owner', 'this site is billed to its previous owner until the billing period ends.'),
    );
    const user = show(STOPPING);
    expect(screen.queryByTestId('billing-previous-owner')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'resume billing' }));

    expect(screen.getByTestId('billing-previous-owner')).toHaveTextContent(
      `this site is billed to its previous owner until ${FAR_LAST_DAY}. you can upgrade it after that billing period ends.`,
    );
    expect(buttons()).toEqual([]);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('a site that is past due', () => {
  it('says the last payment failed and where to fix the card, while the site keeps its plan', () => {
    show({ ...PRO, standing: 'past_due' });

    expect(within(panel()).getByText('past due')).toBeInTheDocument();
    const notice = screen.getByTestId('billing-past-due');
    expect(notice).toHaveTextContent(
      /^the last payment for this site failed\. update the card in your tridant account\.$/,
    );
    // no portal url in the account plan: the words stay plain text
    expect(within(notice).queryByRole('link')).toBeNull();
    expect(buttons()).toEqual(['switch plan', 'stop billing']);
  });

  it('links the tridant portal in a new tab when the account plan names it', () => {
    mockAccount = { ...ACCOUNT, portalUrl: 'https://id-staging.tridant.io' };
    show({ ...PRO, standing: 'past_due' });

    const notice = screen.getByTestId('billing-past-due');
    expect(notice).toHaveTextContent(
      /^the last payment for this site failed\. update the card in your tridant account\.$/,
    );
    const link = within(notice).getByRole('link', { name: 'your tridant account' });
    expect(link).toHaveAttribute('href', 'https://id-staging.tridant.io/billing');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('says the site is on owlette free once the grace ran out', () => {
    show({ ...PRO, tier: 'free', standing: 'past_due', inGoodStanding: false, flags: NO_FLAGS });

    expect(screen.getByTestId('billing-past-due')).toHaveTextContent(
      'the last payment for this site failed, so it is on owlette free. update the card in your tridant account.',
    );
    // still billed as pro, so it is switched or stopped, not upgraded again
    expect(within(panel()).getByText('pro')).toBeInTheDocument();
    expect(buttons()).toEqual(['switch plan', 'stop billing']);
  });
});

describe('someone who is not the owner', () => {
  it('reads the plan with nothing to change', () => {
    show({ ...PRO, isOwner: false });

    expect(screen.getByTestId('billing-not-owner')).toHaveTextContent(
      "only the site owner can change a site's billing.",
    );
    expect(screen.getByText('billing period')).toBeInTheDocument();
    expect(buttons()).toEqual([]);
  });
});

describe('the return from checkout', () => {
  const pending = { ok: true, status: 'pending', tier: 'pro' };
  const complete = { ok: true, status: 'complete', tier: 'pro' };

  /** lets a poll's answer land, and the state it sets render. */
  const settle = () => act(async () => undefined);
  const wait = (ms: number) => act(() => jest.advanceTimersByTimeAsync(ms));

  beforeEach(() => {
    jest.useFakeTimers();
    mockSearch = 'section=billing&session_id=cs_test_1';
  });

  it('asks nothing when the url has no session', async () => {
    mockSearch = 'section=billing';
    render(<SiteBillingSection site={SITE} />);
    await settle();

    expect(mockConfirmCheckout).not.toHaveBeenCalled();
    expect(screen.queryByTestId(/^checkout-/)).toBeNull();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('says it is confirming, then that the site is on its plan, and drops the session from the url', async () => {
    let answer!: (value: unknown) => void;
    mockConfirmCheckout.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    render(<SiteBillingSection site={SITE} />);

    expect(mockConfirmCheckout).toHaveBeenCalledWith('cs_test_1');
    expect(screen.getByTestId('checkout-confirming')).toHaveTextContent('confirming your payment…');
    expect(mockReplace).not.toHaveBeenCalled();

    await act(async () => answer(complete));

    expect(screen.getByTestId('checkout-complete')).toHaveTextContent('payment confirmed. this site is on pro.');
    expect(screen.queryByTestId('checkout-confirming')).toBeNull();
    expect(mockReplace).toHaveBeenCalledWith('/admin/sites/site-a?section=billing', { scroll: false });
    expect(mockConfirmCheckout).toHaveBeenCalledTimes(1);
  });

  it('asks again every 2 s while the checkout is pending', async () => {
    mockConfirmCheckout.mockResolvedValueOnce(pending).mockResolvedValueOnce(pending).mockResolvedValue(complete);
    render(<SiteBillingSection site={SITE} />);
    await settle();
    expect(mockConfirmCheckout).toHaveBeenCalledTimes(1);

    await wait(1_999);
    expect(mockConfirmCheckout).toHaveBeenCalledTimes(1);
    await wait(1);
    expect(mockConfirmCheckout).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('checkout-confirming')).toBeInTheDocument();

    await wait(2_000);
    expect(mockConfirmCheckout).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('checkout-complete')).toBeInTheDocument();

    await wait(10_000);
    expect(mockConfirmCheckout).toHaveBeenCalledTimes(3);
  });

  it('after 30 s still pending, says to reload and keeps the session in the url for it', async () => {
    mockConfirmCheckout.mockResolvedValue(pending);
    render(<SiteBillingSection site={SITE} />);
    await settle();

    await wait(28_000);
    expect(screen.getByTestId('checkout-confirming')).toBeInTheDocument();
    await wait(2_000);

    expect(screen.getByTestId('checkout-slow')).toHaveTextContent(
      'the payment is not confirmed yet. it can take a minute: reload this page to check again.',
    );
    expect(screen.queryByTestId('checkout-confirming')).toBeNull();
    expect(mockConfirmCheckout).toHaveBeenCalledTimes(16);
    expect(mockReplace).not.toHaveBeenCalled();

    await wait(10_000);
    expect(mockConfirmCheckout).toHaveBeenCalledTimes(16);
  });

  it('says the payment was not taken when the checkout failed', async () => {
    mockConfirmCheckout.mockResolvedValue({ ok: true, status: 'failed', tier: 'pro' });
    render(<SiteBillingSection site={SITE} />);
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent('the payment was not taken, and nothing is billed. try again.');
    expect(mockReplace).toHaveBeenCalledWith('/admin/sites/site-a?section=billing', { scroll: false });
    await wait(10_000);
    expect(mockConfirmCheckout).toHaveBeenCalledTimes(1);
  });

  it("stops at a checkout that is not this account's, with the server's word", async () => {
    mockConfirmCheckout.mockResolvedValue(refused('not_found', 'checkout not found', 404));
    render(<SiteBillingSection site={SITE} />);
    await settle();

    expect(screen.getByTestId('checkout-error')).toHaveTextContent('could not confirm the checkout. checkout not found');
    expect(mockReplace).toHaveBeenCalledWith('/admin/sites/site-a?section=billing', { scroll: false });
    await wait(10_000);
    expect(mockConfirmCheckout).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['billing answers a 5xx', refused('billing_upstream', 'billing answered something unexpected.', 502)],
    ['the request gets no answer', refused('', 'could not reach owlette.', 0)],
  ])('keeps asking while %s', async (_, failure) => {
    mockConfirmCheckout.mockResolvedValueOnce(failure).mockResolvedValue(complete);
    render(<SiteBillingSection site={SITE} />);
    await settle();
    expect(screen.getByTestId('checkout-confirming')).toBeInTheDocument();

    await wait(2_000);

    expect(screen.getByTestId('checkout-complete')).toBeInTheDocument();
    expect(mockConfirmCheckout).toHaveBeenCalledTimes(2);
  });

  it('stops asking once the section is gone', async () => {
    mockConfirmCheckout.mockResolvedValue(pending);
    const view = render(<SiteBillingSection site={SITE} />);
    await settle();

    view.unmount();
    await wait(10_000);

    expect(mockConfirmCheckout).toHaveBeenCalledTimes(1);
  });

  it('shows the plan under the confirmation', async () => {
    mockSitePlan = { plan: PRO, loading: false, error: null };
    mockConfirmCheckout.mockResolvedValue(complete);
    render(<SiteBillingSection site={SITE} />);
    await settle();

    expect(screen.getByTestId('checkout-complete')).toBeInTheDocument();
    expect(screen.getByText('billing period')).toBeInTheDocument();
  });
});
