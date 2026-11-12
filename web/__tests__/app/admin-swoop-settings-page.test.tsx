/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * /admin/swoop/settings — one table, a row per site with its swoop switch. it
 * lists only the sites whose switch the caller may change (a whole-site owner or
 * admin, or a superadmin). the switch is a stub; SiteSwitches.test.tsx covers it.
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import SwoopSettingsPage from '@/app/admin/swoop/settings/page';

let mockAuth: { isSuperadmin: boolean; adminOf: string[] };
const mockUserSites = ['site-a', 'site-b', 'site-c'];
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'me' },
    userSites: mockUserSites,
    isSuperadmin: mockAuth.isSuperadmin,
    isSiteAdmin: (siteId: string) => mockAuth.isSuperadmin || mockAuth.adminOf.includes(siteId),
  }),
}));

let mockSites: { id: string; name: string }[];
let mockLoading: boolean;
const mockUseSites = jest.fn();
jest.mock('@/hooks/useFirestore', () => ({
  useSites: (...args: unknown[]) => {
    mockUseSites(...args);
    return { sites: mockSites, loading: mockLoading };
  },
}));

jest.mock('@/components/admin/sites/SiteSwitches', () => ({
  SwoopSwitch: ({ siteId }: { siteId: string }) => <div data-testid="swoop-switch" data-site={siteId} />,
}));

beforeEach(() => {
  // the owner or admin of site-a and site-c, a member of site-b
  mockAuth = { isSuperadmin: false, adminOf: ['site-a', 'site-c'] };
  mockSites = [
    { id: 'site-a', name: 'Alpha' },
    { id: 'site-b', name: 'Bravo' },
    { id: 'site-c', name: 'Charlie' },
  ];
  mockLoading = false;
});

/** each body row's site name and the site its switch is for. */
function rows() {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => [
      within(row).getAllByRole('cell')[0].textContent,
      within(row).getByTestId('swoop-switch').getAttribute('data-site'),
    ]);
}

it("reads the caller's sites through useSites, under the page's own heading", () => {
  render(<SwoopSettingsPage />);

  expect(mockUseSites).toHaveBeenCalledWith('me', mockUserSites, false);
  expect(screen.getByRole('heading', { level: 1, name: 'swoop settings' })).toBeInTheDocument();
  expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['site', 'swoop']);
});

it('lists only the sites whose switch the caller may change, each with its own switch', () => {
  render(<SwoopSettingsPage />);

  expect(rows()).toEqual([
    ['Alpha', 'site-a'],
    ['Charlie', 'site-c'],
  ]);
});

it('lists every site for a superadmin', () => {
  mockAuth = { isSuperadmin: true, adminOf: [] };
  render(<SwoopSettingsPage />);

  expect(rows().map(([name]) => name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
});

it('says it is loading until the sites arrive', () => {
  mockLoading = true;
  render(<SwoopSettingsPage />);

  expect(screen.getByText('loading sites...')).toBeInTheDocument();
  expect(screen.queryByRole('table')).toBeNull();
});

it('says so when there is no site to change', () => {
  mockAuth.adminOf = [];
  render(<SwoopSettingsPage />);

  expect(screen.getByText('no sites you own or administer')).toBeInTheDocument();
  expect(screen.queryByRole('table')).toBeNull();
});
