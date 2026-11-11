/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * /logs "clear logs": a delete the server refused says why, rather than
 * leaving the admin looking at the same logs with no word.
 */
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import LogsPage from '@/app/logs/page';

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'u1' },
    loading: false,
    userPreferences: {},
    isSiteAdmin: () => true,
    machineScope: () => null,
  }),
}));

jest.mock('@/hooks/useCurrentSite', () => ({
  useCurrentSite: () => ({
    sites: [{ id: 'site-A', name: 'site A' }],
    sitesLoading: false,
    currentSiteId: 'site-A',
    currentSite: { id: 'site-A', name: 'site A', owner: 'u1' },
    siteTimezone: undefined,
    hasNoSites: false,
    selectSite: jest.fn(),
  }),
}));

jest.mock('@/hooks/useSitePlan', () => ({ useSitePlan: () => ({ controlLocked: false }) }));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

jest.mock('@/lib/firebase', () => ({ db: {} }));

// one log on screen, so "clear logs" is enabled
jest.mock('firebase/firestore', () => ({
  collection: jest.fn(() => ({})),
  query: jest.fn(() => ({})),
  where: jest.fn(() => ({})),
  orderBy: jest.fn(() => ({})),
  limit: jest.fn(() => ({})),
  startAfter: jest.fn(() => ({})),
  getDocs: jest.fn(async () => ({ docs: [] })),
  onSnapshot: jest.fn((_q: unknown, onNext: (snap: unknown) => void) => {
    const log = {
      id: 'log-1',
      data: () => ({ action: 'process_started', level: 'info', machineId: 'kiosk-01', timestamp: null }),
    };
    onNext({ docs: [log] });
    return () => {};
  }),
  Timestamp: class {},
}));

jest.mock('@/components/PageHeader', () => ({ PageHeader: () => null }));
jest.mock('@/components/AccountSettingsDialog', () => ({ AccountSettingsDialog: () => null }));
jest.mock('@/components/DownloadButton', () => ({ __esModule: true, default: () => null }));

beforeAll(() => {
  global.IntersectionObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver;
});

it('says why when the server refuses to clear the logs', async () => {
  global.fetch = jest.fn(async () => ({
    ok: false,
    json: async () => ({ title: 'forbidden', detail: 'only a site admin can clear its logs' }),
  })) as unknown as typeof fetch;

  render(
    <TooltipProvider>
      <LogsPage />
    </TooltipProvider>,
  );

  await userEvent.click(await screen.findByTestId('logs-clear'));
  const dialog = await screen.findByRole('dialog', { name: 'clear event logs' });
  await userEvent.click(within(dialog).getByRole('button', { name: 'clear logs' }));

  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('only a site admin can clear its logs'));
  expect(global.fetch).toHaveBeenCalledWith('/api/sites/site-A/logs', expect.objectContaining({ method: 'DELETE' }));
});
