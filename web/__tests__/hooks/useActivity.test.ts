/**
 * @jest-environment jsdom
 *
 * `useActivity` — the superadmin activity page's data, through
 * `/api/admin/activity`. pins the first page with its filters, load-more
 * through `next_page_token`, reading on past short or empty pages with a token, a
 * filter change discarding a stale response, and problem details as the error.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { useActivity, type ActivityRow, type ActivityView } from '@/hooks/useActivity';

function makeRow(overrides: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: 'change:one',
    kind: 'change',
    at: 1_700_000_000_000,
    actor: { type: 'user', id: 'uid-1', label: 'ana@example.com' },
    siteId: 'site-1',
    action: 'user_mutated:promoted',
    outcome: null,
    details: {},
    ...overrides,
  };
}

const rowsOf = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => makeRow({ id: `change:${prefix}${i}` }));

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

function page(rows: ActivityRow[], token = '') {
  return jsonResponse({ rows, ...(token ? { next_page_token: token } : {}) });
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

describe('useActivity', () => {
  it('lists the first page with the view and both filters', async () => {
    const one = makeRow();
    fetchMock.mockResolvedValue(page([one]));

    const { result } = renderHook(() => useActivity({ view: 'changes', userId: 'uid-1', siteId: 'site-1' }));
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rows).toEqual([one]);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/activity?view=changes&page_size=50&user=uid-1&site=site-1', {
      cache: 'no-store',
    });
  });

  it('leaves out the filters it was not given', async () => {
    fetchMock.mockResolvedValue(page([]));

    const { result } = renderHook(() => useActivity({ view: 'all' }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/activity?view=all&page_size=50', { cache: 'no-store' });
  });

  it('sends a date range as since and until, from the start of the first day to the end of the last', async () => {
    fetchMock.mockResolvedValue(page([]));

    const { result } = renderHook(() =>
      useActivity({ view: 'all', datePreset: 'custom', dateFrom: '2026-11-01', dateTo: '2026-11-02' }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    const since = new Date(2026, 10, 1).getTime();
    const until = new Date(2026, 10, 2, 23, 59, 59, 999).getTime();
    expect(fetchMock).toHaveBeenCalledWith(`/api/admin/activity?view=all&page_size=50&since=${since}&until=${until}`, {
      cache: 'no-store',
    });
  });

  it('loads more through the token and appends', async () => {
    const a = rowsOf(50, 'a');
    const b = makeRow({ id: 'change:b' });
    fetchMock.mockResolvedValueOnce(page(a, 'tok-1')).mockResolvedValueOnce(page([b]));

    const { result } = renderHook(() => useActivity({ view: 'all' }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      await result.current.loadMore();
    });
    expect(fetchMock).toHaveBeenLastCalledWith('/api/admin/activity?view=all&page_size=50&page_token=tok-1', {
      cache: 'no-store',
    });
    expect(result.current.rows).toEqual([...a, b]);
    expect(result.current.hasMore).toBe(false);
  });

  it('reads on past short and empty pages until it has a page of rows, so a hidden stretch never stops a load at one row', async () => {
    const one = makeRow({ id: 'change:one' });
    const rest = rowsOf(49, 'r');
    const c = makeRow({ id: 'change:c' });
    fetchMock
      .mockResolvedValueOnce(page([one], 'tok-1'))
      .mockResolvedValueOnce(page([], 'tok-2'))
      .mockResolvedValueOnce(page(rest, 'tok-3'));

    const { result } = renderHook(() => useActivity({ view: 'all' }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rows).toEqual([one, ...rest]);
    expect(result.current.hasMore).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fetchMock.mockResolvedValueOnce(page([c], 'tok-4')).mockResolvedValueOnce(page([]));
    await act(async () => {
      await result.current.loadMore();
    });
    expect(fetchMock).toHaveBeenLastCalledWith('/api/admin/activity?view=all&page_size=50&page_token=tok-4', {
      cache: 'no-store',
    });
    expect(result.current.rows).toEqual([one, ...rest, c]);
    expect(result.current.hasMore).toBe(false);
  });

  it('stops after 5 pages with no rows and leaves the rest to load more', async () => {
    fetchMock.mockImplementation(async () => page([], 'tok'));

    const { result } = renderHook(() => useActivity({ view: 'all' }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(result.current.rows).toEqual([]);
    expect(result.current.hasMore).toBe(true);
  });

  it('discards a stale response when the filter changes', async () => {
    let resolveStale: (response: Response) => void = () => {};
    const stale = makeRow({ id: 'change:stale' });
    const fresh = makeRow({ id: 'refused:fresh', kind: 'refused' });
    fetchMock
      .mockReturnValueOnce(new Promise<Response>((resolve) => (resolveStale = resolve)))
      .mockResolvedValueOnce(page([fresh]));

    const { result, rerender } = renderHook(({ view }: { view: ActivityView }) => useActivity({ view }), {
      initialProps: { view: 'changes' as ActivityView },
    });
    rerender({ view: 'refused' });
    await waitFor(() => expect(result.current.rows).toEqual([fresh]));

    await act(async () => {
      resolveStale(page([stale], 'stale-token'));
    });
    // a short stale page does not read on
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.rows).toEqual([fresh]);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it('surfaces the problem detail as the error and refresh recovers', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ title: 'forbidden', detail: 'superadmin only' }, 403));

    const { result } = renderHook(() => useActivity({ view: 'all' }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('superadmin only');
    expect(result.current.rows).toEqual([]);

    const one = makeRow();
    fetchMock.mockResolvedValueOnce(page([one]));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.rows).toEqual([one]);
  });

  it('falls back to the status when the error body is not json', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => Promise.reject(new Error('x')) });

    const { result } = renderHook(() => useActivity({ view: 'all' }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('failed to load activity (500)');
  });
});
