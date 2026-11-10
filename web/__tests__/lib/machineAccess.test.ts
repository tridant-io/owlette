/**
 * machineAccess, the one reading of a member row's machine scope. what these pin
 * beyond the shapes: only a row with no `machineIds` key is the whole site, and
 * every malformed value reads as no machines, so a bad row fails closed in the
 * server, the dashboard and the read-path script alike. the api side never
 * accepts a list it would then read as nothing.
 */

import {
  MAX_MACHINE_SCOPE,
  narrowsMachineScope,
  normalizeMachineIdsInput,
  parseMachineIds,
  scopeCovers,
} from '@/lib/machineAccess';

// zero-padded, so generation order is already sorted order
const ids = (n: number) => Array.from({ length: n }, (_, i) => `m${String(i).padStart(2, '0')}`);
const COUNT_ERROR = 'machineIds must list between 1 and 30 machine ids';
const COUNT_ERROR_WITH_NULL = `${COUNT_ERROR}; send null for the whole site`;

describe('parseMachineIds', () => {
  it('reads a row with no machineIds key as the whole site', () => {
    expect(parseMachineIds({ role: 'member', status: 'active' })).toBeNull();
  });

  it('reads no data as the whole site, leaving the row check to the caller', () => {
    expect(parseMachineIds(null)).toBeNull();
    expect(parseMachineIds(undefined)).toBeNull();
  });

  it.each<[unknown]>([[[]], [null], ['m1'], [{}]])('reads machineIds %p as no machines', (value) => {
    expect(parseMachineIds({ role: 'member', machineIds: value })).toEqual([]);
  });

  it('keeps the string entries, de-duplicated and sorted', () => {
    expect(parseMachineIds({ machineIds: ['m2', 'm1', 'm1', 3] })).toEqual(['m1', 'm2']);
  });
});

describe('scopeCovers', () => {
  it('covers any machine for the whole site', () => {
    expect(scopeCovers(null, 'x')).toBe(true);
  });

  it('covers a machine in the scope', () => {
    expect(scopeCovers(['a'], 'a')).toBe(true);
  });

  // '__proto__' is there because a lookup through an object's keys would find it
  it.each<[readonly string[], string]>([
    [['a'], 'b'],
    [[], 'a'],
    [['a'], '__proto__'],
  ])('does not let scope %p cover %p', (scope, machineId) => {
    expect(scopeCovers(scope, machineId)).toBe(false);
  });
});

describe('narrowsMachineScope', () => {
  it('narrows from the whole site to any list, an empty one included', () => {
    expect(narrowsMachineScope(null, ['m1'])).toBe(true);
    expect(narrowsMachineScope(null, [])).toBe(true);
  });

  it('narrows when the new list drops a machine, whatever it adds', () => {
    expect(narrowsMachineScope(['m1', 'm2'], ['m1'])).toBe(true);
    expect(narrowsMachineScope(['m1'], ['m2'])).toBe(true);
  });

  it('does not narrow when the new list keeps every machine, in any order', () => {
    expect(narrowsMachineScope(['m1'], ['m1', 'm2'])).toBe(false);
    expect(narrowsMachineScope(['m2', 'm1'], ['m1', 'm2'])).toBe(false);
    expect(narrowsMachineScope([], ['m1'])).toBe(false);
  });
});

describe('normalizeMachineIdsInput', () => {
  it('returns a valid list de-duplicated and sorted', () => {
    expect(normalizeMachineIdsInput(['m2', 'm1', 'm2'], { allowNull: false })).toEqual({
      ok: true,
      value: ['m1', 'm2'],
    });
  });

  it('accepts exactly MAX_MACHINE_SCOPE ids', () => {
    expect(normalizeMachineIdsInput(ids(MAX_MACHINE_SCOPE), { allowNull: false })).toEqual({
      ok: true,
      value: ids(MAX_MACHINE_SCOPE),
    });
  });

  it.each<[string, unknown]>([
    ['31 ids', ids(MAX_MACHINE_SCOPE + 1)],
    ['an empty list', []],
    ['a string', 'm1'],
  ])('refuses %s, naming null only where null is allowed', (_label, raw) => {
    expect(normalizeMachineIdsInput(raw, { allowNull: false })).toEqual({
      ok: false,
      error: COUNT_ERROR,
    });
    expect(normalizeMachineIdsInput(raw, { allowNull: true })).toEqual({
      ok: false,
      error: COUNT_ERROR_WITH_NULL,
    });
  });

  it.each(['a/b', 'a.b'])('refuses the machine id %p', (bad) => {
    expect(normalizeMachineIdsInput(['m1', bad], { allowNull: true })).toEqual({
      ok: false,
      error: `machine id "${bad}" is not a valid machine id`,
    });
  });

  it('refuses an entry that is not a string', () => {
    expect(normalizeMachineIdsInput([3], { allowNull: false })).toMatchObject({ ok: false });
  });

  it('refuses null without allowNull, and reads it as the whole site with it', () => {
    expect(normalizeMachineIdsInput(null, { allowNull: false })).toEqual({
      ok: false,
      error: COUNT_ERROR,
    });
    expect(normalizeMachineIdsInput(null, { allowNull: true })).toEqual({ ok: true, value: null });
  });
});
