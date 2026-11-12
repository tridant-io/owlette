/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * UpgradeSiteDialog: the plan picker for one site. pins the prices (the
 * founders price only while a place is left), the rate sent with the plan, the
 * leave for checkout, the site going straight onto a running subscription, the
 * founders places running out (the list price shown, and sent only on a second
 * confirm), the link and verify notices, a refusal's detail as a toast, the
 * switch mode for a billed site, and a request in flight holding the dialog
 * open so it is sent once.
 */
import React from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AccountPlanOn, AccountPlanResponse, AccountPlanSite } from '@/lib/planResponse';

let mockAccount: AccountPlanResponse | undefined;
const mockRefreshAccount = jest.fn(async () => undefined);
jest.mock('@/hooks/usePlan', () => ({
  usePlan: () => ({ plan: mockAccount, refresh: mockRefreshAccount }),
}));

const mockUpgrade = jest.fn();
const mockSwitchTier = jest.fn();
const mockUseSiteBilling = jest.fn();
jest.mock('@/hooks/useSiteBilling', () => ({
  useSiteBilling: (siteId: string) => {
    mockUseSiteBilling(siteId);
    return { upgrade: mockUpgrade, switchTier: mockSwitchTier };
  },
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

import { UpgradeSiteDialog } from '@/components/plan/UpgradeSiteDialog';
import { toast } from '@/lib/toast';

const assign = jest.fn();

beforeAll(() => {
  // jsdom's own location would attempt a real navigation and warn
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { assign, href: 'http://localhost/admin/sites/site-a', origin: 'http://localhost' },
  });
});

const ACCOUNT: AccountPlanOn = {
  enforced: true,
  emailVerified: true,
  trial: { status: 'active', endsAt: 1_800_000_000_000 },
  sites: [],
  free: { sitesUsed: 0, sitesLimit: 1, machinesUsed: 0, machinesLimit: 1, liveMachines: [] },
  foundersRemaining: { core: 0, pro: 0 },
  linkAvailable: true,
  portalUrl: null,
};

const BILLED_ELSEWHERE: AccountPlanSite = {
  siteId: 'site-b',
  name: 'bravo',
  tier: 'core',
  standing: 'active',
  inGoodStanding: true,
  billing: { tier: 'core', founders: false, endsAt: null },
  period: null,
  activeMachinesThisPeriod: 1,
};

const SITE = { id: 'site-a', name: 'Alpha' };
const refused = (code: string, detail: string, status = 409) => ({ ok: false, status, code, detail });

beforeEach(() => {
  mockAccount = ACCOUNT;
  mockUpgrade.mockResolvedValue({ ok: true, checkoutUrl: 'https://checkout.example/c/1' });
  mockSwitchTier.mockResolvedValue({ ok: true, billing: { tier: 'pro', founders: false, endsAt: null } });
});

function open(current?: 'core' | 'pro') {
  const user = userEvent.setup();
  const onOpenChange = jest.fn();
  render(<UpgradeSiteDialog open onOpenChange={onOpenChange} site={SITE} current={current} />);
  return { user, onOpenChange };
}

const card = (tier: 'core' | 'pro') => screen.getByRole('radio', { name: new RegExp(`^${tier}`) });

describe('the plans', () => {
  it('names the site, and says what a machine is billed for', () => {
    open();

    const dialog = screen.getByRole('dialog', { name: 'upgrade Alpha' });
    expect(dialog).toHaveTextContent(
      'billed per active machine per month. a machine counts if it was online at any point in the billing period.',
    );
    expect(mockUseSiteBilling).toHaveBeenCalledWith('site-a');
  });

  it('shows the list prices when no founders place is left, with pro selected', () => {
    open();

    expect(card('core')).toHaveTextContent('$20per active machine per month');
    expect(card('pro')).toHaveTextContent('$60per active machine per month');
    expect(screen.queryByText(/founders rate/)).toBeNull();
    expect(card('pro')).toBeChecked();
    expect(card('core')).not.toBeChecked();
  });

  it('shows the founders price beside the list price for a plan with places left', () => {
    mockAccount = { ...ACCOUNT, foundersRemaining: { core: 12, pro: 0 } };
    open();

    expect(card('core')).toHaveTextContent('$10per active machine per month');
    expect(card('core')).toHaveTextContent('founders rate. the list price is $20.');
    expect(card('pro')).toHaveTextContent('$60per active machine per month');
    expect(card('pro')).not.toHaveTextContent('founders rate');
  });

  it.each([
    ['could not be asked', null],
    ['has no count for the plan', { core: null, pro: null }],
  ])('shows the list prices when tridant id %s', (_, foundersRemaining) => {
    mockAccount = { ...ACCOUNT, foundersRemaining };
    open();

    expect(card('core')).toHaveTextContent('$20');
    expect(card('pro')).toHaveTextContent('$60');
    expect(screen.queryByText(/founders rate/)).toBeNull();
  });

  it('says pro bills at least three machines, and core does not', () => {
    open();

    expect(card('pro')).toHaveTextContent('bills at least 3 machines.');
    expect(card('core')).not.toHaveTextContent('bills at least');
  });

  it('selects the plan clicked', async () => {
    const { user } = open();

    await user.click(card('core'));

    expect(card('core')).toBeChecked();
    expect(card('pro')).not.toBeChecked();
  });
});

describe('upgrading', () => {
  it('leaves for checkout with the plan selected, at the list price', async () => {
    const { user, onOpenChange } = open();

    await user.click(screen.getByRole('button', { name: 'continue to checkout' }));

    expect(mockUpgrade).toHaveBeenCalledWith('pro', false);
    expect(assign).toHaveBeenCalledWith('https://checkout.example/c/1');
    // the page is leaving: the dialog stays, busy
    expect(screen.getByRole('button', { name: 'starting checkout…' })).toBeDisabled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('is usable again when the browser restores the page after back from checkout', async () => {
    const { user } = open();
    await user.click(screen.getByRole('button', { name: 'continue to checkout' }));
    expect(screen.getByRole('button', { name: 'starting checkout…' })).toBeDisabled();

    const restored = new Event('pageshow');
    Object.defineProperty(restored, 'persisted', { value: true });
    act(() => {
      window.dispatchEvent(restored);
    });

    expect(screen.getByRole('button', { name: 'continue to checkout' })).toBeEnabled();
  });

  it('asks for the founders rate only for a plan with places left', async () => {
    mockAccount = { ...ACCOUNT, foundersRemaining: { core: 0, pro: 3 } };
    mockUpgrade.mockResolvedValue(refused('billing_unavailable', 'billing is not available right now.', 503));
    const { user } = open();

    await user.click(screen.getByRole('button', { name: 'continue to checkout' }));
    expect(mockUpgrade).toHaveBeenLastCalledWith('pro', true);

    await user.click(card('core'));
    await user.click(screen.getByRole('button', { name: 'continue to checkout' }));
    expect(mockUpgrade).toHaveBeenLastCalledWith('core', false);
  });

  it('with another site billed, says there is no checkout and closes once the site is added', async () => {
    mockAccount = { ...ACCOUNT, sites: [BILLED_ELSEWHERE] };
    mockUpgrade.mockResolvedValue({ ok: true, added: true });
    const { user, onOpenChange } = open();

    expect(
      screen.getByText('this site goes on your subscription and is billed to the card on file. there is no checkout.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'upgrade site' }));

    expect(mockUpgrade).toHaveBeenCalledWith('pro', false);
    expect(assign).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Alpha is on pro');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not count this site's own billing, or a site that ran out, as a subscription", () => {
    mockAccount = {
      ...ACCOUNT,
      sites: [
        { ...BILLED_ELSEWHERE, siteId: 'site-a' },
        { ...BILLED_ELSEWHERE, siteId: 'site-c', tier: 'free', standing: 'expired', inGoodStanding: false },
      ],
    };
    open();

    expect(screen.getByRole('button', { name: 'continue to checkout' })).toBeInTheDocument();
    expect(screen.queryByText(/there is no checkout/)).toBeNull();
  });

  it("toasts a refusal's detail and stays open", async () => {
    mockUpgrade.mockResolvedValue(refused('site_billed_elsewhere', 'this site is already billed under another tridant account.'));
    const { user, onOpenChange } = open();

    await user.click(screen.getByRole('button', { name: 'continue to checkout' }));

    expect(toast.error).toHaveBeenCalledWith('could not upgrade the site', {
      description: 'this site is already billed under another tridant account.',
    });
    expect(screen.getByRole('button', { name: 'continue to checkout' })).toBeEnabled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('closes on cancel', async () => {
    const { user, onOpenChange } = open();

    await user.click(screen.getByRole('button', { name: 'cancel' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockUpgrade).not.toHaveBeenCalled();
  });

  it('stays open while the request is in flight, and sends it once', async () => {
    // another site is billed, so each request sent would put this one on the card on file
    mockAccount = { ...ACCOUNT, sites: [BILLED_ELSEWHERE] };
    let answer: (result: { ok: true; added: true }) => void = () => undefined;
    mockUpgrade.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const { user, onOpenChange } = open();

    await user.click(screen.getByRole('button', { name: 'upgrade site' }));
    // a close that got through would reset the dialog, and reopened it would send again
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'cancel' }));
    await user.click(screen.getByRole('button', { name: 'upgrading…' }));

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'upgrading…' })).toBeDisabled();
    expect(mockUpgrade).toHaveBeenCalledTimes(1);

    await act(async () => answer({ ok: true, added: true }));

    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.success).toHaveBeenCalledWith('Alpha is on pro');
  });
});

describe('the founders places running out', () => {
  const SOLD_OUT = refused('founders_sold_out', 'the founders places for this plan are taken.');
  const NOTICE = 'the founders places for pro are taken. the price is now $60 per active machine per month.';

  it('stays open at the list price, and bills it only on a second confirm', async () => {
    // another site is billed, so this one would go straight onto the card on file
    mockAccount = { ...ACCOUNT, sites: [BILLED_ELSEWHERE], foundersRemaining: { core: 5, pro: 1 } };
    mockUpgrade.mockResolvedValueOnce(SOLD_OUT).mockResolvedValueOnce({ ok: true, added: true });
    const { user, onOpenChange } = open();
    expect(card('pro')).toHaveTextContent('$30per active machine per month');
    expect(screen.queryByTestId('upgrade-founders-sold-out')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'upgrade site' }));

    expect(mockUpgrade).toHaveBeenCalledTimes(1);
    expect(mockUpgrade).toHaveBeenCalledWith('pro', true);
    expect(screen.getByTestId('upgrade-founders-sold-out')).toHaveTextContent(NOTICE);
    expect(card('pro')).toHaveTextContent('$60per active machine per month');
    expect(card('pro')).not.toHaveTextContent('founders rate');
    // the other plan's places were not refused
    expect(card('core')).toHaveTextContent('founders rate. the list price is $20.');
    expect(mockRefreshAccount).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'upgrade site' }));

    expect(mockUpgrade).toHaveBeenCalledTimes(2);
    expect(mockUpgrade).toHaveBeenLastCalledWith('pro', false);
    expect(toast.success).toHaveBeenCalledWith('Alpha is on pro');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows the notice only for the plan that was refused', async () => {
    mockAccount = { ...ACCOUNT, foundersRemaining: { core: 5, pro: 1 } };
    mockUpgrade.mockResolvedValue(SOLD_OUT);
    const { user } = open();

    await user.click(screen.getByRole('button', { name: 'continue to checkout' }));
    expect(screen.getByTestId('upgrade-founders-sold-out')).toBeInTheDocument();

    await user.click(card('core'));
    expect(screen.queryByTestId('upgrade-founders-sold-out')).toBeNull();

    await user.click(card('pro'));
    expect(screen.getByTestId('upgrade-founders-sold-out')).toHaveTextContent(NOTICE);
  });

  it('does the same for a switch', async () => {
    mockAccount = { ...ACCOUNT, foundersRemaining: { core: 0, pro: 4 } };
    mockSwitchTier
      .mockResolvedValueOnce(SOLD_OUT)
      .mockResolvedValueOnce({ ok: true, billing: { tier: 'pro', founders: false, endsAt: null } });
    const { user, onOpenChange } = open('core');

    await user.click(screen.getByRole('button', { name: 'switch to pro' }));

    expect(mockSwitchTier).toHaveBeenCalledTimes(1);
    expect(mockSwitchTier).toHaveBeenCalledWith('pro', true);
    expect(screen.getByTestId('upgrade-founders-sold-out')).toHaveTextContent(NOTICE);
    expect(onOpenChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'switch to pro' }));

    expect(mockSwitchTier).toHaveBeenLastCalledWith('pro', false);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('toasts the refusal when the list price itself was what it asked for', async () => {
    mockUpgrade.mockResolvedValue(SOLD_OUT);
    const { user } = open();

    await user.click(screen.getByRole('button', { name: 'continue to checkout' }));

    expect(mockUpgrade).toHaveBeenCalledWith('pro', false);
    expect(screen.queryByTestId('upgrade-founders-sold-out')).toBeNull();
    expect(toast.error).toHaveBeenCalledWith('could not upgrade the site', {
      description: 'the founders places for this plan are taken.',
    });
  });
});

describe('an email that already has a tridant account', () => {
  it('offers the link back to this section when the upgrade is refused for it, with no toast', async () => {
    mockUpgrade.mockResolvedValue(refused('link_required', 'your email already has a tridant account. link it, then try again.'));
    const { user } = open();
    expect(screen.queryByTestId('upgrade-link-required')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'continue to checkout' }));

    const notice = screen.getByTestId('upgrade-link-required');
    expect(notice).toHaveTextContent('this email already has a tridant account.');
    expect(within(notice).getByRole('link', { name: 'link it' })).toHaveAttribute(
      'href',
      '/api/auth/tridant/link?return=%2Fadmin%2Fsites%2Fsite-a%3Fsection%3Dbilling',
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows it before any click when the account plan already says so', () => {
    mockAccount = { ...ACCOUNT, trial: { status: 'link_required', endsAt: null } };
    open();

    expect(within(screen.getByTestId('upgrade-link-required')).getByRole('link', { name: 'link it' })).toBeInTheDocument();
  });

  it('points at support where linking is not set up', () => {
    mockAccount = { ...ACCOUNT, trial: { status: 'link_required', endsAt: null }, linkAvailable: false };
    open();

    const notice = screen.getByTestId('upgrade-link-required');
    expect(notice).toHaveTextContent('contact support to link it.');
    expect(within(notice).queryByRole('link')).toBeNull();
  });
});

describe('an unverified email', () => {
  const COPY =
    'verify your email before upgrading a site. the banner at the top of the page sends the verification email again.';

  it('points at the verification banner when the upgrade is refused for it, with no toast', async () => {
    mockUpgrade.mockResolvedValue(refused('email_unverified', 'verify your email before upgrading a site.', 403));
    const { user } = open();
    expect(screen.queryByTestId('upgrade-email-unverified')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'continue to checkout' }));

    expect(screen.getByTestId('upgrade-email-unverified')).toHaveTextContent(COPY);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows it before any click when the account plan already says so', () => {
    mockAccount = { ...ACCOUNT, emailVerified: false };
    open();

    expect(screen.getByTestId('upgrade-email-unverified')).toHaveTextContent(COPY);
  });
});

describe('switching a billed site', () => {
  it('marks the current plan, selects the other and says when the switch counts', () => {
    open('core');

    const dialog = screen.getByRole('dialog', { name: 'switch plan' });
    expect(dialog).toHaveTextContent(
      'the switch is immediate, and the whole billing period is billed at the plan the site is on when it ends.',
    );
    expect(card('core')).toBeDisabled();
    expect(card('core')).toHaveTextContent('current plan');
    expect(card('pro')).toBeChecked();
    expect(card('pro')).not.toHaveTextContent('current plan');
  });

  it('selects core for a site on pro', () => {
    open('pro');

    expect(card('pro')).toBeDisabled();
    expect(card('core')).toBeChecked();
    expect(screen.getByRole('button', { name: 'switch to core' })).toBeInTheDocument();
  });

  it('switches at the rate shown, toasts and closes', async () => {
    mockAccount = { ...ACCOUNT, foundersRemaining: { core: 0, pro: 4 } };
    mockSwitchTier.mockResolvedValue({ ok: true, billing: { tier: 'pro', founders: true, endsAt: null } });
    const { user, onOpenChange } = open('core');

    await user.click(screen.getByRole('button', { name: 'switch to pro' }));

    expect(mockSwitchTier).toHaveBeenCalledWith('pro', true);
    expect(mockUpgrade).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Alpha is on pro');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('never calls it a subscription to join, whatever else is billed', () => {
    mockAccount = { ...ACCOUNT, sites: [BILLED_ELSEWHERE] };
    open('core');

    expect(screen.queryByText(/there is no checkout/)).toBeNull();
    expect(screen.getByRole('button', { name: 'switch to pro' })).toBeInTheDocument();
  });

  it("toasts a refusal's detail and stays open", async () => {
    mockSwitchTier.mockResolvedValue(
      refused('billed_by_previous_owner', 'this site is billed to its previous owner until the billing period ends.'),
    );
    const { user, onOpenChange } = open('core');

    await user.click(screen.getByRole('button', { name: 'switch to pro' }));

    expect(toast.error).toHaveBeenCalledWith('could not switch the plan', {
      description: 'this site is billed to its previous owner until the billing period ends.',
    });
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
