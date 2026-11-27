/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * admin panel → sites: the caller's sites with a gear on each one they
 * administer, the owner column for superadmins, the current site first, the
 * filter, "new site" (which opens the new site's settings and leaves the
 * dashboard's site alone), each row's site ID button, and the machines column
 * with its card.
 */

import React from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { createSite, type Site } from '@/hooks/useFirestore';
import type { ListedMachine, UseMachinesBySiteResult } from '@/hooks/useMachinesBySite';
import { SiteList } from '@/components/admin/sites/SiteList';
import SitesPage from '@/app/admin/sites/page';

// loading by default, so the rest of the list reads as it did before the column
let mockMachines: UseMachinesBySiteResult = { machinesBySite: null, loading: true, failed: false };
const mockUseMachinesBySite = jest.fn();
jest.mock('@/hooks/useMachinesBySite', () => ({
  useMachinesBySite: (siteIds: readonly string[]) => {
    mockUseMachinesBySite(siteIds);
    return mockMachines;
  },
}));

let mockAuth: {
  isSuperadmin: boolean;
  adminOf: string[];
  ownerOf: string[];
  scopes?: Record<string, string[]>;
} = { isSuperadmin: false, adminOf: [], ownerOf: [] };
const mockUpdateLastSite = jest.fn();
jest.mock('@/contexts/AuthContext', () => {
  const scopeOf = (siteId: string) => (mockAuth.isSuperadmin ? null : (mockAuth.scopes?.[siteId] ?? null));
  return {
    // as AuthContext: an owner administers their site, a superadmin administers and owns every site,
    // and a scoped row administers nothing (isSiteAdmin and isSiteOwner mean the whole site)
    useAuth: () => ({
      user: { uid: 'me' },
      isSuperadmin: mockAuth.isSuperadmin,
      isSiteAdmin: (siteId: string) =>
        mockAuth.isSuperadmin ||
        (scopeOf(siteId) === null && (mockAuth.adminOf.includes(siteId) || mockAuth.ownerOf.includes(siteId))),
      isSiteOwner: (siteId: string) =>
        mockAuth.isSuperadmin || (scopeOf(siteId) === null && mockAuth.ownerOf.includes(siteId)),
      machineScope: scopeOf,
      // every listed site is one the caller belongs to, so a site they neither own nor administer is a member's
      siteRole: (siteId: string) =>
        mockAuth.ownerOf.includes(siteId) ? 'owner' : mockAuth.adminOf.includes(siteId) ? 'admin' : 'member',
      updateLastSite: mockUpdateLastSite,
    }),
  };
});

let mockSites: { sites: Site[]; sitesLoading: boolean; sitesError: string | null; currentSiteId: string };
const mockSelectSite = jest.fn();
jest.mock('@/hooks/useCurrentSite', () => ({
  useCurrentSite: () => ({ ...mockSites, selectSite: mockSelectSite }),
}));

// the real module loads the firestore sdk; the list only hands its createSite to the dialog
jest.mock('@/hooks/useFirestore', () => ({ createSite: jest.fn() }));

let mockUsers: { uid: string; email: string }[] = [];
const mockUseUserManagement = jest.fn();
jest.mock('@/hooks/useUserManagement', () => ({
  // as the real hook: no users unless it is enabled
  useUserManagement: (enabled: boolean) => {
    mockUseUserManagement(enabled);
    return { users: enabled ? mockUsers : [] };
  },
}));

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
}));

interface MockDialogProps {
  open: boolean;
  onCreateSite: unknown;
  onSiteCreated?: (siteId: string) => void;
}
let mockDialog: MockDialogProps | undefined;
jest.mock('@/components/CreateSiteDialog', () => ({
  CreateSiteDialog: (props: MockDialogProps) => {
    mockDialog = props;
    return props.open ? <div role="dialog" aria-label="create new site" /> : null;
  },
}));

function site(id: string, name: string, extra: Partial<Site> = {}): Site {
  return { id, name, createdAt: 0, ...extra };
}

const ALPHA = site('site-a', 'Alpha', { timezone: 'America/New_York', owner: 'me' });
const BRAVO = site('site-b', 'bravo', { timezone: 'Europe/Berlin', owner: 'owner-1' });
// no timezone (it reads as UTC) and no owner recorded
const CHARLIE = site('site-c', 'Charlie');

beforeEach(() => {
  // admin of site-a, a member of site-b, the owner of site-c
  mockAuth = { isSuperadmin: false, adminOf: ['site-a'], ownerOf: ['site-c'] };
  mockSites = { sites: [CHARLIE, BRAVO, ALPHA], sitesLoading: false, sitesError: null, currentSiteId: 'site-b' };
  mockUsers = [{ uid: 'owner-1', email: 'owner@example.com' }];
  mockDialog = undefined;
  mockMachines = { machinesBySite: null, loading: true, failed: false };
});

function renderList() {
  const user = userEvent.setup();
  render(
    <TooltipProvider>
      <SiteList />
    </TooltipProvider>,
  );
  return user;
}

const COPY_PREFIX = 'copy site ID ';
const rows = () => within(screen.getByRole('list', { name: 'sites' })).getAllByRole('listitem');
// each row's site, read off its copy button: the highlight can split the visible id
const rowIds = () =>
  rows().map((row) =>
    within(row)
      .getByRole('button', { name: /^copy site ID / })
      .getAttribute('aria-label')
      ?.slice(COPY_PREFIX.length),
  );
function rowFor(siteId: string): HTMLElement {
  const row = rows().find((r) => within(r).queryByRole('button', { name: `${COPY_PREFIX}${siteId}` }));
  if (!row) throw new Error(`no row for ${siteId}`);
  return row;
}
const filterInput = () => screen.getByRole('textbox', { name: 'filter sites' });

describe('the header', () => {
  it('names the page', () => {
    renderList();

    expect(screen.getByRole('heading', { level: 1, name: 'sites' })).toBeInTheDocument();
    expect(screen.getByText("the sites you belong to. a site's gear opens its settings.")).toBeInTheDocument();
  });

  it('shows no count of sites until the filter is on', () => {
    renderList();
    expect(screen.queryByText(/\d+ sites?$/)).toBeNull();
    // the old tally card put the number in its own element
    expect(screen.queryByText('3')).toBeNull();
  });

  it('is what /admin/sites renders', () => {
    render(
      <TooltipProvider>
        <SitesPage />
      </TooltipProvider>,
    );

    expect(screen.getByRole('heading', { level: 1, name: 'sites' })).toBeInTheDocument();
    expect(rows()).toHaveLength(3);
  });
});

describe('the column header', () => {
  const header = () => screen.getByText('timezone').parentElement!;

  it('names each column, the last one your role for anyone but a superadmin', () => {
    renderList();

    expect([...header().children].map((cell) => cell.textContent)).toEqual([
      'site',
      'id',
      'timezone',
      'machines',
      'your role',
    ]);
  });

  it('names the last column owner for a superadmin', () => {
    mockAuth = { isSuperadmin: true, adminOf: [], ownerOf: [] };
    renderList();

    expect(header().lastElementChild).toHaveTextContent('owner');
  });
});

describe('gears and roles', () => {
  it('links a gear only on the sites the caller administers', () => {
    renderList();

    expect(screen.getByRole('link', { name: 'settings for Alpha' })).toHaveAttribute('href', '/admin/sites/site-a');
    expect(screen.getByRole('link', { name: 'settings for Charlie' })).toHaveAttribute('href', '/admin/sites/site-c');
    expect(screen.queryByRole('link', { name: 'settings for bravo' })).toBeNull();
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  it('reads the role on each row, and a member-only row has no gear', () => {
    renderList();

    expect(within(rowFor('site-a')).getByText('admin')).toBeInTheDocument();
    expect(within(rowFor('site-c')).getByText('owner')).toBeInTheDocument();
    const memberRow = rowFor('site-b');
    expect(within(memberRow).getByText('member')).toBeInTheDocument();
    expect(within(memberRow).queryByRole('link')).toBeNull();
  });

  it("reads a scoped admin's row as admin with its machine count, and gives it no gear", () => {
    mockAuth.scopes = { 'site-a': ['m1'] };
    renderList();

    const row = rowFor('site-a');
    expect(within(row).getByText('admin · 1 machine')).toBeInTheDocument();
    expect(within(row).queryByRole('link')).toBeNull();
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it("reads a scoped member's row as member with its machine count", () => {
    mockAuth.scopes = { 'site-b': ['m1', 'm2'] };
    renderList();

    const row = rowFor('site-b');
    expect(within(row).getByText('member · 2 machines')).toBeInTheDocument();
    expect(within(row).queryByRole('link')).toBeNull();
  });

  it('shows anyone but a superadmin no owner column', () => {
    renderList();

    expect(mockUseUserManagement).toHaveBeenCalledWith(false);
    expect(mockUseUserManagement).not.toHaveBeenCalledWith(true);
    expect(screen.queryByText('owner@example.com')).toBeNull();
    expect(screen.queryByText('you')).toBeNull();
    expect(screen.queryByText('no owner recorded')).toBeNull();
  });

  it('gives a superadmin the owner column and a gear on every row', () => {
    mockAuth = { isSuperadmin: true, adminOf: [], ownerOf: [] };
    renderList();

    expect(mockUseUserManagement).toHaveBeenCalledWith(true);
    for (const s of [ALPHA, BRAVO, CHARLIE]) {
      expect(within(rowFor(s.id)).getByRole('link', { name: `settings for ${s.name}` })).toHaveAttribute(
        'href',
        `/admin/sites/${s.id}`,
      );
    }
    expect(within(rowFor('site-a')).getByText('you')).toBeInTheDocument();
    expect(within(rowFor('site-b')).getByText('owner@example.com')).toBeInTheDocument();
    expect(within(rowFor('site-c')).getByText('—')).toBeInTheDocument();
    expect(within(rowFor('site-c')).getByText('no owner recorded')).toBeInTheDocument();
    // the owner takes the role's place: a superadmin's role would read owner on every row
    for (const row of rows()) {
      expect(within(row).queryByText(/^(owner|admin|member)$/)).toBeNull();
    }
  });

  it("falls back to the owner's uid when their account has no email", () => {
    mockAuth = { isSuperadmin: true, adminOf: [], ownerOf: [] };
    mockUsers = [];
    renderList();

    expect(within(rowFor('site-b')).getByText('owner-1')).toBeInTheDocument();
  });
});

describe('order', () => {
  it('puts the current site first, with its badge, and the rest by name', () => {
    renderList();

    expect(rowIds()).toEqual(['site-b', 'site-a', 'site-c']);
    expect(within(rowFor('site-b')).getByText('current')).toBeInTheDocument();
    expect(screen.getAllByText('current')).toHaveLength(1);
  });

  it('follows the current site', () => {
    mockSites.currentSiteId = 'site-c';
    renderList();

    expect(rowIds()).toEqual(['site-c', 'site-a', 'site-b']);
    expect(within(rowFor('site-c')).getByText('current')).toBeInTheDocument();
  });
});

describe('the filter', () => {
  it('is never focused on its own, and says what it does', () => {
    renderList();

    expect(filterInput()).not.toHaveFocus();
    expect(filterInput()).toHaveAttribute('placeholder', 'filter sites…');
  });

  it('matches the name, the id and the timezone, case-insensitively, and counts what it shows', async () => {
    const user = renderList();

    await user.type(filterInput(), 'ALP');
    expect(rowIds()).toEqual(['site-a']);
    expect(within(rowFor('site-a')).getByText('Alp', { selector: 'mark' })).toBeInTheDocument();
    expect(screen.getByText('showing 1 of 3 sites')).toBeInTheDocument();

    await user.clear(filterInput());
    await user.type(filterInput(), 'SITE-B');
    expect(rowIds()).toEqual(['site-b']);
    expect(within(rowFor('site-b')).getByText('site-b', { selector: 'mark' })).toBeInTheDocument();

    await user.clear(filterInput());
    await user.type(filterInput(), 'berlin');
    expect(rowIds()).toEqual(['site-b']);
    expect(within(rowFor('site-b')).getByText('Berlin', { selector: 'mark' })).toBeInTheDocument();

    // a site with no timezone reads, and matches, as UTC
    await user.clear(filterInput());
    await user.type(filterInput(), 'utc');
    expect(rowIds()).toEqual(['site-c']);

    await user.clear(filterInput());
    await user.type(filterInput(), 'site-');
    expect(rowIds()).toEqual(['site-b', 'site-a', 'site-c']);
    expect(screen.getByText('showing 3 of 3 sites')).toBeInTheDocument();
  });

  it("matches the owner's email for a superadmin", async () => {
    mockAuth = { isSuperadmin: true, adminOf: [], ownerOf: [] };
    const user = renderList();

    await user.type(filterInput(), 'OWNER@');

    expect(rowIds()).toEqual(['site-b']);
    expect(within(rowFor('site-b')).getByText('owner@', { selector: 'mark' })).toBeInTheDocument();
    expect(screen.getByText('showing 1 of 3 sites')).toBeInTheDocument();
  });

  it('never matches an owner or a role for anyone else', async () => {
    const user = renderList();

    await user.type(filterInput(), 'owner');

    expect(screen.queryByRole('list', { name: 'sites' })).toBeNull();
    expect(screen.getByText('no sites match “owner”')).toBeInTheDocument();
  });

  it('says when nothing matches, and escape clears it', async () => {
    const user = renderList();

    await user.type(filterInput(), 'zzz');
    expect(screen.queryByRole('list', { name: 'sites' })).toBeNull();
    expect(screen.getByText('no sites match “zzz”')).toBeInTheDocument();
    expect(screen.getByText('showing 0 of 3 sites')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(filterInput()).toHaveValue('');
    expect(rows()).toHaveLength(3);
    expect(screen.queryByText(/^showing /)).toBeNull();
    expect(screen.queryByText(/^no sites match/)).toBeNull();
  });

  it('clears from its clear button and keeps the focus in the filter', async () => {
    const user = renderList();
    expect(screen.queryByRole('button', { name: 'clear filter' })).toBeNull();

    await user.type(filterInput(), 'alp');
    await user.click(screen.getByRole('button', { name: 'clear filter' }));

    expect(filterInput()).toHaveValue('');
    expect(filterInput()).toHaveFocus();
    expect(rows()).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'clear filter' })).toBeNull();
  });

  it('is not offered with a single site', () => {
    mockSites.sites = [ALPHA];
    mockSites.currentSiteId = 'site-a';
    renderList();

    expect(screen.queryByRole('textbox', { name: 'filter sites' })).toBeNull();
    expect(rowIds()).toEqual(['site-a']);
  });
});

describe('new site', () => {
  it("opens the create dialog, then the new site's settings, and leaves the dashboard's site alone", async () => {
    const user = renderList();
    expect(screen.queryByRole('dialog', { name: 'create new site' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'new site' }));

    expect(screen.getByRole('dialog', { name: 'create new site' })).toBeInTheDocument();
    expect(mockDialog?.onCreateSite).toBe(createSite);

    act(() => mockDialog?.onSiteCreated?.('new-id'));

    expect(mockPush).toHaveBeenCalledWith('/admin/sites/new-id');
    expect(mockUpdateLastSite).not.toHaveBeenCalled();
    expect(mockSelectSite).not.toHaveBeenCalled();
  });

  it('is offered with no sites yet', () => {
    mockSites = { sites: [], sitesLoading: false, sitesError: null, currentSiteId: '' };
    renderList();

    expect(screen.getByRole('button', { name: 'new site' })).toBeInTheDocument();
  });
});

describe('the site ID', () => {
  it("is a copy button on each site's row", () => {
    renderList();

    for (const s of [ALPHA, BRAVO, CHARLIE]) {
      const row = rows().find((r) => within(r).queryByText(s.name));
      expect(within(row!).getByRole('button', { name: `copy site ID ${s.id}` })).toHaveTextContent(s.id);
    }
  });
});

describe('states', () => {
  it('shows skeleton rows while the sites load', () => {
    mockSites = { sites: [], sitesLoading: true, sitesError: null, currentSiteId: '' };
    renderList();

    expect(screen.getByText('loading sites')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'sites' })).toBeNull();
    expect(screen.queryByText('no sites yet')).toBeNull();
  });

  it('says when there are no sites yet', () => {
    mockSites = { sites: [], sitesLoading: false, sitesError: null, currentSiteId: '' };
    renderList();

    expect(screen.getByText('no sites yet')).toBeInTheDocument();
    expect(screen.getByText('create one with new site.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'filter sites' })).toBeNull();
  });

  it('shows a sites error, never as no sites yet', () => {
    mockSites = { sites: [], sitesLoading: false, sitesError: 'site site-x: permission denied', currentSiteId: '' };
    renderList();

    expect(screen.getByRole('alert')).toHaveTextContent('site site-x: permission denied');
    expect(screen.queryByText('no sites yet')).toBeNull();
  });

  it('keeps the sites that loaded beside an error', () => {
    mockSites.sitesError = 'site site-x: permission denied';
    renderList();

    expect(screen.getByRole('alert')).toHaveTextContent('site site-x: permission denied');
    expect(rows()).toHaveLength(3);
  });
});

describe('the machines column', () => {
  // radix measures its popover with a ResizeObserver and drives pointers with
  // pointer capture; jsdom has neither.
  beforeAll(() => {
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    window.HTMLElement.prototype.hasPointerCapture = jest.fn();
    window.HTMLElement.prototype.releasePointerCapture = jest.fn();
  });

  const DAY_MS = 24 * 60 * 60 * 1000;

  function machine(name: string, state: 'online' | 'asleep' | 'offline', extra: Partial<ListedMachine> = {}): ListedMachine {
    return {
      id: `id-${name}`,
      name,
      online: state === 'online',
      asleep: state === 'asleep',
      lastHeartbeat: state === 'offline' ? new Date(Date.now() - 18 * DAY_MS).toISOString() : new Date().toISOString(),
      agentVersion: '4.2.7',
      ...extra,
    };
  }

  function answer(bySite: Record<string, ListedMachine[] | null>, extra: Partial<UseMachinesBySiteResult> = {}) {
    mockMachines = { machinesBySite: new Map(Object.entries(bySite)), loading: false, failed: false, ...extra };
  }

  const cellOf = (siteId: string) => within(rowFor(siteId)).getByRole('button', { name: /^\d+ machines?[,:]/ });
  // the phone line's count, which jsdom renders beside the md-up cell (whose 0 says it to a screen reader)
  const phoneCount = (siteId: string) =>
    within(rowFor(siteId)).getByText(/^(\d+ machines?|no machines)$/, { ignore: '.sr-only, script, style' });

  const MIXED = [
    machine('MEDIA-SRV', 'online'),
    machine('GALLERY-WALL-02', 'online'),
    machine('TD-RENDER-1', 'offline', { agentVersion: '4.1.28' }),
    machine('KIOSK-ENTRY', 'asleep'),
    machine('GALLERY-WALL-01', 'online', { agentVersion: null }),
  ];

  it("asks for every listed site's machines", () => {
    renderList();

    expect(mockUseMachinesBySite).toHaveBeenLastCalledWith(['site-c', 'site-b', 'site-a']);
  });

  it('shows a skeleton while they load, on both shapes of the row', () => {
    renderList();

    expect(within(rowFor('site-a')).getAllByRole('img', { name: 'loading machines' })).toHaveLength(2);
  });

  it('says — when nothing has loaded, and leaves them off the phone line', () => {
    mockMachines = { machinesBySite: null, loading: false, failed: true };
    renderList();

    const row = rowFor('site-a');
    expect(within(row).getByTitle('machines did not load')).toHaveTextContent('—');
    expect(within(row).queryByText(/^(\d+ machines?|no machines)$/)).toBeNull();
    expect(within(row).queryByRole('img', { name: 'loading machines' })).toBeNull();
  });

  it('says — for a site whose machines the server would not give', () => {
    answer({ 'site-a': null, 'site-b': [], 'site-c': [] });
    renderList();

    expect(within(rowFor('site-a')).getByTitle('machines did not load')).toHaveTextContent('—');
  });

  it('waits on a site the last answer did not hold while a new one is coming, then says —', () => {
    answer({ 'site-b': [], 'site-c': [] }, { loading: true });
    const { rerender } = render(
      <TooltipProvider>
        <SiteList />
      </TooltipProvider>,
    );
    expect(within(rowFor('site-a')).getAllByRole('img', { name: 'loading machines' })).toHaveLength(2);

    answer({ 'site-b': [], 'site-c': [] });
    rerender(
      <TooltipProvider>
        <SiteList />
      </TooltipProvider>,
    );
    expect(within(rowFor('site-a')).getByTitle('machines did not load')).toHaveTextContent('—');
  });

  it('reads a site with no machines as a muted 0, with no card, and no machines on a phone', () => {
    answer({ 'site-a': [], 'site-b': [], 'site-c': [] });
    renderList();

    const row = rowFor('site-a');
    expect(within(row).getByTitle('no machines on this site')).toHaveTextContent('0');
    expect(within(row).queryByRole('button', { name: /machines/ })).toBeNull();
    expect(phoneCount('site-a')).toHaveTextContent('no machines');
  });

  it('reads all online as the count and a green dot', () => {
    answer({ 'site-a': MIXED.filter((m) => m.online), 'site-b': [machine('ONLY', 'online')], 'site-c': [] });
    renderList();

    const cell = cellOf('site-a');
    expect(cell).toHaveAccessibleName('3 machines, all online');
    expect(cell).toHaveTextContent(/^3$/);
    expect(phoneCount('site-a')).toHaveTextContent('3 machines');
    expect(within(rowFor('site-a')).getByRole('img', { name: 'all online' })).toBeInTheDocument();
    expect(cellOf('site-b')).toHaveAccessibleName('1 machine, all online');
    expect(phoneCount('site-b')).toHaveTextContent('1 machine');
  });

  it('reads a mixed site as the count, then how many are offline and asleep', () => {
    answer({ 'site-a': MIXED, 'site-b': [], 'site-c': [] });
    renderList();

    const cell = cellOf('site-a');
    expect(cell).toHaveAccessibleName('5 machines: 3 online, 1 asleep, 1 offline');
    expect(within(cell).getByText('1 offline')).toHaveClass('text-danger');
    expect(within(cell).getByText('1 asleep')).toHaveClass('text-info');
    expect(phoneCount('site-a')).toHaveTextContent('5 machines');
    expect(within(rowFor('site-a')).queryByRole('img', { name: 'all online' })).toBeNull();
  });

  it('reads a site with nothing online as all offline, and offline alone on a phone', () => {
    const off = [machine('DEMO-PC', 'offline'), machine('DEMO-MAC', 'offline', { lastHeartbeat: null })];
    answer({ 'site-a': off, 'site-b': [machine('LAB-MAC', 'asleep')], 'site-c': [] });
    renderList();

    expect(cellOf('site-a')).toHaveAccessibleName('2 machines, all offline');
    expect(within(cellOf('site-a')).getByText('all offline')).toHaveClass('text-danger');
    expect(within(rowFor('site-a')).getByText('offline', { exact: true })).toHaveClass('text-danger');
    expect(cellOf('site-b')).toHaveAccessibleName('1 machine, all asleep');
    expect(within(cellOf('site-b')).getByText('all asleep')).toHaveClass('text-info');
    expect(within(rowFor('site-b')).getByText('asleep', { exact: true })).toHaveClass('text-info');
  });

  it('opens a card on hover: the site, how many are online, and each machine, trouble first', async () => {
    answer({ 'site-a': MIXED, 'site-b': [], 'site-c': [] });
    const user = renderList();

    await user.hover(cellOf('site-a'));
    const card = await screen.findByRole('tooltip');

    expect(card).toHaveTextContent('Alpha');
    expect(card).toHaveTextContent('3 of 5 online');
    const machineRows = within(card).getAllByRole('listitem');
    expect(machineRows.map((r) => r.textContent)).toEqual([
      'TD-RENDER-1last seen 18d agov4.1.28',
      'KIOSK-ENTRYasleepv4.2.7',
      'GALLERY-WALL-01online—',
      'GALLERY-WALL-02onlinev4.2.7',
      'MEDIA-SRVonlinev4.2.7',
    ]);
    expect(within(machineRows[0]).getByText('last seen 18d ago')).toHaveClass('text-muted-foreground');
    expect(within(machineRows[1]).getByText('asleep')).toHaveClass('text-info');
    expect(within(machineRows[2]).getByText('online')).toHaveClass('text-success');
    expect(cellOf('site-a')).toHaveAttribute('aria-describedby', card.id);
  });

  it('says never seen for a machine that never sent a heartbeat', async () => {
    answer({
      'site-a': [machine('DEMO-MAC', 'offline', { lastHeartbeat: null, agentVersion: null })],
      'site-b': [],
      'site-c': [],
    });
    const user = renderList();

    await user.hover(cellOf('site-a'));

    expect(await screen.findByRole('tooltip')).toHaveTextContent('DEMO-MACnever seen—');
  });

  it('lists 12 machines, then sums the rest, saying when they are all online', async () => {
    const arena = Array.from({ length: 30 }, (_, i) =>
      machine(`CONC-SCREEN-${String(i + 1).padStart(2, '0')}`, 'online'),
    );
    arena[4] = machine('CONC-SCREEN-05', 'offline');
    arena[17] = machine('CONC-SCREEN-18', 'offline');
    arena[22] = machine('CONC-SCREEN-23', 'asleep');
    // 14 offline: two of them fall past the cap, so the rest are not all online
    const crowded = Array.from({ length: 14 }, (_, i) => machine(`OFF-${String(i + 1).padStart(2, '0')}`, 'offline'));
    answer({ 'site-a': arena, 'site-b': crowded, 'site-c': [] });
    const user = renderList();

    expect(cellOf('site-a')).toHaveAccessibleName('30 machines: 27 online, 1 asleep, 2 offline');
    await user.hover(cellOf('site-a'));
    const card = await screen.findByRole('tooltip');
    const machineRows = within(card).getAllByRole('listitem');
    expect(machineRows).toHaveLength(13);
    expect(machineRows.slice(0, 4).map((r) => r.textContent?.match(/^CONC-SCREEN-\d+/)?.[0])).toEqual([
      'CONC-SCREEN-05',
      'CONC-SCREEN-18',
      'CONC-SCREEN-23',
      'CONC-SCREEN-01',
    ]);
    expect(machineRows[12]).toHaveTextContent('+ 18 more, all online');

    await user.unhover(cellOf('site-a'));
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(screen.queryByRole('tooltip')).toBeNull();

    await user.hover(cellOf('site-b'));
    const second = await screen.findByRole('tooltip');
    expect(within(second).getAllByRole('listitem')[12]).toHaveTextContent(/^\+ 2 more$/);
  });

  it('opens on keyboard focus, stays open on a click, and closes on escape', async () => {
    answer({ 'site-a': MIXED, 'site-b': [], 'site-c': [] });
    const user = renderList();

    act(() => cellOf('site-a').focus());
    expect(await screen.findByRole('tooltip')).toHaveTextContent('3 of 5 online');

    await user.click(cellOf('site-a'));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
