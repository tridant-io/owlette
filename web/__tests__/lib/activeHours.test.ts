/**
 * The dashboard's half of the active-hours guard. The agent decides; these
 * helpers only have to agree with it (agent/src/active_hours.py), so the
 * confirm offers the choice exactly when the agent would refuse.
 */
import {
  activeHoursGuardOf,
  describeActiveHours,
  describeCommandError,
  hasActiveHoursGuard,
  insideActiveHoursNow,
  isInsideActiveHours,
  machineClockAt,
  machineHour,
  parseActiveHours,
  parseActiveHoursRefusal,
  powerCommandParams,
} from '@/lib/activeHours';

const WORKDAY = { start: 8, end: 17, source: 'policy' as const };
const OVERNIGHT = { start: 22, end: 6, source: 'user' as const };

describe('isInsideActiveHours', () => {
  it('takes the start hour and leaves out the end hour', () => {
    expect(isInsideActiveHours(WORKDAY, 7)).toBe(false);
    expect(isInsideActiveHours(WORKDAY, 8)).toBe(true);
    expect(isInsideActiveHours(WORKDAY, 16)).toBe(true);
    expect(isInsideActiveHours(WORKDAY, 17)).toBe(false);
  });

  it('wraps past midnight when the start is the later hour', () => {
    expect(isInsideActiveHours(OVERNIGHT, 21)).toBe(false);
    expect(isInsideActiveHours(OVERNIGHT, 22)).toBe(true);
    expect(isInsideActiveHours(OVERNIGHT, 0)).toBe(true);
    expect(isInsideActiveHours(OVERNIGHT, 5)).toBe(true);
    expect(isInsideActiveHours(OVERNIGHT, 6)).toBe(false);
  });
});

describe('machineHour', () => {
  // 2026-07-01T15:30:00Z: 11:30 in New York (EDT), 00:30 the next day in Tokyo
  const NOW = new Date(Date.UTC(2026, 6, 1, 15, 30));

  it('reads the hour on the machine clock, not the browser one', () => {
    expect(machineHour('UTC', NOW)).toBe(15);
    expect(machineHour('America/New_York', NOW)).toBe(11);
    expect(machineHour('Asia/Tokyo', NOW)).toBe(0);
  });

  it('follows daylight saving time', () => {
    // 2026-01-15T15:30:00Z is 10:30 EST
    expect(machineHour('America/New_York', new Date(Date.UTC(2026, 0, 15, 15, 30)))).toBe(10);
  });

  it('is null for an unknown or missing zone', () => {
    expect(machineHour(undefined, NOW)).toBeNull();
    expect(machineHour('Not/AZone', NOW)).toBeNull();
  });
});

describe('parseActiveHours', () => {
  it('keeps the agent heartbeat shape', () => {
    expect(parseActiveHours({ start: 8, end: 17, source: 'policy' })).toEqual(WORKDAY);
    expect(parseActiveHours({ start: 22, end: 6, source: 'user' })).toEqual(OVERNIGHT);
  });

  it('reads an unknown source as null rather than passing it through', () => {
    expect(parseActiveHours({ start: 8, end: 17, source: 'gpo' })).toEqual({ start: 8, end: 17, source: null });
    expect(parseActiveHours({ start: 8, end: 17 })).toEqual({ start: 8, end: 17, source: null });
  });

  it('drops a window the agent would never report', () => {
    expect(parseActiveHours(undefined)).toBeUndefined();
    expect(parseActiveHours(null)).toBeUndefined();
    expect(parseActiveHours('8-17')).toBeUndefined();
    expect(parseActiveHours({ start: 8, end: 8 })).toBeUndefined();
    expect(parseActiveHours({ start: -1, end: 17 })).toBeUndefined();
    expect(parseActiveHours({ start: 8, end: 24 })).toBeUndefined();
    expect(parseActiveHours({ start: 8.5, end: 17 })).toBeUndefined();
    expect(parseActiveHours({ start: '8', end: 17 })).toBeUndefined();
  });
});

describe('hasActiveHoursGuard', () => {
  it('is true only for the value the agent writes, 1', () => {
    expect(hasActiveHoursGuard({ capabilities: { activeHoursGuard: 1 }, agent_version: '4.1.21' })).toBe(true);
    for (const capabilities of [undefined, null, {}, { activeHoursGuard: 0 }, { activeHoursGuard: true }, { activeHoursGuard: '1' }]) {
      expect(hasActiveHoursGuard({ capabilities, agent_version: '4.1.21' })).toBe(false);
    }
  });

  it('needs an agent of 4.1.21 or later, since an older one never clears a stale capability', () => {
    const capabilities = { activeHoursGuard: 1 };
    for (const version of ['4.1.21', '4.1.22', '4.2.0', '5.0.0']) {
      expect(hasActiveHoursGuard({ capabilities, agent_version: version })).toBe(true);
    }
    // rolled back from 4.1.2x, the old agent keeps the 1 it never writes
    for (const version of ['3.3.7', '4.1.20', '4.1.21-beta']) {
      expect(hasActiveHoursGuard({ capabilities, agent_version: version })).toBe(false);
    }
  });

  it('is false when the version is missing or unreadable', () => {
    const capabilities = { activeHoursGuard: 1 };
    expect(hasActiveHoursGuard({ capabilities })).toBe(false);
    for (const version of [null, '', 'unknown', 'legacy', 4.1, {}]) {
      expect(hasActiveHoursGuard({ capabilities, agent_version: version })).toBe(false);
    }
  });
});

describe('activeHoursGuardOf', () => {
  const guarded = {
    osFamily: 'windows' as const,
    capabilities: { activeHoursGuard: 1 },
    agent_version: '4.1.21',
    activeHours: WORKDAY,
    machineTimezone: 'Europe/Berlin',
  };

  it('is the window and the machine zone on a guarded windows agent', () => {
    expect(activeHoursGuardOf(guarded)).toEqual({ window: WORKDAY, timezone: 'Europe/Berlin' });
  });

  it('reads an absent osFamily as windows, as every older agent is', () => {
    expect(activeHoursGuardOf({ ...guarded, osFamily: undefined })).not.toBeNull();
  });

  it('is null where the agent guards nothing', () => {
    // an agent that predates the guard ignores `when` and restarts at once
    expect(activeHoursGuardOf({ ...guarded, capabilities: {} })).toBeNull();
    expect(activeHoursGuardOf({ ...guarded, capabilities: undefined })).toBeNull();
    // a machine rolled back below 4.1.21 keeps the capability its old agent never clears
    expect(activeHoursGuardOf({ ...guarded, agent_version: '3.3.7' })).toBeNull();
    expect(activeHoursGuardOf({ ...guarded, agent_version: undefined })).toBeNull();
    expect(activeHoursGuardOf({ ...guarded, osFamily: 'macos' })).toBeNull();
    expect(activeHoursGuardOf({ ...guarded, osFamily: 'linux' })).toBeNull();
    // a failed read deletes the field, and the agent then holds nothing back
    expect(activeHoursGuardOf({ ...guarded, activeHours: undefined })).toBeNull();
  });

  it('keeps the window when the machine zone is unknown', () => {
    expect(activeHoursGuardOf({ ...guarded, machineTimezone: undefined })).toEqual({
      window: WORKDAY,
      timezone: undefined,
    });
  });
});

describe('insideActiveHoursNow', () => {
  it('answers on the machine clock', () => {
    // 09:00 in Berlin (CEST), 07:00 UTC
    const now = new Date(Date.UTC(2026, 6, 1, 7, 0));
    expect(insideActiveHoursNow({ window: WORKDAY, timezone: 'Europe/Berlin' }, now)).toBe(true);
    expect(insideActiveHoursNow({ window: WORKDAY, timezone: 'UTC' }, now)).toBe(false);
  });

  it('is null when the machine clock is unknown', () => {
    expect(insideActiveHoursNow({ window: WORKDAY, timezone: undefined })).toBeNull();
  });
});

describe('describeActiveHours', () => {
  it('reads the way the agent writes it', () => {
    expect(describeActiveHours(WORKDAY)).toBe('08:00–17:00');
    expect(describeActiveHours(OVERNIGHT)).toBe('22:00–06:00');
  });
});

describe('machineClockAt', () => {
  // 2026-07-01T21:30:00Z: 17:30 in New York (EDT), 06:30 the next day in Tokyo
  const AT = Date.UTC(2026, 6, 1, 21, 30) / 1000;

  it('reads the instant on the machine clock, the way the agent writes it', () => {
    expect(machineClockAt(AT, 'America/New_York')).toEqual({ time: '17:30', machineTime: true });
    expect(machineClockAt(AT, 'Asia/Tokyo')).toEqual({ time: '06:30', machineTime: true });
  });

  it('writes midnight as 00, never 24', () => {
    expect(machineClockAt(Date.UTC(2026, 6, 2, 0, 5) / 1000, 'UTC')).toEqual({ time: '00:05', machineTime: true });
  });

  it('reads in UTC, and says so, when the machine zone is missing or unknown', () => {
    expect(machineClockAt(AT, undefined)).toEqual({ time: '21:30', machineTime: false });
    expect(machineClockAt(AT, 'Not/AZone')).toEqual({ time: '21:30', machineTime: false });
  });
});

describe('parseActiveHoursRefusal', () => {
  it('reads the window and its end out of the agent refusal', () => {
    expect(
      parseActiveHoursRefusal(
        'Error: active_hours: inside active hours 08:00–17:00 (machine time); they end at 17:00',
      ),
    ).toEqual({ window: '08:00–17:00', endsAt: '17:00' });
  });

  it('is null for any other failure', () => {
    expect(parseActiveHoursRefusal('Error: reboot failed: access denied')).toBeNull();
    expect(parseActiveHoursRefusal('')).toBeNull();
  });
});

describe('describeCommandError', () => {
  it('puts the agent refusal in plain words', () => {
    expect(
      describeCommandError(
        'Error: active_hours: inside active hours 11:00–13:00 (machine time); they end at 13:00',
      ),
    ).toBe('refused: inside active hours 11:00–13:00 (machine time), they end at 13:00');
  });

  it('leaves out the end when the refusal names none', () => {
    expect(describeCommandError('Error: active_hours: inside active hours 22:00–06:00')).toBe(
      'refused: inside active hours 22:00–06:00 (machine time)',
    );
  });

  it('keeps any other failure as the agent wrote it', () => {
    expect(describeCommandError('install exited with code 1603')).toBe('install exited with code 1603');
    expect(describeCommandError('Error: reboot failed: access denied')).toBe('Error: reboot failed: access denied');
  });
});

describe('powerCommandParams', () => {
  it('sends the 60 second countdown the agent runs', () => {
    expect(powerCommandParams('restart')).toEqual({ delay_seconds: 60 });
    expect(powerCommandParams('shutdown')).toEqual({ delay_seconds: 60 });
  });

  it('sends a deferral as `when`, on a restart only', () => {
    expect(powerCommandParams('restart', { when: 'after_active_hours' })).toEqual({
      delay_seconds: 60,
      when: 'after_active_hours',
    });
    expect(powerCommandParams('shutdown', { when: 'after_active_hours' })).toEqual({ delay_seconds: 60 });
  });

  it('sends an override as active_hours_override with its reason', () => {
    expect(powerCommandParams('restart', { override: { reason: 'venue closed' } })).toEqual({
      delay_seconds: 60,
      active_hours_override: { reason: 'venue closed' },
    });
    expect(powerCommandParams('shutdown', { override: { reason: 'venue closed' } })).toEqual({
      delay_seconds: 60,
      active_hours_override: { reason: 'venue closed' },
    });
  });
});
