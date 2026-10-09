/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * PageHeader below `md`: the nav drawer behaves as the modal it looks like —
 * focus moves in, tab stays in, escape is claimed and focus goes back to the
 * menu button — the current site stays named beside that button, and the menu
 * scrim exists only while a menu is open.
 *
 * jsdom applies no media queries, so `md:hidden` markup renders here as it does
 * on a phone; the breakpoint itself is not on trial.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PageHeader } from '@/components/PageHeader';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

let siteAdmin = true;
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'op-uid', email: 'op@example.com', displayName: 'op' },
    signOut: jest.fn(),
    isSuperadmin: false,
    administersAnySite: false,
    isSiteAdmin: () => siteAdmin,
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

// the current site's editor, one click from the site switcher, for its admins only.
describe('PageHeader site settings', () => {
  afterEach(() => {
    siteAdmin = true;
  });

  async function openSiteSwitcher(onSiteSettings: () => void) {
    const user = userEvent.setup();
    render(
      <PageHeader
        currentPage="dashboard"
        sites={SITES}
        currentSiteId="site-a"
        onSiteChange={jest.fn()}
        onManageSites={jest.fn()}
        onSiteSettings={onSiteSettings}
      />,
    );
    await user.click(screen.getByTestId('site-switcher-trigger'));
    await screen.findByRole('menuitem', { name: 'manage sites' });
    return user;
  }

  it("opens the current site's settings for its admin", async () => {
    const onSiteSettings = jest.fn();
    const user = await openSiteSwitcher(onSiteSettings);

    await user.click(screen.getByRole('menuitem', { name: 'site settings' }));

    expect(onSiteSettings).toHaveBeenCalledTimes(1);
  });

  it('is not offered to a member', async () => {
    siteAdmin = false;
    await openSiteSwitcher(jest.fn());

    expect(screen.queryByRole('menuitem', { name: 'site settings' })).toBeNull();
  });
});

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
