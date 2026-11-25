/**
 * @jest-environment jsdom
 *
 * `useUninstall.createUninstall`. the uninstall dialog offers every online
 * machine, but the server refuses a `deployment_id` that does not target the
 * machine, so the hook ties only the deployment's own targets to it.
 */

import { renderHook } from '@testing-library/react';

// override the global `{ db: null }` mock: the hook refuses without a db.
jest.mock('@/lib/firebase', () => ({ db: {} }));

const mockGetDoc = jest.fn();
jest.mock('firebase/firestore', () => ({
  collection: jest.fn(),
  getDocs: jest.fn(),
  doc: jest.fn((_db: unknown, ...path: string[]) => ({ path: path.join('/') })),
  getDoc: (...args: unknown[]) => mockGetDoc(...args),
}));

import { useUninstall } from '@/hooks/useUninstall';

describe('useUninstall.createUninstall', () => {
  const fetchMock = jest.fn();
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 202, json: async () => ({ ok: true }) });
    global.fetch = fetchMock as unknown as typeof global.fetch;
    mockGetDoc.mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function sentBodies(): Array<Record<string, unknown>> {
    return fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
  }

  it('sends the deployment_id only for machines the deployment has finished on', async () => {
    mockGetDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({
        targets: [
          { machineId: 'kiosk-01', status: 'completed' },
          { machineId: 'kiosk-03', status: 'installing' },
        ],
      }),
    });
    const { result } = renderHook(() => useUninstall());

    await result.current.createUninstall(
      'site-a',
      'VLC media player',
      ['kiosk-01', 'kiosk-02', 'kiosk-03'],
      'deploy-1',
    );

    expect(mockGetDoc).toHaveBeenCalledWith({ path: 'sites/site-a/deployments/deploy-1' });
    expect(sentBodies()).toEqual([
      { software_name: 'VLC media player', deployment_id: 'deploy-1' },
      { software_name: 'VLC media player' },
      { software_name: 'VLC media player' },
    ]);
  });

  it('reads no deployment when the uninstall is not started from one', async () => {
    const { result } = renderHook(() => useUninstall());

    await result.current.createUninstall('site-a', 'VLC media player', ['kiosk-01']);

    expect(mockGetDoc).not.toHaveBeenCalled();
    expect(sentBodies()).toEqual([{ software_name: 'VLC media player' }]);
  });
});
