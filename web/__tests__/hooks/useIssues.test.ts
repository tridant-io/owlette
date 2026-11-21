/**
 * @jest-environment jsdom
 *
 * `useIssues`, `useIssue` and `setIssueStatus` — the superadmin issue pages'
 * data, through `/api/admin/issues`. pins the list with its status filter and
 * load-more through `next_page_token`, the read by number, the PATCH body, the
 * read issue updated in place after a status set, and problem details surfaced
 * as the error.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { setIssueStatus, useIssue, useIssues, type Issue } from '@/hooks/useIssues';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'doc-1',
    number: 1,
    status: 'new',
    category: 'bug',
    title: 'something broke',
    source: 'agent',
    createdAt: '2026-10-15T00:00:00.000Z',
    appVersion: '4.1.13',
    siteId: 'site-1',
    machineId: 'machine-1',
    from: 'user@example.com',
    host: 'host-1',
    description: { text: 'it broke', systemInfo: '', logTail: '', notes: [] },
    triageNote: null,
    statusUpdatedAt: null,
    statusUpdatedBy: null,
    attachments: { available: false, size: null, expiresAt: null, screenshots: 0, videos: 0, logs: false },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

function page(issues: Issue[], token = '') {
  return jsonResponse({ issues, next_page_token: token, nextPageToken: token });
}

const fetchMock = jest.fn();
let originalFetch: typeof global.fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof global.fetch;
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('useIssues', () => {
  it('lists the first page with the status filter', async () => {
    const one = makeIssue();
    fetchMock.mockResolvedValue(page([one]));

    const { result } = renderHook(() => useIssues({ status: 'new' }));
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.issues).toEqual([one]);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/issues?page_size=20&status=new', { cache: 'no-store' });
  });

  it('leaves out the status param when unfiltered', async () => {
    fetchMock.mockResolvedValue(page([]));

    const { result } = renderHook(() => useIssues());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/issues?page_size=20', { cache: 'no-store' });
  });

  it('loads more through next_page_token and appends the page', async () => {
    const first = makeIssue({ id: 'doc-2', number: 2 });
    const second = makeIssue({ id: 'doc-1', number: 1 });
    fetchMock.mockResolvedValueOnce(page([first], 'doc-2')).mockResolvedValueOnce(page([second]));

    const { result } = renderHook(() => useIssues());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      await result.current.loadMore();
    });

    expect(fetchMock).toHaveBeenLastCalledWith('/api/admin/issues?page_size=20&page_token=doc-2', {
      cache: 'no-store',
    });
    expect(result.current.issues).toEqual([first, second]);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.loadingMore).toBe(false);

    await act(async () => {
      await result.current.loadMore();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces the problem detail on a failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 403, detail: 'superadmin only' }, 403));

    const { result } = renderHook(() => useIssues());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('superadmin only');
    expect(result.current.issues).toEqual([]);
  });

  it('falls back to the status code when the body is not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('bad json');
      },
    } as unknown as Response);

    const { result } = renderHook(() => useIssues());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('failed to load issues (502)');
  });

  it('refetches from the first page when the status changes', async () => {
    const fixed = makeIssue({ id: 'doc-3', number: 3, status: 'fixed' });
    fetchMock.mockResolvedValueOnce(page([makeIssue()], 'doc-1')).mockResolvedValueOnce(page([fixed]));

    const { result, rerender } = renderHook(({ status }) => useIssues({ status }), {
      initialProps: { status: 'new' as Issue['status'] },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ status: 'fixed' });
    await waitFor(() => expect(result.current.issues).toEqual([fixed]));
    expect(fetchMock).toHaveBeenLastCalledWith('/api/admin/issues?page_size=20&status=fixed', {
      cache: 'no-store',
    });
    expect(result.current.hasMore).toBe(false);
  });
});

describe('useIssue', () => {
  it('reads one issue by number', async () => {
    const issue = makeIssue({ number: 42 });
    fetchMock.mockResolvedValue(jsonResponse(issue));

    const { result } = renderHook(() => useIssue(42));
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.issue).toEqual(issue);
    expect(result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/issues/42', { cache: 'no-store' });
  });

  it('fetches nothing without an id', () => {
    const { result } = renderHook(() => useIssue(null));

    expect(result.current).toMatchObject({ issue: null, loading: false, error: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a 404 as the error with no issue', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 404, detail: 'issue not found' }, 404));

    const { result } = renderHook(() => useIssue('999'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.issue).toBeNull();
    expect(result.current.error).toBe('issue not found');
  });

  it('updates the read issue in place after a status set', async () => {
    const issue = makeIssue({ number: 42 });
    const triaged = makeIssue({
      number: 42,
      status: 'triaged',
      triageNote: 'fix on a branch',
      statusUpdatedAt: '2026-10-15T01:00:00.000Z',
      statusUpdatedBy: 'u-super',
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(issue)).mockResolvedValueOnce(jsonResponse(triaged));

    const { result } = renderHook(() => useIssue(42));
    await waitFor(() => expect(result.current.issue).toEqual(issue));

    let returned: Issue | undefined;
    await act(async () => {
      returned = await result.current.setStatus('triaged', 'fix on a branch');
    });

    expect(fetchMock).toHaveBeenLastCalledWith('/api/admin/issues/42', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'triaged', note: 'fix on a branch' }),
    });
    expect(returned).toEqual(triaged);
    expect(result.current.issue).toEqual(triaged);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the issue and rejects when the status set fails', async () => {
    const issue = makeIssue({ number: 42 });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(issue))
      .mockResolvedValueOnce(jsonResponse({ status: 400, detail: 'status must be one of new, triaged, fixed, wontfix' }, 400));

    const { result } = renderHook(() => useIssue(42));
    await waitFor(() => expect(result.current.issue).toEqual(issue));

    await act(async () => {
      await expect(result.current.setStatus('fixed')).rejects.toThrow(
        'status must be one of new, triaged, fixed, wontfix',
      );
    });
    expect(result.current.issue).toEqual(issue);
  });
});

describe('setIssueStatus', () => {
  it('sends no note when none is given and returns the updated issue', async () => {
    const fixed = makeIssue({ id: 'abc_DEF-1', status: 'fixed' });
    fetchMock.mockResolvedValue(jsonResponse(fixed));

    await expect(setIssueStatus('abc_DEF-1', 'fixed')).resolves.toEqual(fixed);
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/issues/abc_DEF-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'fixed' }),
    });
  });
});
