/**
 * @jest-environment jsdom
 *
 * `useSites` must not report a site list as settled until it is the WHOLE list.
 *
 * Incident 2026-09-14: reloading the dashboard intermittently opened the wrong
 * site. Callers pick a default site once `loading` goes false — `lastSiteId` if
 * it is in the list, else `sites[0]` — so any list published early is a wrong
 * answer, not a partial one. The per-site branch published after the FIRST of N
 * snapshots, and snapshots land in any order.
 */
import { act, renderHook } from '@testing-library/react';

// Override jest.setup.js's `{ db: null }` — the hook early-returns on null db.
jest.mock('@/lib/firebase', () => ({ db: {} }));

type DocSnap = { exists: () => boolean; data: () => Record<string, unknown> };
type DocListener = (snap: DocSnap) => void;
type ErrorListener = (err: Error) => void;

const docListeners = new Map<string, { next: DocListener; error: ErrorListener }>();
const unsubscribe = jest.fn();

jest.mock('firebase/firestore', () => ({
  collection: jest.fn((_db: unknown, ...path: string[]) => ({ __kind: 'collection', __path: path.join('/') })),
  doc: jest.fn((_db: unknown, ...path: string[]) => ({ __kind: 'doc', __path: path.join('/') })),
  onSnapshot: jest.fn((ref: { __path: string }, next: DocListener, error: ErrorListener) => {
    docListeners.set(ref.__path, { next, error });
    return unsubscribe;
  }),
}));

import { useSites } from '@/hooks/useFirestore';

const siteSnap = (name: string): DocSnap => ({ exists: () => true, data: () => ({ name }) });

// Stable identities, as AuthContext's memoized projection is: a fresh array per
// render would re-run the hook's effect and re-subscribe after every publish.
const TWO_SITES = ['node-nyc', 'tec-prod'];
const WITH_MISSING = ['node-nyc', 'gone'];
const REPEATED = ['node-nyc', 'node-nyc'];

function emit(siteId: string, snap: DocSnap) {
  const listener = docListeners.get(`sites/${siteId}`);
  if (!listener) throw new Error(`no listener for sites/${siteId}`);
  act(() => listener.next(snap));
}

beforeEach(() => {
  docListeners.clear();
  unsubscribe.mockClear();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('useSites — per-site branch', () => {
  it('stays loading, publishing nothing, until every site has answered', () => {
    const { result } = renderHook(() => useSites('uid-1', TWO_SITES, false));

    // node-nyc lands first. The old hook published [node-nyc] with loading=false
    // here, and the dashboard latched it because tec-prod wasn't in the list yet.
    emit('node-nyc', siteSnap('NODE NYC'));
    expect(result.current.loading).toBe(true);
    expect(result.current.sites).toEqual([]);

    emit('tec-prod', siteSnap('TEC Prod'));
    expect(result.current.loading).toBe(false);
    expect(result.current.sites.map((s) => s.id)).toEqual(['node-nyc', 'tec-prod']);
  });

  it('publishes later updates immediately once settled', () => {
    const { result } = renderHook(() => useSites('uid-1', TWO_SITES, false));
    emit('node-nyc', siteSnap('NODE NYC'));
    emit('tec-prod', siteSnap('TEC Prod'));

    emit('tec-prod', siteSnap('TEC Production'));
    expect(result.current.sites.find((s) => s.id === 'tec-prod')?.name).toBe('TEC Production');
  });

  it('settles when a listener fails, rather than holding the list open forever', () => {
    const { result } = renderHook(() => useSites('uid-1', TWO_SITES, false));

    emit('node-nyc', siteSnap('NODE NYC'));
    act(() => docListeners.get('sites/tec-prod')!.error(new Error('permission-denied')));

    expect(result.current.loading).toBe(false);
    expect(result.current.sites.map((s) => s.id)).toEqual(['node-nyc']);
    expect(result.current.error).toBe('site tec-prod: permission-denied');
  });

  it('counts a missing site doc as answered', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => useSites('uid-1', WITH_MISSING, false));

    emit('node-nyc', siteSnap('NODE NYC'));
    emit('gone', { exists: () => false, data: () => ({}) });

    expect(result.current.loading).toBe(false);
    expect(result.current.sites.map((s) => s.id)).toEqual(['node-nyc']);
  });

  it('does not wait on a repeated id', () => {
    const { result } = renderHook(() => useSites('uid-1', REPEATED, false));

    emit('node-nyc', siteSnap('NODE NYC'));

    expect(result.current.loading).toBe(false);
    expect(result.current.sites.map((s) => s.id)).toEqual(['node-nyc']);
  });
});

describe('useSites — unresolved access', () => {
  it('waits, subscribing to nothing, while userSites is undefined', () => {
    const { result } = renderHook(() => useSites('uid-1', undefined, false));

    expect(result.current.loading).toBe(true);
    expect(result.current.sites).toEqual([]);
    expect(docListeners.size).toBe(0);
  });
});
