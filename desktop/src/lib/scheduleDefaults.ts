/**
 * Schedule palette and default windows, ported from `web/lib/scheduleDefaults.ts`.
 *
 * `BUILT_IN_PRESETS` and `ensureBlockColors` deliberately did NOT come across:
 * presets live in Firestore and this app only sees `config.json`. It ports the
 * process-dialog composition instead, which has no preset bar and never stamps
 * a colour onto a block it didn't create.
 */

import type { ScheduleBlock } from '@/lib/owletteConfig'

/** Schedule-block palette — maximally distinct, no adjacent similar hues. */
export const BLOCK_COLORS = [
  { pill: 'bg-block-1', pillText: 'text-block-1-foreground', bar: 'bg-block-1-bar', label: 'text-block-1-ink' },
  { pill: 'bg-block-2', pillText: 'text-block-2-foreground', bar: 'bg-block-2-bar', label: 'text-block-2-ink' },
  { pill: 'bg-block-3', pillText: 'text-block-3-foreground', bar: 'bg-block-3-bar', label: 'text-block-3-ink' },
  { pill: 'bg-block-4', pillText: 'text-block-4-foreground', bar: 'bg-block-4-bar', label: 'text-block-4-ink' },
  { pill: 'bg-block-5', pillText: 'text-block-5-foreground', bar: 'bg-block-5-bar', label: 'text-block-5-ink' },
  { pill: 'bg-block-6', pillText: 'text-block-6-foreground', bar: 'bg-block-6-bar', label: 'text-block-6-ink' },
  { pill: 'bg-block-7', pillText: 'text-block-7-foreground', bar: 'bg-block-7-bar', label: 'text-block-7-ink' },
  { pill: 'bg-block-8', pillText: 'text-block-8-foreground', bar: 'bg-block-8-bar', label: 'text-block-8-ink' },
] as const

/**
 * Default schedule for an entry with no windows of its own.
 *
 * Safe to pass straight to the blocks editor as a seed: every edit there copies
 * the array and the touched block, so this constant is never mutated.
 */
export const DEFAULT_SCHEDULE: ScheduleBlock[] = [
  { days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: [{ start: '09:00', stop: '17:00' }] },
]
