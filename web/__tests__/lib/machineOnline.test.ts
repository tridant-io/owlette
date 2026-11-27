import {
  isMachineOnline,
  machineOnlineState,
  OFFLINE_HEARTBEAT_AGE_SEC,
  parseFirestoreSeconds,
} from '@/lib/machineOnline';

const NOW_SEC = 1_790_000_000;
const DAY_SEC = 24 * 60 * 60;

/** a firestore Timestamp as either sdk hands it back: only `toMillis` is read. */
function timestamp(sec: number) {
  return { toMillis: () => sec * 1000 };
}

describe('isMachineOnline', () => {
  it('needs the flag and a heartbeat younger than the offline age', () => {
    expect(isMachineOnline(true, NOW_SEC - 30, NOW_SEC)).toBe(true);
    expect(isMachineOnline(true, NOW_SEC - OFFLINE_HEARTBEAT_AGE_SEC, NOW_SEC)).toBe(false);
    expect(isMachineOnline(false, NOW_SEC - 30, NOW_SEC)).toBe(false);
    expect(isMachineOnline('yes', NOW_SEC - 30, NOW_SEC)).toBe(false);
  });

  it('reads an absent heartbeat as offline', () => {
    expect(isMachineOnline(true, 0, NOW_SEC)).toBe(false);
  });
});

describe('parseFirestoreSeconds', () => {
  it('reads every shape a heartbeat arrives in as unix seconds', () => {
    expect(parseFirestoreSeconds(timestamp(NOW_SEC))).toBe(NOW_SEC);
    expect(parseFirestoreSeconds({ seconds: NOW_SEC, nanoseconds: 5 })).toBe(NOW_SEC);
    expect(parseFirestoreSeconds({ _seconds: NOW_SEC })).toBe(NOW_SEC);
    expect(parseFirestoreSeconds(NOW_SEC)).toBe(NOW_SEC);
    expect(parseFirestoreSeconds(new Date(NOW_SEC * 1000).toISOString())).toBe(NOW_SEC);
    expect(parseFirestoreSeconds(new Date(NOW_SEC * 1000))).toBe(NOW_SEC);
  });

  it('is 0 for an absent or unparseable value', () => {
    expect(parseFirestoreSeconds(undefined)).toBe(0);
    expect(parseFirestoreSeconds(null)).toBe(0);
    expect(parseFirestoreSeconds('not a date')).toBe(0);
    expect(parseFirestoreSeconds(Number.NaN)).toBe(0);
  });
});

describe('machineOnlineState', () => {
  it('is online with the flag and a fresh heartbeat', () => {
    expect(machineOnlineState({ online: true, lastHeartbeat: timestamp(NOW_SEC - 30) }, NOW_SEC)).toBe('online');
  });

  // the agent died without writing online: false, so the doc still says online
  it('is offline when the flag is stuck true and the heartbeat is 18 days old', () => {
    expect(machineOnlineState({ online: true, lastHeartbeat: timestamp(NOW_SEC - 18 * DAY_SEC) }, NOW_SEC)).toBe('offline');
  });

  it('is offline with the flag and no heartbeat', () => {
    expect(machineOnlineState({ online: true }, NOW_SEC)).toBe('offline');
  });

  it('is offline without the flag, however fresh the heartbeat', () => {
    expect(machineOnlineState({ online: false, lastHeartbeat: timestamp(NOW_SEC) }, NOW_SEC)).toBe('offline');
    expect(machineOnlineState({ lastHeartbeat: timestamp(NOW_SEC) }, NOW_SEC)).toBe('offline');
  });

  it('is asleep when the agent marked it asleep, before any heartbeat age', () => {
    expect(machineOnlineState({ online: true, asleep: true, lastHeartbeat: timestamp(NOW_SEC) }, NOW_SEC)).toBe('asleep');
    expect(machineOnlineState({ online: true, asleep: true, lastHeartbeat: timestamp(NOW_SEC - DAY_SEC) }, NOW_SEC)).toBe('asleep');
  });

  it('is offline, not asleep, once the agent has written online: false', () => {
    expect(machineOnlineState({ online: false, asleep: true, lastHeartbeat: timestamp(NOW_SEC) }, NOW_SEC)).toBe('offline');
  });
});
