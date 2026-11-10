/**
 * the one reading of a member row's machine scope, the `machineIds` field on
 * `sites/{siteId}/members/{uid}`. the server, the dashboard and the read-path
 * script must each read a row exactly as firestore.rules does, so the reading
 * lives here once: a second copy that drifted would let one layer show or allow
 * a machine that another refuses.
 *
 * - no `machineIds` key means the whole site: every row written before machine
 *   scope, and every owner.
 * - a present key means only those machines. `[]` and any value that is not a
 *   list (null, a string, a map) mean no machines: a malformed row fails closed
 *   instead of widening to the whole site.
 *
 * pure, with no firebase imports, because the browser imports it too.
 */

import { FIRESTORE_IN_LIMIT } from '@/lib/logFilters';

/** at most this many machines per scoped member: the dashboard lists them with one documentId() `in` query */
export const MAX_MACHINE_SCOPE = FIRESTORE_IN_LIMIT;

// the api's machine id rule, as requireMachineAuthAndScope checks it. hoot's
// MACHINE_ID_RE is looser: it admits dots.
const MACHINE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function uniqueSorted(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

/**
 * null for the whole site, else the machines the row reaches. it reads only the
 * scope: whether the row exists and is active is the caller's check, which is
 * why no data at all reads as the whole site here.
 */
export function parseMachineIds(
  memberData: Record<string, unknown> | null | undefined,
): readonly string[] | null {
  if (memberData == null || !Object.prototype.hasOwnProperty.call(memberData, 'machineIds')) {
    return null;
  }
  const raw = memberData.machineIds;
  if (!Array.isArray(raw)) return [];
  return uniqueSorted(raw.filter((id): id is string => typeof id === 'string'));
}

export function scopeCovers(scope: readonly string[] | null, machineId: string): boolean {
  return scope === null || scope.includes(machineId);
}

/**
 * whether limiting a row to `after` takes a machine away: from the whole site it
 * always does, else when `after` drops one `before` held. the members api ends
 * swoop sessions on it, and the change-access dialog warns on the same answer.
 */
export function narrowsMachineScope(before: readonly string[] | null, after: readonly string[]): boolean {
  return before === null || before.some((id) => !after.includes(id));
}

export type MachineIdsInput = { ok: true; value: string[] | null } | { ok: false; error: string };

/**
 * validates `machineIds` from an api body. `[]` is refused rather than stored,
 * because it would read as no machines. the whole site is null, accepted only
 * with allowNull: a PATCH clears the field with it, and a POST leaves the key out.
 */
export function normalizeMachineIdsInput(
  raw: unknown,
  opts: { allowNull: boolean },
): MachineIdsInput {
  if (raw === null && opts.allowNull) return { ok: true, value: null };
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MACHINE_SCOPE) {
    const nullClause = opts.allowNull ? '; send null for the whole site' : '';
    return {
      ok: false,
      error: `machineIds must list between 1 and ${MAX_MACHINE_SCOPE} machine ids${nullClause}`,
    };
  }
  for (const id of raw) {
    // the typeof check comes first: RegExp.test would coerce 3 to '3' and pass it
    if (typeof id !== 'string' || !MACHINE_ID_RE.test(id)) {
      return { ok: false, error: `machine id ${JSON.stringify(id)} is not a valid machine id` };
    }
  }
  return { ok: true, value: uniqueSorted(raw) };
}
