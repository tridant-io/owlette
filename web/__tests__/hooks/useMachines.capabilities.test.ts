/**
 * @jest-environment jsdom
 *
 * `Machine.capabilities` is the agent-written handshake map that gates remote
 * operations — `displayRemoteApply` disables the display panel's restore button
 * on an agent too old to dispatch it. The panel used to read it through a
 * private per-machine listener; it now rides this subscription, so a field that
 * is declared but never parsed would silently gate every machine off.
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

beforeEach(() => {
  collectionListeners.clear();
  unsubscribe.mockClear();
  jest.useFakeTimers();
  jest.setSystemTime(NOW_MS);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useMachines — capabilities handshake', () => {
  it('maps the capabilities map off the machine doc', async () => {
    const { result } = renderHook(() => useMachines(SITE_ID));

    act(() => {
      emitMachines([machineDoc('kiosk-01', { capabilities: { displayRemoteApply: 1 } })]);
    });

    await waitFor(() => expect(result.current.machines).toHaveLength(1));
    expect(result.current.machines[0].capabilities).toEqual({ displayRemoteApply: 1 });
  });

  it('leaves capabilities undefined on an agent that predates the map', async () => {
    const { result } = renderHook(() => useMachines(SITE_ID));

    act(() => {
      emitMachines([machineDoc('kiosk-01', {})]);
    });

    await waitFor(() => expect(result.current.machines).toHaveLength(1));
    expect(result.current.machines[0].capabilities).toBeUndefined();
  });

  it('keeps machines independent and follows a later snapshot', async () => {
    const { result } = renderHook(() => useMachines(SITE_ID));

    act(() => {
      emitMachines([
        machineDoc('kiosk-01', { capabilities: { displayRemoteApply: 1 } }),
        machineDoc('kiosk-02', { capabilities: { displayRemoteApply: 0 } }),
      ]);
    });

    await waitFor(() => expect(result.current.machines).toHaveLength(2));
    expect(result.current.machines.map((m) => m.capabilities?.displayRemoteApply)).toEqual([1, 0]);

    // An upgraded agent must reach the UI — the restore button reads this.
    act(() => {
      emitMachines([
        machineDoc('kiosk-01', { capabilities: { displayRemoteApply: 1 } }),
        machineDoc('kiosk-02', { capabilities: { displayRemoteApply: 1 } }),
      ]);
    });

    await waitFor(() =>
      expect(result.current.machines.map((m) => m.capabilities?.displayRemoteApply)).toEqual([1, 1]),
    );
  });
});
