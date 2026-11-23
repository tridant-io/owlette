/** @jest-environment node */

/**
 * The default threshold rules a site has before it saves its own list, and the
 * check that the functions mirror the metrics evaluator reads is the same rule.
 */

import { DEFAULT_LOW_DISK_RULE, alertRulesOrDefault } from '@/lib/defaultAlertRules';
import * as functionsMirror from '../../../functions/src/lib/defaultAlertRules';

describe('DEFAULT_LOW_DISK_RULE', () => {
  it('fires on a disk over 90% used, at most once a day per machine, under a fixed id', () => {
    expect(DEFAULT_LOW_DISK_RULE).toEqual({
      id: 'default-low-disk',
      name: 'Low Disk',
      metric: 'disk_percent',
      operator: '>',
      value: 90,
      severity: 'warning',
      channels: ['email', 'webhook'],
      enabled: true,
      cooldownMinutes: 1440,
    });
  });

  it('is the rule the functions evaluator applies', () => {
    expect(functionsMirror.DEFAULT_LOW_DISK_RULE).toEqual(DEFAULT_LOW_DISK_RULE);
    for (const stored of [undefined, [], [{ id: 'r1' }]]) {
      expect(functionsMirror.alertRulesOrDefault(stored)).toEqual(alertRulesOrDefault(stored));
    }
  });
});

describe('alertRulesOrDefault', () => {
  it('gives a site that never saved rules the default rule', () => {
    for (const stored of [undefined, null, 'junk', { r1: {} }]) {
      expect(alertRulesOrDefault(stored)).toEqual([DEFAULT_LOW_DISK_RULE]);
    }
  });

  it('reads a saved list as stored, so a deleted default stays deleted', () => {
    expect(alertRulesOrDefault([])).toEqual([]);
    const saved = [{ ...DEFAULT_LOW_DISK_RULE, enabled: false }];
    expect(alertRulesOrDefault(saved)).toBe(saved);
  });

  it('hands out a copy, never the shared rule', () => {
    const before = structuredClone(DEFAULT_LOW_DISK_RULE);
    const [rule] = alertRulesOrDefault(undefined) as Array<typeof DEFAULT_LOW_DISK_RULE>;
    rule.channels.push('sms');
    rule.value = 1;
    expect(DEFAULT_LOW_DISK_RULE).toEqual(before);
  });
});
