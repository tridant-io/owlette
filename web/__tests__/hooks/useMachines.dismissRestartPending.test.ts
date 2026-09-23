/**
 * @jest-environment jsdom
 *
 * `dismissRestartPending` used to queue a `dismiss_reboot_pending` machine
 * command, which only an online agent ever collects — so the banner could not be
 * dismissed on the machine that most needed it. It now clears the cloud flag
 * through the api, which neither knows nor cares whether the agent is reachable.
 */
import { renderHook, act } from '@testing-library/react';

jest.mock('@/lib/firebase', () => ({ db: {} }));

jest.mock('firebase/firestore', () => ({
  Timestamp: class {},
  collection: jest.fn((_db: unknown, ...path: string[]) => ({ __path: path.join('/') })),
  doc: jest.fn((_db: unknown, ...path: string[]) => ({ __path: path.join('/') })),
  getDoc: jest.fn(async () => ({ exists: () => false })),
  onSnapshot: jest.fn(() => jest.fn()),
}));

import { useMachines } from '@/hooks/useFirestore';

const SITE_ID = 'site1';
const MACHINE_ID = 'kiosk-01';

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

beforeEach(() => {
  fetchMock.mockReset();
});

describe('useMachines — dismissRestartPending', () => {
  it('deletes the reboot-pending flag through the api, with no machine state consulted', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, data: { machineId: MACHINE_ID, commandId: null } }),
    });

    const { result } = renderHook(() => useMachines(SITE_ID));

    await act(async () => {
      await result.current.dismissRestartPending(MACHINE_ID);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/sites/${SITE_ID}/machines/${MACHINE_ID}/reboot-pending`);
    expect(init.method).toBe('DELETE');
  });

  it('rejects with the api problem detail so the ui can show it', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ code: 'machine_not_found', detail: 'machine kiosk-01 not found on site site1' }),
    });

    const { result } = renderHook(() => useMachines(SITE_ID));

    await expect(
      act(async () => {
        await result.current.dismissRestartPending(MACHINE_ID);
      }),
    ).rejects.toThrow('machine kiosk-01 not found on site site1');
  });
});
