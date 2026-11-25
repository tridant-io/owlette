/**
 * @jest-environment node
 *
 * kickSwoopViewer: the bar's one call to take someone out of a session. the
 * dialog shows whatever it throws, so a refusal says what the api said, and
 * anything else says only that it could not.
 */

import { kickSwoopViewer } from '@/lib/swoop/kick';

const SESSION = { siteId: 'site-a', machineId: 'TEC-B4A', sid: 'sid-1' };
const fetchMock = jest.fn();

beforeEach(() => {
  fetchMock.mockReset();
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

afterEach(() => {
  delete (globalThis as unknown as { fetch?: unknown }).fetch;
});

describe('kickSwoopViewer', () => {
  it("posts the seat to the session's kick route", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });

    await expect(kickSwoopViewer(SESSION, 'viewer-ada')).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith('/api/sites/site-a/machines/TEC-B4A/swoop/sessions/sid-1/kick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewerId: 'viewer-ada' }),
    });
  });

  it("throws the api's own sentence when it refuses", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ code: 'session_ended', detail: 'this session has already ended' }),
    });

    await expect(kickSwoopViewer(SESSION, 'viewer-ada')).rejects.toThrow('this session has already ended');
  });

  it.each([
    [
      'a refusal with no body',
      () =>
        fetchMock.mockResolvedValue({
          ok: false,
          status: 502,
          json: async () => {
            throw new SyntaxError('Unexpected end of JSON input');
          },
        }),
    ],
    ['a refusal whose detail is not a sentence', () => fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ detail: 42 }) })],
    ['a request that never reached the api', () => fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))],
  ])('says it could not after %s', async (_what, answer) => {
    answer();

    await expect(kickSwoopViewer(SESSION, 'viewer-ada')).rejects.toThrow(/^could not kick them$/);
  });
});
