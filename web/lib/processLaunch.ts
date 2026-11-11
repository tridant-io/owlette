import type { LaunchMode, Process, ScheduleBlock } from '@/hooks/useFirestore';

type LaunchFields = Pick<
  Process,
  'autolaunch' | 'launch_mode' | 'schedules' | '_optimisticLaunchMode' | '_optimisticSchedules'
>;

/**
 * The launch mode a process shows: a toggle the config doc has not confirmed
 * yet, then the stored mode, then `autolaunch` from before launch modes existed.
 */
export function effectiveLaunchMode(process: LaunchFields): LaunchMode {
  return process._optimisticLaunchMode ?? process.launch_mode ?? (process.autolaunch ? 'always' : 'off');
}

/** The schedule that goes with it, by the same rule. */
export function effectiveSchedules(process: LaunchFields): ScheduleBlock[] | null {
  return process._optimisticSchedules ?? process.schedules ?? null;
}
