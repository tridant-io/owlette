/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * UpgradeGate: a gate follows the plan of the site it is given. the children
 * render while that plan loads, after a failed lookup, with plans off and when
 * the flag is on; otherwise a lowercase card or inline note stands in, with an
 * upgrade link to the site's billing section for its owner and "ask the site
 * owner" for anyone else.
 */
import React from 'react';
import { render, renderHook, screen } from '@testing-library/react';
import { ASK_OWNER, UpgradeGate, siteBillingPath, usePlanGated } from '@/components/plan/UpgradeGate';
import type { SitePlanResponse } from '@/lib/sitePlanResponse';

// keyed by site id, as the real store is; a site with no entry is loading or failed.
let mockPlans: Record<string, SitePlanResponse | undefined> = {};
jest.mock('@/hooks/useSitePlan', () => ({
  useSitePlan: (siteId: string | null | undefined) => ({ plan: siteId ? mockPlans[siteId] : undefined }),
}));

const SITE = 'site-a';
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
const CORE: SitePlanResponse = {
  ...FREE,
  tier: 'core',
  standing: 'active',
  inGoodStanding: true,
  flags: { ...NO_FLAGS, control: true },
};
const TRIAL: SitePlanResponse = { ...CORE, tier: 'trial', standing: 'trialing', flags: ALL_FLAGS };
const PRO: SitePlanResponse = { ...CORE, tier: 'pro', flags: ALL_FLAGS };
const OFF: SitePlanResponse = {
  enforced: false,
  reason: 'enforcement_off',
  tier: null,
  standing: null,
  inGoodStanding: true,
  flags: ALL_FLAGS,
  billing: null,
  period: null,
  isOwner: true,
  billedByPreviousOwner: false,
};
const member = (plan: SitePlanResponse): SitePlanResponse => ({ ...plan, isOwner: false });

function renderGate(props: Partial<React.ComponentProps<typeof UpgradeGate>> = {}) {
  return render(
    <UpgradeGate flag="roost" siteId={SITE} {...props}>
      <button type="button">create roost</button>
    </UpgradeGate>,
  );
}

beforeEach(() => {
  mockPlans = {};
});

describe('UpgradeGate', () => {
  it.each([
    ['loading or failed', undefined],
    ['plans off', OFF],
    ['on a trial', TRIAL],
    ['on pro', PRO],
    ['plans off for a member', member(OFF)],
  ])('renders the children when the site is %s', (_label, plan) => {
    mockPlans = { [SITE]: plan };
    renderGate();

    expect(screen.getByRole('button', { name: 'create roost' })).toBeInTheDocument();
    expect(screen.queryByTestId('upgrade-gate')).not.toBeInTheDocument();
  });

  it.each([
    ['no site', null],
    ['a site not picked yet', ''],
  ])('renders the children with %s', (_label, siteId) => {
    mockPlans = { [SITE]: FREE };
    renderGate({ siteId });

    expect(screen.getByRole('button', { name: 'create roost' })).toBeInTheDocument();
    expect(screen.queryByTestId('upgrade-gate')).not.toBeInTheDocument();
  });

  it("follows the plan of the site it is given, not another site's", () => {
    mockPlans = { [SITE]: FREE, 'site-b': PRO };
    const { unmount } = renderGate({ siteId: 'site-b' });
    expect(screen.getByRole('button', { name: 'create roost' })).toBeInTheDocument();
    unmount();

    renderGate();
    expect(screen.queryByRole('button', { name: 'create roost' })).not.toBeInTheDocument();
    expect(screen.getByTestId('upgrade-gate')).toBeInTheDocument();
  });

  it("sends the site's owner to its billing section in place of the children", () => {
    mockPlans = { [SITE]: FREE };
    renderGate();

    expect(screen.queryByRole('button', { name: 'create roost' })).not.toBeInTheDocument();
    const gate = screen.getByTestId('upgrade-gate');
    expect(gate).toHaveTextContent("this site's plan doesn't include roost");
    expect(gate).toHaveTextContent('upgrade to pro to use it.');
    expect(gate).not.toHaveTextContent('ask the site owner');
    expect(screen.getByRole('link', { name: 'upgrade' })).toHaveAttribute('href', '/admin/sites/site-a?section=billing');
  });

  it('tells anyone else to ask the site owner, with no link', () => {
    mockPlans = { [SITE]: member(FREE) };
    renderGate();

    expect(screen.queryByRole('button', { name: 'create roost' })).not.toBeInTheDocument();
    const gate = screen.getByTestId('upgrade-gate');
    expect(gate).toHaveTextContent("this site's plan doesn't include roost");
    expect(gate).toHaveTextContent('ask the site owner to upgrade this site.');
    expect(gate).not.toHaveTextContent('upgrade to pro');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('exports the one ask-the-owner line the machine views share, with no full stop', () => {
    expect(ASK_OWNER).toBe('ask the site owner to upgrade this site');
  });

  it('gates on the named flag only', () => {
    mockPlans = { [SITE]: CORE };
    const { unmount } = renderGate({ flag: 'control' });
    expect(screen.getByRole('button', { name: 'create roost' })).toBeInTheDocument();
    unmount();

    renderGate({ flag: 'webhooks' });
    expect(screen.getByTestId('upgrade-gate')).toHaveTextContent("this site's plan doesn't include webhooks");
  });

  it.each([
    ['deployments', 'deployments'],
    ['swoop', 'swoop'],
    ['hoot', 'hoot'],
  ] as const)('gates %s on core, naming pro as the upgrade', (flag, name) => {
    mockPlans = { [SITE]: CORE };
    renderGate({ flag });

    expect(screen.queryByRole('button', { name: 'create roost' })).not.toBeInTheDocument();
    expect(screen.getByTestId('upgrade-gate')).toHaveTextContent(`this site's plan doesn't include ${name}`);
    expect(screen.getByTestId('upgrade-gate')).toHaveTextContent('upgrade to pro to use it.');
  });

  it('names core as the upgrade for remote control', () => {
    mockPlans = { [SITE]: FREE };
    renderGate({ flag: 'control' });

    expect(screen.getByTestId('upgrade-gate')).toHaveTextContent("this site's plan doesn't include remote control");
    expect(screen.getByTestId('upgrade-gate')).toHaveTextContent('upgrade to core to use it.');
  });

  it('renders the inline note in place of a create control, with the link for the owner', () => {
    mockPlans = { [SITE]: FREE };
    renderGate({ flag: 'webhooks', variant: 'inline' });

    expect(screen.queryByRole('button', { name: 'create roost' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('upgrade-gate')).not.toBeInTheDocument();
    const note = screen.getByTestId('upgrade-gate-inline');
    expect(note).toHaveTextContent("this site's plan doesn't include webhooks.");
    expect(note).not.toHaveTextContent('ask the site owner');
    expect(screen.getByRole('link', { name: 'upgrade' })).toHaveAttribute('href', '/admin/sites/site-a?section=billing');
  });

  it('renders the inline note for anyone else with no link', () => {
    mockPlans = { [SITE]: member(FREE) };
    renderGate({ flag: 'webhooks', variant: 'inline' });

    expect(screen.queryByRole('button', { name: 'create roost' })).not.toBeInTheDocument();
    expect(screen.getByTestId('upgrade-gate-inline')).toHaveTextContent(
      "this site's plan doesn't include webhooks. ask the site owner to upgrade this site.",
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('names the feature when the flag covers more than one', () => {
    mockPlans = { [SITE]: FREE };
    renderGate({ flag: 'control', feature: 'alert rules', variant: 'inline' });

    expect(screen.getByTestId('upgrade-gate-inline')).toHaveTextContent("this site's plan doesn't include alert rules.");
  });

  it('keeps every word of its own copy lowercase', () => {
    mockPlans = { [SITE]: FREE };
    const { unmount } = renderGate();
    const owner = screen.getByTestId('upgrade-gate').textContent ?? '';
    unmount();
    mockPlans = { [SITE]: member(FREE) };
    renderGate();
    const other = screen.getByTestId('upgrade-gate').textContent ?? '';

    expect(owner).toBe(owner.toLowerCase());
    expect(other).toBe(other.toLowerCase());
  });
});

describe('usePlanGated', () => {
  it.each([
    ['loading or failed', undefined, SITE, false],
    ['plans off', OFF, SITE, false],
    ['the flag on', PRO, SITE, false],
    ['a free site the viewer owns', FREE, SITE, true],
    ['a free site someone else owns', member(FREE), SITE, true],
    ['no site', FREE, null, false],
    ['another site', FREE, 'site-b', false],
  ] as const)('with %s', (_label, plan, siteId, gated) => {
    mockPlans = { [SITE]: plan };
    const { result } = renderHook(() => usePlanGated('roost', siteId));

    expect(result.current).toBe(gated);
  });
});

describe('siteBillingPath', () => {
  it("is the billing section of the site's settings, with the id encoded", () => {
    expect(siteBillingPath('site-a')).toBe('/admin/sites/site-a?section=billing');
    expect(siteBillingPath('a/b c')).toBe('/admin/sites/a%2Fb%20c?section=billing');
  });
});
