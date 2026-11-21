/**
 * @jest-environment jsdom
 *
 * `useDisplaySettings` reads `keepAwake` as on until the document says
 * otherwise: while loading, when absent, and when the read fails.
 */
import { renderHook, act } from '@testing-library/react';

// override the global `{ db: null }` mock — the hook early-returns on null db.
jest.mock('@/lib/firebase', () => ({ db: {} }));

type Snap = { data: () => Record<string, unknown> | undefined };
type OnNext = (snap: Snap) => void;
type OnError = (error: Error) => void;

let onNext: OnNext | null = null;
let onError: OnError | null = null;
let docPath = '';
const unsubscribe = jest.fn();

jest.mock('firebase/firestore', () => ({
  doc: jest.fn((_db: unknown, ...path: string[]) => ({ __path: path.join('/') })),
  onSnapshot: jest.fn((ref: { __path: string }, next: OnNext, error: OnError) => {
    docPath = ref.__path;
    onNext = next;
    onError = error;
    return unsubscribe;
  }),
}));

import { useDisplaySettings } from '@/hooks/useDisplaySettings';

function emit(data: Record<string, unknown> | undefined) {
  const next = onNext;
  if (!next) throw new Error('no listener registered');
  act(() => next({ data: () => data }));
}

beforeEach(() => {
  onNext = null;
  onError = null;
  docPath = '';
  unsubscribe.mockClear();
});

describe('useDisplaySettings', () => {
  it('subscribes to the site display settings document', () => {
    renderHook(() => useDisplaySettings('site1'));
    expect(docPath).toBe('sites/site1/settings/display');
  });

  it('reads keepAwake as on while loading', () => {
    const { result } = renderHook(() => useDisplaySettings('site1'));
    expect(result.current).toEqual({ settings: { keepAwake: true }, loading: true });
  });

  it('reads an absent document as on', () => {
    const { result } = renderHook(() => useDisplaySettings('site1'));
    emit(undefined);
    expect(result.current).toEqual({ settings: { keepAwake: true }, loading: false });
  });

  it('follows the document off and back on', () => {
    const { result } = renderHook(() => useDisplaySettings('site1'));

    emit({ keepAwake: false });
    expect(result.current.settings.keepAwake).toBe(false);

    emit({ keepAwake: true });
    expect(result.current.settings.keepAwake).toBe(true);
  });

  it('reads only the literal false as off', () => {
    const { result } = renderHook(() => useDisplaySettings('site1'));
    emit({ keepAwake: 'false' });
    expect(result.current.settings.keepAwake).toBe(true);
  });

  it('falls back to on when the read fails', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderHook(() => useDisplaySettings('site1'));
    emit({ keepAwake: false });

    const fail = onError;
    if (!fail) throw new Error('no error listener registered');
    act(() => fail(new Error('permission-denied')));

    expect(result.current).toEqual({ settings: { keepAwake: true }, loading: false });
    consoleError.mockRestore();
  });

  it('does not carry the previous site answer to the next site', () => {
    const { result, rerender } = renderHook(({ siteId }) => useDisplaySettings(siteId), {
      initialProps: { siteId: 'site1' },
    });
    emit({ keepAwake: false });

    rerender({ siteId: 'site2' });

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(docPath).toBe('sites/site2/settings/display');
    expect(result.current).toEqual({ settings: { keepAwake: true }, loading: true });
  });

  it('holds no subscription without a site', () => {
    const { result } = renderHook(() => useDisplaySettings(''));
    expect(onNext).toBeNull();
    expect(result.current).toEqual({ settings: { keepAwake: true }, loading: false });
  });
});
