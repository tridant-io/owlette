/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * CreateSiteDialog under plans (adr 0018): the account plan's `siteCreation`
 * picks the step. `open` is a plain create. `choose_plan` asks for core or pro,
 * creates the site with `onPlan` and goes straight into its upgrade: checkout,
 * or the card on file. `blocked` names the site that isn't billed and links its
 * billing section. an upgrade the server would refuse is never started, and a
 * plan refusal from the create reloads the account plan.
 */
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { AccountPlanOn, AccountPlanResponse } from '@/lib/planResponse';

global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

jest.mock('@/lib/timeUtils', () => ({
  ...jest.requireActual('@/lib/timeUtils'),
  getBrowserTimezone: () => 'Europe/Berlin',
}));

// jest.setup mocks `db` to null, which would leave the availability check, and the button, stuck.
jest.mock('@/lib/firebase', () => ({ app: null, auth: null, db: {}, isConfigured: true }));
jest.mock('firebase/firestore', () => ({
  doc: jest.fn(() => ({})),
  getDoc: jest.fn(async () => ({ exists: () => false })),
}));

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { uid: 'creator-uid' } }),
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));

let mockAccount: AccountPlanResponse | undefined;
const mockRefreshPlan = jest.fn(async () => undefined);
jest.mock('@/hooks/usePlan', () => ({
  usePlan: () => ({ plan: mockAccount, refresh: mockRefreshPlan }),
}));

const mockRequestSiteUpgrade = jest.fn();
jest.mock('@/hooks/useSiteBilling', () => ({
  requestSiteUpgrade: (...args: unknown[]) => mockRequestSiteUpgrade(...args),
}));

import { CreateSiteDialog } from '@/components/CreateSiteDialog';
import { LINK_TRIDANT_HREF } from '@/components/plan/TrialBanner';
import { PRICING_FACTS, usd } from '@/lib/product-facts';
import { toast } from '@/lib/toast';

const assign = jest.fn();

beforeAll(() => {
  // jsdom's own location would attempt a real navigation and warn
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { assign, href: 'http://localhost/dashboard', origin: 'http://localhost' },
  });
});

const ACCOUNT: AccountPlanOn = {
  enforced: true,
  emailVerified: true,
  trial: { status: 'ended', endsAt: 1_700_000_000_000 },
  sites: [],
  free: { sitesUsed: 0, sitesLimit: 1, machinesUsed: 0, machinesLimit: 1, liveMachines: [] },
  siteCreation: { state: 'open', unpaidSite: null },
  foundersRemaining: { core: 0, pro: 3 },
  foundersHeld: { core: false, pro: false },
  linkAvailable: true,
  portalUrl: null,
};

const LOBBY = { siteId: 'lobby', name: 'Lobby' };
const CHOOSE_PLAN: AccountPlanOn = {
  ...ACCOUNT,
  free: { ...ACCOUNT.free, sitesUsed: 1 },
  siteCreation: { state: 'choose_plan', unpaidSite: LOBBY },
};

beforeEach(() => {
  mockAccount = ACCOUNT;
});

function openDialog() {
  const user = userEvent.setup();
  const onCreateSite = jest.fn().mockResolvedValue('new-site');
  const onOpenChange = jest.fn();
  const onSiteCreated = jest.fn();
  render(
    <TooltipProvider>
      <CreateSiteDialog
        open
        onOpenChange={onOpenChange}
        onCreateSite={onCreateSite}
        onSiteCreated={onSiteCreated}
      />
    </TooltipProvider>,
  );
  return { user, onCreateSite, onOpenChange, onSiteCreated };
}

/** names the site and presses create once the debounced id check lets it. */
async function create(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.type(screen.getByLabelText('site name'), 'NYC Office');
  const button = screen.getByRole('button', { name: label });
  await waitFor(() => expect(button).toBeEnabled(), { timeout: 3_000 });
  await user.click(button);
}

describe('the free site, or plans off', () => {
  it('is a plain create with no plan step, and reloads the account plan after it', async () => {
    const { user, onCreateSite, onSiteCreated } = openDialog();
    expect(screen.queryByTestId('create-site-plan')).toBeNull();

    await create(user, 'create site');

    await waitFor(() => expect(onSiteCreated).toHaveBeenCalledWith('new-site'));
    expect(onCreateSite).toHaveBeenCalledWith(expect.any(String), 'NYC Office', 'Europe/Berlin', true, undefined);
    expect(mockRequestSiteUpgrade).not.toHaveBeenCalled();
    expect(mockRefreshPlan).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('site created', {
      description: 'NYC Office is ready for its first machine.',
    });
  });

  it('is a plain create while plans are off, reading nothing more', async () => {
    mockAccount = { enforced: false, reason: 'enforcement_off' };
    const { user, onSiteCreated } = openDialog();
    expect(screen.queryByTestId('create-site-plan')).toBeNull();

    await create(user, 'create site');

    await waitFor(() => expect(onSiteCreated).toHaveBeenCalledWith('new-site'));
    expect(mockRefreshPlan).not.toHaveBeenCalled();
  });

  it('reloads the account plan when the server refuses the create for the plan', async () => {
    const { user, onCreateSite, onSiteCreated } = openDialog();
    onCreateSite.mockRejectedValue(
      Object.assign(new Error('owlette free covers one site, and Lobby is on it. add this site on core or pro.'), {
        status: 402,
      }),
    );

    await create(user, 'create site');

    await waitFor(() => expect(mockRefreshPlan).toHaveBeenCalled());
    expect(toast.error).toHaveBeenCalledWith('could not create the site', {
      description: 'owlette free covers one site, and Lobby is on it. add this site on core or pro.',
    });
    expect(onSiteCreated).not.toHaveBeenCalled();
  });
});

describe('the free site taken: create on a plan', () => {
  beforeEach(() => {
    mockAccount = CHOOSE_PLAN;
  });

  it('names the free site, offers core and pro with their prices, and says what follows', async () => {
    const { user } = openDialog();

    const step = screen.getByTestId('create-site-plan');
    expect(step).toHaveTextContent('owlette free covers one site, and Lobby is on it. pick a plan for this one.');
    expect(step).toHaveTextContent(
      'then checkout opens, or, if you already have a subscription, this site goes straight on the card on file.',
    );
    const core = within(step).getByRole('radio', { name: /^core/ });
    const pro = within(step).getByRole('radio', { name: /^pro/ });
    expect(core).toHaveTextContent(usd(PRICING_FACTS.core.list));
    // a founders place is left for pro only
    expect(pro).toHaveTextContent(usd(PRICING_FACTS.pro.founders));
    expect(pro).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: 'create on pro' })).toBeInTheDocument();

    await user.click(core);
    expect(core).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: 'create on core' })).toBeInTheDocument();
  });

  it('creates the site on its way to a plan, then leaves for checkout with the dialog closed', async () => {
    mockRequestSiteUpgrade.mockResolvedValue({ ok: true, checkoutUrl: 'https://checkout.example/c/1' });
    const { user, onCreateSite, onOpenChange, onSiteCreated } = openDialog();

    await create(user, 'create on pro');

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.example/c/1'));
    expect(onCreateSite).toHaveBeenCalledWith(expect.any(String), 'NYC Office', 'Europe/Berlin', true, true);
    expect(mockRequestSiteUpgrade).toHaveBeenCalledWith('new-site', 'pro', true);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSiteCreated).toHaveBeenCalledWith('new-site');
    // closed and handed over first, so back from checkout restores a page with no dialog mid-request
    expect(onSiteCreated.mock.invocationCallOrder[0]).toBeLessThan(assign.mock.invocationCallOrder[0]);
  });

  // tridant id keeps the founders rate for an account that has a founders site of the plan, past the cap.
  it('asks for the founders rate on core once the account holds it there, with no place left', async () => {
    mockAccount = { ...CHOOSE_PLAN, foundersHeld: { core: true, pro: false } };
    mockRequestSiteUpgrade.mockResolvedValue({ ok: true, added: true });
    const { user, onSiteCreated } = openDialog();

    const core = screen.getByRole('radio', { name: /^core/ });
    expect(core).toHaveTextContent(usd(PRICING_FACTS.core.founders));
    await user.click(core);
    await create(user, 'create on core');

    await waitFor(() => expect(onSiteCreated).toHaveBeenCalledWith('new-site'));
    expect(mockRequestSiteUpgrade).toHaveBeenCalledWith('new-site', 'core', true);
  });

  it('puts the site on the card on file when a subscription already runs', async () => {
    mockRequestSiteUpgrade.mockResolvedValue({ ok: true, added: true });
    const { user, onSiteCreated } = openDialog();

    await user.click(screen.getByRole('radio', { name: /^core/ }));
    await create(user, 'create on core');

    await waitFor(() => expect(onSiteCreated).toHaveBeenCalledWith('new-site'));
    expect(mockRequestSiteUpgrade).toHaveBeenCalledWith('new-site', 'core', false);
    expect(toast.success).toHaveBeenCalledWith('site created', {
      description: 'NYC Office is on core, billed to the card on file.',
    });
    expect(assign).not.toHaveBeenCalled();
  });

  it('says the site exists on owlette free when its upgrade is refused, with a way to its billing section', async () => {
    mockRequestSiteUpgrade.mockResolvedValue({
      ok: false,
      status: 409,
      code: 'subscription_paused',
      detail: 'your subscription is paused. resume it before adding a site.',
    });
    const { user, onSiteCreated } = openDialog();

    await create(user, 'create on pro');

    await waitFor(() => expect(onSiteCreated).toHaveBeenCalledWith('new-site'));
    expect(toast.error).toHaveBeenCalledWith('NYC Office is created, but not on pro', {
      description:
        'your subscription is paused. resume it before adding a site. it stays on owlette free until you upgrade it in its billing section.',
      action: { label: 'go to its billing', onClick: expect.any(Function) },
    });
    expect(mockRefreshPlan).toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();

    const [[, { action }]] = jest.mocked(toast.error).mock.calls as [[string, { action: { onClick: () => void } }]];
    action.onClick();
    expect(mockPush).toHaveBeenCalledWith('/admin/sites/new-site?section=billing');
  });

  it('starts nothing for an unverified email, which the upgrade would refuse', async () => {
    mockAccount = { ...CHOOSE_PLAN, emailVerified: false };
    const { user, onCreateSite } = openDialog();

    expect(screen.getByTestId('create-site-email-unverified')).toHaveTextContent(
      'verify your email before adding a site on core or pro. the banner at the top of the page sends the verification email again.',
    );
    await user.type(screen.getByLabelText('site name'), 'NYC Office');
    // the id check still lands, and the button stays off after it
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('site ID available'), { timeout: 3_000 });
    expect(screen.getByRole('button', { name: 'create on pro' })).toBeDisabled();
    expect(onCreateSite).not.toHaveBeenCalled();
  });

  it.each([
    [true, 'link it'],
    [false, null],
  ])('starts nothing while the tridant account must be linked (link offered: %s)', (linkAvailable, linkName) => {
    mockAccount = { ...CHOOSE_PLAN, linkAvailable, trial: { status: 'link_required', endsAt: null } };
    openDialog();

    const notice = screen.getByTestId('create-site-link-required');
    expect(notice).toHaveTextContent('this email already has a tridant account. link it before adding a site on core or pro.');
    if (linkName) {
      expect(within(notice).getByRole('link', { name: linkName })).toHaveAttribute('href', LINK_TRIDANT_HREF);
    } else {
      expect(notice).toHaveTextContent('contact support to link it.');
    }
    expect(screen.getByRole('button', { name: 'create on pro' })).toBeDisabled();
  });
});

describe('a further site not billed: blocked', () => {
  it("names that site, links its billing section, and offers no create", async () => {
    mockAccount = {
      ...ACCOUNT,
      free: { ...ACCOUNT.free, sitesUsed: 2 },
      siteCreation: { state: 'blocked', unpaidSite: { siteId: 'gallery', name: 'Gallery' } },
    };
    const { user, onOpenChange } = openDialog();

    expect(screen.getByTestId('create-site-blocked')).toHaveTextContent(
      "Gallery isn't billed. upgrade it to core or pro, or delete it, before adding another site.",
    );
    expect(screen.queryByLabelText('site name')).toBeNull();
    expect(screen.queryByRole('button', { name: /^create/ })).toBeNull();

    const link = screen.getByRole('link', { name: 'go to its billing' });
    expect(link).toHaveAttribute('href', '/admin/sites/gallery?section=billing');
    // jsdom cannot navigate; the dialog closing is what is under test
    link.addEventListener('click', (event) => event.preventDefault());
    await user.click(link);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
