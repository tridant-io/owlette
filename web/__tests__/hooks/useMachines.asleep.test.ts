/**
 * @jest-environment jsdom
 *
 * `Machine.asleep` is what a macOS agent writes on the system's way to sleep,
 * and keeps writing through its dark wakes. `useMachines` whitelists the fields
 * it rebuilds a machine from, and a dark wake's fresh heartbeat must not paint
 * the machine online for the seconds it is up.
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
const NOW_MS = 1_760_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

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
  jest.useFakeTimers();
  jest.setSystemTime(NOW_MS);
});

afterEach(() => {
  jest.useRealTimers();
});

async function machinesFrom(docs: SnapshotDoc[]) {
  const { result } = renderHook(() => useMachines(SITE_ID));
  act(() => emitMachines(docs));
  await waitFor(() => expect(result.current.machines).toHaveLength(docs.length));
  return result.current.machines;
}

describe('useMachines — asleep', () => {
  it('reads an asleep machine as asleep and not online, a dark wake included', async () => {
    const [stale, darkWake] = await machinesFrom([
      machineDoc('mac-01', { asleep: true, lastHeartbeat: NOW_SEC - 1800 }),
      machineDoc('mac-02', { asleep: true }),
    ]);

    expect(stale).toMatchObject({ asleep: true, online: false });
    expect(darkWake).toMatchObject({ asleep: true, online: false });
  });

  it('reads an awake mac, and an agent that never writes it, as not asleep', async () => {
    const [awake, older] = await machinesFrom([
      machineDoc('mac-01', { asleep: false }),
      machineDoc('win-01', {}),
    ]);

    expect(awake).toMatchObject({ asleep: false, online: true });
    expect(older).toMatchObject({ asleep: false, online: true });
  });

  it('leaves a stopped agent offline rather than asleep', async () => {
    const [stopped] = await machinesFrom([machineDoc('mac-01', { asleep: true, online: false })]);

    expect(stopped).toMatchObject({ asleep: false, online: false });
  });
});
