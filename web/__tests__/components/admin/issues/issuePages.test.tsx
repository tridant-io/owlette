/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * The superadmin issue pages: the list at /admin/issues (one status at a time,
 * newest first, paged) and one issue at /admin/issues/{number or doc id}. Both
 * read through the real `useIssues` hooks, so these tests answer the hooks'
 * fetches the way the admin routes do.
 */

import React, { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import { IssueList, type IssueFilter } from '@/components/admin/issues/IssueList';
import { IssueDetail } from '@/components/admin/issues/IssueDetail';
import IssuesPage from '@/app/admin/issues/page';
import type { Issue } from '@/hooks/useIssues';

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ userPreferences: { timeFormat: '12h' } }),
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

const mockReplace = jest.fn();
let mockStatusParam: string | null = null;
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(mockStatusParam ? { status: mockStatusParam } : {}),
}));

// radix select drives its trigger with pointer capture and scrolls the active item into view
window.HTMLElement.prototype.scrollIntoView = jest.fn();
window.HTMLElement.prototype.hasPointerCapture = jest.fn();
window.HTMLElement.prototype.releasePointerCapture = jest.fn();

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** an agent issue with everything: system info, a log tail, notes and live attachments */
function agentIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'doc-agent-42',
    number: 42,
    status: 'new',
    category: 'bug',
    title: 'touchdesigner restarts every few minutes',
    source: 'agent',
    createdAt: new Date(Date.now() - 3 * HOUR).toISOString(),
    appVersion: '4.1.17',
    siteId: 'site-lobby',
    machineId: 'kiosk-07',
    from: '',
    host: 'KIOSK-07',
    description: {
      text: 'the show restarts on its own.\n\nit started after the update.',
      systemInfo: '  cpu percent: 12.5\n  memory percent: 61\n  os: Windows-10-10.0.22631-SP0',
      logTail: '2026-10-15 10:00:01 INFO started\n2026-10-15 10:04:12 ERROR touchdesigner exited (code 3)\n',
      notes: ['screenshots attached: 2', 'attachments could not be sent: upload timed out'],
    },
    triageNote: null,
    statusUpdatedAt: null,
    statusUpdatedBy: null,
    attachments: {
      available: true,
      size: 5 * 1024 * 1024,
      expiresAt: new Date(Date.now() + 21 * DAY + HOUR).toISOString(),
      screenshots: 2,
      videos: 1,
      logs: true,
    },
    ...overrides,
  };
}

/** a dashboard issue: the user's words and nothing else */
function webIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    ...agentIssue(),
    id: 'doc-web-7',
    number: 7,
    category: 'feature_request',
    title: 'dark mode for the docs',
    source: 'web',
    createdAt: new Date(Date.now() - 2 * DAY).toISOString(),
    appVersion: null,
    siteId: null,
    machineId: null,
    from: 'ana@example.com',
    host: null,
    description: { text: 'please', systemInfo: '', logTail: '', notes: [] },
    attachments: { available: false, size: null, expiresAt: null, screenshots: 0, videos: 0, logs: false },
    ...overrides,
  };
}

interface Reply {
  status: number;
  body: unknown;
}

function reply({ status, body }: Reply) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function problem(status: number, detail: string): Reply {
  return { status, body: { title: 'error', status, detail } };
}

let fetchMock: jest.Mock;

/** answers each fetch with the next reply from `route`, which sees the url and init */
function answer(route: (url: URL, init?: RequestInit) => Reply) {
  fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    reply(route(new URL(String(input), 'http://localhost'), init)),
  );
  global.fetch = fetchMock as unknown as typeof fetch;
}

function listCalls(): URL[] {
  return fetchMock.mock.calls
    .map(([input]) => new URL(String(input), 'http://localhost'))
    .filter((url) => url.pathname === '/api/admin/issues');
}

function renderWithTooltips(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

function ListHarness({ initial = 'new' }: { initial?: IssueFilter }) {
  const [filter, setFilter] = useState<IssueFilter>(initial);
  return <IssueList filter={filter} onFilterChange={setFilter} />;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStatusParam = null;
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore();
});

describe('issue list', () => {
  it('shows a row per issue: number, title, category, status, sender and age, linking to the issue', async () => {
    const unnumbered = webIssue({ id: 'legacyDoc_1', number: null, title: 'old one', status: 'triaged' });
    answer(() => ({ status: 200, body: { issues: [agentIssue(), webIssue(), unnumbered], next_page_token: '' } }));
    renderWithTooltips(<ListHarness />);

    const list = await screen.findByRole('list', { name: 'new issues' });
    const rows = within(list).getAllByRole('link');
    expect(rows).toHaveLength(3);

    expect(rows[0]).toHaveAttribute('href', '/admin/issues/42');
    expect(rows[0]).toHaveTextContent('#42');
    expect(rows[0]).toHaveTextContent('touchdesigner restarts every few minutes');
    expect(rows[0]).toHaveTextContent('something broke');
    expect(rows[0]).toHaveTextContent('new');
    // an agent issue has no email; its host names it
    expect(rows[0]).toHaveTextContent('KIOSK-07');
    expect(rows[0]).toHaveTextContent('3h ago');

    expect(rows[1]).toHaveTextContent("wouldn't it be nice if...");
    expect(rows[1]).toHaveTextContent('ana@example.com');
    expect(rows[1]).toHaveTextContent('2d ago');

    // an issue from before numbering is addressed by its doc id
    expect(rows[2]).toHaveAttribute('href', '/admin/issues/legacyDoc_1');
    expect(rows[2]).toHaveTextContent('triaged');
  });

  it('asks for new issues first, then whichever status the filter picks, and all without one', async () => {
    answer(() => ({ status: 200, body: { issues: [], next_page_token: '' } }));
    const user = userEvent.setup();
    renderWithTooltips(<ListHarness />);

    await screen.findByText('no new issues');
    expect(listCalls()[0].searchParams.get('status')).toBe('new');
    expect(screen.getByRole('button', { name: 'new' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: "won't fix" }));
    await screen.findByText("no won't fix issues");
    expect(listCalls().at(-1)!.searchParams.get('status')).toBe('wontfix');
    expect(screen.getByRole('button', { name: "won't fix" })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'new' })).toHaveAttribute('aria-pressed', 'false');

    await user.click(screen.getByRole('button', { name: 'all' }));
    await screen.findByText('no issues yet');
    expect(listCalls().at(-1)!.searchParams.has('status')).toBe(false);
  });

  it('never shows the last filter’s rows while the next filter loads', async () => {
    let releaseTriaged: (() => void) | null = null;
    fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.searchParams.get('status') === 'triaged') {
        await new Promise<void>((resolve) => {
          releaseTriaged = resolve;
        });
        return reply({ status: 200, body: { issues: [], next_page_token: '' } });
      }
      return reply({ status: 200, body: { issues: [agentIssue()], next_page_token: '' } });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();
    renderWithTooltips(<ListHarness />);

    await screen.findByText('touchdesigner restarts every few minutes');
    await user.click(screen.getByRole('button', { name: 'triaged' }));
    expect(screen.queryByText('touchdesigner restarts every few minutes')).not.toBeInTheDocument();
    expect(screen.getByText('loading issues')).toBeInTheDocument();

    releaseTriaged!();
    await screen.findByText('no triaged issues');
  });

  it('loads the next page under the first', async () => {
    answer((url) =>
      url.searchParams.get('page_token') === 'doc-agent-42'
        ? { status: 200, body: { issues: [webIssue()], next_page_token: '' } }
        : { status: 200, body: { issues: [agentIssue()], next_page_token: 'doc-agent-42' } },
    );
    const user = userEvent.setup();
    renderWithTooltips(<ListHarness />);

    await user.click(await screen.findByRole('button', { name: 'load more' }));
    await screen.findByText('dark mode for the docs');
    expect(screen.getByText('touchdesigner restarts every few minutes')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'load more' })).not.toBeInTheDocument();
  });

  it('shows the route’s error and reads again on try again', async () => {
    let fail = true;
    answer(() => (fail ? problem(500, 'the issues are unavailable') : { status: 200, body: { issues: [agentIssue()] } }));
    const user = userEvent.setup();
    renderWithTooltips(<ListHarness />);

    expect(await screen.findByRole('alert')).toHaveTextContent('the issues are unavailable');
    fail = false;
    await user.click(screen.getByRole('button', { name: 'try again' }));
    await screen.findByText('touchdesigner restarts every few minutes');
  });

  it('reads the first page again on refresh', async () => {
    answer(() => ({ status: 200, body: { issues: [agentIssue()] } }));
    const user = userEvent.setup();
    renderWithTooltips(<ListHarness />);

    await screen.findByText('touchdesigner restarts every few minutes');
    await user.click(screen.getByRole('button', { name: 'refresh issues' }));
    await waitFor(() => expect(listCalls()).toHaveLength(2));
    await screen.findByText('touchdesigner restarts every few minutes');
  });
});

describe('issues page', () => {
  it('takes the filter from the url and writes a new one back', async () => {
    mockStatusParam = 'fixed';
    answer(() => ({ status: 200, body: { issues: [] } }));
    const user = userEvent.setup();
    renderWithTooltips(<IssuesPage />);

    await screen.findByText('no fixed issues');
    expect(listCalls()[0].searchParams.get('status')).toBe('fixed');

    await user.click(screen.getByRole('button', { name: 'new' }));
    expect(mockReplace).toHaveBeenCalledWith('/admin/issues', { scroll: false });
    await user.click(screen.getByRole('button', { name: 'triaged' }));
    expect(mockReplace).toHaveBeenCalledWith('/admin/issues?status=triaged', { scroll: false });
  });

  it('falls back to new for a status it does not know', async () => {
    mockStatusParam = 'bogus';
    answer(() => ({ status: 200, body: { issues: [] } }));
    renderWithTooltips(<IssuesPage />);

    await screen.findByText('no new issues');
    expect(listCalls()[0].searchParams.get('status')).toBe('new');
  });
});

describe('issue detail', () => {
  function serve(issue: Issue, patch?: (body: { status: string; note?: string }) => Reply) {
    answer((url, init) => {
      if (init?.method === 'PATCH') return patch!(JSON.parse(String(init.body)));
      return { status: 200, body: issue };
    });
  }

  it('shows every section of an agent issue', async () => {
    serve(agentIssue());
    renderWithTooltips(<IssueDetail idOrNumber="42" />);

    // header
    expect(await screen.findByRole('heading', { level: 1, name: 'touchdesigner restarts every few minutes' })).toBeInTheDocument();
    expect(screen.getByText('#42')).toBeInTheDocument();
    expect(screen.getAllByText('new').length).toBeGreaterThan(0);
    expect(screen.getByText('something broke')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'issues' })).toHaveAttribute('href', '/admin/issues');

    // the user's words, paragraphs kept
    const description = screen.getByRole('region', { name: 'description' });
    expect(description).toHaveTextContent('the show restarts on its own.');
    expect(description).toHaveTextContent('it started after the update.');

    // the facts
    const details = screen.getByRole('region', { name: 'details' });
    const fact = (label: string) => within(details).getByText(label).nextElementSibling;
    expect(fact('from')).toHaveTextContent('—');
    expect(fact('host')).toHaveTextContent('KIOSK-07');
    expect(fact('site')).toHaveTextContent('site-lobby');
    expect(fact('machine')).toHaveTextContent('kiosk-07');
    expect(fact('app version')).toHaveTextContent('4.1.17');
    expect(fact('source')).toHaveTextContent('desktop app');
    expect(fact('created')).toHaveTextContent('3h ago');

    // attachments, with the download through the logs route, and the app's notes
    const attachments = screen.getByRole('region', { name: 'attachments' });
    expect(attachments).toHaveTextContent('logs, 2 screenshots and 1 video');
    expect(attachments).toHaveTextContent('5 MB');
    expect(attachments).toHaveTextContent('expires in 21 days');
    expect(within(attachments).getByRole('link', { name: 'download attachments' })).toHaveAttribute(
      'href',
      '/api/admin/issues/42/logs',
    );
    expect(attachments).toHaveTextContent('screenshots attached: 2');
    expect(attachments).toHaveTextContent('attachments could not be sent: upload timed out');

    // system info as a two-column table
    const systemInfo = screen.getByRole('region', { name: 'system info' });
    expect(within(systemInfo).getByRole('rowheader', { name: 'cpu percent' })).toBeInTheDocument();
    const osRow = within(systemInfo).getByRole('rowheader', { name: 'os' }).closest('tr')!;
    expect(within(osRow).getByRole('cell')).toHaveTextContent('Windows-10-10.0.22631-SP0');

    // the log tail starts collapsed
    const logToggle = screen.getByRole('button', { name: /log tail/ });
    expect(logToggle).toHaveTextContent('2 lines');
    expect(logToggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/touchdesigner exited/)).not.toBeInTheDocument();
    await userEvent.setup().click(logToggle);
    expect(logToggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/touchdesigner exited \(code 3\)/)).toBeInTheDocument();

    // triage
    expect(screen.getByRole('combobox', { name: 'status' })).toHaveTextContent('new');
    expect(screen.getByText('not triaged yet')).toBeInTheDocument();
  });

  it('shows system info that is not key: value lines as it came', async () => {
    serve(agentIssue({ description: { ...agentIssue().description, systemInfo: 'gpu probe failed\nno data' } }));
    renderWithTooltips(<IssueDetail idOrNumber="42" />);

    const systemInfo = await screen.findByRole('region', { name: 'system info' });
    expect(within(systemInfo).queryByRole('table')).not.toBeInTheDocument();
    expect(systemInfo.querySelector('pre')).toHaveTextContent('gpu probe failed no data');
  });

  it('says when the attachments have expired, with no download', async () => {
    serve(
      agentIssue({
        attachments: {
          available: false,
          size: 1024,
          expiresAt: new Date(Date.now() - DAY).toISOString(),
          screenshots: 3,
          videos: 0,
          logs: true,
        },
      }),
    );
    renderWithTooltips(<IssueDetail idOrNumber="42" />);

    const attachments = await screen.findByRole('region', { name: 'attachments' });
    expect(attachments).toHaveTextContent('attachments expired');
    expect(attachments).toHaveTextContent('logs and 3 screenshots were deleted on');
    expect(within(attachments).queryByRole('link')).not.toBeInTheDocument();
  });

  it('leaves out what a dashboard issue does not have', async () => {
    serve(webIssue());
    renderWithTooltips(<IssueDetail idOrNumber="7" />);

    const attachments = await screen.findByRole('region', { name: 'attachments' });
    expect(attachments).toHaveTextContent('nothing attached');
    expect(screen.queryByRole('region', { name: 'system info' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /log tail/ })).not.toBeInTheDocument();
    const details = screen.getByRole('region', { name: 'details' });
    expect(within(details).getByText('from').nextElementSibling).toHaveTextContent('ana@example.com');
    expect(within(details).getByText('source').nextElementSibling).toHaveTextContent('dashboard');
  });

  it('opens an unnumbered issue by its doc id', async () => {
    serve(agentIssue({ id: 'legacyDoc_1', number: null }));
    renderWithTooltips(<IssueDetail idOrNumber="legacyDoc_1" />);

    expect(await screen.findByText('legacyDoc_1')).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/issues/legacyDoc_1');
    expect(screen.getByRole('link', { name: 'download attachments' })).toHaveAttribute(
      'href',
      '/api/admin/issues/legacyDoc_1/logs',
    );
  });

  it('saves a status and a note, and shows what the route returned', async () => {
    const patches: { status: string; note?: string }[] = [];
    serve(agentIssue(), (body) => {
      patches.push(body);
      return {
        status: 200,
        body: agentIssue({
          status: 'fixed',
          triageNote: body.note ?? null,
          statusUpdatedAt: new Date().toISOString(),
          statusUpdatedBy: 'super-1',
        }),
      };
    });
    const user = userEvent.setup();
    renderWithTooltips(<IssueDetail idOrNumber="42" />);

    const save = await screen.findByRole('button', { name: 'save' });
    expect(save).toBeDisabled();

    await user.click(screen.getByRole('combobox', { name: 'status' }));
    await user.click(await screen.findByRole('option', { name: 'fixed' }));
    await user.type(screen.getByRole('textbox', { name: 'note' }), 'fixed in 4.1.18');
    await user.click(save);

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('issue #42 marked fixed'));
    expect(patches).toEqual([{ status: 'fixed', note: 'fixed in 4.1.18' }]);
    expect(fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')![0]).toBe('/api/admin/issues/42');

    // the form now holds the saved issue
    expect(screen.getByRole('combobox', { name: 'status' })).toHaveTextContent('fixed');
    expect(screen.getByRole('textbox', { name: 'note' })).toHaveValue('fixed in 4.1.18');
    expect(screen.getByText('status set just now')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'save' })).toBeDisabled();
  });

  it('leaves an untouched note out of a status change', async () => {
    const patches: { status: string; note?: string }[] = [];
    serve(agentIssue({ triageNote: 'looking into it' }), (body) => {
      patches.push(body);
      return { status: 200, body: agentIssue({ status: 'triaged', triageNote: 'looking into it', statusUpdatedAt: new Date().toISOString() }) };
    });
    const user = userEvent.setup();
    renderWithTooltips(<IssueDetail idOrNumber="42" />);

    await user.click(await screen.findByRole('combobox', { name: 'status' }));
    await user.click(await screen.findByRole('option', { name: 'triaged' }));
    await user.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('issue #42 marked triaged'));
    expect(patches).toEqual([{ status: 'triaged' }]);
  });

  it('keeps the edit and says why when a save fails', async () => {
    serve(agentIssue(), () => problem(403, 'superadmin only'));
    const user = userEvent.setup();
    renderWithTooltips(<IssueDetail idOrNumber="42" />);

    await user.type(await screen.findByRole('textbox', { name: 'note' }), 'dup of #12');
    await user.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('could not update the issue', { description: 'superadmin only' }),
    );
    expect(screen.getByRole('textbox', { name: 'note' })).toHaveValue('dup of #12');
    expect(screen.getByRole('button', { name: 'save' })).toBeEnabled();
  });

  it('says so when no issue answers to the number', async () => {
    answer(() => problem(404, 'issue not found'));
    renderWithTooltips(<IssueDetail idOrNumber="999" />);

    expect(await screen.findByRole('heading', { name: 'issue not found' })).toBeInTheDocument();
    expect(screen.getByText('999')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'issues' })).toHaveAttribute('href', '/admin/issues');
  });

  it('shows any other failure with a way to try again', async () => {
    let fail = true;
    answer(() => (fail ? problem(500, 'firestore is unavailable') : { status: 200, body: agentIssue() }));
    const user = userEvent.setup();
    renderWithTooltips(<IssueDetail idOrNumber="42" />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('could not load the issue');
    expect(alert).toHaveTextContent('firestore is unavailable');
    fail = false;
    await user.click(screen.getByRole('button', { name: 'try again' }));
    await screen.findByRole('heading', { level: 1, name: 'touchdesigner restarts every few minutes' });
  });
});
