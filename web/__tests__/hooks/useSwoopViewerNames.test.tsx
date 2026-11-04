/**
 * @jest-environment jsdom
 */

/**
 * the streamer's roster joined with the session record's names, on the
 * viewer id. the record is read when someone joins or leaves and at no other
 * time: once for every component that asks, never on a timer.
 */

import React from 'react';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { attach } from '@/lib/swoop/presence';
import type { SwoopSession } from '@/lib/swoop/features';
import { useSwoopViewerNames, type SwoopNamedViewer } from '@/hooks/useSwoopViewerNames';

const RECORD = '/api/sites/site-a/machines/machine-1/swoop/sessions/sid-1';

const ADA = { id: 'viewer-ada', name: 'uid_ada', ctl: true };
const ME = { id: 'viewer-me', name: 'uid_me', ctl: false };
const CY = { id: 'viewer-cy', name: 'viewer-cy', ctl: false };

/** the session route's answer: its viewers, named as it names them to this caller. */
const answer = (viewers: Array<Record<string, unknown>>) => ({
  ok: true,
  json: async () => ({ ok: true, data: { sid: 'sid-1', state: 'live', viewers } }),
});

const fetchMock = jest.fn();

// signed out unless a test signs someone in: the context's own default
let mockUser: { displayName: string | null } | null = null;
jest.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));

function liveSession() {
  const handlers = new Map<string, (data: unknown) => void>();
  const session = {
    siteId: 'site-a',
    machineId: 'machine-1',
    sid: 'sid-1',
    viewerId: 'viewer-me',
    onChannelMessage: (label: string, incoming: (data: unknown) => void) => {
      handlers.set(label, incoming);
      return () => handlers.delete(label);
    },
  } as unknown as SwoopSession;
  const detach = attach(session);
  const roster = (viewers: Array<Record<string, unknown>>) =>
    act(() => handlers.get('swoop-control')?.(JSON.stringify({ t: 'roster', viewers, tsUs: 1 })));
  return { session, roster, detach };
}

beforeEach(() => {
  mockUser = null;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    answer([
      { viewerId: ADA.id, uid: 'uid_ada', displayName: 'Ada Lovelace' },
      { viewerId: ME.id, uid: 'uid_me', displayName: 'Bob Watcher' },
    ]),
  );
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

afterEach(() => {
  delete (globalThis as unknown as { fetch?: unknown }).fetch;
});

describe('useSwoopViewerNames', () => {
  it('names nobody, and reads nothing, before the first roster', async () => {
    const live = liveSession();
    const { result } = renderHook(() => useSwoopViewerNames(live.session));
    await act(async () => {});
    expect(result.current).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    live.detach();
  });

  it('names this viewer alone in the session too', async () => {
    const live = liveSession();
    const { result } = renderHook(() => useSwoopViewerNames(live.session));
    live.roster([ME]);

    await waitFor(() => expect(result.current).toEqual([expect.objectContaining({ id: ME.id, you: true, short: 'Bob W.' })]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    live.detach();
  });

  it("calls this tab by the signed-in user's name until the read lands, and leaves the email to the route", () => {
    mockUser = { displayName: 'Bob Watcher' };
    fetchMock.mockReturnValue(new Promise(() => {}));
    const live = liveSession();
    const { result } = renderHook(() => useSwoopViewerNames(live.session));
    live.roster([ADA, ME]);

    expect(result.current.map((viewer) => [viewer.short, viewer.full, viewer.email])).toEqual([
      ['viewer', 'viewer', null],
      ['Bob W.', 'Bob Watcher', null],
    ]);
    live.detach();
  });

  it('names each viewer the roster lists, by viewer id: first name and last initial, the full name, and this tab marked', async () => {
    const live = liveSession();
    const { result } = renderHook(() => useSwoopViewerNames(live.session));
    live.roster([ADA, ME]);

    await waitFor(() => expect(result.current[0]?.short).toBe('Ada L.'));
    expect(fetchMock).toHaveBeenCalledWith(RECORD);
    expect(result.current).toEqual<SwoopNamedViewer[]>([
      { id: ADA.id, ctl: true, you: false, short: 'Ada L.', full: 'Ada Lovelace', email: null },
      { id: ME.id, ctl: false, you: true, short: 'Bob W.', full: 'Bob Watcher', email: null },
    ]);
    live.detach();
  });

  it('calls a viewer the record has not named "viewer", until it has', async () => {
    let settle: (value: unknown) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)));
    const live = liveSession();
    const { result } = renderHook(() => useSwoopViewerNames(live.session));
    live.roster([ADA, ME]);

    // before the read lands, and for a line it does not name (an account that is gone)
    expect(result.current.map((viewer) => [viewer.short, viewer.full])).toEqual([
      ['viewer', 'viewer'],
      ['viewer', 'viewer'],
    ]);
    await act(async () => settle(answer([{ viewerId: ME.id, uid: 'uid_me', displayName: 'Bob Watcher' }])));
    expect(result.current.map((viewer) => viewer.short)).toEqual(['viewer', 'Bob W.']);
    live.detach();
  });

  it('carries an email only where the route sent one', async () => {
    fetchMock.mockResolvedValue(
      answer([
        { viewerId: ADA.id, uid: 'uid_ada', displayName: 'Ada Lovelace', email: 'ada@example.test' },
        // an account with no name: its email stands in, for a caller who is sent it
        { viewerId: ME.id, uid: 'uid_me', displayName: null, email: 'bob@example.test' },
      ]),
    );
    const live = liveSession();
    const { result } = renderHook(() => useSwoopViewerNames(live.session));
    live.roster([ADA, ME]);

    await waitFor(() => expect(result.current[0]?.email).toBe('ada@example.test'));
    expect(result.current[1]).toMatchObject({ short: 'bob', full: 'bob@example.test', email: 'bob@example.test' });
    live.detach();
  });

  it('reads the record once for every component that asks, and again only when someone joins or leaves', async () => {
    // fake from the start, so a read on a timer would be caught
    jest.useFakeTimers();
    const advance = (ms: number) =>
      act(async () => {
        await jest.advanceTimersByTimeAsync(ms);
      });
    try {
      const live = liveSession();
      function Names() {
        const viewers = useSwoopViewerNames(live.session);
        return <p>{viewers.map((viewer) => viewer.short).join(', ')}</p>;
      }
      // the bar and the stage, as the page has them
      const { container } = render(
        <>
          <Names />
          <Names />
        </>,
      );

      live.roster([ADA, ME]);
      await advance(0);
      expect([...container.querySelectorAll('p')].map((line) => line.textContent)).toEqual([
        'Ada L., Bob W.',
        'Ada L., Bob W.',
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // the roster again, as the streamer resends it once it has checked a token: nobody new
      live.roster([ADA, { ...ME, name: 'uid_me_checked' }]);
      // and no read on a timer, however long the session runs
      await advance(30 * 60_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      live.roster([ADA, ME, CY]);
      await advance(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      live.detach();
    } finally {
      jest.useRealTimers();
    }
  });

  it('leaves everyone unnamed when the read fails, and throws nothing', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const live = liveSession();
    const { result } = renderHook(() => useSwoopViewerNames(live.session));
    live.roster([ADA, ME]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(result.current.map((viewer) => viewer.short)).toEqual(['viewer', 'viewer']);
    live.detach();
  });
});
