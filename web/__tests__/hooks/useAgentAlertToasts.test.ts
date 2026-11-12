/**
 * @jest-environment jsdom
 *
 * `useAgentAlertToasts` watches a site's newest `exe_missing` logs.
 *
 * Order: without an `orderBy('timestamp')` Firestore orders by document id, and
 * log ids are random, so once a site held more than the limit a new alert only
 * entered the window, and toasted, when its id happened to sort low.
 *
 * Scope: the listener follows the caller's machine scope. The rules let a scoped
 * member read only their machines' logs, so the query must carry
 * `machineId in scope`; an unfiltered one is refused and the toasts go silent.
 */

import { renderHook } from '@testing-library/react';

// Override the global `{ db: null }` mock — the hook early-returns on null db.
jest.mock('@/lib/firebase', () => ({ db: {}, storage: null }));

type Change = { type: string; doc: { id: string; data: () => Record<string, unknown> } };
let emit: (changes: Change[]) => void = () => {};

jest.mock('firebase/firestore', () => ({
  collection: jest.fn((_db: unknown, ...path: string[]) => ({ path: path.join('/') })),
  query: jest.fn((ref: unknown, ...constraints: unknown[]) => ({ ref, constraints })),
  where: jest.fn((field: string, op: string, value: unknown) => ({ where: [field, op, value] })),
  orderBy: jest.fn((field: string, direction: string) => ({ orderBy: [field, direction] })),
  limit: jest.fn((n: number) => ({ limit: n })),
  onSnapshot: jest.fn((_q: unknown, onNext: (snap: { docChanges: () => Change[] }) => void) => {
    emit = (changes) => onNext({ docChanges: () => changes });
    return jest.fn();
  }),
}));

jest.mock('@/lib/toast', () => ({ toast: { error: jest.fn() } }));

import { onSnapshot } from 'firebase/firestore';
import { useAgentAlertToasts } from '@/hooks/useAgentAlertToasts';
import { toast } from '@/lib/toast';

const mockOnSnapshot = onSnapshot as unknown as jest.Mock;

type Scope = readonly string[] | null | undefined;

const NEWEST_FIRST = { orderBy: ['timestamp', 'desc'] };

function mountHook(machineIds: Scope) {
  return renderHook((props: { machineIds: Scope }) =>
    useAgentAlertToasts('site-A', undefined, undefined, props.machineIds),
  { initialProps: { machineIds } });
}

/** The constraints of every query the hook subscribed to. */
function subscribedConstraints(): unknown[][] {
  return mockOnSnapshot.mock.calls.map(([q]) => (q as { constraints: unknown[] }).constraints);
}

const added = (id: string, data: Record<string, unknown> = {}): Change => ({
  type: 'added',
  doc: { id, data: () => ({ processName: 'kiosk', exePath: 'C:\\kiosk.exe', ...data }) },
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useAgentAlertToasts', () => {
  it('toasts an alert that arrives after the first snapshot, once', () => {
    mountHook(null);

    emit([added('old')]);
    expect(toast.error).not.toHaveBeenCalled();

    emit([added('new')]);
    emit([added('new')]);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});

describe('useAgentAlertToasts machine scope', () => {
  it('asks the whole site for the newest exe_missing logs, not the lowest document ids', () => {
    mountHook(null);

    expect(subscribedConstraints()).toEqual([
      [{ where: ['action', '==', 'exe_missing'] }, NEWEST_FIRST, { limit: 20 }],
    ]);
    expect(mockOnSnapshot.mock.calls[0][0].ref).toEqual({ path: 'sites/site-A/logs' });
  });

  it('reads an omitted scope as the whole site', () => {
    mountHook(undefined);

    expect(subscribedConstraints()).toEqual([
      [{ where: ['action', '==', 'exe_missing'] }, NEWEST_FIRST, { limit: 20 }],
    ]);
  });

  it('filters a scoped query to the machines in scope, newest first', () => {
    mountHook(['m2', 'm1']);

    expect(subscribedConstraints()).toEqual([
      [
        { where: ['action', '==', 'exe_missing'] },
        { where: ['machineId', 'in', ['m1', 'm2']] },
        NEWEST_FIRST,
        { limit: 20 },
      ],
    ]);
  });

  it('subscribes to nothing for an empty scope', () => {
    mountHook([]);

    expect(mockOnSnapshot).not.toHaveBeenCalled();
  });

  it('keeps its listener when a new array holds the same ids', () => {
    const { rerender } = mountHook(['m1', 'm2']);
    rerender({ machineIds: ['m2', 'm1'] });

    expect(mockOnSnapshot).toHaveBeenCalledTimes(1);
  });

  it('caps the in filter at 30 ids', () => {
    const ids = Array.from({ length: 31 }, (_, i) => `m${String(i).padStart(2, '0')}`);
    mountHook(ids);

    const inFilter = subscribedConstraints()[0][1] as { where: [string, string, string[]] };
    expect(inFilter.where[2]).toEqual(ids.slice(0, 30));
  });
});
