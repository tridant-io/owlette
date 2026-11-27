/** @jest-environment node */

/**
 * The alert digest's pure rules: when a period is due in a person's zone, the key
 * it goes out under, who may still receive each queued row, how a claim is
 * decided, what a Resend answer means, and how repeats collapse into one line.
 */

import { Timestamp } from 'firebase-admin/firestore';

// the rules here touch no firestore; keep the admin sdk from booting
jest.mock('@/lib/firebase-admin', () => ({ getAdminDb: jest.fn() }));
import { parseAlertDelivery } from '@/lib/alerts/delivery';
import {
  DIGEST_CAPS,
  MAX_CLAIM_ATTEMPTS,
  classifySendError,
  decideClaim,
  digestDue,
  digestIdempotencyKey,
  digestTimezone,
  displayDigestEvent,
  nextDigestAt,
  partitionRows,
  summarizeDigest,
  type DigestClaim,
  type DigestMachineState,
  type DigestRow,
} from '@/lib/alerts/digest.server';
import { buildAlertDigestEmail, unsubscribeHeaders } from '@/lib/emailTemplates.server';
import type { SiteAlertAudience, SiteRecipient } from '@/lib/adminUtils.server';

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

describe('parseAlertDelivery', () => {
  it('reads a stored mode and falls back to daily for anything else', () => {
    expect(parseAlertDelivery('immediate')).toBe('immediate');
    expect(parseAlertDelivery('weekly')).toBe('weekly');
    expect(parseAlertDelivery(undefined)).toBe('daily');
    expect(parseAlertDelivery('monthly')).toBe('daily');
    expect(parseAlertDelivery(7)).toBe('daily');
  });
});

describe('digestTimezone', () => {
  it('keeps a real zone and falls back to UTC for a missing or invalid one', () => {
    expect(digestTimezone('Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(digestTimezone('Eastern Standard Time')).toBe('UTC');
    expect(digestTimezone('')).toBe('UTC');
    expect(digestTimezone(undefined)).toBe('UTC');
    expect(digestTimezone(42)).toBe('UTC');
  });
});

describe('nextDigestAt', () => {
  it.each([
    ['UTC daily, later that day', 'daily', 'UTC', '2026-11-26T10:00:00Z', '2026-11-27T08:00:00.000Z'],
    ['UTC daily, strictly after the boundary itself', 'daily', 'UTC', '2026-11-27T08:00:00Z', '2026-11-28T08:00:00.000Z'],
    ['new york daily, before 8 local', 'daily', 'America/New_York', '2026-11-26T12:00:00Z', '2026-11-26T13:00:00.000Z'],
    ['new york, the night DST starts', 'daily', 'America/New_York', '2026-03-07T14:00:00Z', '2026-03-08T12:00:00.000Z'],
    ['new york, the night DST ends', 'daily', 'America/New_York', '2026-10-31T13:00:00Z', '2026-11-01T13:00:00.000Z'],
    ['kolkata (+5:30), past 8 local', 'daily', 'Asia/Kolkata', '2026-11-26T03:00:00Z', '2026-11-27T02:30:00.000Z'],
    ['kathmandu (+5:45), before 8 local', 'daily', 'Asia/Kathmandu', '2026-11-26T00:00:00Z', '2026-11-26T02:15:00.000Z'],
    ['weekly from a friday', 'weekly', 'UTC', '2026-11-27T10:00:00Z', '2026-11-30T08:00:00.000Z'],
    ['weekly from the monday boundary', 'weekly', 'UTC', '2026-11-30T08:00:00Z', '2026-12-07T08:00:00.000Z'],
    ['weekly, monday before 8 in new york', 'weekly', 'America/New_York', '2026-11-30T12:00:00Z', '2026-11-30T13:00:00.000Z'],
    ['hourly, mid-hour', 'hourly', 'UTC', '2026-11-26T10:07:00Z', '2026-11-26T11:00:00.000Z'],
    ['hourly, on the hour itself', 'hourly', 'UTC', '2026-11-26T11:00:00Z', '2026-11-26T12:00:00.000Z'],
    // the whole UTC hour, which is :30 local in a +5:30 zone (the design's choice)
    ['hourly in kolkata is the UTC hour', 'hourly', 'Asia/Kolkata', '2026-11-26T10:07:00Z', '2026-11-26T11:00:00.000Z'],
  ] as const)('%s', (_name, mode, tz, after, expected) => {
    expect(iso(nextDigestAt(mode, tz, at(after)))).toBe(expected);
  });

  it('runs an invalid zone as UTC', () => {
    expect(nextDigestAt('daily', digestTimezone('Eastern Standard Time'), at('2026-11-26T10:00:00Z'))).toBe(
      at('2026-11-27T08:00:00Z'),
    );
  });
});

describe('digestDue', () => {
  const oldest = at('2026-11-26T10:00:00Z');

  it('is deterministic, so overlapping runs agree on the key', () => {
    expect(digestDue('daily', 'UTC', oldest, 0)).toEqual(digestDue('daily', 'UTC', oldest, 0));
    expect(digestDue('daily', 'UTC', oldest, 0)).toEqual({
      periodKey: 'daily:2026-11-27T08:00:00.000Z',
      dueAt: at('2026-11-27T08:00:00Z'),
    });
  });

  it('anchors on the last closed period, so a held row never pins a period already sent', () => {
    const closed = at('2026-11-27T08:00:05Z');
    const due = digestDue('daily', 'UTC', oldest, closed);
    expect(due.periodKey).toBe('daily:2026-11-28T08:00:00.000Z');
  });

  it('flushes at once for someone who switched to each alert as it happens', () => {
    expect(digestDue('immediate', 'UTC', oldest, 0)).toEqual({ periodKey: `flush:${oldest}`, dueAt: oldest });
  });

  it('follows a cadence change at once', () => {
    expect(digestDue('weekly', 'UTC', oldest, 0).periodKey).toBe('weekly:2026-11-30T08:00:00.000Z');
    expect(digestDue('hourly', 'UTC', oldest, 0).periodKey).toBe('hourly:2026-11-26T11:00:00.000Z');
  });

  it('strictly advances the key from one period to the next', () => {
    const first = digestDue('daily', 'UTC', oldest, 0);
    // the period closes at or after its due time, and a row lands just before that
    const second = digestDue('daily', 'UTC', first.dueAt - 1000, first.dueAt + 2000);
    expect(second.dueAt).toBeGreaterThan(first.dueAt);
    expect(second.periodKey).not.toBe(first.periodKey);
  });
});

describe('digestIdempotencyKey', () => {
  it('is the uid and period, inside Resend’s 256 characters for the longest uid', () => {
    expect(digestIdempotencyKey('u1', 'daily:2026-11-27T08:00:00.000Z')).toBe('alert-digest/u1/daily:2026-11-27T08:00:00.000Z');
    expect(digestIdempotencyKey('x'.repeat(128), 'weekly:2026-11-30T08:00:00.000Z').length).toBeLessThanOrEqual(256);
  });
});

describe('decideClaim', () => {
  const now = at('2026-11-27T08:00:30Z');
  const claim = (over: Partial<DigestClaim>): DigestClaim => ({
    claimId: 'c1',
    periodKey: 'daily:2026-11-27T08:00:00.000Z',
    mode: 'daily',
    dueAt: at('2026-11-27T08:00:00Z'),
    cutoff: Timestamp.fromMillis(now - 1000),
    leaseUntil: 0,
    attempts: 1,
    ...over,
  });

  it('blocks on any live lease, whatever its key', () => {
    expect(decideClaim(claim({ leaseUntil: now + 60_000, periodKey: 'flush:1' }), now - 1, now)).toBe('busy');
  });

  it('resumes a dead claim before any new period, and gives up after three deaths', () => {
    expect(decideClaim(claim({ attempts: MAX_CLAIM_ATTEMPTS - 1 }), now + 86_400_000, now)).toBe('resume');
    expect(decideClaim(claim({ attempts: MAX_CLAIM_ATTEMPTS }), now - 1, now)).toBe('give_up');
  });

  it('claims a due period and waits on one that is not', () => {
    expect(decideClaim(null, now - 1, now)).toBe('claim');
    expect(decideClaim(null, now, now)).toBe('claim');
    expect(decideClaim(null, now + 1, now)).toBe('wait');
    expect(decideClaim(null, null, now)).toBe('wait');
  });
});

describe('classifySendError', () => {
  it.each([
    ['success', null, 'sent'],
    ['a reused key with a body already sent (409)', { name: 'invalid_idempotent_request', statusCode: 409 }, 'sent'],
    ['the same key in flight (409)', { name: 'concurrent_idempotent_requests', statusCode: 409 }, 'concurrent'],
    ['the rate limit (429)', { name: 'rate_limit_exceeded', statusCode: 429 }, 'stop'],
    ['the daily quota', { name: 'daily_quota_exceeded', statusCode: 429 }, 'stop'],
    ['a bare 429', { statusCode: 429 }, 'stop'],
    ['a broken api key', { name: 'invalid_api_key', statusCode: 403 }, 'stop'],
    ['an unverified sending domain', { name: 'invalid_from_address', statusCode: 403 }, 'stop'],
    ['a validation error that is about the account (403)', { name: 'validation_error', statusCode: 403 }, 'stop'],
    ['any 401', { name: 'validation_error', statusCode: 401 }, 'stop'],
    ['our own key format', { name: 'invalid_idempotency_key', statusCode: 400 }, 'stop'],
    ['a bad address', { name: 'validation_error', statusCode: 422 }, 'rejected'],
    ['a missing field', { name: 'missing_required_field', statusCode: 422 }, 'rejected'],
    ['a server error', { name: 'application_error', statusCode: 500 }, 'transient'],
    ['no response at all', { name: 'application_error', statusCode: null }, 'transient'],
    ['an unknown 4xx', { name: 'not_found', statusCode: 404 }, 'transient'],
  ] as const)('%s', (_name, error, verdict) => {
    expect(classifySendError(error)).toBe(verdict);
  });
});

function row(id: string, over: Partial<DigestRow> = {}): DigestRow {
  return {
    id,
    siteId: 'site-a',
    machineId: 'kiosk-1',
    category: 'healthAlerts',
    kind: 'offline',
    severity: 'critical',
    title: 'offline',
    detail: '',
    data: {},
    at: at('2026-11-26T10:00:00Z'),
    ...over,
  };
}

function recipient(over: Partial<SiteRecipient> = {}): SiteRecipient {
  return { userId: 'u1', email: 'u1@example.test', ccEmails: [], mutedMachines: [], machineIds: null, delivery: 'daily', ...over };
}

describe('partitionRows (the send-time recipient check)', () => {
  const audience = (recipients: SiteRecipient[], complete = true): Map<string, SiteAlertAudience> =>
    new Map([['site-a|healthAlerts', { recipients, complete }]]);

  it('keeps a row its person may still receive', () => {
    expect(partitionRows([row('r1')], 'u1', audience([recipient()]))).toEqual({ keep: [row('r1')], drop: [], held: [] });
  });

  it.each([
    ['removed from the site, opted out, or the site paused (not on the list)', [recipient({ userId: 'u2' })]],
    ['muted the machine', [recipient({ mutedMachines: ['kiosk-1'] })]],
    ['narrowed to other machines', [recipient({ machineIds: ['kiosk-2'] })]],
    ['only the ADMIN_EMAIL fallback left', [recipient({ userId: 'fallback', delivery: 'immediate' })]],
    ['the site paused by its plan', []],
  ])('drops it once they have %s', (_name, recipients) => {
    expect(partitionRows([row('r1')], 'u1', audience(recipients as SiteRecipient[]))).toEqual({ keep: [], drop: ['r1'], held: [] });
  });

  it('holds a whole group when its recipients could not be read', () => {
    const rows = [row('r1'), row('r2'), row('p1', { category: 'processAlerts' })];
    const audiences = new Map<string, SiteAlertAudience>([
      ['site-a|healthAlerts', { recipients: [recipient({ userId: 'fallback' })], complete: false }],
      ['site-a|processAlerts', { recipients: [recipient()], complete: true }],
    ]);
    expect(partitionRows(rows, 'u1', audiences)).toEqual({ keep: [rows[2]], drop: [], held: ['site-a|healthAlerts'] });
  });

  it('checks no machine for a row without one', () => {
    const r = row('r1', { machineId: null });
    expect(partitionRows([r], 'u1', audience([recipient({ machineIds: ['kiosk-2'] })])).keep).toEqual([r]);
  });
});

describe('summarizeDigest (repeats collapse into one line)', () => {
  const now = at('2026-11-27T08:00:00Z');
  const online: DigestMachineState = { online: true, asleep: false, lastHeartbeatMs: now - 30_000, asleepSinceMs: 0 };
  const summarize = (rows: DigestRow[], states = new Map<string, DigestMachineState | null>()) =>
    summarizeDigest({ rows, states, siteLabels: new Map([['site-a', 'lobby (site-a)']]), timezone: 'UTC', now });
  const lines = (s: ReturnType<typeof summarize>) => s.sites.flatMap((site) => site.machines.flatMap((m) => m.lines.map((l) => l.text)));

  it('collapses an outage’s episodes into one line, and says one outage since when', () => {
    const three = [1, 2, 3].map((h) => row(`o${h}`, { at: at(`2026-11-26T1${h}:00:00Z`) }));
    expect(lines(summarize(three))).toEqual(['offline 3× · last thu, nov 26, 1:00 pm']);
    expect(lines(summarize([three[0]]))).toEqual(['offline since thu, nov 26, 11:00 am']);
  });

  it('collapses a crashing process into one line with its count and last error', () => {
    const crashes = Array.from({ length: 14 }, (_, i) =>
      row(`p${i}`, {
        category: 'processAlerts',
        kind: 'process_crash',
        title: 'touchdesigner',
        detail: i === 13 ? 'exit code 3' : 'exit code 1',
        at: at('2026-11-26T10:00:00Z') + i * 60_000,
      }),
    );
    expect(lines(summarize(crashes))).toEqual(['touchdesigner crashed 14× · last thu, nov 26, 10:13 am · last error: exit code 3']);
  });

  it('collapses a flapping threshold rule into one line with its peak and latest value', () => {
    const breaches = [91, 93, 90].map((value, i) =>
      row(`t${i}`, {
        category: 'thresholdAlerts',
        kind: 'threshold',
        severity: 'warning',
        title: 'low disk',
        data: { metric: 'disk_percent', operator: '>', threshold: 85, value },
        at: at('2026-11-26T10:00:00Z') + i * 60_000,
      }),
    );
    expect(lines(summarize(breaches))).toEqual(['low disk: Disk Usage (%) > 85 · 3× · peak 93 · latest 90']);

    const below = breaches.map((r) => ({ ...r, data: { ...r.data, operator: '<', threshold: 95 } }));
    expect(lines(summarize(below))[0]).toContain('peak 90');
  });

  it('pairs sleeps and wakes into one line with the time asleep', () => {
    const sleeps = [
      row('a1', { kind: 'asleep', severity: 'info', data: { asleepSince: 1 } }),
      row('w1', { kind: 'awake', severity: 'info', data: { asleepSince: 1, sleptMs: 60 * 60_000 } }),
      row('a2', { kind: 'asleep', severity: 'info', data: { asleepSince: 2 } }),
      row('w2', { kind: 'awake', severity: 'info', data: { asleepSince: 2, sleptMs: 40 * 60 * 60_000 } }),
    ];
    expect(lines(summarize(sleeps))).toEqual(['slept 2× · 41 h in total']);
  });

  it('puts the most severe site and machine first, and lists what is offline or asleep now', () => {
    const rows = [
      row('i1', { siteId: 'site-b', machineId: 'mac-1', kind: 'asleep', severity: 'info', data: { asleepSince: now - 3_600_000 } }),
      row('c1', { machineId: 'kiosk-1' }),
      row('w1', { machineId: 'kiosk-2', kind: 'threshold', severity: 'warning', title: 'cpu', data: { metric: 'cpu_percent', operator: '>', threshold: 80, value: 90 } }),
    ];
    const states = new Map<string, DigestMachineState | null>([
      ['site-a/kiosk-1', { online: true, asleep: false, lastHeartbeatMs: now - 20 * 60_000, asleepSinceMs: 0 }],
      ['site-a/kiosk-2', online],
      ['site-b/mac-1', { online: true, asleep: true, lastHeartbeatMs: now, asleepSinceMs: now - 3_600_000 }],
    ]);
    const s = summarize(rows, states);
    expect(s.sites.map((site) => site.siteLabel)).toEqual(['lobby (site-a)', 'site-b']);
    expect(s.sites[0].machines.map((m) => [m.machineId, m.stateNow])).toEqual([
      ['kiosk-1', 'offline since fri, nov 27, 7:40 am'],
      ['kiosk-2', 'online now'],
    ]);
    expect(s.offlineNow.map((m) => [m.machineId, m.state])).toEqual([
      ['kiosk-1', 'offline'],
      ['mac-1', 'asleep'],
    ]);
    expect([s.eventCount, s.siteCount]).toEqual([3, 2]);
  });

  it('reads a machine with no doc as removed, and never offline now', () => {
    const s = summarize([row('r1')], new Map([['site-a/kiosk-1', null]]));
    expect(s.sites[0].machines[0].stateNow).toBe('removed');
    expect(s.offlineNow).toEqual([]);
  });

  it('caps a site at 25 machines', () => {
    const rows = Array.from({ length: 27 }, (_, i) => row(`m${i}`, { machineId: `kiosk-${i}` }));
    const s = summarize(rows);
    expect(s.sites[0].machines).toHaveLength(25);
    expect(s.sites[0].moreMachines).toBe(2);
  });

  it('caps what is offline now at 25, and says how many more', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(`m${i}`, { machineId: `kiosk-${i}` }));
    const down: DigestMachineState = { online: false, asleep: false, lastHeartbeatMs: now - 3_600_000, asleepSinceMs: 0 };
    const states = new Map(rows.map((r) => [`site-a/${r.machineId}`, down] as const));
    const s = summarize(rows, states);
    expect(s.offlineNow).toHaveLength(25);
    expect(s.moreOffline).toBe(5);
  });

  it('caps the lines of one machine, and takes tighter caps when asked', () => {
    const crashes = Array.from({ length: 30 }, (_, i) =>
      row(`p${i}`, { category: 'processAlerts', kind: 'process_crash', title: `process-${i}` }),
    );
    const s = summarize(crashes);
    expect(s.sites[0].machines[0].lines).toHaveLength(20);
    expect(s.sites[0].machines[0].moreLines).toBe(10);

    const tight = summarizeDigest({
      rows: crashes,
      states: new Map(),
      siteLabels: new Map(),
      timezone: 'UTC',
      now,
      caps: DIGEST_CAPS[DIGEST_CAPS.length - 1],
    });
    expect(tight.sites[0].machines[0].lines.length).toBeLessThan(20);
  });
});

describe('buildAlertDigestEmail', () => {
  const now = at('2026-11-27T08:00:00Z');
  const summary = summarizeDigest({
    rows: [row('o1'), row('o2', { machineId: '<b>kiosk</b>' }), row('o3', { machineId: 'kiosk-3' })],
    states: new Map([
      ['site-a/kiosk-1', { online: false, asleep: false, lastHeartbeatMs: now - 3_600_000, asleepSinceMs: 0 }],
      ['site-a/kiosk-3', { online: true, asleep: false, lastHeartbeatMs: now, asleepSinceMs: 0 }],
    ]),
    siteLabels: new Map(),
    timezone: 'America/New_York',
    now,
  });
  const build = (over: Partial<Parameters<typeof buildAlertDigestEmail>[0]> = {}) =>
    buildAlertDigestEmail({
      mode: 'daily',
      timezone: 'America/New_York',
      summary,
      introduce: false,
      baseUrl: 'https://owlette.test',
      unsubscribeUrl: 'https://owlette.test/api/unsubscribe?token=t',
      ...over,
    });

  it('leads the subject with what is offline now', () => {
    expect(build().subject).toBe('owlette daily digest · 1 machine offline now · 3 events in 1 site');
    expect(build({ mode: 'immediate' }).subject).toMatch(/^owlette alert digest · /);
  });

  it('names the zone and links manage alerts, the dashboard and the unsubscribe page', () => {
    const { html } = build();
    // a zone id and UTC keep their case: identifiers and acronyms are not lowercased
    expect(html).toContain('one digest a day at 8:00 am America/New_York.');
    expect(html).not.toContain('america/new_york');
    expect(build({ mode: 'hourly', timezone: 'UTC' }).html).toContain('on the hour (UTC)');
    expect(html).toContain('https://owlette.test/settings/alerts');
    expect(html).toContain('https://owlette.test/dashboard');
    expect(html).toContain('https://owlette.test/api/unsubscribe?token=t');
    expect(html).toContain('offline now (1)');
  });

  it('escapes what it is given', () => {
    expect(build().html).not.toContain('<b>kiosk</b>');
    expect(build().html).toContain('&lt;b&gt;kiosk&lt;/b&gt;');
  });

  it('says how many more machines are offline than it lists', () => {
    const { html } = build({ summary: { ...summary, moreOffline: 7 } });
    expect(html).toContain('and 7 more machines');
  });

  it('introduces the digest once, and never on a flush', () => {
    expect(build({ introduce: true }).html).toContain('new: your alerts now arrive as one daily digest.');
    expect(build().html).not.toContain('new: your alerts');
    expect(build({ mode: 'immediate', introduce: true }).html).not.toContain('new: your alerts');
  });
});

describe('unsubscribeHeaders', () => {
  it('sets RFC 8058 one-click headers for a per-user link, and none without one', () => {
    expect(unsubscribeHeaders('https://owlette.test/api/unsubscribe?token=t')).toEqual({
      headers: {
        'List-Unsubscribe': '<https://owlette.test/api/unsubscribe?token=t>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
    expect(unsubscribeHeaders(undefined)).toEqual({});
  });

  it('sets none on a copy with cc, so a colleague’s mail-client button cannot turn off the recipient’s alerts', () => {
    expect(unsubscribeHeaders('https://owlette.test/api/unsubscribe?token=t', ['ops@example.test'])).toEqual({});
    expect(unsubscribeHeaders('https://owlette.test/api/unsubscribe?token=t', [])).toHaveProperty('headers');
  });
});

describe('displayDigestEvent', () => {
  it('carries the label, severity and monitor of a display event', () => {
    const event = displayDigestEvent(
      {
        docId: 'd1',
        siteId: 'site-a',
        machineId: 'wall-1',
        eventType: 'display_monitor_removed',
        data: { monitor: { friendlyName: 'DELL P2415Q', port: 'DP-1' } },
        agentVersion: '4.2.0',
        correlatedApplyId: '',
        timestamp: new Date(at('2026-11-26T10:00:00Z')),
      },
      'display|d1',
    );
    expect(event).toMatchObject({
      sourceKey: 'display|d1',
      category: 'displayAlerts',
      kind: 'display_monitor_removed',
      severity: 'critical',
      title: 'monitor removed',
      detail: 'DELL P2415Q (DP-1)',
      at: at('2026-11-26T10:00:00Z'),
    });
  });
});
