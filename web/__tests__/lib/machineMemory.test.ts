import { resolveMemoryTotalGb } from '@/lib/machineMemory';

describe('resolveMemoryTotalGb', () => {
  it('prefers the total the agent reports', () => {
    expect(resolveMemoryTotalGb({ percent: 84.5, usedGb: 6.57, totalGb: 16 })).toBe(16);
  });

  it('recovers from used and percent only when the agent sent no total', () => {
    expect(resolveMemoryTotalGb({ percent: 50, usedGb: 8 })).toBe(16);
  });

  it('ignores a total that cannot be one', () => {
    expect(resolveMemoryTotalGb({ percent: 50, usedGb: 8, totalGb: 0 })).toBe(16);
  });

  it('says nothing when percent is zero or the metric is missing', () => {
    expect(resolveMemoryTotalGb({ percent: 0, usedGb: 8 })).toBeNull();
    expect(resolveMemoryTotalGb(undefined)).toBeNull();
  });
});
