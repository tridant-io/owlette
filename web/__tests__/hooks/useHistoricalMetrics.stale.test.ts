/**
 * @jest-environment jsdom
 *
 * A read for a range the panel has moved off never lands. Switching from a
 * year (thousands of bucket reads) to an hour starts a second read; the year
 * one finishing last used to overwrite the hour chart under an "1h" selector.
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { formatHourBucketId } from '@/lib/metricsHistoryBuckets';

jest.mock('@/lib/firebase', () => ({ db: {} }));

/** reads reaching back more than two days wait for this; the hour's reads do not. */
let mockReleaseWide: () => void = () => {};
let mockWideGate: Promise<void> = Promise.resolve();

/** one hourly bucket with a sample 30 s old: cpu 10 for a wide window, 77 for a narrow one. */
function mockSnapshot(cpu: number) {
  const now = Date.now();
  const doc = {
    id: formatHourBucketId(new Date(now)),
    data: () => ({ samples: [{ t: Math.floor(now / 1000) - 30, c: cpu, m: 20, d: 30 }] }),
  };
  return { forEach: (cb: (d: unknown) => void) => [doc].forEach(cb) };
}

function mockGetDocs(q: { clauses: { op: string; value: unknown }[] }) {
  const from = q.clauses.find((c) => c.op === '>=')?.value;
  // the exact-id `in` reads carry no window: nothing in them for this test
  if (typeof from !== 'string') return Promise.resolve({ forEach: () => {} });
  const twoDaysAgo = formatHourBucketId(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000));
  return from < twoDaysAgo ? mockWideGate.then(() => mockSnapshot(10)) : Promise.resolve(mockSnapshot(77));
}

jest.mock('firebase/firestore', () => ({
  collection: jest.fn(() => ({})),
  query: jest.fn((_ref: unknown, ...clauses: unknown[]) => ({ clauses })),
  where: jest.fn((_field: unknown, op: string, value: unknown) => ({ op, value })),
  orderBy: jest.fn(() => ({ op: 'orderBy' })),
  documentId: jest.fn(() => '__name__'),
  getDocs: (q: { clauses: { op: string; value: unknown }[] }) => mockGetDocs(q),
}));

import { useHistoricalMetrics } from '@/hooks/useHistoricalMetrics';
import type { TimeRange } from '@/components/charts';

beforeEach(() => {
  mockWideGate = new Promise((resolve) => {
    mockReleaseWide = resolve;
  });
});

it('keeps the hour chart when the year read it replaced finishes last', async () => {
  const { result, rerender } = renderHook(
    ({ range }: { range: TimeRange }) => useHistoricalMetrics('site-a', 'TEC-C3A', range),
    { initialProps: { range: '1y' } },
  );

  rerender({ range: '1h' });
  await waitFor(() => expect(result.current.data?.at(-1)?.cpu).toBe(77));

  // the year read comes back now, long after the panel moved to the hour
  await act(async () => {
    mockReleaseWide();
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  });

  expect(result.current.data?.at(-1)?.cpu).toBe(77);
  expect(result.current.loading).toBe(false);
});
