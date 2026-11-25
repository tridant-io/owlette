/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * /admin/alerts keeps each site's rules to that site. A save sent for site A
 * that lands after the admin has moved to site B used to put A's rules on
 * screen under B, and the next edit on B saved A's rules over B's.
 */
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import AlertsPage from '@/app/admin/alerts/page';

window.HTMLElement.prototype.hasPointerCapture = jest.fn();
window.HTMLElement.prototype.releasePointerCapture = jest.fn();
window.HTMLElement.prototype.scrollIntoView = jest.fn();

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'u1' },
    isSuperadmin: false,
    userSites: ['site-a', 'site-b'],
    lastSiteId: 'site-a',
    updateLastSite: jest.fn(),
    userPreferences: { displayAlertsBannerDismissed: true },
    updateUserPreferences: jest.fn(),
  }),
}));

jest.mock('@/hooks/useFirestore', () => ({
  useSites: () => ({
    sites: [
      { id: 'site-a', name: 'site A', owner: 'u1' },
      { id: 'site-b', name: 'site B', owner: 'u1' },
    ],
  }),
}));

jest.mock('@/components/plan/UpgradeGate', () => ({
  UpgradeGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  usePlanGated: () => false,
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

jest.mock('@/lib/firebase', () => ({ db: {} }));

const rule = (id: string, name: string) => ({
  id,
  name,
  metric: 'cpu_percent',
  operator: '>',
  value: 90,
  severity: 'warning',
  channels: ['email'],
  enabled: true,
  cooldownMinutes: 30,
});

const RULES: Record<string, ReturnType<typeof rule>[]> = {
  'site-a': [rule('a1', 'site A cpu')],
  'site-b': [rule('b1', 'site B cpu')],
};

jest.mock('firebase/firestore', () => ({
  doc: jest.fn((_db: unknown, ...path: string[]) => ({ siteId: path[1] })),
  getDoc: jest.fn(async (ref: { siteId: string }) => ({
    exists: () => true,
    data: () => ({ rules: RULES[ref.siteId] }),
  })),
}));

it("never shows a save for the last site under the one now selected", async () => {
  let landSave: () => void = () => {};
  global.fetch = jest.fn(
    () =>
      new Promise((resolve) => {
        landSave = () => resolve({ ok: true, json: async () => ({}) } as Response);
      }),
  ) as unknown as typeof fetch;
  const user = userEvent.setup();
  render(
    <TooltipProvider>
      <AlertsPage />
    </TooltipProvider>,
  );

  // site A: turn its rule off; the save is still out when the admin moves on
  await user.click(await screen.findByRole('switch', { name: 'enable site A cpu' }));
  await user.click(screen.getByRole('combobox', { name: 'site' }));
  await user.click(screen.getByRole('option', { name: 'site B' }));
  expect(await screen.findByText('site B cpu')).toBeInTheDocument();

  await act(async () => landSave());

  expect(screen.queryByText('site A cpu')).toBeNull();
  expect(screen.getByText('site B cpu')).toBeInTheDocument();
});
