/**
 * @jest-environment jsdom
 *
 * `useSiteMemberships().scopeMap`: the caller's machine scope per site, read from
 * the same member rows as the role. A site absent from the map is whole site, so
 * the reading must match firestore.rules exactly: a malformed `machineIds` is no
 * machines, never the whole site.
 */
import { renderHook, act } from '@testing-library/react';

jest.mock('@/lib/firebase', () => ({ db: {} }));

type MemberDoc = { ref: { parent: { parent: { id: string } } }; data: () => Record<string, unknown> };
type Listener = (snap: { forEach: (cb: (d: MemberDoc) => void) => void }) => void;

let mockListener: Listener | null = null;

jest.mock('firebase/firestore', () => ({
  Timestamp: class {},
  collectionGroup: jest.fn((_db: unknown, id: string) => ({ __path: `group:${id}` })),
  where: jest.fn(() => ({})),
  query: jest.fn((ref: unknown) => ref),
  onSnapshot: jest.fn((_ref: unknown, next: Listener) => {
    mockListener = next;
    return () => {};
  }),
}));

import { useSiteMemberships } from '@/hooks/useFirestore';

const UID = 'u1';

function row(siteId: string, data: Record<string, unknown>): MemberDoc {
  return { ref: { parent: { parent: { id: siteId } } }, data: () => ({ uid: UID, ...data }) };
}

function deliver(rows: MemberDoc[]) {
  if (!mockListener) throw new Error('membership listener not subscribed');
  const next = mockListener;
  act(() => next({ forEach: (cb) => rows.forEach(cb) }));
}

beforeEach(() => {
  mockListener = null;
});

describe('useSiteMemberships — scopeMap', () => {
  it('holds a scoped row and leaves a whole-site row out', () => {
    const { result } = renderHook(() => useSiteMemberships(UID));

    deliver([
      row('scoped', { status: 'active', role: 'member', machineIds: ['m2', 'm1'] }),
      row('whole', { status: 'active', role: 'admin' }),
    ]);

    expect(result.current.scopeMap.get('scoped')).toEqual(['m1', 'm2']);
    expect(result.current.scopeMap.has('whole')).toBe(false);
    expect(result.current.roleMap.get('whole')).toBe('admin');
  });

  it('reads a malformed machineIds as no machines', () => {
    const { result } = renderHook(() => useSiteMemberships(UID));

    deliver([
      row('str', { status: 'active', role: 'member', machineIds: 'm1' }),
      row('map', { status: 'active', role: 'member', machineIds: { m1: true } }),
      row('nul', { status: 'active', role: 'admin', machineIds: null }),
    ]);

    expect(result.current.scopeMap.get('str')).toEqual([]);
    expect(result.current.scopeMap.get('map')).toEqual([]);
    expect(result.current.scopeMap.get('nul')).toEqual([]);
  });

  it('ignores an inactive row', () => {
    const { result } = renderHook(() => useSiteMemberships(UID));

    deliver([row('gone', { status: 'removed', role: 'member', machineIds: ['m1'] })]);

    expect(result.current.scopeMap.size).toBe(0);
    expect(result.current.roleMap.size).toBe(0);
  });

  it('keeps the same map for an identical snapshot, and a new one when a scope changes', () => {
    const { result } = renderHook(() => useSiteMemberships(UID));

    // each snapshot carries fresh arrays, as the SDK's data() does
    deliver([row('scoped', { status: 'active', role: 'member', machineIds: ['m1', 'm2'] })]);
    const first = result.current.scopeMap;
    deliver([row('scoped', { status: 'active', role: 'member', machineIds: ['m1', 'm2'] })]);

    expect(result.current.scopeMap).toBe(first);

    deliver([row('scoped', { status: 'active', role: 'member', machineIds: ['m1'] })]);
    expect(result.current.scopeMap).not.toBe(first);
    expect(result.current.scopeMap.get('scoped')).toEqual(['m1']);
  });
});

// the dashboard hides swoop from someone whose mode on a site is none, so the
// row's mode is read the way the server reads it: a bad value is none.
describe('useSiteMemberships — swoopMap', () => {
  it('holds a row that carries a mode and leaves one without out', () => {
    const { result } = renderHook(() => useSiteMemberships(UID));

    deliver([
      row('none', { status: 'active', role: 'member', swoop: 'none' }),
      row('view', { status: 'active', role: 'admin', swoop: 'view' }),
      row('default', { status: 'active', role: 'member' }),
      row('gone', { status: 'removed', role: 'member', swoop: 'control' }),
    ]);

    expect(result.current.swoopMap.get('none')).toBe('none');
    expect(result.current.swoopMap.get('view')).toBe('view');
    expect(result.current.swoopMap.has('default')).toBe(false);
    expect(result.current.swoopMap.has('gone')).toBe(false);
  });

  it('reads a bad value as none', () => {
    const { result } = renderHook(() => useSiteMemberships(UID));

    deliver([row('bad', { status: 'active', role: 'member', swoop: 'watch' })]);

    expect(result.current.swoopMap.get('bad')).toBe('none');
  });

  it('keeps the same map for an identical snapshot, and a new one when a mode changes', () => {
    const { result } = renderHook(() => useSiteMemberships(UID));

    deliver([row('s', { status: 'active', role: 'member', swoop: 'view' })]);
    const first = result.current.swoopMap;
    deliver([row('s', { status: 'active', role: 'member', swoop: 'view' })]);

    expect(result.current.swoopMap).toBe(first);

    deliver([row('s', { status: 'active', role: 'member', swoop: 'none' })]);
    expect(result.current.swoopMap).not.toBe(first);
    expect(result.current.swoopMap.get('s')).toBe('none');
  });

  it("drops the previous user's modes on a sign-out", () => {
    const { result, rerender } = renderHook(({ uid }) => useSiteMemberships(uid), {
      initialProps: { uid: UID as string | undefined },
    });
    deliver([row('s', { status: 'active', role: 'member', swoop: 'none' })]);

    rerender({ uid: undefined });

    expect(result.current.swoopMap.size).toBe(0);
  });
});
