/**
 * The default threshold rules a site has before it saves its own list.
 * `getAlertRules` (metricsHistory.ts) reads every site's rules through
 * `alertRulesOrDefault`, so these are the evaluator's view of an unsaved site.
 * The rule's numbers are pinned once, web-side, beside the mirror check.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LOW_DISK_RULE, alertRulesOrDefault } from '../src/lib/defaultAlertRules';

describe('alertRulesOrDefault', () => {
  it('gives a site that never saved rules the low disk rule', () => {
    for (const stored of [undefined, null, 'junk', { r1: {} }]) {
      assert.deepEqual(alertRulesOrDefault(stored), [DEFAULT_LOW_DISK_RULE]);
    }
  });

  it('reads a saved list as stored, so a deleted default stays deleted', () => {
    assert.deepEqual(alertRulesOrDefault([]), []);
    const saved = [{ ...DEFAULT_LOW_DISK_RULE, enabled: false }];
    assert.equal(alertRulesOrDefault(saved), saved);
  });

  it('hands out a copy, never the shared rule', () => {
    const before = structuredClone(DEFAULT_LOW_DISK_RULE);
    const [rule] = alertRulesOrDefault(undefined) as Array<typeof DEFAULT_LOW_DISK_RULE>;
    rule.channels.push('sms');
    rule.value = 1;
    assert.deepEqual(DEFAULT_LOW_DISK_RULE, before);
  });
});

describe('DEFAULT_LOW_DISK_RULE', () => {
  it('fires on a disk filling up, under a fixed id', () => {
    assert.equal(DEFAULT_LOW_DISK_RULE.id, 'default-low-disk');
    assert.equal(DEFAULT_LOW_DISK_RULE.metric, 'disk_percent');
    assert.equal(DEFAULT_LOW_DISK_RULE.operator, '>');
    assert.equal(DEFAULT_LOW_DISK_RULE.enabled, true);
  });
});
