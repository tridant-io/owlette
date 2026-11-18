/**
 * @jest-environment jsdom
 *
 * `useMachineMove`, the fetch-based client of the move route: request shape,
 * the unwrapped success body, problem+json `detail` surfaced as the error,
 * the machine-limit copy on a 402, a fresh idempotency key per call, and busy.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { useMachineMove } from '@/hooks/useMachineMove';
import { MACHINE_LIMIT_ERROR } from '@/lib/planResponse';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function call(index: number): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
  return { url, init };
}

function idempotencyKey(index: number): string | undefined {
  return (call(index).init.headers as Record<string, string>)['Idempotency-Key'];
}

const fetchMock = jest.fn();
let originalFetch: typeof global.fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('useMachineMove', () => {
  it('requests a move and answers the route data', async () => {
    const data = { moveId: 'site-a:kiosk-1', status: 'pending', targetSiteId: 'site-b', expiresAt: 1_700_000_000_000 };
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, data }, 202));
    const { result } = renderHook(() => useMachineMove('site-a'));

    let answer: unknown;
    await act(async () => {
      answer = await result.current.requestMove('kiosk 1', 'site-b');
    });

    expect(answer).toEqual(data);
    const { url, init } = call(0);
    expect(url).toBe('/api/sites/site-a/machines/kiosk%201/move');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ targetSiteId: 'site-b' });
  });

  it('cancels a move', async () => {
    const data = { moveId: 'site-a:kiosk-1', status: 'cancelled', targetSiteId: 'site-b' };
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, data }));
    const { result } = renderHook(() => useMachineMove('site-a'));

    let answer: unknown;
    await act(async () => {
      answer = await result.current.cancelMove('kiosk-1');
    });

    expect(answer).toEqual(data);
    expect(call(0).url).toBe('/api/sites/site-a/machines/kiosk-1/move');
    expect(call(0).init.method).toBe('DELETE');
  });

  it('throws the problem detail as is', async () => {
    const detail = 'site b already has a machine named kiosk-1. remove it there first.';
    fetchMock.mockResolvedValue(jsonResponse({ code: 'machine_exists', title: 'conflict', detail }, 409));
    const { result } = renderHook(() => useMachineMove('site-a'));

    await act(async () => {
      await expect(result.current.requestMove('kiosk-1', 'site-b')).rejects.toThrow(detail);
    });
  });

  it('throws the cancel refusal detail', async () => {
    const detail = 'the machine is switching sites now. remove it to end the move.';
    fetchMock.mockResolvedValue(jsonResponse({ code: 'move_switching', title: 'conflict', detail }, 409));
    const { result } = renderHook(() => useMachineMove('site-a'));

    await act(async () => {
      await expect(result.current.cancelMove('kiosk-1')).rejects.toThrow(detail);
    });
  });

  it('shows the machine-limit message on a 402', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ code: 'plan_required', title: 'plan required', detail: 'something else' }, 402),
    );
    const { result } = renderHook(() => useMachineMove('site-a'));

    await act(async () => {
      await expect(result.current.requestMove('kiosk-1', 'site-b')).rejects.toThrow(MACHINE_LIMIT_ERROR);
    });
  });

  it('falls back to a lowercase message when the error body is not json', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response);
    const { result } = renderHook(() => useMachineMove('site-a'));

    await act(async () => {
      await expect(result.current.requestMove('kiosk-1', 'site-b')).rejects.toThrow(
        'could not move the machine (500)',
      );
    });
  });

  it('says so in a short lowercase message when the network fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => useMachineMove('site-a'));

    await act(async () => {
      await expect(result.current.requestMove('kiosk-1', 'site-b')).rejects.toThrow(
        'could not reach owlette. check your connection and try again.',
      );
    });
    expect(result.current.busy).toBe(false);
  });

  it('sends a fresh idempotency key with every call', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: true, data: { moveId: 'm', status: 'pending', targetSiteId: 'site-b', expiresAt: 1 } }),
    );
    const { result } = renderHook(() => useMachineMove('site-a'));

    await act(async () => {
      await result.current.requestMove('kiosk-1', 'site-b');
      await result.current.requestMove('kiosk-1', 'site-b');
      await result.current.cancelMove('kiosk-1');
    });

    const keys = [idempotencyKey(0), idempotencyKey(1), idempotencyKey(2)];
    for (const key of keys) expect(key).toEqual(expect.any(String));
    expect(new Set(keys).size).toBe(3);
  });

  it('is busy while a call is in flight', async () => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValue(pending.promise);
    const { result } = renderHook(() => useMachineMove('site-a'));
    expect(result.current.busy).toBe(false);

    let request!: Promise<unknown>;
    act(() => {
      request = result.current.requestMove('kiosk-1', 'site-b');
    });
    await waitFor(() => expect(result.current.busy).toBe(true));

    await act(async () => {
      pending.resolve(
        jsonResponse({ ok: true, data: { moveId: 'm', status: 'pending', targetSiteId: 'site-b', expiresAt: 1 } }, 202),
      );
      await request;
    });
    expect(result.current.busy).toBe(false);
  });

  it('is not busy after a refusal', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 'machine_busy', detail: 'kiosk is installing or syncing.' }, 409));
    const { result } = renderHook(() => useMachineMove('site-a'));

    await act(async () => {
      await expect(result.current.requestMove('kiosk-1', 'site-b')).rejects.toThrow('kiosk is installing or syncing.');
    });
    expect(result.current.busy).toBe(false);
  });
});
