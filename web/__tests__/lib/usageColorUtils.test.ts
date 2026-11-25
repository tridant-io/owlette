/** @jest-environment node */

/**
 * Tests for usageColorUtils.ts: each usage band edge maps to its band class.
 */

import { getUsageColorClass } from '@/lib/usageColorUtils';

describe('usage bands', () => {
  it.each([
    [0, 'calm'],
    [29.9, 'calm'],
    [30, 'steady'],
    [49.9, 'steady'],
    [50, 'working'],
    [69.9, 'working'],
    [70, 'strained'],
    [84.9, 'strained'],
    [85, 'critical'],
    [100, 'critical'],
  ])('%p%% is %s', (percent, band) => {
    expect(getUsageColorClass(percent)).toBe(`bg-band-${band}`);
  });
});
