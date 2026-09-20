/**
 * `planActionFilter` / `actionDeleteScope` — how a multi-selected action filter
 * reaches Firestore.
 *
 * The logs action catalogue is larger than Firestore's 30-value `in` cap, so a
 * wide selection cannot always be pushed to the server. Three callers depend on
 * agreeing about that: the live query, the in-memory fallback that narrows what
 * the query could not, and the clear-logs payload. The third DELETES, so the
 * "empty means all" cases below are not cosmetic — a selection that silently
 * reads as "no filter" on the delete path clears the whole site.
 */

import {
  FIRESTORE_IN_LIMIT,
  actionDeleteScope,
  planActionFilter,
} from '@/lib/logFilters';

const TOTAL = 47;
const values = (n: number) => Array.from({ length: n }, (_, i) => `action_${i}`);

describe('planActionFilter', () => {
  it('does not filter when nothing is selected', () => {
    expect(planActionFilter([], TOTAL)).toEqual({ inValues: null, clientSide: false });
  });

  it('does not filter when the whole catalogue is selected', () => {
    // Same result set as no filter, minus 47 redundant disjunctions.
    expect(planActionFilter(values(TOTAL), TOTAL)).toEqual({ inValues: null, clientSide: false });
  });

  it('pushes a single selection to the server', () => {
    expect(planActionFilter(['process_crash'], TOTAL)).toEqual({
      inValues: ['process_crash'],
      clientSide: false,
    });
  });

  it('pushes a selection at the `in` limit to the server', () => {
    const selected = values(FIRESTORE_IN_LIMIT);
    expect(planActionFilter(selected, TOTAL)).toEqual({ inValues: selected, clientSide: false });
  });

  it('falls back to in-memory narrowing one past the `in` limit', () => {
    // Firestore rejects the query outright past 30, so the clause has to go.
    expect(planActionFilter(values(FIRESTORE_IN_LIMIT + 1), TOTAL)).toEqual({
      inValues: null,
      clientSide: true,
    });
  });

  it('never asks for a client-side pass when it filtered server-side', () => {
    for (const n of [0, 1, 5, FIRESTORE_IN_LIMIT, TOTAL]) {
      const plan = planActionFilter(values(n), TOTAL);
      expect(plan.inValues !== null && plan.clientSide).toBe(false);
    }
  });

  it('treats an unknown catalogue size as no "everything" shortcut', () => {
    expect(planActionFilter(['a', 'b'], 0)).toEqual({ inValues: ['a', 'b'], clientSide: false });
  });
});

describe('actionDeleteScope', () => {
  it('is empty when nothing is selected', () => {
    expect(actionDeleteScope([], TOTAL)).toEqual([]);
  });

  it('is empty when everything is selected', () => {
    expect(actionDeleteScope(values(TOTAL), TOTAL)).toEqual([]);
  });

  it('carries the exact selection otherwise', () => {
    // Narrower than the view would delete rows the user cannot see; wider (or
    // empty) would delete rows they never selected.
    expect(actionDeleteScope(['a', 'b'], TOTAL)).toEqual(['a', 'b']);
  });

  it('carries a selection past the `in` limit, which the view narrows in memory', () => {
    const selected = values(FIRESTORE_IN_LIMIT + 5);
    expect(actionDeleteScope(selected, TOTAL)).toEqual(selected);
  });
});
