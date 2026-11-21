/**
 * @jest-environment jsdom
 *
 * `useMachines(siteId, machineIds)` for a scoped member.
 *
 * firestore.rules refuse a scoped member's plain list of `sites/{siteId}/machines`
 * and `config/{siteId}/machines`: the document id is the machine id, so the rules
 * can only prove a `documentId() in` query over the row's own machineIds. With a
 * scope the hook must issue exactly that query on both collections, never the
 * plain list, and a refused listener must end loading instead of spinning forever.
 */
import { renderHook, act, waitFor } from '@testing-library/react';

// Override jest.setup.js's `{ db: null }` — the hook early-returns on null db.
jest.mock('@/lib/firebase', () => ({ db: {} }));

type SnapshotDoc = { id: string; data: () => Record<string, unknown> };
type Snapshot = { metadata: { fromCache: boolean }; forEach: (cb: (doc: SnapshotDoc) => void) => void };
type Constraint = { field: unknown; op: string; value: unknown };
type Ref =
  | { __kind: 'collection' | 'doc'; __path: string }
  | { __kind: 'query'; __path: string; __constraints: Constraint[] };
type Subscription = {
  ref: Ref;
  onNext: (snap: Snapshot) => void;
  onError?: (err: Error) => void;
  unsubscribe: jest.Mock;
};

const mockSubscriptions: Subscription[] = [];

jest.mock('firebase/firestore', () => ({
  Timestamp: class {},
  collection: jest.fn((_db: unknown, ...path: string[]) => ({ __kind: 'collection', __path: path.join('/') })),
  doc: jest.fn((_db: unknown, ...path: string[]) => ({ __kind: 'doc', __path: path.join('/') })),
  documentId: jest.fn(() => '__name__'),
  where: jest.fn((field: unknown, op: string, value: unknown) => ({ field, op, value })),
  query: jest.fn((col: { __path: string }, ...constraints: Constraint[]) => ({
    __kind: 'query',
    __path: col.__path,
    __constraints: constraints,
  })),
  getDoc: jest.fn(async () => ({ exists: () => false })),
  onSnapshot: jest.fn(
    (ref: Ref, onNext: Subscription['onNext'], onError?: Subscription['onError']) => {
      const unsubscribe = jest.fn();
      mockSubscriptions.push({ ref, onNext, onError, unsubscribe });
      return unsubscribe;
    },
  ),
}));

import { onSnapshot } from 'firebase/firestore';
import { useMachines } from '@/hooks/useFirestore';

const SITE_ID = 'site1';
const STATUS_PATH = `sites/${SITE_ID}/machines`;
const CONFIG_PATH = `config/${SITE_ID}/machines`;
const NOW_SEC = Math.floor(Date.now() / 1000);

/** the live listener on a machines collection (status or config), plain or queried */
function listenerOn(path: string): Subscription {
  const live = mockSubscriptions.filter(
    (s) => s.ref.__path === path && s.ref.__kind !== 'doc' && s.unsubscribe.mock.calls.length === 0,
  );
  if (live.length !== 1) throw new Error(`expected one live listener on ${path}, found ${live.length}`);
  return live[0];
}

function machineDoc(id: string): SnapshotDoc {
  return { id, data: () => ({ online: true, lastHeartbeat: NOW_SEC - 5 }) };
}

function emitStatus(docs: SnapshotDoc[]) {
  listenerOn(STATUS_PATH).onNext({ metadata: { fromCache: false }, forEach: (cb) => docs.forEach(cb) });
}

beforeEach(() => {
  mockSubscriptions.length = 0;
  jest.mocked(onSnapshot).mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('useMachines — machine scope', () => {
  it('lists the plain collections without a scope, as before', async () => {
    const { result } = renderHook(() => useMachines(SITE_ID));

    expect(listenerOn(STATUS_PATH).ref.__kind).toBe('collection');
    expect(listenerOn(CONFIG_PATH).ref.__kind).toBe('collection');
    expect(result.current.loading).toBe(true);

    act(() => emitStatus([machineDoc('m1'), machineDoc('m3')]));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.machines.map((m) => m.machineId)).toEqual(['m1', 'm3']);
  });

  it('queries both collections by document id over the sorted scope, and never lists them', async () => {
    const { result } = renderHook(() => useMachines(SITE_ID, ['m2', 'm1']));

    for (const path of [STATUS_PATH, CONFIG_PATH]) {
      const { ref } = listenerOn(path);
      expect(ref).toEqual({
        __kind: 'query',
        __path: path,
        __constraints: [{ field: '__name__', op: 'in', value: ['m1', 'm2'] }],
      });
    }
    expect(mockSubscriptions.some((s) => s.ref.__kind === 'collection')).toBe(false);

    act(() => emitStatus([machineDoc('m1'), machineDoc('m2')]));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.machines.map((m) => m.machineId)).toEqual(['m1', 'm2']);
    expect(result.current.error).toBeNull();
  });

  it('keeps its listeners when a new array carries the same ids', () => {
    const { rerender } = renderHook(({ ids }) => useMachines(SITE_ID, ids), {
      initialProps: { ids: ['m1', 'm2'] as readonly string[] },
    });
    const subscribed = jest.mocked(onSnapshot).mock.calls.length;

    rerender({ ids: ['m2', 'm1', 'm2'] });

    expect(jest.mocked(onSnapshot).mock.calls.length).toBe(subscribed);
    expect(mockSubscriptions.every((s) => s.unsubscribe.mock.calls.length === 0)).toBe(true);
  });

  it('opens nothing for an empty scope, and reports no machines without loading', () => {
    const { result } = renderHook(() => useMachines(SITE_ID, []));

    expect(onSnapshot).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.machines).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('ends loading on a refused status listener, with no machines and the error set', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderHook(() => useMachines(SITE_ID, ['m1']));
    expect(result.current.loading).toBe(true);

    act(() => listenerOn(STATUS_PATH).onError?.(new Error('Missing or insufficient permissions.')));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.machines).toEqual([]);
    expect(result.current.error).toBe('Missing or insufficient permissions.');
  });

  it('loads again without the old error once the scope changes after a refusal', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const { result, rerender } = renderHook(({ ids }) => useMachines(SITE_ID, ids), {
      initialProps: { ids: ['m1', 'm2'] as readonly string[] },
    });
    act(() => listenerOn(STATUS_PATH).onError?.(new Error('Missing or insufficient permissions.')));
    await waitFor(() => expect(result.current.error).not.toBeNull());

    rerender({ ids: ['m1'] });

    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(true);
    act(() => emitStatus([machineDoc('m1')]));
    await waitFor(() => expect(result.current.machines.map((m) => m.machineId)).toEqual(['m1']));
  });

  it('reads at most 30 machines from a longer scope, and warns once', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const ids = Array.from({ length: 31 }, (_, i) => `m${String(i).padStart(2, '0')}`);

    const { rerender } = renderHook(({ scope }) => useMachines(SITE_ID, scope), {
      initialProps: { scope: ids as readonly string[] },
    });
    rerender({ scope: [...ids] });

    const { ref } = listenerOn(STATUS_PATH);
    expect(ref.__kind === 'query' && ref.__constraints[0].value).toEqual(ids.slice(0, 30));
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
