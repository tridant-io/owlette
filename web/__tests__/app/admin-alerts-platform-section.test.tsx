/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * /admin/alerts is open to site admins, but its `platform` section (the activity
 * email card) is for superadmins only: absent for everyone else, and after
 * `built-in` and before `custom rules` for a superadmin.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import AlertsPage from '@/app/admin/alerts/page';

let mockIsSuperadmin = false;
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'u1' },
    isSuperadmin: mockIsSuperadmin,
    userSites: ['site-a'],
    lastSiteId: 'site-a',
    updateLastSite: jest.fn(),
    userPreferences: { displayAlertsBannerDismissed: true },
    updateUserPreferences: jest.fn(),
  }),
}));

jest.mock('@/hooks/useFirestore', () => ({
  useSites: () => ({ sites: [{ id: 'site-a', name: 'site A', owner: 'u1' }] }),
}));

jest.mock('@/components/plan/UpgradeGate', () => ({
  UpgradeGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  usePlanGated: () => false,
}));

jest.mock('@/components/AlertEmailToggles', () => ({ AlertEmailToggles: () => <div>built-in toggles</div> }));
jest.mock('@/components/admin/activity/ActivityEmailSettings', () => ({
  ActivityEmailSettings: () => <div>activity email card</div>,
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

jest.mock('@/lib/firebase', () => ({ db: {} }));
jest.mock('firebase/firestore', () => ({
  doc: jest.fn(),
  getDoc: jest.fn(async () => ({ exists: () => false, data: () => undefined })),
}));

const renderPage = () =>
  render(
    <TooltipProvider>
      <AlertsPage />
    </TooltipProvider>,
  );

it('shows a superadmin the platform section between built-in and custom rules', async () => {
  mockIsSuperadmin = true;
  renderPage();

  const platform = await screen.findByRole('heading', { name: /^platform/ });
  expect(platform).toHaveTextContent('platform · superadmins only');
  expect(screen.getByText('activity email card')).toBeInTheDocument();

  const order = [screen.getByText('built-in toggles'), platform, screen.getByRole('heading', { name: 'custom rules' })];
  order.slice(1).forEach((el, i) => {
    expect(order[i].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

it('hides it from a site admin', async () => {
  mockIsSuperadmin = false;
  renderPage();

  await screen.findByRole('heading', { name: 'custom rules' });
  expect(screen.queryByRole('heading', { name: /^platform/ })).not.toBeInTheDocument();
  expect(screen.queryByText('activity email card')).not.toBeInTheDocument();
});
