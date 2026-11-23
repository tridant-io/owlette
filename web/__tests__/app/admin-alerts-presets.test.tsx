/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * /admin/alerts presets. `disk_percent` is disk usage, so the Low Disk preset
 * has to fire on a disk that is filling up. It used to read `disk_percent < 10`,
 * which fires on an almost empty disk and never on a full one.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import AlertsPage from '@/app/admin/alerts/page';

window.HTMLElement.prototype.hasPointerCapture = jest.fn();
window.HTMLElement.prototype.releasePointerCapture = jest.fn();
window.HTMLElement.prototype.scrollIntoView = jest.fn();
// jsdom's crypto has no randomUUID, which a new rule's id comes from
Object.defineProperty(globalThis.crypto, 'randomUUID', { value: () => 'new-rule-id' });

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

// a site that saved an empty rule list
jest.mock('firebase/firestore', () => ({
  doc: jest.fn(() => ({})),
  getDoc: jest.fn(async () => ({ exists: () => true, data: () => ({ rules: [] }) })),
}));

it('adds a Low Disk preset that fires when disk usage passes 90%', async () => {
  const fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({}) }) as Response);
  global.fetch = fetchMock as unknown as typeof fetch;
  const user = userEvent.setup();
  render(
    <TooltipProvider>
      <AlertsPage />
    </TooltipProvider>,
  );

  await user.click(await screen.findByRole('button', { name: /^presets$/ }));
  await user.click(await screen.findByRole('menuitem', { name: /^Low Disk/ }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('/api/sites/site-a/alerts');
  const { rules } = JSON.parse(init.body as string);
  expect(rules).toHaveLength(1);
  expect(rules[0]).toMatchObject({ name: 'Low Disk', metric: 'disk_percent', operator: '>', value: 90 });
});
