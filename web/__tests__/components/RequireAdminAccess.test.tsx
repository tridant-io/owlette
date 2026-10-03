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
  usePathname: () => '/admin/members',
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
};
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: auth.user,
    loading: auth.loading,
    role: auth.role,
    isSuperadmin: auth.role === 'superadmin',
    administersAnySite:
      auth.administersAnySite ?? (auth.role === 'admin' || auth.role === 'superadmin'),
    userSites: [],
  }),
}));

import RequireAdminAccess from '@/components/RequireAdminAccess';
import { visibleNavItems, requiredRoleForPath } from '@/app/admin/navItems';

const setAuth = (role: UserRole | null, overrides: Partial<typeof auth> = {}) => {
  auth = { user: { uid: 'u1' }, loading: false, role, ...overrides };
};

const renderGuard = (minRole: 'admin' | 'superadmin') =>
  render(
    <RequireAdminAccess minRole={minRole}>
      <p>admin panel</p>
    </RequireAdminAccess>
  );

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
    setAuth(null, { user: null });
    renderGuard('admin');

    await waitFor(() => expect(push).toHaveBeenCalledWith('/login'));
    expect(toastError).not.toHaveBeenCalled();
    expect(screen.queryByText('admin panel')).not.toBeInTheDocument();
  });

  it('shows the spinner and redirects nowhere while auth is still loading', () => {
    setAuth(null, { user: null, loading: true });
    renderGuard('admin');

    expect(screen.getByText('verifying permissions...')).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe('visibleNavItems', () => {
  it('gives a site administrator exactly the site-scoped destinations, members first', () => {
    expect(visibleNavItems('member', true).map((item) => item.name)).toEqual([
      'members',
      'agent tokens',
      'swoop',
      'schedules',
      'alerts',
      'webhooks',
    ]);
  });

  it('gives a superadmin every destination, with no membership', () => {
    expect(visibleNavItems('superadmin', false).map((item) => item.name)).toEqual([
      'installers',
      'template library',
      'members',
      'users',
      'agent tokens',
      'swoop',
      'schedules',
      'alerts',
      'webhooks',
      'email',
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
    expect(requiredRoleForPath('/admin/members')).toBe('admin');
    expect(requiredRoleForPath('/admin/webhooks')).toBe('admin');
    expect(requiredRoleForPath('/admin/swoop')).toBe('admin');
    expect(requiredRoleForPath('/admin/users')).toBe('superadmin');
  });

  it('lets subpaths inherit their page requirement', () => {
    expect(requiredRoleForPath('/admin/schedules/abc123')).toBe('admin');
    expect(requiredRoleForPath('/admin/installers/3.2.3')).toBe('superadmin');
  });

  it('fails closed on unknown paths and on prefix look-alikes', () => {
    expect(requiredRoleForPath('/admin')).toBe('superadmin');
    expect(requiredRoleForPath('/admin/something-new')).toBe('superadmin');
    expect(requiredRoleForPath('/admin/alertsomething')).toBe('superadmin');
    expect(requiredRoleForPath(null)).toBe('superadmin');
  });
});
