/**
 * @jest-environment jsdom
 *
 * `Machine.displayAwake` is what the agent holds for the site's keep screens
 * awake switch, mirrored onto the machine doc on each change. `useMachines`
 * whitelists the fields it rebuilds a machine from, so a field that is declared
 * but never mapped would silently read undefined and no machine would ever
 * show as held awake.
 */
import { renderHook, act, waitFor } from '@testing-library/react';

// Override jest.setup.js's `{ db: null }` — the hook early-returns on null db
// and would skip the snapshot effect.
jest.mock('@/lib/firebase', () => ({ db: {} }));

type SnapshotDoc = { id: string; data: () => Record<string, unknown> };
type CollectionListener = (snap: {
  metadata: { fromCache: boolean };
  forEach: (cb: (doc: SnapshotDoc) => void) => void;
}) => void;

const collectionListeners = new Map<string, CollectionListener>();
const unsubscribe = jest.fn();

jest.mock('firebase/firestore', () => ({
  Timestamp: class {},
  collection: jest.fn((_db: unknown, ...path: string[]) => ({
    __kind: 'collection' as const,
    __path: path.join('/'),
  })),
  doc: jest.fn((_db: unknown, ...path: string[]) => ({
    __kind: 'doc' as const,
    __path: path.join('/'),
  })),
  getDoc: jest.fn(async () => ({ exists: () => false })),
  onSnapshot: jest.fn((ref: { __kind: string; __path: string }, onNext: CollectionListener) => {
    if (ref.__kind === 'collection') collectionListeners.set(ref.__path, onNext);
    return unsubscribe;
  }),
}));

import { useMachines } from '@/hooks/useFirestore';

const SITE_ID = 'site1';
const NOW_MS = 1_760_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

/** Emit a machines-collection snapshot for the site under test. */
function emitMachines(docs: SnapshotDoc[]) {
  const listener = collectionListeners.get(`sites/${SITE_ID}/machines`);
  if (!listener) throw new Error('machines listener not registered');
  listener({
    metadata: { fromCache: false },
    forEach: (cb) => docs.forEach(cb),
  });
}

const machineDoc = (id: string, data: Record<string, unknown>): SnapshotDoc => ({
  id,
  data: () => ({ online: true, lastHeartbeat: NOW_SEC - 5, ...data }),
});

const held = {
  wanted: true,
  held: true,
  session: true,
  how: 'power_request',
  reason: null,
};

beforeEach(() => {
  collectionListeners.clear();
  unsubscribe.mockClear();
  jest.useFakeTimers();
  jest.setSystemTime(NOW_MS);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useMachines — displayAwake', () => {
  it('maps the mirror and follows it when the switch goes off', async () => {
    const { result } = renderHook(() => useMachines(SITE_ID));

    act(() => {
      emitMachines([machineDoc('kiosk-01', { displayAwake: held })]);
    });

    await waitFor(() => expect(result.current.machines).toHaveLength(1));
    expect(result.current.machines[0].displayAwake).toEqual(held);

    act(() => {
      emitMachines([machineDoc('kiosk-01', {
        displayAwake: { wanted: false, held: false, session: false, how: null, reason: null },
      })]);
    });

    await waitFor(() => expect(result.current.machines[0].displayAwake?.held).toBe(false));
    expect(result.current.machines[0].displayAwake).toEqual({
      wanted: false, held: false, session: false, how: null, reason: null,
    });
  });

  it('keeps a missing session report as null, with the reason the agent gave', async () => {
    const { result } = renderHook(() => useMachines(SITE_ID));

    act(() => {
      emitMachines([machineDoc('kiosk-01', {
        displayAwake: { wanted: true, held: true, session: null, how: 'systemd_inhibit', reason: 'no_display' },
      })]);
    });

    await waitFor(() => expect(result.current.machines).toHaveLength(1));
    expect(result.current.machines[0].displayAwake).toEqual({
      wanted: true, held: true, session: null, how: 'systemd_inhibit', reason: 'no_display',
    });
  });

  it('leaves it undefined on an agent that predates it', async () => {
    const { result } = renderHook(() => useMachines(SITE_ID));

    act(() => {
      emitMachines([machineDoc('kiosk-01', {})]);
    });

    await waitFor(() => expect(result.current.machines).toHaveLength(1));
    expect(result.current.machines[0].displayAwake).toBeUndefined();
  });

  it('ignores a mirror that is not the agent\'s shape', async () => {
    const { result } = renderHook(() => useMachines(SITE_ID));

    act(() => {
      emitMachines([
        machineDoc('kiosk-01', { displayAwake: true }),
        machineDoc('kiosk-02', { displayAwake: { wanted: 'yes', held: true } }),
      ]);
    });

    await waitFor(() => expect(result.current.machines).toHaveLength(2));
    expect(result.current.machines[0].displayAwake).toBeUndefined();
    expect(result.current.machines[1].displayAwake).toBeUndefined();
  });

  it('reads stray field types as null rather than passing them through', async () => {
    const { result } = renderHook(() => useMachines(SITE_ID));

    act(() => {
      emitMachines([machineDoc('kiosk-01', {
        displayAwake: { wanted: true, held: false, session: 'yes', how: 7, reason: {} },
      })]);
    });

    await waitFor(() => expect(result.current.machines).toHaveLength(1));
    expect(result.current.machines[0].displayAwake).toEqual({
      wanted: true, held: false, session: null, how: null, reason: null,
    });
  });
});
