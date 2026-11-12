/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * admin panel → swoop's sites table: a row per site with its swoop switch. it
 * lists only the sites whose switch the caller may change (a whole-site owner or
 * admin, or a superadmin). the switch is a stub; SiteSwitches.test.tsx covers it.
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { SwoopSiteTable } from '@/components/admin/SwoopSiteTable';

let mockAuth: { isSuperadmin: boolean; adminOf: string[] };
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    isSiteAdmin: (siteId: string) => mockAuth.isSuperadmin || mockAuth.adminOf.includes(siteId),
  }),
}));

jest.mock('@/components/admin/sites/SiteSwitches', () => ({
  SwoopSwitch: ({ siteId }: { siteId: string }) => <div data-testid="swoop-switch" data-site={siteId} />,
}));

const SITES = [
  { id: 'site-a', name: 'Alpha' },
  { id: 'site-b', name: 'Bravo' },
  { id: 'site-c', name: 'Charlie' },
];

beforeEach(() => {
  // the owner or admin of site-a and site-c, a member of site-b
  mockAuth = { isSuperadmin: false, adminOf: ['site-a', 'site-c'] };
});

function renderTable(loading = false) {
  render(<SwoopSiteTable sites={SITES as never} loading={loading} />);
}

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

it('heads its two columns site and swoop', () => {
  renderTable();

  expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['site', 'swoop']);
});

it('lists only the sites whose switch the caller may change, each with its own switch', () => {
  renderTable();

  expect(rows()).toEqual([
    ['Alpha', 'site-a'],
    ['Charlie', 'site-c'],
  ]);
});

it('lists every site for a superadmin', () => {
  mockAuth = { isSuperadmin: true, adminOf: [] };
  renderTable();

  expect(rows().map(([name]) => name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
});

it('says it is loading until the sites arrive', () => {
  renderTable(true);

  expect(screen.getByText('loading sites...')).toBeInTheDocument();
  expect(screen.queryByRole('table')).toBeNull();
});

it('says so when there is no site to change', () => {
  mockAuth.adminOf = [];
  renderTable();

  expect(screen.getByText('no sites you own or administer')).toBeInTheDocument();
  expect(screen.queryByRole('table')).toBeNull();
});
