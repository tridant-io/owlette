/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * the admin panel's hoot page: one site's switch and senders at a time, for a
 * site the person administers whole and no other.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import HootSettingsPage from '@/app/admin/hoot/page';

// radix's select asks jsdom for these
window.HTMLElement.prototype.hasPointerCapture = jest.fn();
window.HTMLElement.prototype.releasePointerCapture = jest.fn();
window.HTMLElement.prototype.scrollIntoView = jest.fn();

type SiteRow = { id: string; name: string };

let sites: SiteRow[] = [];
let administered: string[] = [];
let lastSiteId: string | null = null;
const updateLastSite = jest.fn();
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'u1' },
    isSuperadmin: false,
    userSites: sites.map((site) => site.id),
    lastSiteId,
    updateLastSite,
    isSiteAdmin: (siteId: string) => administered.includes(siteId),
  }),
}));
jest.mock('@/hooks/useFirestore', () => ({
  useSites: () => ({ sites, loading: false }),
}));

const fleetSettingsFor = jest.fn((_siteId: string) => ({ settings: { enabled: false, senders: {} }, loading: false }));
jest.mock('@/hooks/useFleetSettings', () => ({
  useFleetSettings: (siteId: string) => fleetSettingsFor(siteId),
}));
jest.mock('@/hooks/useSiteMachines', () => ({
  useSiteMachines: () => ({ machines: [], error: null, refresh: jest.fn() }),
}));
jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

const fetchMock = jest.fn();

beforeEach(() => {
  sites = [
    { id: 'site-a', name: 'Site A' },
    { id: 'site-b', name: 'Site B' },
    { id: 'site-c', name: 'Site C' },
  ];
  administered = ['site-a', 'site-b'];
  lastSiteId = null;
  updateLastSite.mockReset();
  fleetSettingsFor.mockClear();
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({}) });
  global.fetch = fetchMock as unknown as typeof fetch;
  window.localStorage.clear();
});

const theSwitch = () => screen.getByRole('switch', { name: 'let machines act on other machines' });

describe('which site it shows', () => {
  it('opens on the site last worked on', () => {
    lastSiteId = 'site-b';
    render(<HootSettingsPage />);

    expect(theSwitch()).toHaveAttribute('id', 'fleet-site-b');
    expect(fleetSettingsFor).toHaveBeenLastCalledWith('site-b');
  });

  it('opens on the first administered site when the last one is not administered', () => {
    lastSiteId = 'site-c';
    render(<HootSettingsPage />);

    expect(theSwitch()).toHaveAttribute('id', 'fleet-site-a');
  });

  it('offers only the sites the person administers whole, and remembers the pick', async () => {
    const user = userEvent.setup();
    render(<HootSettingsPage />);

    await user.click(screen.getByRole('combobox', { name: 'site' }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Site A', 'Site B']);
    await user.click(screen.getByRole('option', { name: 'Site B' }));

    expect(theSwitch()).toHaveAttribute('id', 'fleet-site-b');
    expect(updateLastSite).toHaveBeenCalledWith('site-b');
  });

  it('shows no picker for one site', () => {
    administered = ['site-a'];
    render(<HootSettingsPage />);

    expect(screen.queryByRole('combobox', { name: 'site' })).not.toBeInTheDocument();
    expect(theSwitch()).toHaveAttribute('id', 'fleet-site-a');
  });

  it('says what it needs when the person administers no site whole', () => {
    administered = [];
    render(<HootSettingsPage />);

    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.getByText('these settings need a site you own or administer whole.')).toBeInTheDocument();
  });
});

describe('the switch', () => {
  it('PATCHes the site\'s fleet settings the moment it moves', async () => {
    const user = userEvent.setup();
    lastSiteId = 'site-b';
    render(<HootSettingsPage />);

    await user.click(theSwitch());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/sites/site-b/fleet-settings');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ enabled: true });
  });

  it('sits in a panel above the senders', () => {
    render(<HootSettingsPage />);

    expect(screen.getByRole('region', { name: 'machines' })).toContainElement(theSwitch());
    expect(screen.getByRole('region', { name: 'machines that act on others' })).toBeInTheDocument();
  });
});
