/**
 * @jest-environment jsdom
 *
 * `useSiteMachineCounts(siteIds, machineScope, open)`: the machine count beside
 * each site in the header's switcher. the header is on every page, so nothing
 * is read until the list opens. a scoped member is counted with the
 * `documentId() in` query the rules can prove, never the plain collection, an
 * empty scope is 0 with no read, and a refused count leaves its site out. on
 * /demo the counts are the demo's, and nothing is read.
 */
import { renderHook, waitFor } from '@testing-library/react';

// over jest.setup.js's `{ db: null }`: the hook reads nothing without a db
jest.mock('@/lib/firebase', () => ({ db: {} }));

type Constraint = { field: unknown; op: string; value: unknown };
type Ref = { __path: string; __constraints?: Constraint[] };

const mockCounts: Record<string, number | Error> = {};

jest.mock('firebase/firestore', () => ({
  collection: jest.fn((_db: unknown, ...path: string[]) => ({ __path: path.join('/') })),
  documentId: jest.fn(() => '__name__'),
  where: jest.fn((field: unknown, op: string, value: unknown) => ({ field, op, value })),
  query: jest.fn((col: Ref, ...constraints: Constraint[]) => ({ __path: col.__path, __constraints: constraints })),
  getCountFromServer: jest.fn(async (ref: Ref) => {
    const siteId = ref.__path.split('/')[1];
    const count = mockCounts[siteId];
    if (count instanceof Error) throw count;
    return { data: () => ({ count }) };
  }),
}));

import { createElement, type ContextType, type ReactNode } from 'react';
import { getCountFromServer } from 'firebase/firestore';
import { DemoContext } from '@/contexts/DemoContext';
import { useSiteMachineCounts } from '@/hooks/useSiteMachineCounts';

const read = getCountFromServer as unknown as jest.Mock<Promise<unknown>, [Ref]>;
const SCOPES: Record<string, readonly string[] | null> = {
  whole: null,
  scoped: ['m-2', 'm-1'],
  empty: [],
  refused: null,
};
const machineScope = (siteId: string) => SCOPES[siteId] ?? null;

beforeEach(() => {
  read.mockClear();
  Object.assign(mockCounts, { whole: 4, scoped: 2, refused: new Error('permission-denied') });
  jest.spyOn(console, 'debug').mockImplementation(() => {});
});

it('reads nothing while the list is closed, then counts each site once it opens', async () => {
  const { result, rerender } = renderHook(
    ({ open }) => useSiteMachineCounts(['whole', 'scoped', 'empty', 'refused'], machineScope, open),
    { initialProps: { open: false } },
  );
  expect(read).not.toHaveBeenCalled();
  expect(result.current).toEqual({});

  rerender({ open: true });

  await waitFor(() => expect(result.current).toEqual({ whole: 4, scoped: 2, empty: 0 }));
  // the empty scope is not read at all
  expect(read.mock.calls.map(([ref]) => ref.__path)).toEqual([
    'sites/whole/machines',
    'sites/scoped/machines',
    'sites/refused/machines',
  ]);
  expect(read.mock.calls[0][0].__constraints).toBeUndefined();
  expect(read.mock.calls[1][0].__constraints).toEqual([{ field: '__name__', op: 'in', value: ['m-2', 'm-1'] }]);
});

it('reads again on the next open, and not on a re-render with fresh but equal arguments', async () => {
  const { result, rerender } = renderHook(
    ({ open, ids }) => useSiteMachineCounts(ids, (siteId) => machineScope(siteId), open),
    { initialProps: { open: true, ids: ['whole'] } },
  );
  await waitFor(() => expect(result.current).toEqual({ whole: 4 }));
  rerender({ open: true, ids: ['whole'] });
  expect(read).toHaveBeenCalledTimes(1);

  mockCounts.whole = 5;
  rerender({ open: false, ids: ['whole'] });
  rerender({ open: true, ids: ['whole'] });

  await waitFor(() => expect(result.current).toEqual({ whole: 5 }));
  expect(read).toHaveBeenCalledTimes(2);
});

it("on /demo it hands back the demo's counts and reads nothing", async () => {
  const demo = { siteMachineCounts: { 'demo-site': 13 } } as unknown as ContextType<typeof DemoContext>;
  const { result } = renderHook(() => useSiteMachineCounts(['demo-site'], machineScope, true), {
    wrapper: ({ children }: { children: ReactNode }) => createElement(DemoContext.Provider, { value: demo }, children),
  });

  expect(result.current).toEqual({ 'demo-site': 13 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(read).not.toHaveBeenCalled();
});
