import { effectiveLaunchMode, effectiveSchedules } from '@/lib/processLaunch';
import type { ScheduleBlock } from '@/hooks/useFirestore';

const NIGHTS: ScheduleBlock[] = [{ days: ['mon'], ranges: [{ start: '18:00', stop: '23:00' }] }];
const MORNINGS: ScheduleBlock[] = [{ days: ['tue'], ranges: [{ start: '06:00', stop: '09:00' }] }];

describe('effectiveLaunchMode', () => {
  it.each([
    ['a toggle not yet confirmed', { autolaunch: false, launch_mode: 'off', _optimisticLaunchMode: 'scheduled' }, 'scheduled'],
    ['the stored mode', { autolaunch: true, launch_mode: 'off' }, 'off'],
    ['autolaunch on, from before launch modes', { autolaunch: true }, 'always'],
    ['autolaunch off, from before launch modes', { autolaunch: false }, 'off'],
  ] as const)('reads %s', (_, process, mode) => {
    expect(effectiveLaunchMode(process)).toBe(mode);
  });
});

describe('effectiveSchedules', () => {
  it('reads an unconfirmed schedule, then the stored one, then none', () => {
    expect(effectiveSchedules({ autolaunch: false, schedules: NIGHTS, _optimisticSchedules: MORNINGS })).toBe(MORNINGS);
    expect(effectiveSchedules({ autolaunch: false, schedules: NIGHTS })).toBe(NIGHTS);
    expect(effectiveSchedules({ autolaunch: false })).toBeNull();
  });
});
