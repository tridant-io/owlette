/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * /admin/swoop — one table of the swoop sessions on every site the user can
 * see, read per site from `GET /api/sites/{siteId}/swoop/sessions`. A site the
 * user is only a member of answers 403 and is left out quietly; kill goes
 * through the machine's own `swoop/kill` route with the session's sid.
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import SwoopPage from '@/app/admin/swoop/page';

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'super-1' },
    isSuperadmin: true,
    userSites: [],
    userPreferences: { timeFormat: '12h' },
  }),
}));

// one array for every render: a fresh one each time would refetch forever
const mockSites = [
  { id: 'site-a', name: 'site a' },
  { id: 'site-b', name: 'site b' },
];

jest.mock('@/hooks/useFirestore', () => ({
  useSites: () => ({ sites: mockSites, loading: false, error: null }),
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

interface Reply {
  status: number;
  body: unknown;
}

const sessionsBySite: Record<string, Reply> = {};
let killReply: Reply = { status: 200, body: {} };
let fetchMock: jest.Mock;

function sessionsOk(sessions: unknown[]): Reply {
  return { status: 200, body: { ok: true, data: { sessions } } };
}

function liveSession(overrides: Record<string, unknown> = {}) {
  return {
    sid: 's1',
    machineId: 'kiosk-1',
    state: 'live',
    startedAt: Date.now() - 65_000,
    viewers: [
      { uid: 'u-ana', email: 'ana@example.com', displayName: 'ana', ctl: true, joinedAt: Date.now() - 65_000 },
    ],
    ...overrides,
  };
}

function reply({ status, body }: Reply) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(sessionsBySite)) delete sessionsBySite[key];
  killReply = { status: 200, body: { ok: true, data: { machineId: 'kiosk-1', sid: 's1', via: 'command' } } };
  fetchMock = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/swoop/kill')) return reply(killReply);
    const site = /^\/api\/sites\/([^/]+)\/swoop\/sessions$/.exec(url)?.[1];
    return reply((site && sessionsBySite[site]) || sessionsOk([]));
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

function renderPage() {
  const user = userEvent.setup();
  render(
    <TooltipProvider>
      <SwoopPage />
    </TooltipProvider>,
  );
  return user;
}

describe('/admin/swoop', () => {
  it('lists the sessions of every site in one table', async () => {
    sessionsBySite['site-a'] = sessionsOk([liveSession()]);
    sessionsBySite['site-b'] = sessionsOk([
      liveSession({
        sid: 's2',
        machineId: 'wall-2',
        state: 'pending',
        startedAt: Date.now() - 3_725_000,
        viewers: [{ uid: 'u-bo', email: null, displayName: 'bo', ctl: false, joinedAt: Date.now() }],
      }),
    ]);
    renderPage();

    const kiosk = await screen.findByRole('row', { name: /kiosk-1/ });
    expect(within(kiosk).getByText('site a')).toBeInTheDocument();
    expect(within(kiosk).getByText('ana@example.com')).toBeInTheDocument();
    expect(within(kiosk).getByText('control')).toBeInTheDocument();
    expect(within(kiosk).getByText('live')).toBeInTheDocument();
    expect(within(kiosk).getByText(/^1:0\d$/)).toBeInTheDocument();

    const wall = screen.getByRole('row', { name: /wall-2/ });
    expect(within(wall).getByText('site b')).toBeInTheDocument();
    expect(within(wall).getByText('bo')).toBeInTheDocument();
    expect(within(wall).getByText('watch')).toBeInTheDocument();
    expect(within(wall).getByText('pending')).toBeInTheDocument();
    expect(within(wall).getByText(/^1:02:0\d$/)).toBeInTheDocument();

    // oldest first, across sites
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows[0]).toBe(wall);
    expect(rows[1]).toBe(kiosk);

    for (const site of ['site-a', 'site-b']) {
      expect(fetchMock).toHaveBeenCalledWith(`/api/sites/${site}/swoop/sessions`, { cache: 'no-store' });
    }
  });

  it('leaves out a site that answers 403, without a toast', async () => {
    sessionsBySite['site-a'] = {
      status: 403,
      body: { title: 'forbidden', detail: 'you need the machine remote control capability' },
    };
    sessionsBySite['site-b'] = sessionsOk([liveSession({ sid: 's2', machineId: 'wall-2' })]);
    renderPage();

    await screen.findByRole('row', { name: /wall-2/ });
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows any other failure as one toast with the problem detail', async () => {
    const failure = { status: 500, body: { title: 'internal error', detail: 'firestore is down' } };
    sessionsBySite['site-a'] = failure;
    sessionsBySite['site-b'] = failure;
    renderPage();

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith('could not load swoop sessions', {
      description: 'firestore is down',
    });
  });

  it('kills a session through the machine kill route, then refetches', async () => {
    sessionsBySite['site-a'] = sessionsOk([liveSession()]);
    const user = renderPage();

    const row = await screen.findByRole('row', { name: /kiosk-1/ });
    await user.click(within(row).getByRole('button', { name: /kill/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('end this session?')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('closes every pending second-factor window on kiosk-1');

    sessionsBySite['site-a'] = sessionsOk([]);
    await user.click(within(dialog).getByRole('button', { name: 'end session' }));

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sites/site-a/machines/kiosk-1/swoop/kill',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ sid: 's1' }) }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('session ended', { description: 'queued for the machine' }),
    );
    await screen.findByText('no one is in a swoop session right now');
    const listCalls = fetchMock.mock.calls.filter(([url]) => url === '/api/sites/site-a/swoop/sessions');
    expect(listCalls).toHaveLength(2);
  });

  it('says so when no one is in a session', async () => {
    renderPage();

    expect(screen.getByText('loading sessions...')).toBeInTheDocument();
    expect(await screen.findByText('no one is in a swoop session right now')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
