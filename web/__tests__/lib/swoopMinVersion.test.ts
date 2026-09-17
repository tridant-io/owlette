/**
 * @jest-environment node
 */

/**
 * `SWOOP_MIN_AGENT_VERSION` (web/lib/versionUtils.ts) is advisory COPY only —
 * the authorization gate is the machine's `capabilities.swoop == 1` heartbeat
 * key, never this string. These assertions pin the two things a copy constant
 * can still get wrong: an unparseable value (which turns every comparison into
 * `null`, and a `=== -1` advisory check into silence) and a value copied from
 * the site-time constant beside it.
 */

import {
  SWOOP_MIN_AGENT_VERSION,
  SITE_TIME_MIN_AGENT_VERSION,
  compareVersions,
  isValidVersion,
} from '@/lib/versionUtils';

describe('SWOOP_MIN_AGENT_VERSION', () => {
  it('is a parseable release version, not a prerelease', () => {
    expect(isValidVersion(SWOOP_MIN_AGENT_VERSION)).toBe(true);
    expect(SWOOP_MIN_AGENT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is newer than the site-time floor beside it', () => {
    // swoop ships long after site-time schedules; an equal value would mean the
    // constant was copied rather than set.
    expect(compareVersions(SWOOP_MIN_AGENT_VERSION, SITE_TIME_MIN_AGENT_VERSION)).toBe(1);
  });

  it('sorts older and newer agents the way the advisory copy reads them', () => {
    // `compareVersions(agent, MIN) === -1` is the shape every existing advisory
    // uses (lib/scheduleClockCopy.ts, components/ScheduleEditor.tsx).
    expect(compareVersions('3.3.5', SWOOP_MIN_AGENT_VERSION)).toBe(-1);
    expect(compareVersions(SWOOP_MIN_AGENT_VERSION, SWOOP_MIN_AGENT_VERSION)).toBe(0);
    expect(compareVersions('99.0.0', SWOOP_MIN_AGENT_VERSION)).toBe(1);
  });

  it('reads an unknown agent version as unknown, never as below the floor', () => {
    // A machine that has never reported a version must not be advised against;
    // `null` is the honest answer and the advisory checks compare against -1.
    expect(compareVersions(undefined, SWOOP_MIN_AGENT_VERSION)).toBeNull();
    expect(compareVersions('', SWOOP_MIN_AGENT_VERSION)).toBeNull();
  });
});
