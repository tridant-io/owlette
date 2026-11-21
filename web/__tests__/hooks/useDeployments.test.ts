/**
 * @jest-environment jsdom
 *
 * `useDeployments` mutations. the per-target cancel on the deployments page
 * hands the hook one machine; the request must name that machine, or the
 * server cancels every queued target in the deployment.
 */

import { renderHook } from '@testing-library/react';

// override the global `{ db: null }` mock: the mutations refuse without a db.
jest.mock('@/lib/firebase', () => ({ db: {} }));

jest.mock('firebase/firestore', () => ({
  collection: jest.fn(() => ({})),
  onSnapshot: jest.fn(() => jest.fn()),
}));

import { useDeployments } from '@/hooks/useDeployments';

const SITE_ID = 'site-a';

describe('useDeployments cancel and retry', () => {
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

  it('cancels only the machine it is given', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ cancelled: 1 }) });
    const { result } = renderHook(() => useDeployments(SITE_ID));

    await result.current.cancelDeployment('deploy-1', 'kiosk-02');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/sites/${SITE_ID}/deployments/deploy-1/cancel`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ machines: ['kiosk-02'] });
  });

  it("surfaces the server's reason when it refuses", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        code: 'no_cancellable_targets',
        detail: 'no targets in `pending`, `closing_processes` or `downloading` state matching the machines filter',
      }),
    });
    const { result } = renderHook(() => useDeployments(SITE_ID));

    const refused = result.current.cancelDeployment('deploy-1', 'kiosk-02');
    await expect(refused).rejects.toThrow(/matching the machines filter/);
    // the page words its own message from the code
    await expect(refused).rejects.toMatchObject({ status: 409, code: 'no_cancellable_targets' });
  });

  it("carries the problem's code on a refused retry too", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ code: 'no_failed_targets', detail: 'no targets in `failed` state to retry' }),
    });
    const { result } = renderHook(() => useDeployments(SITE_ID));

    const refused = result.current.retryDeployment('deploy-1', ['kiosk-02']);
    await expect(refused).rejects.toThrow('no targets in `failed` state to retry');
    await expect(refused).rejects.toMatchObject({ status: 409, code: 'no_failed_targets' });
  });

  it('falls back to lowercase copy with the status when the answer has no problem body', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    });
    const { result } = renderHook(() => useDeployments(SITE_ID));

    await expect(result.current.cancelDeployment('deploy-1', 'kiosk-02')).rejects.toThrow(
      'failed to cancel deployment (502)',
    );
  });
});
