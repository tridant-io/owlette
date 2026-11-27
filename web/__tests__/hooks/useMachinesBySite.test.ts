/**
 * @jest-environment jsdom
 *
 * the admin site list's machines: one `GET /api/sites?include=machines` for every
 * site, asked again each minute and when the site list changes. a refresh that
 * fails keeps what last loaded; only a list that never loaded reads as failed.
 * a hidden tab skips its refreshes and catches up when it shows.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { MACHINES_REFRESH_MS, useMachinesBySite, type ListedMachine } from '@/hooks/useMachinesBySite';

const MACHINE: ListedMachine = {
  id: 'm1',
  name: 'GALLERY-WALL-01',
  online: true,
  asleep: false,
  lastHeartbeat: '2026-11-26T10:00:00.000Z',
  agentVersion: '4.2.7',
};

function answer(sites: { id: string; machines: ListedMachine[] | null }[]): Response {
  return { ok: true, status: 200, json: async () => ({ sites }) } as Response;
}
const refused = { ok: false, status: 500, json: async () => ({}) } as Response;

const fetchMock = jest.fn<Promise<Response>, [string]>();
let visibility: DocumentVisibilityState = 'visible';

beforeAll(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  visibility = 'visible';
  jest.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

async function tick(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

it('asks once for every site, and maps each to its machines', async () => {
  fetchMock.mockResolvedValue(answer([{ id: 'site-a', machines: [MACHINE] }, { id: 'site-b', machines: null }]));
  const { result } = renderHook(() => useMachinesBySite(['site-a', 'site-b']));

  await waitFor(() => expect(result.current.machinesBySite).not.toBeNull());
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith('/api/sites?include=machines');
  expect(result.current.machinesBySite?.get('site-a')).toEqual([MACHINE]);
  expect(result.current.machinesBySite?.get('site-b')).toBeNull();
  expect(result.current).toMatchObject({ loading: false, failed: false });
});

it('asks for nothing while there are no sites', async () => {
  const { result } = renderHook(() => useMachinesBySite([]));
  await tick(MACHINES_REFRESH_MS * 2);

  expect(fetchMock).not.toHaveBeenCalled();
  expect(result.current).toEqual({ machinesBySite: null, loading: false, failed: false });
});

it('asks again every minute', async () => {
  fetchMock.mockResolvedValueOnce(answer([{ id: 'site-a', machines: [] }]));
  fetchMock.mockResolvedValueOnce(answer([{ id: 'site-a', machines: [MACHINE] }]));
  const { result } = renderHook(() => useMachinesBySite(['site-a']));
  await waitFor(() => expect(result.current.machinesBySite?.get('site-a')).toEqual([]));

  await tick(MACHINES_REFRESH_MS);

  await waitFor(() => expect(result.current.machinesBySite?.get('site-a')).toEqual([MACHINE]));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('keeps the last good answer when a refresh fails', async () => {
  fetchMock.mockResolvedValueOnce(answer([{ id: 'site-a', machines: [MACHINE] }]));
  fetchMock.mockResolvedValueOnce(refused);
  fetchMock.mockRejectedValueOnce(new Error('offline'));
  const { result } = renderHook(() => useMachinesBySite(['site-a']));
  await waitFor(() => expect(result.current.machinesBySite).not.toBeNull());

  await tick(MACHINES_REFRESH_MS);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  await tick(MACHINES_REFRESH_MS);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(result.current.loading).toBe(false));

  expect(result.current.machinesBySite?.get('site-a')).toEqual([MACHINE]);
  expect(result.current.failed).toBe(false);
});

it('reads as failed only while nothing has loaded, and recovers on the next minute', async () => {
  fetchMock.mockResolvedValueOnce(refused);
  fetchMock.mockResolvedValueOnce(answer([{ id: 'site-a', machines: [MACHINE] }]));
  const { result } = renderHook(() => useMachinesBySite(['site-a']));

  await waitFor(() => expect(result.current.failed).toBe(true));
  expect(result.current.machinesBySite).toBeNull();

  await tick(MACHINES_REFRESH_MS);

  await waitFor(() => expect(result.current.machinesBySite?.get('site-a')).toEqual([MACHINE]));
  expect(result.current.failed).toBe(false);
});

it('asks again when the site list changes, not when the same sites come in a new array', async () => {
  fetchMock.mockResolvedValue(answer([{ id: 'site-a', machines: [] }]));
  const { result, rerender } = renderHook(({ ids }) => useMachinesBySite(ids), {
    initialProps: { ids: ['site-a', 'site-b'] },
  });
  await waitFor(() => expect(result.current.machinesBySite).not.toBeNull());

  rerender({ ids: ['site-b', 'site-a'] });
  await tick(0);
  expect(fetchMock).toHaveBeenCalledTimes(1);

  rerender({ ids: ['site-a', 'site-b', 'site-c'] });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
});

it('skips a refresh while the tab is hidden and catches up when it shows', async () => {
  fetchMock.mockResolvedValue(answer([{ id: 'site-a', machines: [] }]));
  const { result } = renderHook(() => useMachinesBySite(['site-a']));
  await waitFor(() => expect(result.current.machinesBySite).not.toBeNull());

  visibility = 'hidden';
  await tick(MACHINES_REFRESH_MS * 2);
  expect(fetchMock).toHaveBeenCalledTimes(1);

  visibility = 'visible';
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
});

it('stops asking once unmounted', async () => {
  fetchMock.mockResolvedValue(answer([{ id: 'site-a', machines: [] }]));
  const { result, unmount } = renderHook(() => useMachinesBySite(['site-a']));
  await waitFor(() => expect(result.current.machinesBySite).not.toBeNull());

  unmount();
  await tick(MACHINES_REFRESH_MS * 3);

  expect(fetchMock).toHaveBeenCalledTimes(1);
});
