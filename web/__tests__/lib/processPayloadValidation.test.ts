/** @jest-environment node */

import {
  validateCreateProcessFields,
  validateScheduleBlocks,
  validateUpdateProcessFields,
} from '@/lib/processPayloadValidation';

// the agent hands both fields to float() at every launch. versions in the field
// raise on anything it refuses, which ends their main loop, so none is stored.
describe.each([
  ['time_delay', '0'],
  ['time_to_init', '10'],
] as const)('%s', (field, fallback) => {
  const created = (typed: string) =>
    validateCreateProcessFields({ name: 'app', exe_path: 'C:\\app.exe', [field]: typed });

  it.each(['', '   '])('stores the default for a cleared field (%p)', (typed) => {
    expect(validateUpdateProcessFields({ [field]: typed })).toEqual({
      ok: true,
      value: { [field]: fallback },
    });
    const create = created(typed);
    expect(create.ok && create.value[field]).toBe(fallback);
  });

  it.each([
    ['0', '0'],
    ['2.5', '2.5'],
    [' 30 ', '30'],
    ['.5', '.5'],
  ])('keeps %p as %p', (typed, stored) => {
    expect(validateUpdateProcessFields({ [field]: typed })).toEqual({
      ok: true,
      value: { [field]: stored },
    });
    const create = created(typed);
    expect(create.ok && create.value[field]).toBe(stored);
  });

  it.each(['soon', '-5', '5s', 'NaN', 'Infinity', '1,5'])('refuses %p', (typed) => {
    for (const result of [validateUpdateProcessFields({ [field]: typed }), created(typed)]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invalid_field');
        expect(result.error.detail).toContain(field);
      }
    }
  });
});

function block(start: string, stop: string) {
  return [{ days: ['mon'], ranges: [{ start, stop }] }];
}

describe('validateScheduleBlocks', () => {
  it.each([
    ['00:00', '23:59'],
    ['09:00', '17:00'],
    ['22:00', '01:00'],
  ])('accepts %s to %s', (start, stop) => {
    expect(validateScheduleBlocks(block(start, stop))).toEqual({
      ok: true,
      value: [{ days: ['mon'], ranges: [{ start, stop }] }],
    });
  });

  // a time already stored unpadded must not start blocking saves of its process:
  // the edit form sends the schedules it loaded straight back.
  it('stores an unpadded time padded', () => {
    expect(validateScheduleBlocks(block('9:00', '17:5'))).toEqual({
      ok: true,
      value: [{ days: ['mon'], ranges: [{ start: '09:00', stop: '17:05' }] }],
    });
  });

  // the agent builds a clock time from each end of a range every tick. an hour or
  // minute no clock has raises there, and that ends the agent's main loop.
  it.each([
    ['24:00', '17:00'],
    ['09:00', '24:00'],
    ['09:60', '17:00'],
    ['-1:00', '17:00'],
    ['09:00:00', '17:00'],
    ['nine', '17:00'],
  ])('refuses %s to %s', (start, stop) => {
    const result = validateScheduleBlocks(block(start, stop));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_field');
      expect(result.error.detail).toContain('schedules[0].ranges[0]');
    }
  });

  // the agent matches a day by its lowercase three-letter name; anything else was
  // stored and silently never ran.
  it('stores a day written another way as its three-letter name', () => {
    const days = ['mon', 'Tue', 'WEDNESDAY', ' thursday ', 'sun'];
    expect(validateScheduleBlocks([{ days, ranges: [{ start: '09:00', stop: '17:00' }] }])).toEqual({
      ok: true,
      value: [{ days: ['mon', 'tue', 'wed', 'thu', 'sun'], ranges: [{ start: '09:00', stop: '17:00' }] }],
    });
  });

  it.each([['funday'], ['mo'], ['tues'], ['']])('refuses the day %p', (day) => {
    const result = validateScheduleBlocks([{ days: ['mon', day], ranges: [{ start: '09:00', stop: '17:00' }] }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_field');
      expect(result.error.detail).toContain('schedules[0].days');
    }
  });
});
