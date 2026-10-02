/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * The admin shell: the mobile menu button had no name, the off-screen drawer
 * stayed in the tab order with no escape, the collapsed rail's links were named
 * only by a tooltip, the active link was marked by colour alone, and the shell
 * rendered its own h1 on top of every page's.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/admin/members',
}));

jest.mock('next/image', () => ({
  __esModule: true,
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

jest.mock('@/components/RequireAdminAccess', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ role: 'superadmin', administersAnySite: true }),
}));

let collapsed = false;
jest.mock('@/hooks/useDevicePrefFlag', () => ({
  useDevicePrefFlag: () => ({ value: collapsed, setValue: jest.fn() }),
  useDevicePrefNumber: (_key: string, initial: number) => ({ value: initial, setValue: jest.fn() }),
}));

import AdminLayout from '@/app/admin/layout';

function renderLayout() {
  const user = userEvent.setup();
  render(
    <AdminLayout>
      <h1>members</h1>
    </AdminLayout>,
  );
  return user;
}

describe('admin layout', () => {
  beforeEach(() => {
    collapsed = false;
  });

  it('leaves the page its single h1', () => {
    renderLayout();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('members');
  });

  it('marks the active destination as the current page', () => {
    renderLayout();
    const active = screen.getAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'page');
    expect(active).toHaveLength(1);
    expect(active[0]).toHaveAttribute('href', '/admin/members');
  });

  it('names the collapsed rail links, whose text is hidden', () => {
    collapsed = true;
    renderLayout();
    expect(screen.getByRole('link', { name: 'members' })).toHaveAttribute('href', '/admin/members');
    expect(screen.getByRole('link', { name: 'installers' })).toHaveAttribute('href', '/admin/installers');
  });

  it('opens the mobile drawer into focus, closes it on escape, and hands focus back', async () => {
    const user = renderLayout();

    const sidebar = document.getElementById('admin-sidebar')!;
    // hidden below lg until opened, so its links are not tab stops off-screen
    expect(sidebar).toHaveClass('invisible', 'lg:visible');

    await user.click(screen.getByRole('button', { name: 'open admin menu' }));
    expect(sidebar).not.toHaveClass('invisible');
    expect(within(sidebar).getByRole('button', { name: 'close admin menu' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(sidebar).toHaveClass('invisible');
    expect(screen.getByRole('button', { name: 'open admin menu' })).toHaveFocus();
  });
});
