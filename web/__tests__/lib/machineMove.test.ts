/**
 * The gate on moving a machine between sites, and the words a refusal uses.
 * The server refuses an agent that can't follow a move; the dialog disables
 * its button on the same rule.
 */
import {
  canFollowMove,
  MOVE_BUSY,
  MOVE_EXISTS,
  MOVE_OFFLINE,
  MOVE_TOO_OLD,
} from '@/lib/machineMove';
import { SITE_MOVE_MIN_AGENT_VERSION } from '@/lib/versionUtils';

describe('canFollowMove', () => {
  const capabilities = { siteMove: 1 };

  it('is true at exactly the minimum version', () => {
    expect(SITE_MOVE_MIN_AGENT_VERSION).toBe('4.2.3');
    expect(canFollowMove({ capabilities, agentVersion: '4.2.3' })).toBe(true);
  });

  it('is true on a newer agent', () => {
    for (const version of ['4.2.4', '4.3.0', '5.0.0']) {
      expect(canFollowMove({ capabilities, agentVersion: version })).toBe(true);
    }
  });

  it('is false on an older agent, even one that kept a stale flag after a rollback', () => {
    for (const version of ['4.2.2', '4.1.23', '3.3.7', '4.2.3-beta']) {
      expect(canFollowMove({ capabilities, agentVersion: version })).toBe(false);
    }
  });

  it('is false without the flag, or with any value but the 1 the agent writes', () => {
    for (const caps of [undefined, null, {}, { siteMove: 0 }, { siteMove: true }, { siteMove: '1' }]) {
      expect(canFollowMove({ capabilities: caps, agentVersion: '4.2.3' })).toBe(false);
    }
  });

  it('is false when the version is missing or unreadable', () => {
    expect(canFollowMove({ capabilities })).toBe(false);
    for (const version of [null, '', 'unknown', 'legacy']) {
      expect(canFollowMove({ capabilities, agentVersion: version })).toBe(false);
    }
  });
});

describe('move copy', () => {
  it('says what to do about an agent too old to move', () => {
    expect(MOVE_TOO_OLD('kiosk-01', '4.1.23', '4.2.3')).toBe(
      'kiosk-01 runs owlette 4.1.23. moving it needs 4.2.3 or later: update it first, or leave and join from the machine.',
    );
  });

  it('names the machine already on the target', () => {
    expect(MOVE_EXISTS('lobby', 'kiosk-01')).toBe(
      'lobby already has a machine named kiosk-01. remove it there first.',
    );
  });

  it('says a busy machine can move once it finishes', () => {
    expect(MOVE_BUSY('kiosk-01')).toBe('kiosk-01 is installing or syncing. try again when it finishes.');
  });

  it('says an offline machine follows when it returns, for up to 7 days', () => {
    expect(MOVE_OFFLINE('kiosk-01')).toBe(
      'kiosk-01 is offline. the move waits until it comes back, for up to 7 days.',
    );
  });
});
