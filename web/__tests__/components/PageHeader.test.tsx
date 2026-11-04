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
 * the site switcher and the drawer offer the same site entries ("site
 * settings", "manage sites", "new site") by what the person administers, none
 * in demo mode, and the user menu's admin panel lands site admins on their
 * sites.
 *
 * past ten sites the switcher opens on a filter that keeps every typed key
 * from the menu's typeahead, and the drawer's site list has the same filter.
 * in both, escape clears the filter before it closes anything.
 *
 * jsdom applies no media queries, so `md:hidden` markup renders here as it does
 * on a phone; the breakpoint itself is not on trial.
 */
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PageHeader } from '@/components/PageHeader';
import { createSite } from '@/hooks/useFirestore';
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

interface MockAuth {
  isSuperadmin: boolean;
  administersAnySite: boolean;
  adminOf: string[];
}
// as AuthContext: a superadmin administers every site
const SITE_ADMIN: MockAuth = { isSuperadmin: false, administersAnySite: true, adminOf: ['site-a'] };
const ADMIN_ELSEWHERE: MockAuth = { isSuperadmin: false, administersAnySite: true, adminOf: ['site-b'] };
const MEMBER: MockAuth = { isSuperadmin: false, administersAnySite: false, adminOf: [] };
const SUPERADMIN: MockAuth = { isSuperadmin: true, administersAnySite: true, adminOf: [] };

let mockAuth = SITE_ADMIN;
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'op-uid', email: 'op@example.com', displayName: 'op' },
    signOut: jest.fn(),
    isSuperadmin: mockAuth.isSuperadmin,
    administersAnySite: mockAuth.administersAnySite,
    isSiteAdmin: (siteId: string) => mockAuth.isSuperadmin || mockAuth.adminOf.includes(siteId),
  }),
}));

beforeEach(() => {
  mockAuth = SITE_ADMIN;
});

jest.mock('@/components/ReportBugDialog', () => ({
  ReportBugDialog: () => null,
}));

// the real module loads the firestore sdk; the header only hands its createSite to the dialog
jest.mock('@/hooks/useFirestore', () => ({ createSite: jest.fn() }));

interface MockDialogProps {
  open: boolean;
  onCreateSite: unknown;
  onSiteCreated?: (siteId: string) => void;
}
let mockDialogProps: MockDialogProps | undefined;
jest.mock('@/components/CreateSiteDialog', () => ({
  CreateSiteDialog: (props: MockDialogProps) => {
    mockDialogProps = props;
    return props.open ? (
      <div data-testid="create-site-dialog">
        <button type="button" onClick={() => props.onSiteCreated?.('new-site')}>
          create
        </button>
      </div>
    ) : null;
  },
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

function renderHeader(props: Partial<React.ComponentProps<typeof PageHeader>> = {}) {
  const user = userEvent.setup();
  const view = render(
    <PageHeader currentPage="dashboard" sites={SITES} currentSiteId="site-a" onSiteChange={jest.fn()} {...props} />,
  );
  return { user, ...view };
}

async function openDrawer() {
  const rendered = renderHeader();
  const trigger = screen.getByRole('button', { name: 'menu', exact: true });
  await rendered.user.click(trigger);
  return { ...rendered, trigger, drawer: screen.getByRole('dialog', { name: 'menu' }) };
}

async function openSwitcher(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('site-switcher-trigger'));
  return screen.findByRole('menu');
}

const SITE_ENTRIES = ['site settings', 'manage sites', 'new site'];

// the site entries a surface offers, in its order
function siteEntries(surface: HTMLElement, role: 'menuitem' | 'button'): string[] {
  return within(surface)
    .queryAllByRole(role)
    .map((item) => item.textContent ?? '')
    .filter((label) => SITE_ENTRIES.includes(label));
}

// "site settings" needs admin of the current site; "new site" is only for
// people who administer nothing.
const ENTRIES_BY_ROLE: [string, string[], MockAuth][] = [
  ['a site admin', ['site settings', 'manage sites'], SITE_ADMIN],
  ['an admin of another site', ['manage sites'], ADMIN_ELSEWHERE],
  ['a member who administers nothing', ['new site'], MEMBER],
  ['a superadmin', ['site settings', 'manage sites'], SUPERADMIN],
];

describe('PageHeader site entries', () => {
  it.each(ENTRIES_BY_ROLE)('the switcher offers %s %j', async (_who, entries, auth) => {
    mockAuth = auth;
    const { user } = renderHeader();

    const menu = await openSwitcher(user);

    expect(siteEntries(menu, 'menuitem')).toEqual(entries);
    expect(within(menu).getByRole('separator')).toBeInTheDocument();
  });

  it.each(ENTRIES_BY_ROLE)('the drawer offers %s %j', async (_who, entries, auth) => {
    mockAuth = auth;
    const { drawer } = await openDrawer();

    expect(siteEntries(drawer, 'button')).toEqual(entries);
  });

  it.each([
    ['a site admin', SITE_ADMIN],
    ['a member who administers nothing', MEMBER],
  ])('offers %s none of them in demo mode', async (_who, auth) => {
    mockAuth = auth;
    const { user } = renderHeader({ disableNav: true });

    const menu = await openSwitcher(user);

    expect(siteEntries(menu, 'menuitem')).toEqual([]);
    expect(within(menu).queryByRole('separator')).toBeNull();
  });

  it("site settings opens the current site's settings", async () => {
    const { user } = renderHeader();

    await openSwitcher(user);
    await user.click(screen.getByRole('menuitem', { name: 'site settings' }));

    expect(mockPush).toHaveBeenCalledWith('/admin/sites/site-a');
  });

  it('manage sites opens the sites page', async () => {
    const { user } = renderHeader();

    await openSwitcher(user);
    await user.click(screen.getByRole('menuitem', { name: 'manage sites' }));

    expect(mockPush).toHaveBeenCalledWith('/admin/sites');
  });

  it('new site opens the dialog, and the site it creates becomes the current one', async () => {
    mockAuth = MEMBER;
    const onSiteChange = jest.fn();
    const { user } = renderHeader({ onSiteChange });

    await openSwitcher(user);
    expect(screen.queryByTestId('create-site-dialog')).toBeNull();
    await user.click(screen.getByRole('menuitem', { name: 'new site' }));
    const dialog = await screen.findByTestId('create-site-dialog');
    await user.click(within(dialog).getByRole('button', { name: 'create' }));

    expect(mockDialogProps?.onCreateSite).toBe(createSite);
    expect(onSiteChange).toHaveBeenCalledWith('new-site');
  });

  it('the drawer closes as it opens site settings', async () => {
    const { user } = await openDrawer();

    await user.click(screen.getByRole('button', { name: 'site settings' }));

    expect(screen.queryByRole('dialog', { name: 'menu' })).toBeNull();
    expect(mockPush).toHaveBeenCalledWith('/admin/sites/site-a');
  });

  it('the drawer closes as it opens new site', async () => {
    mockAuth = MEMBER;
    const { user } = await openDrawer();

    await user.click(screen.getByRole('button', { name: 'new site' }));

    expect(screen.queryByRole('dialog', { name: 'menu' })).toBeNull();
    expect(await screen.findByTestId('create-site-dialog')).toBeInTheDocument();
  });
});

// eleven: one past the switcher's filter threshold
const MANY_SITES = [
  ...SITES,
  ...Array.from({ length: 9 }, (_, i) => ({ id: `harbor-${i}`, name: `harbor ${i}` })),
];

// the sites a surface lists, without its site entries
function siteNames(surface: HTMLElement, role: 'menuitem' | 'button'): string[] {
  return within(surface)
    .queryAllByRole(role)
    .map((item) => item.textContent ?? '')
    .filter((label) => !SITE_ENTRIES.includes(label));
}

describe('PageHeader site filter', () => {
  it('is not in a switcher of ten sites', async () => {
    const { user } = renderHeader({ sites: MANY_SITES.slice(0, 10) });

    const menu = await openSwitcher(user);

    expect(within(menu).queryByRole('textbox')).toBeNull();
    expect(siteNames(menu, 'menuitem')).toHaveLength(10);
  });

  it('past ten sites the switcher opens on it, and typed keys narrow the sites, not the typeahead', async () => {
    const { user } = renderHeader({ sites: MANY_SITES });

    const menu = await openSwitcher(user);
    const filter = within(menu).getByRole('textbox', { name: 'filter sites' });
    expect(filter).toHaveFocus();
    // "s" alone would be typeahead to "site settings"
    await user.keyboard('south');

    expect(filter).toHaveValue('south');
    expect(filter).toHaveFocus();
    expect(siteNames(menu, 'menuitem')).toEqual(['gallery south']);
    expect(siteEntries(menu, 'menuitem')).toEqual(['site settings', 'manage sites']);
  });

  it('enter picks the first match and closes the switcher', async () => {
    const onSiteChange = jest.fn();
    const { user } = renderHeader({ sites: MANY_SITES, onSiteChange });

    await openSwitcher(user);
    await user.keyboard('harbor{Enter}');

    expect(onSiteChange).toHaveBeenCalledWith('harbor-0');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('arrow down moves from the filter into the sites, and up from the first one comes back', async () => {
    const { user } = renderHeader({ sites: MANY_SITES });

    const menu = await openSwitcher(user);
    await user.keyboard('harbor{ArrowDown}');
    expect(within(menu).getByRole('menuitem', { name: 'harbor 0' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(within(menu).getByRole('menuitem', { name: 'harbor 1' })).toHaveFocus();
    await user.keyboard('{ArrowUp}{ArrowUp}');

    expect(within(menu).getByRole('textbox', { name: 'filter sites' })).toHaveFocus();
  });

  it('takes the focus back once the pointer leaves a site, so typing still filters', async () => {
    const { user } = renderHeader({ sites: MANY_SITES });

    const menu = await openSwitcher(user);
    const filter = within(menu).getByRole('textbox', { name: 'filter sites' });
    const site = within(menu).getByRole('menuitem', { name: 'harbor 3' });
    await user.hover(site);
    expect(site).toHaveFocus();
    // back up over the filter, with no click on it
    await user.hover(filter);
    expect(filter).toHaveFocus();
    await user.keyboard('3');

    expect(filter).toHaveValue('3');
    expect(siteNames(menu, 'menuitem')).toEqual(['harbor 3']);
  });

  it('escape clears it and keeps the switcher open; the next escape closes the switcher', async () => {
    const { user } = renderHeader({ sites: MANY_SITES });

    const menu = await openSwitcher(user);
    const filter = within(menu).getByRole('textbox', { name: 'filter sites' });
    await user.keyboard('harbor');
    await user.keyboard('{Escape}');

    expect(filter).toHaveValue('');
    expect(screen.getByRole('menu')).toBe(menu);
    expect(siteNames(menu, 'menuitem')).toHaveLength(MANY_SITES.length);

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(screen.getByTestId('site-switcher-trigger')).toHaveFocus();
  });

  it("is in the drawer's site list past ten sites, and picking a match closes the drawer", async () => {
    const onSiteChange = jest.fn();
    const { user } = renderHeader({ sites: MANY_SITES, onSiteChange });
    await user.click(screen.getByRole('button', { name: 'menu', exact: true }));
    await user.click(screen.getByTestId('drawer-site-toggle'));
    const drawer = screen.getByRole('dialog', { name: 'menu' });

    await user.type(within(drawer).getByRole('textbox', { name: 'filter sites' }), 'south');
    expect(within(drawer).queryByRole('button', { name: 'gallery north' })).toBeNull();
    expect(within(drawer).queryByRole('button', { name: 'harbor 0' })).toBeNull();
    await user.click(within(drawer).getByRole('button', { name: 'gallery south' }));

    expect(onSiteChange).toHaveBeenCalledWith('site-b');
    expect(screen.queryByRole('dialog', { name: 'menu' })).toBeNull();
  });

  it("escape clears the drawer's filter and keeps the drawer open; the next escape closes it", async () => {
    const { user } = renderHeader({ sites: MANY_SITES });
    await user.click(screen.getByRole('button', { name: 'menu', exact: true }));
    await user.click(screen.getByTestId('drawer-site-toggle'));
    const filter = within(screen.getByRole('dialog', { name: 'menu' })).getByRole('textbox', { name: 'filter sites' });

    await user.type(filter, 'harbor');
    await user.keyboard('{Escape}');

    expect(filter).toHaveValue('');
    expect(screen.getByRole('dialog', { name: 'menu' })).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: 'menu' })).toBeNull();
  });
});

describe('PageHeader admin panel entry', () => {
  it.each([
    ['a site admin', '/admin/sites', SITE_ADMIN],
    ['a superadmin', '/admin/installers', SUPERADMIN],
  ])('takes %s to %s', async (_who, href, auth) => {
    mockAuth = auth;
    const { user } = renderHeader();

    await user.click(screen.getByTestId('user-menu-trigger'));
    await user.click(await screen.findByRole('menuitem', { name: 'admin panel' }));

    expect(mockPush).toHaveBeenCalledWith(href);
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
