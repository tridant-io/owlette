/**
 * @jest-environment jsdom
 *
 * The active-hours guard on the machine doc and the restart and shutdown sends.
 *
 * Parsing: `useMachines` whitelists the fields it rebuilds a machine from, so a
 * field that is declared but never mapped reads undefined and the dashboard
 * would never offer the active-hours choice.
 *
 * Sends: the override and the deferral ride the commands route's params, the
 * countdown the dashboard draws is the agent's 60 seconds, and a refused
 * command can take its countdown back.
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
const MACHINE_ID = 'kiosk-01';
const NOW_MS = 1_760_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

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

function acceptCommand(commandId = 'cmd_1') {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 202,
    text: async () => JSON.stringify({ ok: true, data: { commandId, status: 'pending' } }),
  });
}

function sentParams(): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0];
  return JSON.parse(init.body).params;
}

beforeEach(() => {
  collectionListeners.clear();
  unsubscribe.mockClear();
  fetchMock.mockReset();
  jest.useFakeTimers();
  jest.setSystemTime(NOW_MS);
});

afterEach(() => {
  jest.useRealTimers();
});

async function loaded(data: Record<string, unknown> = {}) {
  const hook = renderHook(() => useMachines(SITE_ID));
  act(() => {
    emitMachines([machineDoc(MACHINE_ID, data)]);
  });
  await waitFor(() => expect(hook.result.current.machines).toHaveLength(1));
  return hook;
}

describe('useMachines — active hours on the machine doc', () => {
  it('maps the window, the guard capability and a deferred restart', async () => {
    const { result } = await loaded({
      activeHours: { start: 8, end: 17, source: 'policy' },
      capabilities: { keepAwake: 1, activeHoursGuard: 1 },
      rebootDeferredUntil: NOW_SEC + 3600,
    });

    const machine = result.current.machines[0];
    expect(machine.activeHours).toEqual({ start: 8, end: 17, source: 'policy' });
    expect(machine.capabilities?.activeHoursGuard).toBe(1);
    expect(machine.rebootDeferredUntil).toBe(NOW_SEC + 3600);
  });

  it('leaves all three undefined on an agent that predates them', async () => {
    const { result } = await loaded({ capabilities: { keepAwake: 1 } });

    const machine = result.current.machines[0];
    expect(machine.activeHours).toBeUndefined();
    expect(machine.capabilities?.activeHoursGuard).toBeUndefined();
    expect(machine.rebootDeferredUntil).toBeUndefined();
  });

  it('drops a window that is not the agent shape and a cleared deferral', async () => {
    const { result } = await loaded({
      activeHours: { start: 8, end: 8 },
      rebootDeferredUntil: null,
    });

    expect(result.current.machines[0].activeHours).toBeUndefined();
    expect(result.current.machines[0].rebootDeferredUntil).toBeUndefined();
  });
});

describe('useMachines — restart and shutdown sends', () => {
  it('restarts with the 60 second countdown the agent runs', async () => {
    acceptCommand('cmd_restart');
    const { result } = await loaded();

    let sent: Awaited<ReturnType<typeof result.current.restartMachine>> | undefined;
    await act(async () => {
      sent = await result.current.restartMachine(MACHINE_ID);
    });

    expect(sent?.commandId).toBe('cmd_restart');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/sites/${SITE_ID}/machines/${MACHINE_ID}/commands`);
    expect(JSON.parse(init.body).type).toBe('reboot_machine');
    expect(sentParams()).toEqual({ delay_seconds: 60 });
    expect(result.current.machines[0].rebootScheduledAt).toBe(NOW_SEC + 60);
  });

  it('sends a person\'s reason as active_hours_override', async () => {
    acceptCommand();
    const { result } = await loaded();

    await act(async () => {
      await result.current.restartMachine(MACHINE_ID, { override: { reason: 'venue closed' } });
    });

    expect(sentParams()).toEqual({ delay_seconds: 60, active_hours_override: { reason: 'venue closed' } });
    expect(result.current.machines[0].rebootScheduledAt).toBe(NOW_SEC + 60);
  });

  it('defers without drawing a countdown the agent will not run', async () => {
    acceptCommand();
    const { result } = await loaded();

    await act(async () => {
      await result.current.restartMachine(MACHINE_ID, { when: 'after_active_hours' });
    });

    expect(sentParams()).toEqual({ delay_seconds: 60, when: 'after_active_hours' });
    expect(result.current.machines[0].rebootScheduledAt).toBeUndefined();
  });

  it('takes the countdown back when the agent refuses the restart', async () => {
    acceptCommand();
    const { result } = await loaded();

    let sent: Awaited<ReturnType<typeof result.current.restartMachine>> | undefined;
    await act(async () => {
      sent = await result.current.restartMachine(MACHINE_ID);
    });
    expect(result.current.machines[0].rebootScheduledAt).toBe(NOW_SEC + 60);

    act(() => sent?.revertCountdown?.());
    expect(result.current.machines[0].rebootScheduledAt).toBeUndefined();
  });

  it('leaves a countdown the agent wrote alone', async () => {
    acceptCommand();
    const { result } = await loaded();

    let sent: Awaited<ReturnType<typeof result.current.restartMachine>> | undefined;
    await act(async () => {
      sent = await result.current.restartMachine(MACHINE_ID);
    });
    act(() => {
      emitMachines([machineDoc(MACHINE_ID, { rebooting: true, rebootScheduledAt: NOW_SEC + 58 })]);
    });
    await waitFor(() => expect(result.current.machines[0].rebootScheduledAt).toBe(NOW_SEC + 58));

    act(() => sent?.revertCountdown?.());
    expect(result.current.machines[0].rebootScheduledAt).toBe(NOW_SEC + 58);
  });

  it('shuts down with the override, the 60 second countdown and a way back', async () => {
    acceptCommand('cmd_shutdown');
    const { result } = await loaded();

    let sent: Awaited<ReturnType<typeof result.current.shutdownMachine>> | undefined;
    await act(async () => {
      sent = await result.current.shutdownMachine(MACHINE_ID, { override: { reason: 'power work' } });
    });

    expect(sent?.commandId).toBe('cmd_shutdown');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).type).toBe('shutdown_machine');
    expect(sentParams()).toEqual({ delay_seconds: 60, active_hours_override: { reason: 'power work' } });
    expect(result.current.machines[0].shutdownScheduledAt).toBe(NOW_SEC + 60);

    act(() => sent?.revertCountdown?.());
    expect(result.current.machines[0].shutdownScheduledAt).toBeUndefined();
  });
});
