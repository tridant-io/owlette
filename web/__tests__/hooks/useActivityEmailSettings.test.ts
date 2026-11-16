/**
 * @jest-environment jsdom
 *
 * `useActivityEmailSettings` — the activity email switch and address list on
 * admin → alerts, through `/api/admin/activity/settings`. pins the load, a save
 * that shows at once and sticks, a failed save rolling back to the last saved
 * state with the problem detail as the message, and one save at a time.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { useActivityEmailSettings } from '@/hooks/useActivityEmailSettings';

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

const SAVED = { enabled: true, recipients: ['a@example.test'], fallback: 'admin@example.test' };

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

describe('useActivityEmailSettings', () => {
  it('loads the settings on mount', async () => {
    fetchMock.mockResolvedValue(jsonResponse(SAVED));
    const { result } = renderHook(() => useActivityEmailSettings());

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.settings).toEqual(SAVED);
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/activity/settings', expect.objectContaining({ cache: 'no-store' }));
  });

  it('says why a load failed', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'superadmin access required' }, 403));
    const { result } = renderHook(() => useActivityEmailSettings());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.settings).toBeNull();
    expect(result.current.error).toBe('superadmin access required');
  });

  it('puts the new settings, shows them at once and keeps them', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(SAVED));
    const { result } = renderHook(() => useActivityEmailSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let finish: (r: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    let outcome: Promise<string | null> = Promise.resolve('unset');
    act(() => {
      outcome = result.current.save({ enabled: false, recipients: ['a@example.test', 'b@example.test'] });
    });

    expect(result.current.saving).toBe(true);
    expect(result.current.settings).toMatchObject({ enabled: false, recipients: ['a@example.test', 'b@example.test'] });

    await act(async () => {
      finish(jsonResponse({ enabled: false, recipients: ['a@example.test', 'b@example.test'], fallback: 'admin@example.test' }));
      await outcome;
    });

    expect(await outcome).toBeNull();
    expect(result.current.saving).toBe(false);
    expect(result.current.settings).toEqual({
      enabled: false,
      recipients: ['a@example.test', 'b@example.test'],
      fallback: 'admin@example.test',
    });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('/api/admin/activity/settings');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ enabled: false, recipients: ['a@example.test', 'b@example.test'] });
  });

  it('rolls back to the last saved state and returns the detail when a save fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(SAVED));
    const { result } = renderHook(() => useActivityEmailSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'a@@ is not an email address' }, 400));
    let message: string | null = null;
    await act(async () => {
      message = await result.current.save({ enabled: true, recipients: [] });
    });

    expect(message).toBe('a@@ is not an email address');
    expect(result.current.settings).toEqual(SAVED);
    expect(result.current.saving).toBe(false);
  });

  it('rolls back when the request itself fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(SAVED));
    const { result } = renderHook(() => useActivityEmailSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetchMock.mockRejectedValueOnce(new Error('offline'));
    let message: string | null = null;
    await act(async () => {
      message = await result.current.save({ enabled: false, recipients: [] });
    });

    expect(message).toBe('offline');
    expect(result.current.settings).toEqual(SAVED);
  });
});
