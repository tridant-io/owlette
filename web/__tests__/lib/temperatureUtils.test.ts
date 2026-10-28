/** @jest-environment node */

/** Tests for temperatureUtils.ts: threshold edges map to the status tokens. */

import { getTemperatureColorClass } from '@/lib/temperatureUtils';

describe('getTemperatureColorClass', () => {
  it.each([
    [69.9, ''],
    [70, 'text-warning'],
    [84.9, 'text-warning'],
    [85, 'text-danger'],
  ])('%p°C → %p', (celsius, cls) => {
    expect(getTemperatureColorClass(celsius)).toBe(cls);
  });
});
