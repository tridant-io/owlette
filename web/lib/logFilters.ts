/**
 * Pure helpers for the logs page's action filter.
 *
 * Firestore's `in` operator takes at most 30 values and the action catalogue is
 * larger than that, so a wide selection cannot always be pushed to the server.
 * The decision lives in one pure function because three callers must agree on
 * it — the live query, the in-memory fallback that filters what the query could
 * not, and the clear-logs payload. The last one DELETES, so a disagreement there
 * is not a cosmetic bug.
 */

/** Firestore's disjunction cap for `in` / `array-contains-any`. */
export const FIRESTORE_IN_LIMIT = 30;

export interface ActionFilterPlan {
  /** Values for `where('action', 'in', …)`, or null for no server-side filter. */
  inValues: string[] | null;
  /** True when the caller must narrow rows in memory instead. */
  clientSide: boolean;
}

/**
 * How to apply a set of selected action types.
 *
 * An empty selection means "every action" — a filter nobody has touched should
 * not have to enumerate the catalogue to mean "don't narrow anything" — and so
 * does a selection that covers the whole catalogue, which is the same query with
 * 47 redundant disjunctions.
 */
export function planActionFilter(selected: string[], totalOptions: number): ActionFilterPlan {
  if (selected.length === 0) return { inValues: null, clientSide: false };
  if (totalOptions > 0 && selected.length >= totalOptions) {
    return { inValues: null, clientSide: false };
  }
  if (selected.length <= FIRESTORE_IN_LIMIT) return { inValues: selected, clientSide: false };
  return { inValues: null, clientSide: true };
}

/**
 * The action set a DELETE should carry: the same one the view is showing, and
 * empty when the view is not narrowed by action at all.
 */
export function actionDeleteScope(selected: string[], totalOptions: number): string[] {
  if (selected.length === 0) return [];
  if (totalOptions > 0 && selected.length >= totalOptions) return [];
  return selected;
}
