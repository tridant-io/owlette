/**
 * @jest-environment jsdom
 *
 * The exe-missing toast listener follows the caller's machine scope. The rules
 * let a scoped member read only their machines' logs, so the query must carry
 * `machineId in scope`; an unfiltered one is refused and the toasts go silent.
 */

import { renderHook } from '@testing-library/react';

jest.mock('@/lib/firebase', () => ({ db: {}, storage: null }));

jest.mock('firebase/firestore', () => ({
  collection: jest.fn((_db: unknown, ...path: string[]) => ({ path: path.join('/') })),
  query: jest.fn((ref: unknown, ...constraints: unknown[]) => ({ ref, constraints })),
  where: jest.fn((field: string, op: string, value: unknown) => ({ where: [field, op, value] })),
  limit: jest.fn((n: number) => ({ limit: n })),
  onSnapshot: jest.fn(() => jest.fn()),
}));

jest.mock('@/lib/toast', () => ({ toast: { error: jest.fn() } }));

import { onSnapshot } from 'firebase/firestore';
import { useAgentAlertToasts } from '@/hooks/useAgentAlertToasts';

const mockOnSnapshot = onSnapshot as unknown as jest.Mock;

type Scope = readonly string[] | null | undefined;

function mountHook(machineIds: Scope) {
  return renderHook((props: { machineIds: Scope }) =>
    useAgentAlertToasts('site-A', undefined, undefined, props.machineIds),
  { initialProps: { machineIds } });
}

/** The constraints of every query the hook subscribed to. */
function subscribedConstraints(): unknown[][] {
  return mockOnSnapshot.mock.calls.map(([q]) => (q as { constraints: unknown[] }).constraints);
}

describe('useAgentAlertToasts machine scope', () => {
  it('queries the whole site with no scope, as before', () => {
    mountHook(null);

    expect(subscribedConstraints()).toEqual([
      [{ where: ['action', '==', 'exe_missing'] }, { limit: 20 }],
    ]);
    expect(mockOnSnapshot.mock.calls[0][0].ref).toEqual({ path: 'sites/site-A/logs' });
  });

  it('reads an omitted scope as the whole site', () => {
    mountHook(undefined);

    expect(subscribedConstraints()).toEqual([
      [{ where: ['action', '==', 'exe_missing'] }, { limit: 20 }],
    ]);
  });

  it('filters a scoped query to the machines in scope', () => {
    mountHook(['m2', 'm1']);

    expect(subscribedConstraints()).toEqual([
      [
        { where: ['action', '==', 'exe_missing'] },
        { where: ['machineId', 'in', ['m1', 'm2']] },
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
