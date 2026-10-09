/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * PageHeader below `md`: the nav drawer behaves as the modal it looks like —
 * focus moves in, tab stays in, escape is claimed and focus goes back to the
 * menu button — the current site stays named beside that button, and the menu
 * scrim exists only while a menu is open. the user menu links the plan page
 * only while plans are enforced.
 *
 * jsdom applies no media queries, so `md:hidden` markup renders here as it does
 * on a phone; the breakpoint itself is not on trial.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PageHeader } from '@/components/PageHeader';
import type { PlanResponse } from '@/lib/plan.server';

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

let mockPlan: PlanResponse | undefined;
jest.mock('@/hooks/usePlan', () => ({
  usePlan: () => ({ plan: mockPlan, loading: false, error: null, refresh: jest.fn() }),
}));

jest.mock('@/components/plan/TrialBanner', () => ({
  TrialBanner: () => <div data-testid="trial-banner-mount" />,
}));

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'op-uid', email: 'op@example.com', displayName: 'op' },
    signOut: jest.fn(),
    isSuperadmin: false,
    administersAnySite: false,
  }),
}));

jest.mock('@/components/ReportBugDialog', () => ({
  ReportBugDialog: () => null,
}));

// radix measures its menus with a ResizeObserver and drives triggers with
// pointer capture; jsdom has neither.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.HTMLElement.prototype.hasPointerCapture = jest.fn();
window.HTMLElement.prototype.releasePointerCapture = jest.fn();
window.HTMLElement.prototype.scrollIntoView = jest.fn();

window.matchMedia = jest.fn().mockImplementation((query: string) => ({
  matches: false,
  media: query,
  addEventListener: jest.fn(),
  removeEventListener: jest.fn(),
}));

const SITES = [
  { id: 'site-a', name: 'gallery north' },
  { id: 'site-b', name: 'gallery south' },
];

function renderHeader() {
  const user = userEvent.setup();
  const view = render(
    <PageHeader currentPage="dashboard" sites={SITES} currentSiteId="site-a" onSiteChange={jest.fn()} />,
  );
  return { user, ...view };
}

async function openDrawer() {
  const rendered = renderHeader();
  const trigger = screen.getByRole('button', { name: 'menu', exact: true });
  await rendered.user.click(trigger);
  return { ...rendered, trigger, drawer: screen.getByRole('dialog', { name: 'menu' }) };
}

describe('PageHeader mobile nav drawer', () => {
  it('is a modal dialog that takes focus when it opens', async () => {
    const { drawer } = await openDrawer();

    expect(drawer).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: 'close menu' })).toHaveFocus();
  });

  it('keeps tab inside the drawer, both ways round', async () => {
    const { user, drawer } = await openDrawer();
    const close = screen.getByRole('button', { name: 'close menu' });

    await user.tab({ shift: true });
    expect(drawer).toContainElement(document.activeElement as HTMLElement);
    expect(close).not.toHaveFocus();

    await user.tab();
    expect(close).toHaveFocus();
  });

  it('claims escape, closes, and hands focus back to the menu button', async () => {
    const { user, trigger } = await openDrawer();
    let escapeWasClaimed = false;
    const later = (e: KeyboardEvent) => {
      escapeWasClaimed = e.defaultPrevented;
    };
    window.addEventListener('keydown', later);

    await user.keyboard('{Escape}');
    window.removeEventListener('keydown', later);

    expect(escapeWasClaimed).toBe(true);
    expect(screen.queryByRole('dialog', { name: 'menu' })).toBeNull();
    expect(trigger).toHaveFocus();
  });
});

describe('PageHeader below md', () => {
  it('names the current site beside the menu button', () => {
    renderHeader();

    expect(screen.getByTestId('mobile-current-site')).toHaveTextContent('gallery north');
  });
});

describe('PageHeader menu scrim', () => {
  it('is not in the page while no menu is open', () => {
    const { container } = renderHeader();

    expect(container.querySelector('.backdrop-blur-\\[2px\\]')).toBeNull();
  });

  it('mounts while a menu is open', async () => {
    const { user, container } = renderHeader();

    await user.click(screen.getByTestId('site-switcher-trigger'));

    expect(await screen.findByRole('menu')).toBeInTheDocument();
    expect(container.querySelector('.backdrop-blur-\\[2px\\]')).not.toBeNull();
  });
});

describe('PageHeader plan entry', () => {
  const FLAGS = {
    control: true,
    deployments: true,
    swoop: true,
    hoot: true,
    roost: true,
    talons: true,
    webhooks: true,
    api_keys: true,
  };
  const OFF: PlanResponse = {
    enforced: false,
    reason: 'enforcement_off',
    plan: null,
    standing: null,
    limits: { machines: null, sites: null },
    flags: FLAGS,
    activeMachinesThisMonth: null,
  };
  const FREE: PlanResponse = {
    enforced: true,
    plan: 'free',
    standing: 'expired',
    limits: { machines: 1, sites: 1 },
    flags: {
      control: false,
      deployments: false,
      swoop: false,
      hoot: false,
      roost: false,
      talons: false,
      webhooks: false,
      api_keys: false,
    },
    activeMachinesThisMonth: 1,
  };

  afterEach(() => {
    mockPlan = undefined;
    mockPush.mockReset();
  });

  it.each([
    ['loading', undefined],
    ['not enforced', OFF],
  ])('leaves plan out of the user menu while plans are %s', async (_label, plan) => {
    mockPlan = plan;
    const { user } = renderHeader();

    await user.click(screen.getByTestId('user-menu-trigger'));

    expect(await screen.findByRole('menuitem', { name: 'sign out' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'plan' })).toBeNull();
  });

  it('links the plan page from the user menu while plans are enforced', async () => {
    mockPlan = FREE;
    const { user } = renderHeader();

    await user.click(screen.getByTestId('user-menu-trigger'));
    await user.click(await screen.findByRole('menuitem', { name: 'plan' }));

    expect(mockPush).toHaveBeenCalledWith('/settings/plan');
  });

  it('mounts the plan banner under the header', () => {
    renderHeader();

    expect(screen.getByTestId('trial-banner-mount')).toBeInTheDocument();
  });
});
