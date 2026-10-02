/**
 * @jest-environment jsdom
 *
 * `useMachines` keeps an unchanged machine's object across snapshots.
 *
 * Every heartbeat lands as a machines-collection snapshot that carries every
 * doc, not just the one that changed. Rebuilding all of them handed the
 * dashboard a new object per machine per heartbeat, so a memoized card or row
 * could never skip a render: one agent reporting in re-rendered the whole fleet.
 */
import { renderHook, act, waitFor } from '@testing-library/react';

// Override jest.setup.js's `{ db: null }` — the hook early-returns on null db.
jest.mock('@/lib/firebase', () => ({ db: {} }));

type SnapshotDoc = { id: string; data: () => Record<string, unknown> };
type CollectionListener = (snap: {
  metadata: { fromCache: boolean };
  forEach: (cb: (doc: SnapshotDoc) => void) => void;
}) => void;

const collectionListeners = new Map<string, CollectionListener>();

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
    return jest.fn();
  }),
}));

import { useMachines } from '@/hooks/useFirestore';

const SITE_ID = 'site1';
const NOW_SEC = Math.floor(Date.now() / 1000);

/**
 * A heartbeat-shaped status doc. `data()` builds a fresh object on every call,
 * as the Firestore SDK does, so identity can only survive by comparing content.
 */
function machineDoc(id: string, lastHeartbeat: number, cpuPercent: number): SnapshotDoc {
  return {
    id,
    data: () => ({
      online: true,
      lastHeartbeat,
      metrics: {
        schemaVersion: 2,
        cpus: { CPU0: { percent: cpuPercent } },
        processes: {
          'proc-1': { name: 'TouchDesigner.exe', status: 'RUNNING', pid: 4242 },
        },
      },
    }),
  };
}

function emitMachines(docs: SnapshotDoc[]) {
  const listener = collectionListeners.get(`sites/${SITE_ID}/machines`);
  if (!listener) throw new Error('machines listener not registered');
  listener({ metadata: { fromCache: false }, forEach: (cb) => docs.forEach(cb) });
}

beforeEach(() => {
  collectionListeners.clear();
});

describe('useMachines — object identity across snapshots', () => {
  it('keeps the unchanged machine when another machine heartbeats', async () => {
    const { result } = renderHook(() => useMachines(SITE_ID));

    act(() => {
      emitMachines([machineDoc('kiosk-a', NOW_SEC - 5, 10), machineDoc('kiosk-b', NOW_SEC - 5, 20)]);
    });
    await waitFor(() => expect(result.current.machines).toHaveLength(2));
    const [before, otherBefore] = result.current.machines;

    act(() => {
      emitMachines([machineDoc('kiosk-a', NOW_SEC - 5, 10), machineDoc('kiosk-b', NOW_SEC, 35)]);
    });
    await waitFor(() => expect(result.current.machines[1].metrics?.cpus?.CPU0.percent).toBe(35));

    const [after, otherAfter] = result.current.machines;
    expect(after).toBe(before);
    expect(after.processes).toBe(before.processes);
    expect(after.devices).toBe(before.devices);
    expect(otherAfter).not.toBe(otherBefore);
  });

  it('keeps the whole list when a snapshot changes nothing', async () => {
    const { result } = renderHook(() => useMachines(SITE_ID));

    act(() => {
      emitMachines([machineDoc('kiosk-a', NOW_SEC - 5, 10)]);
    });
    await waitFor(() => expect(result.current.machines).toHaveLength(1));
    const before = result.current.machines;

    act(() => {
      emitMachines([machineDoc('kiosk-a', NOW_SEC - 5, 10)]);
    });

    expect(result.current.machines).toBe(before);
  });

  it('drops a machine whose doc left the snapshot and keeps the rest', async () => {
    const { result } = renderHook(() => useMachines(SITE_ID));

    act(() => {
      emitMachines([machineDoc('kiosk-a', NOW_SEC - 5, 10), machineDoc('kiosk-b', NOW_SEC - 5, 20)]);
    });
    await waitFor(() => expect(result.current.machines).toHaveLength(2));
    const kept = result.current.machines[0];

    act(() => {
      emitMachines([machineDoc('kiosk-a', NOW_SEC - 5, 10)]);
    });
    await waitFor(() => expect(result.current.machines).toHaveLength(1));

    expect(result.current.machines[0]).toBe(kept);
  });
});

/**
 * Reusing an unchanged machine's object also stopped dropping the optimistic
 * launch-mode hold on every unrelated heartbeat. The config listener has to
 * release it once the config doc agrees, or an offline machine (whose status doc
 * never changes) keeps showing the optimistic mode after someone else changes it.
 */
describe('useMachines — optimistic launch mode on a quiet machine', () => {
  function emitConfig(launchMode: string) {
    const listener = collectionListeners.get(`config/${SITE_ID}/machines`);
    if (!listener) throw new Error('config listener not registered');
    const doc: SnapshotDoc = {
      id: 'kiosk-a',
      data: () => ({ processes: [{ id: 'proc-1', launch_mode: launchMode }] }),
    };
    listener({ metadata: { fromCache: false }, forEach: (cb) => cb(doc) });
  }

  const shownMode = (machines: ReturnType<typeof useMachines>['machines']) => {
    const process = machines[0].processes?.[0];
    return process?._optimisticLaunchMode ?? process?.launch_mode;
  };

  beforeEach(() => {
    global.fetch = jest.fn(async () => ({ ok: true, text: async () => '' })) as unknown as typeof fetch;
  });

  it('follows a later config change once the config doc confirmed the optimistic write', async () => {
    const { result } = renderHook(() => useMachines(SITE_ID));
    act(() => {
      emitMachines([machineDoc('kiosk-a', NOW_SEC - 600, 10)]);
    });
    await waitFor(() => expect(result.current.machines).toHaveLength(1));

    await act(async () => {
      await result.current.setLaunchMode('kiosk-a', 'proc-1', 'TouchDesigner.exe', 'always');
    });
    expect(shownMode(result.current.machines)).toBe('always');

    act(() => emitConfig('always'));
    act(() => emitConfig('off'));

    await waitFor(() => expect(shownMode(result.current.machines)).toBe('off'));
  });
});
