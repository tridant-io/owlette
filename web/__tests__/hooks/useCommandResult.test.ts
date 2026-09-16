/**
 * @jest-environment jsdom
 *
 * Unit tests for `useCommandResult`, the scoped replacement for
 * DisplayLayoutPanel's private `commands/completed` listener. The subscription
 * must stay bound to one command id: no id means no listener, a resolved command
 * drops its own, and a swapped id must never surface the previous result — that
 * is what keeps a one-off dispatch from turning into a standing per-machine
 * subscription.
 */
import { renderHook, act, waitFor } from '@testing-library/react';

// Override the global `{ db: null }` mock — the hook early-returns on null db.
jest.mock('@/lib/firebase', () => ({ db: {} }));

type CompletedDoc = Record<string, { status?: string; result?: unknown }>;
type DocListener = (snap: { exists: () => boolean; data: () => CompletedDoc }) => void;

let listener: DocListener | null = null;
let docPath = '';
const unsubscribe = jest.fn();

jest.mock('firebase/firestore', () => ({
  doc: jest.fn((_db: unknown, ...path: string[]) => ({ __path: path.join('/') })),
  onSnapshot: jest.fn((ref: { __path: string }, onNext: DocListener) => {
    docPath = ref.__path;
    listener = onNext;
    return unsubscribe;
  }),
}));

import { useCommandResult } from '@/hooks/useCommandResult';
import { onSnapshot } from 'firebase/firestore';

/** Emit a completed-commands doc into the live listener. */
function emit(entries: CompletedDoc) {
  if (!listener) throw new Error('no listener registered');
  const emitTo = listener;
  act(() => {
    emitTo({ exists: () => true, data: () => entries });
  });
}

beforeEach(() => {
  listener = null;
  docPath = '';
  unsubscribe.mockClear();
  jest.mocked(onSnapshot).mockClear();
});

describe('useCommandResult', () => {
  it('subscribes to the machine-scoped completed-commands doc', () => {
    renderHook(() => useCommandResult('site1', 'kiosk-01', 'cmd-1'));
    expect(docPath).toBe('sites/site1/machines/kiosk-01/commands/completed');
  });

  it('holds no subscription without a command id', () => {
    renderHook(() => useCommandResult('site1', 'kiosk-01', null));
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it('stays pending until the entry for this command reports completed', async () => {
    const { result } = renderHook(() => useCommandResult('site1', 'kiosk-01', 'cmd-1'));

    emit({ 'cmd-2': { status: 'completed', result: 'other command' } });
    expect(result.current).toBeNull();

    emit({ 'cmd-1': { status: 'pending' } });
    expect(result.current).toBeNull();

    emit({ 'cmd-1': { status: 'completed', result: 'helper reachable' } });
    await waitFor(() => expect(result.current).toBe('helper reachable'));
  });

  it('reads a completed entry with no result string as "no result"', async () => {
    const { result } = renderHook(() => useCommandResult('site1', 'kiosk-01', 'cmd-1'));

    emit({ 'cmd-1': { status: 'completed' } });
    await waitFor(() => expect(result.current).toBe('no result'));
  });

  it('drops the listener once the result lands', async () => {
    const { result } = renderHook(() => useCommandResult('site1', 'kiosk-01', 'cmd-1'));

    emit({ 'cmd-1': { status: 'completed', result: 'done' } });
    await waitFor(() => expect(result.current).toBe('done'));
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('drops the listener when the command id clears', () => {
    const { rerender } = renderHook(
      ({ cmdId }: { cmdId: string | null }) => useCommandResult('site1', 'kiosk-01', cmdId),
      { initialProps: { cmdId: 'cmd-1' as string | null } },
    );
    expect(unsubscribe).not.toHaveBeenCalled();

    rerender({ cmdId: null });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('re-subscribes on a new command id and reads as pending, not the old result', async () => {
    const { result, rerender } = renderHook(
      ({ cmdId }: { cmdId: string | null }) => useCommandResult('site1', 'kiosk-01', cmdId),
      { initialProps: { cmdId: 'cmd-1' as string | null } },
    );

    emit({ 'cmd-1': { status: 'completed', result: 'first' } });
    await waitFor(() => expect(result.current).toBe('first'));

    rerender({ cmdId: 'cmd-2' });
    expect(result.current).toBeNull();
    expect(onSnapshot).toHaveBeenCalledTimes(2);

    emit({ 'cmd-1': { status: 'completed', result: 'first' }, 'cmd-2': { status: 'completed', result: 'second' } });
    await waitFor(() => expect(result.current).toBe('second'));
  });
});
