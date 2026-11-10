/**
 * @jest-environment jsdom
 *
 * `useAgentAlertToasts` watches a site's newest `exe_missing` logs. Without an
 * `orderBy('timestamp')` Firestore orders by document id, and log ids are
 * random, so once a site held more than the limit a new alert only entered the
 * window, and toasted, when its id happened to sort low.
 */
import { renderHook } from '@testing-library/react';

// Override the global `{ db: null }` mock — the hook early-returns on null db.
jest.mock('@/lib/firebase', () => ({ db: {} }));
jest.mock('@/lib/toast', () => ({ toast: { error: jest.fn() } }));

type Change = { type: string; doc: { id: string; data: () => Record<string, unknown> } };
let emit: (changes: Change[]) => void = () => {};

jest.mock('firebase/firestore', () => ({
  collection: jest.fn(() => ({})),
  query: jest.fn(() => ({})),
  where: jest.fn(() => ({})),
  orderBy: jest.fn(() => ({})),
  limit: jest.fn(() => ({})),
  onSnapshot: jest.fn((_q: unknown, onNext: (snap: { docChanges: () => Change[] }) => void) => {
    emit = (changes) => onNext({ docChanges: () => changes });
    return jest.fn();
  }),
}));

import { useAgentAlertToasts } from '@/hooks/useAgentAlertToasts';
import { toast } from '@/lib/toast';
import { limit, orderBy, where } from 'firebase/firestore';

const added = (id: string, data: Record<string, unknown> = {}): Change => ({
  type: 'added',
  doc: { id, data: () => ({ processName: 'kiosk', exePath: 'C:\\kiosk.exe', ...data }) },
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useAgentAlertToasts', () => {
  it('asks for the newest exe_missing logs, not the lowest document ids', () => {
    renderHook(() => useAgentAlertToasts('site1'));

    expect(where).toHaveBeenCalledWith('action', '==', 'exe_missing');
    expect(orderBy).toHaveBeenCalledWith('timestamp', 'desc');
    expect(limit).toHaveBeenCalledWith(20);
  });

  it('toasts an alert that arrives after the first snapshot, once', () => {
    renderHook(() => useAgentAlertToasts('site1'));

    emit([added('old')]);
    expect(toast.error).not.toHaveBeenCalled();

    emit([added('new')]);
    emit([added('new')]);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
