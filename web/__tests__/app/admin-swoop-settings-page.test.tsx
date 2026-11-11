/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * /admin/swoop/settings — a site's swoop switch, under the site picker the other
 * site-scoped admin pages use. it offers only the sites whose switch the caller
 * may change (a whole-site owner or admin, or a superadmin), opens the site the
 * url names, then the caller's last site, then the first, and keeps the pick in
 * the url. the switch is a stub; SiteSwitches.test.tsx covers it.
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SwoopSettingsPage from '@/app/admin/swoop/settings/page';

window.HTMLElement.prototype.hasPointerCapture = jest.fn();
window.HTMLElement.prototype.releasePointerCapture = jest.fn();
window.HTMLElement.prototype.scrollIntoView = jest.fn();

let mockAuth: { isSuperadmin: boolean; adminOf: string[]; lastSiteId: string | null };
const mockUpdateLastSite = jest.fn();
const mockUserSites = ['site-a', 'site-b', 'site-c'];
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'me' },
    userSites: mockUserSites,
    isSuperadmin: mockAuth.isSuperadmin,
    lastSiteId: mockAuth.lastSiteId,
    updateLastSite: mockUpdateLastSite,
    isSiteAdmin: (siteId: string) => mockAuth.isSuperadmin || mockAuth.adminOf.includes(siteId),
  }),
}));

let mockSites: { id: string; name: string }[];
const mockUseSites = jest.fn();
jest.mock('@/hooks/useFirestore', () => ({
  useSites: (...args: unknown[]) => {
    mockUseSites(...args);
    return { sites: mockSites, loading: false };
  },
}));

jest.mock('@/components/admin/sites/SiteSwitches', () => ({
  SwoopSwitch: ({ siteId }: { siteId: string }) => <div data-testid="swoop-switch" data-site={siteId} />,
}));

const mockReplace = jest.fn();
let mockSearch = '';
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

beforeEach(() => {
  // the owner or admin of site-a and site-c, a member of site-b
  mockAuth = { isSuperadmin: false, adminOf: ['site-a', 'site-c'], lastSiteId: null };
  mockSites = [
    { id: 'site-a', name: 'Alpha' },
    { id: 'site-b', name: 'Bravo' },
    { id: 'site-c', name: 'Charlie' },
  ];
  mockSearch = '';
  mockReplace.mockReset();
  mockUpdateLastSite.mockReset();
});

function renderPage() {
  const user = userEvent.setup();
  render(<SwoopSettingsPage />);
  return user;
}

const switchSite = () => screen.getByTestId('swoop-switch').getAttribute('data-site');

it("reads the caller's sites through useSites, under the page's own heading", () => {
  renderPage();

  expect(mockUseSites).toHaveBeenCalledWith('me', mockUserSites, false);
  expect(screen.getByRole('heading', { level: 1, name: 'swoop settings' })).toBeInTheDocument();
});

it('offers only the sites whose switch the caller may change', async () => {
  const user = renderPage();

  await user.click(screen.getByRole('combobox', { name: 'site' }));

  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Alpha', 'Charlie']);
});

it('offers a superadmin every site', async () => {
  mockAuth = { isSuperadmin: true, adminOf: [], lastSiteId: null };
  const user = renderPage();

  await user.click(screen.getByRole('combobox', { name: 'site' }));

  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Alpha', 'Bravo', 'Charlie']);
});

it("puts the site's switch in a panel named for the site", () => {
  renderPage();

  const panel = screen.getByRole('region', { name: 'Alpha' });
  expect(panel).toHaveTextContent('this switch acts the moment it moves.');
  expect(within(panel).getByTestId('swoop-switch')).toHaveAttribute('data-site', 'site-a');
});

it.each([
  ['the site the url names', 'site=site-c', 'site-a', 'site-c'],
  ["the caller's last site with no site in the url", '', 'site-c', 'site-c'],
  ['the last site over a url site the caller may not change', 'site=site-b', 'site-c', 'site-c'],
  ['the first site the caller may change, with no last site', '', null, 'site-a'],
  ['the first site over a last site the caller may not change', '', 'site-b', 'site-a'],
])('opens %s', (_case, search, lastSiteId, expected) => {
  mockSearch = search;
  mockAuth.lastSiteId = lastSiteId;
  renderPage();

  expect(switchSite()).toBe(expected);
});

it('keeps a pick in the url and as the last site', async () => {
  const user = renderPage();

  await user.click(screen.getByRole('combobox', { name: 'site' }));
  await user.click(screen.getByRole('option', { name: 'Charlie' }));

  expect(mockReplace).toHaveBeenCalledWith('/admin/swoop/settings?site=site-c', { scroll: false });
  expect(mockUpdateLastSite).toHaveBeenCalledWith('site-c');
});

it('shows no picker when the caller may change one site only', () => {
  mockAuth.adminOf = ['site-b'];
  renderPage();

  expect(screen.queryByRole('combobox', { name: 'site' })).toBeNull();
  expect(screen.getByRole('region', { name: 'Bravo' })).toBeInTheDocument();
  expect(switchSite()).toBe('site-b');
});

it('shows the heading and nothing else when there is no site to change', () => {
  mockAuth.adminOf = [];
  renderPage();

  expect(screen.getByRole('heading', { level: 1, name: 'swoop settings' })).toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: 'site' })).toBeNull();
  expect(screen.queryByRole('region')).toBeNull();
});
