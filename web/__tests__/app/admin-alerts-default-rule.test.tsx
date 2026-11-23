/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * /admin/alerts shows the default low disk rule on a site that never saved
 * its rules, the same rule the metrics function evaluates there. Turning it
 * off or deleting it saves the whole list, so the change sticks.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import AlertsPage from '@/app/admin/alerts/page';
import { DEFAULT_LOW_DISK_RULE } from '@/lib/defaultAlertRules';

window.HTMLElement.prototype.hasPointerCapture = jest.fn();
window.HTMLElement.prototype.releasePointerCapture = jest.fn();
window.HTMLElement.prototype.scrollIntoView = jest.fn();

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'u1' },
    isSuperadmin: false,
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

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

jest.mock('@/lib/firebase', () => ({ db: {} }));

/** the alerts doc as stored; null is no doc at all */
let mockStored: Record<string, unknown> | null = null;

jest.mock('firebase/firestore', () => ({
  doc: jest.fn(() => ({})),
  getDoc: jest.fn(async () => ({ exists: () => mockStored !== null, data: () => mockStored ?? undefined })),
}));

const fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({}) }) as Response);

/** the rules array of the nth PUT */
function savedRules(call = 0): unknown[] {
  const [, init] = fetchMock.mock.calls[call] as unknown as [string, RequestInit];
  return JSON.parse(init.body as string).rules;
}

function renderPage() {
  render(
    <TooltipProvider>
      <AlertsPage />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  mockStored = null;
  global.fetch = fetchMock as unknown as typeof fetch;
});

it('shows the default rule on a site that never saved its rules', async () => {
  renderPage();

  const toggle = await screen.findByRole('switch', { name: 'enable Low Disk' });
  expect(toggle).toBeChecked();
  expect(screen.getByText(/disk usage \(%\) > 90/)).toHaveTextContent('cooldown 1440m');
});

it('also shows it on a doc that holds no rules array', async () => {
  mockStored = { lastFired: {} };
  renderPage();

  expect(await screen.findByRole('switch', { name: 'enable Low Disk' })).toBeChecked();
});

it('saves the default turned off, under its own id', async () => {
  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByRole('switch', { name: 'enable Low Disk' }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(savedRules()).toEqual([{ ...DEFAULT_LOW_DISK_RULE, enabled: false }]);
});

it('saves an empty list when the default is deleted', async () => {
  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByRole('button', { name: 'delete Low Disk' }));
  await user.click(screen.getByRole('button', { name: /^delete$/ }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(savedRules()).toEqual([]);
});

it('keeps a saved empty list empty', async () => {
  mockStored = { rules: [] };
  renderPage();

  expect(await screen.findByText('no alert rules configured')).toBeInTheDocument();
  expect(screen.queryByRole('switch', { name: 'enable Low Disk' })).toBeNull();
});
