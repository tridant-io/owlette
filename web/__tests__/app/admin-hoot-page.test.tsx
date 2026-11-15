/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * the admin panel's hoot page: one site's hoot settings at a time, for a site
 * the person administers whole and no other. the approval switch asks before
 * it turns off, and the senders show only while their switch is on.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
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

let search = '';
const replace = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => '/admin/hoot',
  useSearchParams: () => new URLSearchParams(search),
}));

let fleetEnabled = false;
let storedSenders: Record<string, { maxTier: 1 | 2 | 3; machineIds: string[] | null }> = {};
const fleetSettingsFor = jest.fn((_siteId: string) => ({
  settings: { enabled: fleetEnabled, senders: storedSenders },
  loading: false,
}));
jest.mock('@/hooks/useFleetSettings', () => ({
  useFleetSettings: (siteId: string) => fleetSettingsFor(siteId),
}));
let requireApproval = true;
jest.mock('@/hooks/useHootApprovalSetting', () => ({
  useHootApprovalSetting: () => ({ requireApproval }),
}));
let siteMachines: { id: string; name: string }[] = [];
jest.mock('@/hooks/useSiteMachines', () => ({
  useSiteMachines: () => ({ machines: siteMachines, error: null, refresh: jest.fn() }),
}));
const toastError = jest.fn();
jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: (...args: unknown[]) => toastError(...args), info: jest.fn(), warning: jest.fn() },
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
  fleetEnabled = false;
  storedSenders = {};
  siteMachines = [];
  search = '';
  replace.mockReset();
  toastError.mockReset();
  requireApproval = true;
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

describe('a link from a machine (?site=&machine=)', () => {
  it('opens on the linked site ahead of the last one worked on', () => {
    lastSiteId = 'site-a';
    search = 'site=site-b';
    render(<HootSettingsPage />);

    expect(theSwitch()).toHaveAttribute('id', 'fleet-site-b');
  });

  it('ignores a linked site the person does not administer', () => {
    lastSiteId = 'site-a';
    search = 'site=site-c';
    render(<HootSettingsPage />);

    expect(theSwitch()).toHaveAttribute('id', 'fleet-site-a');
  });
});

describe('the allow card', () => {
  const card = () => screen.queryByTestId('allow-machine-card');

  beforeEach(() => {
    siteMachines = [
      { id: 'm1', name: 'Kiosk One' },
      { id: 'm2', name: 'Kiosk Two' },
    ];
    search = 'site=site-b&machine=m1';
  });

  it('shows for a machine of the site with no sender row', () => {
    render(<HootSettingsPage />);

    expect(card()).toBeInTheDocument();
    expect(screen.getByText('allow Kiosk One to act on other machines')).toBeInTheDocument();
    expect(screen.getByText("ai tools on Kiosk One get hoot's tools for the machines you pick.")).toBeInTheDocument();
    expect(screen.getByText('this also turns on "let machines act on other machines" for Site B.')).toBeInTheDocument();
  });

  it('leaves out the switch note when the switch is already on', () => {
    fleetEnabled = true;
    render(<HootSettingsPage />);

    expect(card()).toBeInTheDocument();
    expect(screen.queryByText(/this also turns on/)).not.toBeInTheDocument();
  });

  it('is absent with no machine in the link', () => {
    search = 'site=site-b';
    render(<HootSettingsPage />);

    expect(card()).not.toBeInTheDocument();
  });

  it('is absent when the linked site is not the one shown', () => {
    search = 'site=site-c&machine=m1';
    render(<HootSettingsPage />);

    expect(theSwitch()).toHaveAttribute('id', 'fleet-site-a');
    expect(card()).not.toBeInTheDocument();
  });

  it('is absent for a machine the site does not have', () => {
    search = 'site=site-b&machine=nope';
    render(<HootSettingsPage />);

    expect(card()).not.toBeInTheDocument();
  });

  it('is absent for a machine that already has a row while the site switch is on', () => {
    fleetEnabled = true;
    storedSenders = { m1: { maxTier: 1, machineIds: [] } };
    render(<HootSettingsPage />);

    expect(card()).not.toBeInTheDocument();
  });

  it('shows prefilled from the stored row when the machine has one but the site switch is off', async () => {
    const user = userEvent.setup();
    storedSenders = { m1: { maxTier: 2, machineIds: ['m2'] }, m2: { maxTier: 1, machineIds: [] } };
    render(<HootSettingsPage />);

    expect(card()).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'how far' })).toHaveTextContent('bounded changes');
    expect(screen.getByText('this also turns on "let machines act on other machines" for Site B.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'allow' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      enabled: true,
      senders: { m1: { maxTier: 2, machineIds: ['m2'] }, m2: { maxTier: 1 } },
    });
  });

  it('allows with one PATCH: the site switch on and the stored senders carried', async () => {
    const user = userEvent.setup();
    storedSenders = { m2: { maxTier: 2, machineIds: ['m1'] } };
    render(<HootSettingsPage />);

    await user.click(screen.getByRole('button', { name: 'allow' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/sites/site-b/fleet-settings');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({
      enabled: true,
      senders: { m2: { maxTier: 2, machineIds: ['m1'] }, m1: { maxTier: 1 } },
    });
  });

  it('sends the chosen tier and machines', async () => {
    const user = userEvent.setup();
    render(<HootSettingsPage />);

    await user.click(screen.getByRole('combobox', { name: 'how far' }));
    await user.click(screen.getByRole('option', { name: 'bounded changes' }));
    await user.click(screen.getByTestId('allow-machine-machines'));
    await user.click(await screen.findByRole('checkbox', { name: 'Kiosk Two' }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'allow' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      enabled: true,
      senders: { m1: { maxTier: 2, machineIds: ['m2'] } },
    });
  });

  it('shows the refusal in a toast and keeps the card', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ detail: 'a second factor is needed' }),
    });
    render(<HootSettingsPage />);

    await user.click(screen.getByRole('button', { name: 'allow' }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('could not change which machines may act on others', {
        description: 'a second factor is needed',
      }),
    );
    expect(card()).toBeInTheDocument();
  });

  it('cancel drops ?machine= and writes nothing', async () => {
    const user = userEvent.setup();
    render(<HootSettingsPage />);

    await user.click(screen.getByRole('button', { name: 'cancel' }));

    expect(replace).toHaveBeenCalledWith('/admin/hoot?site=site-b');
    expect(fetchMock).not.toHaveBeenCalled();
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

  it('shows the senders under it, in the same panel, while it is on', () => {
    fleetEnabled = true;
    render(<HootSettingsPage />);

    const machines = screen.getByRole('region', { name: 'machines' });
    expect(machines).toContainElement(theSwitch());
    expect(within(machines).getByText('this site has no machines yet.')).toBeInTheDocument();
    expect(screen.getAllByRole('region').map((region) => region.getAttribute('aria-labelledby'))).toEqual([
      'hoot-approval',
      'hoot-machines',
    ]);
    expect(screen.queryByText('turn this on to choose which machines may act.')).not.toBeInTheDocument();
  });

  it('hides the senders while it is off, and says how to get them', () => {
    render(<HootSettingsPage />);

    expect(screen.queryByText('this site has no machines yet.')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'machines' })).toHaveTextContent(
      'turn this on to choose which machines may act.',
    );
  });
});

describe('the approval switch', () => {
  const approval = () => screen.getByRole('switch', { name: 'require approval for privileged tools' });

  it('is on by default, in its own panel', () => {
    render(<HootSettingsPage />);

    expect(screen.getByRole('region', { name: 'approval' })).toContainElement(approval());
    expect(approval()).toHaveAttribute('aria-checked', 'true');
  });

  it('asks before it turns off, and writes nothing until the answer', async () => {
    const user = userEvent.setup();
    lastSiteId = 'site-b';
    render(<HootSettingsPage />);

    await user.click(approval());

    expect(await screen.findByText('disable tier-3 approval site-wide?')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'disable approval' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/sites/site-b/hoot-settings');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ requireTier3Approval: false });
  });

  it('writes nothing when the question is cancelled', async () => {
    const user = userEvent.setup();
    render(<HootSettingsPage />);

    await user.click(approval());
    await user.click(await screen.findByRole('button', { name: 'cancel' }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('turns back on in one click', async () => {
    const user = userEvent.setup();
    requireApproval = false;
    render(<HootSettingsPage />);

    expect(approval()).toHaveAttribute('aria-checked', 'false');
    await user.click(approval());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ requireTier3Approval: true });
    expect(screen.queryByText('disable tier-3 approval site-wide?')).not.toBeInTheDocument();
  });
});
