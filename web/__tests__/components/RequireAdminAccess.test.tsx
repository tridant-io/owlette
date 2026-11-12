/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * The admin panel is no longer superadmin-only: global `admin` users get the
 * site-scoped destinations, superadmins get everything. These pin the role gate
 * (children must never mount for someone below `minRole`) and the nav/pathname
 * helpers that decide which destinations exist and what each one demands.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import type { UserRole } from '@/contexts/AuthContext';

const push = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/admin/sites',
}));

const toastError = jest.fn();
jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: (...args: unknown[]) => toastError(...args), info: jest.fn() },
}));

let auth: {
  user: { uid: string } | null;
  loading: boolean;
  role: UserRole | null;
  /** Administers at least one site. Defaults from the role for the cases that
   *  predate wave 5.1; set it explicitly to separate the two. */
  administersAnySite?: boolean;
  /** undefined until the user doc and the membership rows have both landed */
  userSites: string[] | undefined;
};
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: auth.user,
    loading: auth.loading,
    role: auth.role,
    isSuperadmin: auth.role === 'superadmin',
    administersAnySite:
      auth.administersAnySite ?? (auth.role === 'admin' || auth.role === 'superadmin'),
    userSites: auth.userSites,
  }),
}));

import RequireAdminAccess from '@/components/RequireAdminAccess';
import {
  activeNavItem,
  groupNavItems,
  navItemMatches,
  visibleNavItems,
  requiredRoleForPath,
} from '@/app/admin/navItems';

const setAuth = (role: UserRole | null, overrides: Partial<typeof auth> = {}) => {
  auth = { user: { uid: 'u1' }, loading: false, role, userSites: ['site-a'], ...overrides };
};

const guard = (minRole: 'admin' | 'superadmin') => (
  <RequireAdminAccess minRole={minRole}>
    <p>admin panel</p>
  </RequireAdminAccess>
);

const renderGuard = (minRole: 'admin' | 'superadmin') => render(guard(minRole));

beforeEach(() => {
  jest.clearAllMocks();
  setAuth('member');
});

describe('RequireAdminAccess', () => {
  it('bounces a member away from an admin-level route', async () => {
    setAuth('member');
    renderGuard('admin');

    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard'));
    expect(toastError).toHaveBeenCalledWith('access denied', {
      description: 'you do not have permission to access this page.',
    });
    expect(screen.queryByText('admin panel')).not.toBeInTheDocument();
  });

  it('admits an admin to an admin-level route', () => {
    setAuth('admin');
    renderGuard('admin');

    expect(screen.getByText('admin panel')).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('bounces a GLOBAL admin who administers no site', async () => {
    // Wave 5.1: the global role grants nothing on a site. Such a user used to
    // reach every site-scoped admin page, see an empty site list on each, and
    // have every write refused server-side.
    setAuth('admin', { administersAnySite: false });
    renderGuard('admin');

    expect(screen.queryByText('admin panel')).not.toBeInTheDocument();
    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard'));
    expect(toastError).toHaveBeenCalled();
  });

  it('admits a plain member who administers a site', () => {
    // The other half: a self-serve owner carries global role `member`, and the
    // membership is what qualifies them.
    setAuth('member', { administersAnySite: true });
    renderGuard('admin');

    expect(screen.getByText('admin panel')).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it('bounces an admin away from a superadmin-level route', async () => {
    setAuth('admin');
    renderGuard('superadmin');

    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard'));
    expect(screen.queryByText('admin panel')).not.toBeInTheDocument();
  });

  it.each(['admin', 'superadmin'] as const)('admits a superadmin to a %s-level route', (minRole) => {
    setAuth('superadmin');
    renderGuard(minRole);

    expect(screen.getByText('admin panel')).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it('sends a signed-out visitor to /login without a toast', async () => {
    setAuth(null, { user: null, userSites: undefined });
    renderGuard('admin');

    await waitFor(() => expect(push).toHaveBeenCalledWith('/login'));
    expect(toastError).not.toHaveBeenCalled();
    expect(screen.queryByText('admin panel')).not.toBeInTheDocument();
  });

  it('shows the spinner and redirects nowhere while auth is still loading', () => {
    setAuth(null, { user: null, loading: true, userSites: undefined });
    renderGuard('admin');

    expect(screen.getByText('verifying permissions...')).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('waits for the membership rows before deciding, then admits a site admin', () => {
    // a hard load: auth's loading ends with the user doc, before the admin row arrives
    setAuth('member', { userSites: undefined, administersAnySite: false });
    const { rerender } = renderGuard('admin');

    expect(screen.getByText('verifying permissions...')).toBeInTheDocument();
    expect(screen.queryByText('admin panel')).not.toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();

    setAuth('member', { userSites: ['site-a'], administersAnySite: true });
    rerender(guard('admin'));

    expect(screen.getByText('admin panel')).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('standing lost after admission redirects without a toast', async () => {
    // deleting the last site you administer removes your own admin row before the delete answers
    setAuth('member', { administersAnySite: true });
    const { rerender } = renderGuard('admin');
    expect(screen.getByText('admin panel')).toBeInTheDocument();

    setAuth('member', { administersAnySite: false });
    rerender(guard('admin'));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard'));
    expect(push).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('a user denied on first render still gets the toast exactly once', async () => {
    setAuth('member', { administersAnySite: false });
    renderGuard('admin');

    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard'));
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith('access denied', {
      description: 'you do not have permission to access this page.',
    });
    expect(push).toHaveBeenCalledTimes(1);
  });
});

describe('navItemMatches', () => {
  const issues = visibleNavItems('superadmin', false).find((item) => item.name === 'issues')!;

  it.each([
    ['/admin/issues', true],
    ['/admin/issues/42', true],
    ['/admin/issuesx', false],
    ['/admin/installers', false],
    [null, false],
  ])('matches %p: %p', (pathname, expected) => {
    expect(navItemMatches(issues, pathname)).toBe(expected);
  });
});

describe('activeNavItem', () => {
  const items = visibleNavItems('superadmin', false);

  it.each([
    ['/admin/swoop', 'live sessions'],
    ['/admin/swoop/settings', 'settings'],
    ['/admin/swoop/settings/anything', 'settings'],
    ['/admin/sites/site-a', 'sites'],
    ['/admin/issues/42', 'issues'],
  ])('puts %p under %p alone, the longest match', (pathname, name) => {
    expect(activeNavItem(items, pathname)?.name).toBe(name);
  });

  it.each(['/admin', '/admin/swoopy', '/admin/something-new', null])('puts %p under nothing', (pathname) => {
    expect(activeNavItem(items, pathname)).toBeUndefined();
  });
});

describe('visibleNavItems', () => {
  it('gives a site administrator exactly the site-scoped destinations, sites first', () => {
    expect(visibleNavItems('member', true).map((item) => `${item.group}/${item.name}`)).toEqual([
      'fleet/sites',
      'fleet/agent tokens',
      'swoop/live sessions',
      'swoop/settings',
      'hoot/settings',
      'configuration/alerts',
      'configuration/schedules',
      'configuration/webhooks',
    ]);
  });

  it('gives a superadmin every destination, with no membership', () => {
    expect(visibleNavItems('superadmin', false).map((item) => item.name)).toEqual([
      'users',
      'sites',
      'installers',
      'agent tokens',
      'live sessions',
      'settings',
      'settings',
      'alerts',
      'schedules',
      'template library',
      'webhooks',
      'issues',
      'email',
    ]);
  });

  it('groups the destinations into the owner sections in order, dropping empty ones', () => {
    expect(
      groupNavItems(visibleNavItems('superadmin', false)).map(
        ({ group, items }) => `${group}: ${items.map((item) => item.name).join(', ')}`,
      ),
    ).toEqual([
      'people: users',
      'fleet: sites, installers, agent tokens',
      'swoop: live sessions, settings',
      'hoot: settings',
      'configuration: alerts, schedules, template library, webhooks',
      'support: issues, email',
    ]);
    // a site admin has no people section: users is a superadmin's alone
    expect(groupNavItems(visibleNavItems('member', true)).map(({ group }) => group)).toEqual([
      'fleet',
      'swoop',
      'hoot',
      'configuration',
    ]);
  });

  it('gives a GLOBAL admin who administers no site nothing', () => {
    // The migration's point: the global role no longer predicts whether these
    // destinations will work, so it no longer opens them.
    expect(visibleNavItems('admin', false)).toEqual([]);
  });

  it('gives a plain member and a role-less user nothing', () => {
    expect(visibleNavItems('member', false)).toEqual([]);
    expect(visibleNavItems(null, false)).toEqual([]);
  });
});

describe('requiredRoleForPath', () => {
  it('reads the requirement off the matching nav entry', () => {
    expect(requiredRoleForPath('/admin/sites')).toBe('admin');
    expect(requiredRoleForPath('/admin/webhooks')).toBe('admin');
    expect(requiredRoleForPath('/admin/swoop')).toBe('admin');
    expect(requiredRoleForPath('/admin/swoop/settings')).toBe('admin');
    expect(requiredRoleForPath('/admin/users')).toBe('superadmin');
  });

  it('lets subpaths inherit their page requirement', () => {
    expect(requiredRoleForPath('/admin/sites/site-a')).toBe('admin');
    expect(requiredRoleForPath('/admin/schedules/abc123')).toBe('admin');
    expect(requiredRoleForPath('/admin/installers/3.2.3')).toBe('superadmin');
    expect(requiredRoleForPath('/admin/issues/42')).toBe('superadmin');
  });

  it('fails closed on unknown paths and on prefix look-alikes', () => {
    expect(requiredRoleForPath('/admin')).toBe('superadmin');
    expect(requiredRoleForPath('/admin/something-new')).toBe('superadmin');
    expect(requiredRoleForPath('/admin/alertsomething')).toBe('superadmin');
    // the members page's old path: no nav entry names it any more
    expect(requiredRoleForPath('/admin/members')).toBe('superadmin');
    expect(requiredRoleForPath(null)).toBe('superadmin');
  });
});
