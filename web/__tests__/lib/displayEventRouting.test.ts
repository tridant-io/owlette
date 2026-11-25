/** @jest-environment node */

import {
  DISPLAY_EVENT_ROUTING,
  isDisplayEventType,
} from '@/lib/alerts/displayEventRouting';

/**
 * Locks the DISPLAY_EVENT_ROUTING contract. webhookSender and /api/agent/alert
 * both read this table, so drift is a wire-format break — these tests must fail
 * loudly on an uncoordinated change.
 */

const CRITICAL_EVENTS = [
  'display_monitor_removed',
  'display_apply_failed',
  'display_auto_revert_fired',
  'display_sync_lost',
] as const;

const WARNING_EVENTS = [
  'display_drift',
  'display_monitor_swapped',
  'display_mosaic_disabled',
  'display_apply_refused_mosaic',
] as const;

const INFO_EVENTS = ['display_monitor_added', 'display_apply_succeeded'] as const;

const ALL_EVENTS = [...CRITICAL_EVENTS, ...WARNING_EVENTS, ...INFO_EVENTS];

const CRITICAL_PATH_EVENTS = ['display_monitor_removed', 'display_auto_revert_fired'] as const;

describe('DISPLAY_EVENT_ROUTING — completeness', () => {
  it('contains exactly 10 entries', () => {
    expect(Object.keys(DISPLAY_EVENT_ROUTING)).toHaveLength(10);
  });

  it('contains every expected snake_case agent event key', () => {
    // Sorted: membership is the contract, order is not.
    expect(Object.keys(DISPLAY_EVENT_ROUTING).sort()).toEqual([...ALL_EVENTS].sort());
  });

  it.each(ALL_EVENTS)('entry %s exists with all required fields', (eventType) => {
    const route = DISPLAY_EVENT_ROUTING[eventType];
    expect(route).toBeDefined();
    expect(typeof route!.email).toBe('boolean');
    expect(typeof route!.webhook).toBe('boolean');
    expect(typeof route!.webhookEventName).toBe('string');
    expect(route!.webhookEventName.length).toBeGreaterThan(0);
  });
});

describe('DISPLAY_EVENT_ROUTING — severity-to-channel mapping', () => {
  it.each(CRITICAL_EVENTS)('%s is email + webhook (critical)', (eventType) => {
    const route = DISPLAY_EVENT_ROUTING[eventType]!;
    expect(route.email).toBe(true);
    expect(route.webhook).toBe(true);
  });

  it.each(WARNING_EVENTS)('%s is webhook-only (warning)', (eventType) => {
    const route = DISPLAY_EVENT_ROUTING[eventType]!;
    expect(route.email).toBe(false);
    expect(route.webhook).toBe(true);
  });

  it.each(INFO_EVENTS)('%s is in-dashboard only (info)', (eventType) => {
    const route = DISPLAY_EVENT_ROUTING[eventType]!;
    expect(route.email).toBe(false);
    expect(route.webhook).toBe(false);
  });

  it('exactly 4 events have email enabled', () => {
    const emailEnabled = Object.entries(DISPLAY_EVENT_ROUTING).filter(([, r]) => r.email);
    expect(emailEnabled).toHaveLength(4);
    expect(emailEnabled.map(([k]) => k).sort()).toEqual([...CRITICAL_EVENTS].sort());
  });

  it('exactly 8 events have webhook enabled', () => {
    const webhookEnabled = Object.entries(DISPLAY_EVENT_ROUTING).filter(([, r]) => r.webhook);
    expect(webhookEnabled).toHaveLength(8);
    expect(webhookEnabled.map(([k]) => k).sort()).toEqual(
      [...CRITICAL_EVENTS, ...WARNING_EVENTS].sort(),
    );
  });
});

describe('DISPLAY_EVENT_ROUTING — invariants', () => {
  it('no info-tier event has email enabled (programmatic check)', () => {
    // Inspects the whole webhook=false tier rather than named keys, so a new
    // info-classed event is covered automatically.
    const infoTier = Object.entries(DISPLAY_EVENT_ROUTING).filter(
      ([, r]) => r.webhook === false,
    );
    for (const [key, route] of infoTier) {
      expect({ key, email: route.email }).toEqual({ key, email: false });
    }
  });

  it('any event with email=true also has webhook=true (email implies webhook)', () => {
    // Email is louder than webhook: never inbox without also chatting.
    for (const [key, route] of Object.entries(DISPLAY_EVENT_ROUTING)) {
      if (route.email) {
        expect({ key, webhook: route.webhook }).toEqual({ key, webhook: true });
      }
    }
  });
});

describe('DISPLAY_EVENT_ROUTING — criticalPath flag', () => {
  it('exactly two events carry criticalPath: true', () => {
    const flagged = Object.entries(DISPLAY_EVENT_ROUTING).filter(
      ([, r]) => r.criticalPath === true,
    );
    expect(flagged).toHaveLength(2);
    expect(flagged.map(([k]) => k).sort()).toEqual([...CRITICAL_PATH_EVENTS].sort());
  });

  it.each(CRITICAL_PATH_EVENTS)('%s has criticalPath: true', (eventType) => {
    expect(DISPLAY_EVENT_ROUTING[eventType]!.criticalPath).toBe(true);
  });

  it('every other event omits criticalPath or sets it falsy', () => {
    const nonCritical = ALL_EVENTS.filter(
      (k) => !CRITICAL_PATH_EVENTS.includes(k as (typeof CRITICAL_PATH_EVENTS)[number]),
    );
    for (const key of nonCritical) {
      expect(DISPLAY_EVENT_ROUTING[key]!.criticalPath ?? false).toBe(false);
    }
  });

  it('criticalPath is reserved for email+webhook events (never on info/warning)', () => {
    for (const [key, route] of Object.entries(DISPLAY_EVENT_ROUTING)) {
      if (route.criticalPath) {
        expect({ key, email: route.email, webhook: route.webhook }).toEqual({
          key,
          email: true,
          webhook: true,
        });
      }
    }
  });
});

describe('DISPLAY_EVENT_ROUTING — webhookEventName convention', () => {
  it.each(ALL_EVENTS)(
    '%s maps to display.<rest> mirroring its key suffix',
    (eventType) => {
      const route = DISPLAY_EVENT_ROUTING[eventType]!;
      const suffix = eventType.slice('display_'.length);
      expect(route.webhookEventName).toBe(`display.${suffix}`);
    },
  );

  it('every webhookEventName starts with "display."', () => {
    for (const [key, route] of Object.entries(DISPLAY_EVENT_ROUTING)) {
      expect({ key, prefix: route.webhookEventName.startsWith('display.') }).toEqual({
        key,
        prefix: true,
      });
    }
  });

  it('all 10 dotted webhookEventNames are unique', () => {
    const names = Object.values(DISPLAY_EVENT_ROUTING).map((r) => r.webhookEventName);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('isDisplayEventType', () => {
  it.each(ALL_EVENTS)('accepts known key %s', (eventType) => {
    expect(isDisplayEventType(eventType)).toBe(true);
  });

  it.each([
    'display_unknown',
    'display.monitor_removed', // dotted form is the wire name, not a routing key
    'process_crashed',
    '',
    'DISPLAY_MONITOR_REMOVED', // case-sensitive
    'display_monitor_removed ', // trailing whitespace
    'foo',
  ])('rejects unknown string %p', (input) => {
    expect(isDisplayEventType(input)).toBe(false);
  });
});

describe('DISPLAY_EVENT_ROUTING — webhook event names', () => {
  it('contains every expected dotted name explicitly', () => {
    const names = Object.values(DISPLAY_EVENT_ROUTING).map((route) => route.webhookEventName);
    expect(names.sort()).toEqual(
      [
        'display.monitor_removed',
        'display.apply_failed',
        'display.auto_revert_fired',
        'display.sync_lost',
        'display.drift',
        'display.monitor_swapped',
        'display.mosaic_disabled',
        'display.apply_refused_mosaic',
        'display.monitor_added',
        'display.apply_succeeded',
      ].sort(),
    );
  });
});
