/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * The superadmin activity page at /admin/activity: every kind of row as text,
 * an opened row with its two shortcut buttons, the filters in the url, and the
 * loading, error, empty and load-more states. It reads through the real
 * `useActivity`, so the tests answer the hook's fetches the way the route does.
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { checkboxRow } from '@/components/ui/multi-select';
import ActivityPage from '@/app/admin/activity/page';
import type { ActivityRow } from '@/lib/activity/types';

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { uid: 'root' }, userSites: [], isSuperadmin: true }),
}));

const TWO_USERS = [
  { uid: 'uid-sam', email: 'sam@lumenevents.example' },
  { uid: 'uid-ana', email: 'ana@tridant.example' },
];
let mockUsers = TWO_USERS;
jest.mock('@/hooks/useUserManagement', () => ({
  useUserManagement: () => ({ users: mockUsers }),
}));

jest.mock('@/hooks/useFirestore', () => ({
  useSites: () => ({
    sites: [
      { id: 'site-lumen', name: 'lumen events' },
      { id: 'site-harbor', name: 'harbor museum' },
    ],
  }),
}));

const mockReplace = jest.fn();
let mockSearch = '';
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

// radix select drives its trigger with pointer capture and scrolls the active item into view
window.HTMLElement.prototype.scrollIntoView = jest.fn();
window.HTMLElement.prototype.hasPointerCapture = jest.fn();
window.HTMLElement.prototype.releasePointerCapture = jest.fn();

const MIN = 60 * 1000;

function row(overrides: Partial<ActivityRow>): ActivityRow {
  return {
    id: 'change:x',
    kind: 'change',
    at: Date.now() - 5 * MIN,
    actor: { type: 'user', id: 'uid-sam', label: 'sam@lumenevents.example' },
    siteId: 'site-lumen',
    action: 'user_mutated:promoted',
    outcome: null,
    details: {},
    ...overrides,
  };
}

const ROWS: ActivityRow[] = [
  row({
    id: 'finding:high',
    kind: 'flagged',
    severity: 'high',
    actor: { type: 'user', id: 'uid-ana', label: 'ana@tridant.example' },
    siteId: null,
    action: 'superadmin_promoted',
    details: {
      title: 'superadmin promoted',
      summary: 'ana@tridant.example made lee a superadmin.',
      facts: [{ label: 'by', value: 'ana via the dashboard' }, { label: 'bad', value: 3 }, ['by', 'x']],
      rowIds: ['change:abc'],
      emailedAt: 1_700_000_000_000,
    },
  }),
  row({
    id: 'finding:digest',
    kind: 'flagged',
    severity: 'digest',
    action: 'new_network_sign_in',
    details: { title: 'sign-in from a new network', summary: 'sam signed in from a network not seen before.' },
  }),
  row({
    id: 'change:user',
    action: 'user_mutated:promoted',
    target: { id: 'lee' },
    details: { from: 'member', to: 'admin', hash: 'h1' },
  }),
  row({
    id: 'change:key',
    actor: { type: 'api_key', id: 'ci-deploy' },
    action: 'roost_mutated:deploy',
    target: { id: 'spring-show' },
  }),
  row({
    id: 'change:machine',
    actor: { type: 'machine', id: 'KIOSK-3' },
    siteId: 'site-harbor',
    action: 'machine_command_dispatched:reboot_machine',
    // as recorded: the target is the command, the machine is in the attributes
    target: { id: 'cmd_mwnqj6bs_imrh8jsk' },
    details: { machineId: 'LOBBY-01' },
  }),
  row({
    id: 'change:system',
    actor: { type: 'system', id: 'talon_runner' },
    action: 'machine_command_dispatched:restart_process',
  }),
  row({
    id: 'change:hoot',
    action: 'webhook_mutated:created',
    target: { id: 'hook-1' },
    details: { via: 'hoot' },
  }),
  row({
    id: 'finding:digested',
    kind: 'flagged',
    severity: 'digest',
    action: 'user_deleted',
    details: { title: 'user deleted', summary: 'sam deleted the account kai.', digestedAt: 1_700_000_100_000 },
  }),
  row({
    id: 'platform:passed',
    kind: 'sign_in',
    actor: { type: 'user', id: 'uid-pat', label: 'pat@lumenevents.example' },
    siteId: null,
    action: 'second_factor',
    outcome: 'allow',
    details: { method: 'totp' },
  }),
  row({
    id: 'change:unknown',
    actor: { type: 'unknown', id: '' },
    action: 'site_mutated',
  }),
  row({
    id: 'decision:refused',
    kind: 'refused',
    actor: { type: 'user', id: 'uid-kai', label: 'kai@lumenevents.example' },
    action: 'MACHINE_REMOVE',
    outcome: 'deny',
    reason: 'role_insufficient',
    target: { kind: 'machine', id: 'LOBBY-02' },
    details: { route: '/api/sites/x/machines/y', method: 'DELETE' },
  }),
  row({
    id: 'decision:host',
    kind: 'refused',
    actor: { type: 'system', id: 'swoop_host' },
    subject: { type: 'user', id: 'uid-viv', label: 'viv@lumenevents.example' },
    action: 'MACHINE_REMOTE_CONTROL',
    outcome: 'deny',
    reason: 'input',
    target: { kind: 'swoop_session', id: 'b646bb7d', machineId: 'TEC-B4A' },
    details: { event: 'input_not_permitted', sid: 'b646bb7d', viewerId: 'abf1c8d7', target: { kind: 'swoop_session', id: 'b646bb7d', machineId: 'TEC-B4A' } },
  }),
  row({
    id: 'platform:signin',
    kind: 'sign_in',
    actor: { type: 'user', id: 'uid-ana', label: 'ana@tridant.example' },
    siteId: null,
    action: 'sign_in',
    outcome: 'allow',
    network: { key: 'asn:7018', prefix: '99.42.8.0/24' },
    details: { method: 'passkey', role: 'superadmin' },
  }),
  row({
    id: 'platform:second',
    kind: 'sign_in',
    actor: { type: 'user', id: 'uid-jo', label: 'jo@harbormuseum.example' },
    siteId: null,
    action: 'second_factor',
    outcome: 'deny',
    reason: 'invalid_totp_code',
    network: { key: 'asn:7922', prefix: null },
    details: { method: 'totp', role: 'admin' },
  }),
];

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

const fetchMock = jest.fn();
let originalFetch: typeof global.fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  fetchMock.mockReset();
  mockReplace.mockReset();
  mockSearch = '';
  mockUsers = TWO_USERS;
  global.fetch = fetchMock as unknown as typeof global.fetch;
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

function renderPage() {
  return render(
    <TooltipProvider>
      <ActivityPage />
    </TooltipProvider>,
  );
}

// a picker row's text: the label around its checkbox square, which holds none of its own
const rowText = (checkbox: Element) => checkbox.closest('label')?.textContent;

async function item(text: RegExp | string) {
  const list = await screen.findByRole('list', { name: 'activity' });
  return within(list)
    .getAllByRole('button', { expanded: false })
    .find((b) => (typeof text === 'string' ? b.textContent?.includes(text) : text.test(b.textContent ?? '')))!;
}

describe('activity page rows', () => {
  beforeEach(() => fetchMock.mockResolvedValue(jsonResponse({ rows: ROWS })));

  it('reads the first page for the default view', async () => {
    renderPage();
    await screen.findByRole('list', { name: 'activity' });
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/activity?view=all&page_size=50', { cache: 'no-store' });
  });

  it('tells flagged high and digest apart by label and shows the rule and its summary', async () => {
    renderPage();
    const high = await item('superadmin promoted');
    expect(high).toHaveTextContent('flagged · high');
    expect(high).toHaveTextContent('superadmin promoted ana@tridant.example made lee a superadmin.');
    expect(high).toHaveTextContent('platform · emailed');

    const digest = await item('sign-in from a new network');
    expect(digest).toHaveTextContent('flagged · digest');
    expect(digest).toHaveTextContent('lumen events · in the next digest');
  });

  it('words a change for each actor type', async () => {
    renderPage();
    const user = await item('promoted user lee');
    expect(user).toHaveTextContent('change');
    expect(user).toHaveTextContent('sam@lumenevents.example promoted user lee');
    expect(user).toHaveTextContent('lumen events');

    expect(await item('api key ci-deploy')).toHaveTextContent('api key ci-deploy deploy roost spring-show');
    const machine = await item('machine KIOSK-3');
    expect(machine).toHaveTextContent('machine KIOSK-3 sent reboot machine to LOBBY-01');
    expect(machine).toHaveTextContent('harbor museum');
    expect(await item('owlette · talon runner')).toHaveTextContent('owlette · talon runner sent restart process');
    expect(await item('unknown')).toHaveTextContent('unknown changed site');
  });

  it('says a change was made through hoot, after the site', async () => {
    renderPage();
    const hoot = await item('created webhook hook-1');
    expect(hoot).toHaveTextContent('lumen events · through hoot');
    expect(await item('promoted user lee')).not.toHaveTextContent('through hoot');
  });

  it('words a passed second factor with its method', async () => {
    renderPage();
    expect(await item('passed a second factor')).toHaveTextContent('pat@lumenevents.example passed a second factor (totp)');
  });

  it('words a refusal with its target and reason', async () => {
    renderPage();
    const refused = await item('kai@lumenevents.example');
    expect(refused).toHaveTextContent('refused');
    expect(refused).toHaveTextContent('kai@lumenevents.example was refused: machine remove on LOBBY-02');
    expect(refused).toHaveTextContent('lumen events · role insufficient');
  });

  it('words a sign-in and a failed second factor with role and network', async () => {
    renderPage();
    const signIn = await item('signed in with a passkey');
    expect(signIn).toHaveTextContent('sign-in');
    expect(signIn).toHaveTextContent('ana@tridant.example signed in with a passkey');
    expect(signIn).toHaveTextContent('superadmin · AS7018 · 99.42.8.0/24');
    expect(signIn).not.toHaveTextContent('platform');

    // the global admin role no longer confers anything, so only superadmin is shown
    const second = await item('failed a second factor');
    expect(second).toHaveTextContent('jo@harbormuseum.example failed a second factor (invalid totp code)');
    expect(second).toHaveTextContent('AS7922');
    expect(second).not.toHaveTextContent('admin ·');
  });
});

describe('an opened row', () => {
  beforeEach(() => fetchMock.mockResolvedValue(jsonResponse({ rows: ROWS })));

  it('leads a host refusal with the person and the machine, and says who reported it', async () => {
    renderPage();
    const host = await item('viv@lumenevents.example');
    expect(host).toHaveTextContent('viv@lumenevents.example was refused: input not permitted on TEC-B4A');
    expect(host).toHaveTextContent('lumen events · reported by owlette · swoop host');
    expect(host).not.toHaveTextContent('input not permitted ·');
    // the host's short reason code repeats the line, so the meta does not carry it
    expect(host).not.toHaveTextContent('swoop host · input');
  });

  it('shows the viewer, the machine and a readable target, and filters by the subject', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await item('viv@lumenevents.example'));

    const facts = Object.fromEntries(
      [...document.querySelectorAll('dt')].map((t) => [t.textContent, t.nextElementSibling?.textContent]),
    );
    expect(facts.viewer).toBe('viv@lumenevents.example');
    expect(facts.machine).toBe('TEC-B4A');
    expect(facts.target).toBe('swoop session b646bb7d');

    await user.click(screen.getByRole('button', { name: 'everything from this actor' }));
    expect(mockReplace).toHaveBeenCalledWith('/admin/activity?user=uid-viv', { scroll: false });
  });

  it('shows its details and sets the user filter from "everything from this actor"', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await item('promoted user lee'));

    const details = screen.getAllByRole('definition').map((d) => d.textContent);
    expect(details).toEqual(expect.arrayContaining(['user_mutated:promoted', 'member', 'admin', 'h1']));
    expect(screen.getByText('hash')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'everything from this actor' }));
    expect(mockReplace).toHaveBeenCalledWith('/admin/activity?user=uid-sam', { scroll: false });
  });

  it('sets the site filter from "everything on this site"', async () => {
    const user = userEvent.setup();
    mockSearch = 'view=changes';
    renderPage();
    await user.click(await item('promoted user lee'));
    await user.click(screen.getByRole('button', { name: 'everything on this site' }));
    expect(mockReplace).toHaveBeenCalledWith('/admin/activity?site=site-lumen', { scroll: false });
  });

  it('hides the actor shortcut for an api key and the site shortcut for a platform row', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await item('api key ci-deploy'));
    expect(screen.queryByRole('button', { name: 'everything from this actor' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'everything on this site' })).toBeInTheDocument();

    await user.click(await item('signed in with a passkey'));
    expect(screen.getByRole('button', { name: 'everything from this actor' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'everything on this site' })).not.toBeInTheDocument();
  });

  it('shows when a finding was emailed or put in a digest', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await item('superadmin promoted'));
    expect(screen.getByText('emailed')).toBeInTheDocument();
    await user.click(await item('user deleted'));
    expect(screen.getByText('in a digest')).toBeInTheDocument();
  });

  it('shows a finding as its rule, severity and facts', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await item('superadmin promoted'));
    const details = screen.getAllByRole('definition').map((d) => d.textContent);
    expect(details).toEqual(expect.arrayContaining(['superadmin promoted', 'high', 'ana via the dashboard', '1']));
  });
});

describe('the filters', () => {
  it('reads view, user and site from the url into the request', async () => {
    mockSearch = 'view=refused&user=uid-sam&site=site-lumen';
    fetchMock.mockResolvedValue(jsonResponse({ rows: [] }));
    renderPage();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/admin/activity?view=refused&page_size=50&user=uid-sam&site=site-lumen', {
        cache: 'no-store',
      }),
    );
  });

  it('writes the chosen view to the url and drops it for all', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ rows: [] }));
    renderPage();
    await user.click(screen.getByRole('button', { name: 'sign-ins' }));
    expect(mockReplace).toHaveBeenCalledWith('/admin/activity?view=sign-ins', { scroll: false });
    await user.click(screen.getByRole('button', { name: 'all' }));
    expect(mockReplace).toHaveBeenLastCalledWith('/admin/activity', { scroll: false });
  });

  it('lists users by email and sites by name, and writes a picked user', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ rows: [] }));
    renderPage();
    await user.click(screen.getByRole('button', { name: 'user' }));
    const list = await screen.findByRole('dialog', { name: 'users' });
    // ten or fewer to pick from, so no filter, as in the site switcher
    expect(within(list).queryByRole('textbox')).toBeNull();
    const rows = within(list).getAllByRole('checkbox').map(rowText);
    expect(rows).toEqual(['anyone', 'ana@tridant.example', 'sam@lumenevents.example']);
    expect(within(list).getByRole('checkbox', { name: 'anyone' })).toBeChecked();
    await user.click(within(list).getByRole('checkbox', { name: 'sam@lumenevents.example' }));
    expect(mockReplace).toHaveBeenCalledWith('/admin/activity?user=uid-sam', { scroll: false });
    // several can be picked, so the list stays open
    expect(screen.getByRole('dialog', { name: 'users' })).toBeInTheDocument();
  });

  it('past ten users the list opens on a filter that finds a user by part of an email', async () => {
    mockUsers = [
      ...TWO_USERS,
      ...Array.from({ length: 9 }, (_, i) => ({ uid: `uid-crew-${i}`, email: `crew${i}@venue.example` })),
    ];
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ rows: [] }));
    renderPage();
    await user.click(screen.getByRole('button', { name: 'user' }));
    const list = await screen.findByRole('dialog', { name: 'users' });
    const filter = within(list).getByRole('textbox', { name: 'filter users' });
    await waitFor(() => expect(filter).toHaveFocus());

    await user.type(filter, 'lumen');
    // the match is marked mid-word, which jsdom spaces apart in a row's name, so this reads the text
    const rows = () => Array.from(list.querySelectorAll('[data-site-item]'), rowText);
    expect(rows()).toEqual(['sam@lumenevents.example']);

    await user.clear(filter);
    await user.type(filter, 'zzz');
    expect(within(list).getByText('no users match “zzz”')).toBeInTheDocument();

    await user.clear(filter);
    await user.type(filter, 'lumen{Enter}');
    expect(mockReplace).toHaveBeenCalledWith('/admin/activity?user=uid-sam', { scroll: false });
  });

  it('hides "anyone" while a query is typed, so enter picks a user even when "anyone" holds the text', async () => {
    mockUsers = [
      ...TWO_USERS,
      ...Array.from({ length: 9 }, (_, i) => ({ uid: `uid-crew-${i}`, email: `crew${i}@venue.example` })),
    ];
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ rows: [] }));
    renderPage();
    // the arrow opens the list, as on a select
    screen.getByRole('button', { name: 'user' }).focus();
    await user.keyboard('{ArrowDown}');
    const list = await screen.findByRole('dialog', { name: 'users' });
    const filter = within(list).getByRole('textbox', { name: 'filter users' });
    await waitFor(() => expect(filter).toHaveFocus());

    await user.type(filter, 'an');
    expect(Array.from(list.querySelectorAll('[data-site-item]'), rowText)).toEqual(['ana@tridant.example']);
    await user.keyboard('{Enter}');
    expect(mockReplace).toHaveBeenCalledWith('/admin/activity?user=uid-ana', { scroll: false });
  });

  it('opens ten users with no filter, as the site switcher does ten sites', async () => {
    mockUsers = [
      ...TWO_USERS,
      ...Array.from({ length: 8 }, (_, i) => ({ uid: `uid-crew-${i}`, email: `crew${i}@venue.example` })),
    ];
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ rows: [] }));
    renderPage();
    await user.click(screen.getByRole('button', { name: 'user' }));
    const list = await screen.findByRole('dialog', { name: 'users' });
    expect(within(list).getAllByRole('checkbox')).toHaveLength(11);
    expect(within(list).queryByRole('textbox')).toBeNull();
  });

  it('shows a user id the list has not loaded as itself, and anyone clears it', async () => {
    const user = userEvent.setup();
    mockSearch = 'user=uid-gone';
    fetchMock.mockResolvedValue(jsonResponse({ rows: [] }));
    renderPage();
    const trigger = screen.getByRole('button', { name: 'user' });
    expect(trigger).toHaveTextContent('uid-gone');
    await user.click(trigger);
    const list = await screen.findByRole('dialog', { name: 'users' });
    expect(within(list).getByRole('checkbox', { name: 'uid-gone' })).toBeChecked();
    await user.click(within(list).getByRole('checkbox', { name: 'anyone' }));
    expect(mockReplace).toHaveBeenCalledWith('/admin/activity', { scroll: false });
  });

  it('names a picked site on its trigger, and every site clears it', async () => {
    const user = userEvent.setup();
    mockSearch = 'site=site-harbor';
    fetchMock.mockResolvedValue(jsonResponse({ rows: [] }));
    renderPage();
    const trigger = screen.getByRole('button', { name: 'site' });
    expect(trigger).toHaveTextContent('harbor museum');
    await user.click(trigger);
    const list = await screen.findByRole('dialog', { name: 'sites' });
    expect(within(list).getByRole('checkbox', { name: 'harbor museum' })).toBeChecked();
    await user.click(within(list).getByRole('checkbox', { name: 'every site' }));
    expect(mockReplace).toHaveBeenCalledWith('/admin/activity', { scroll: false });
  });
});

describe('several users and sites', () => {
  beforeEach(() => fetchMock.mockResolvedValue(jsonResponse({ rows: [] })));

  const CREW = Array.from({ length: 10 }, (_, i) => ({ uid: `uid-crew-${i}`, email: `crew${i}@venue.example` }));

  it('opens its list as the multi-select does: a button with a dialog popup, not a combobox', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(screen.queryByRole('combobox', { name: 'user' })).toBeNull();
    const trigger = screen.getByRole('button', { name: 'user' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    expect(await screen.findByRole('dialog', { name: 'users' })).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps the first ten of more ids pasted into the url, so the page loads instead of failing', async () => {
    mockUsers = [...TWO_USERS, ...CREW];
    const eleven = [...CREW.map((c) => c.uid), 'uid-sam'];
    mockSearch = `${eleven.map((id) => `user=${id}`).join('&')}&site=site-lumen`;
    renderPage();
    expect(screen.getByRole('button', { name: 'user' })).toHaveTextContent('10 users');
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/admin/activity?view=all&page_size=50&${CREW.map((c) => `user=${c.uid}`).join('&')}&site=site-lumen`,
        { cache: 'no-store' },
      ),
    );
  });

  it('reads several users and sites from the url into the request', async () => {
    mockSearch = 'user=uid-sam&user=uid-ana&site=site-lumen&site=site-harbor';
    renderPage();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/admin/activity?view=all&page_size=50&user=uid-sam&user=uid-ana&site=site-lumen&site=site-harbor',
        { cache: 'no-store' },
      ),
    );
  });

  it("draws each row as the logs page's multi-select does: its checkbox square first, and no trailing check", async () => {
    const user = userEvent.setup();
    mockSearch = 'user=uid-sam';
    renderPage();
    await user.click(screen.getByRole('button', { name: 'user' }));
    const list = await screen.findByRole('dialog', { name: 'users' });

    for (const box of within(list).getAllByRole('checkbox')) {
      const row = box.closest('label')!;
      expect(row.firstElementChild).toBe(box);
      expect(row).toHaveClass(checkboxRow());
      expect(box).toHaveAttribute('data-state', box.getAttribute('aria-checked') === 'true' ? 'checked' : 'unchecked');
      // no trailing check: any icon in the row is the square's own
      for (const icon of row.querySelectorAll('svg')) expect(box).toContainElement(icon as unknown as HTMLElement);
    }
    expect(within(list).getByRole('checkbox', { name: 'sam@lumenevents.example' })).toHaveAttribute('data-state', 'checked');
    expect(within(list).getByRole('checkbox', { name: 'anyone' })).toHaveAttribute('data-state', 'unchecked');
  });

  it('a row adds a user beside the ones picked, and the list stays open', async () => {
    const user = userEvent.setup();
    mockSearch = 'user=uid-sam';
    renderPage();
    const trigger = screen.getByRole('button', { name: 'user' });
    expect(trigger).toHaveTextContent('sam@lumenevents.example');
    await user.click(trigger);
    const list = await screen.findByRole('dialog', { name: 'users' });
    expect(within(list).getByRole('checkbox', { name: 'anyone' })).not.toBeChecked();
    expect(within(list).getByRole('checkbox', { name: 'sam@lumenevents.example' })).toBeChecked();

    await user.click(within(list).getByRole('checkbox', { name: 'ana@tridant.example' }));
    expect(mockReplace).toHaveBeenCalledWith('/admin/activity?user=uid-sam&user=uid-ana', { scroll: false });
    expect(screen.getByRole('dialog', { name: 'users' })).toBeInTheDocument();
  });

  it('counts several on the trigger, a checked row drops its user, and anyone clears them all', async () => {
    const user = userEvent.setup();
    mockSearch = 'user=uid-sam&user=uid-ana&site=site-lumen&site=site-harbor';
    renderPage();
    expect(screen.getByRole('button', { name: 'user' })).toHaveTextContent('2 users');
    expect(screen.getByRole('button', { name: 'site' })).toHaveTextContent('2 sites');

    await user.click(screen.getByRole('button', { name: 'user' }));
    const list = await screen.findByRole('dialog', { name: 'users' });
    expect(within(list).getByRole('checkbox', { name: 'ana@tridant.example' })).toBeChecked();
    await user.click(within(list).getByRole('checkbox', { name: 'sam@lumenevents.example' }));
    expect(mockReplace).toHaveBeenLastCalledWith('/admin/activity?user=uid-ana&site=site-lumen&site=site-harbor', {
      scroll: false,
    });
    await user.click(within(list).getByRole('checkbox', { name: 'anyone' }));
    expect(mockReplace).toHaveBeenLastCalledWith('/admin/activity?site=site-lumen&site=site-harbor', { scroll: false });
  });

  it('enter toggles the first match, off as well as on', async () => {
    mockUsers = [...TWO_USERS, ...CREW];
    const user = userEvent.setup();
    mockSearch = 'user=uid-ana&user=uid-crew-1';
    renderPage();
    await user.click(screen.getByRole('button', { name: 'user' }));
    const list = await screen.findByRole('dialog', { name: 'users' });
    const filter = within(list).getByRole('textbox', { name: 'filter users' });
    await waitFor(() => expect(filter).toHaveFocus());

    await user.type(filter, 'tridant{Enter}');
    expect(mockReplace).toHaveBeenLastCalledWith('/admin/activity?user=uid-crew-1', { scroll: false });
    expect(screen.getByRole('dialog', { name: 'users' })).toBeInTheDocument();
  });

  it('has an x beside each picker only while it filters, which clears it and hands focus back', async () => {
    const user = userEvent.setup();
    const { unmount } = renderPage();
    expect(screen.queryByRole('button', { name: 'clear user filter' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'clear site filter' })).toBeNull();
    unmount();

    mockSearch = 'view=changes&user=uid-sam&user=uid-ana&site=site-lumen';
    renderPage();
    await user.click(screen.getByRole('button', { name: 'clear user filter' }));
    expect(mockReplace).toHaveBeenLastCalledWith('/admin/activity?view=changes&site=site-lumen', { scroll: false });
    expect(screen.getByRole('button', { name: 'user' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'clear site filter' }));
    expect(mockReplace).toHaveBeenLastCalledWith('/admin/activity?view=changes&user=uid-sam&user=uid-ana', {
      scroll: false,
    });
    expect(screen.getByRole('button', { name: 'site' })).toHaveFocus();
  });

  it('stops at ten users: the rest are disabled, it says so, and a picked one still drops', async () => {
    mockUsers = [...TWO_USERS, ...CREW];
    const user = userEvent.setup();
    mockSearch = CREW.map((c) => `user=${c.uid}`).join('&');
    renderPage();
    expect(screen.getByRole('button', { name: 'user' })).toHaveTextContent('10 users');
    await user.click(screen.getByRole('button', { name: 'user' }));
    const list = await screen.findByRole('dialog', { name: 'users' });
    expect(within(list).getByText('at most 10 users')).toBeInTheDocument();

    const sam = within(list).getByRole('checkbox', { name: 'sam@lumenevents.example' });
    expect(sam).toHaveAttribute('aria-disabled', 'true');
    await user.click(sam);
    expect(mockReplace).not.toHaveBeenCalled();

    await user.click(within(list).getByRole('checkbox', { name: 'crew0@venue.example' }));
    expect(mockReplace).toHaveBeenCalledWith(
      `/admin/activity?${CREW.slice(1)
        .map((c) => `user=${c.uid}`)
        .join('&')}`,
      { scroll: false },
    );
  });

  it('a row shortcut narrows to just that one person or site', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ rows: ROWS }));
    const user = userEvent.setup();
    mockSearch = 'user=uid-ana&user=uid-kai&site=site-harbor&site=site-lumen';
    renderPage();
    await user.click(await item('promoted user lee'));
    await user.click(screen.getByRole('button', { name: 'everything from this actor' }));
    expect(mockReplace).toHaveBeenLastCalledWith('/admin/activity?user=uid-sam&site=site-harbor&site=site-lumen', {
      scroll: false,
    });
    await user.click(screen.getByRole('button', { name: 'everything on this site' }));
    expect(mockReplace).toHaveBeenLastCalledWith('/admin/activity?user=uid-ana&user=uid-kai&site=site-lumen', {
      scroll: false,
    });
  });
});

describe('states', () => {
  it('shows skeleton rows while loading', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(await screen.findByText('loading activity')).toBeInTheDocument();
  });

  it('shows the error with try again, which reads the first page again', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ detail: 'superadmin only' }, 403))
      .mockResolvedValueOnce(jsonResponse({ rows: [ROWS[2]] }));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('superadmin only');
    await user.click(screen.getByRole('button', { name: 'try again' }));
    expect(await item('promoted user lee')).toBeInTheDocument();
  });

  it('shows the empty state', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ rows: [] }));
    renderPage();
    expect(await screen.findByText('nothing here')).toBeInTheDocument();
    expect(screen.getByText('no activity matches this view and these filters')).toBeInTheDocument();
  });

  it('reads past short and empty pages by itself, then offers load more while the token is non-empty, and appends', async () => {
    const user = userEvent.setup();
    const filler = Array.from({ length: 49 }, (_, i) => row({ id: `change:filler${i}`, action: 'webhook_mutated:created' }));
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ rows: [ROWS[0]], next_page_token: 'tok-1' }))
      .mockResolvedValueOnce(jsonResponse({ rows: [], next_page_token: 'tok-2' }))
      .mockResolvedValueOnce(jsonResponse({ rows: filler, next_page_token: 'tok-3' }))
      .mockResolvedValueOnce(jsonResponse({ rows: [ROWS[2]] }));
    renderPage();
    expect(await item('superadmin promoted')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await user.click(await screen.findByRole('button', { name: 'load more' }));
    expect(fetchMock).toHaveBeenLastCalledWith('/api/admin/activity?view=all&page_size=50&page_token=tok-3', {
      cache: 'no-store',
    });
    expect(await item('promoted user lee')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'load more' })).not.toBeInTheDocument();
  });
});
