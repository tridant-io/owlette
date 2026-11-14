import type { ScheduleBlock } from '@/hooks/useFirestore';

export interface SchedulePresetDefinition {
  name: string;
  description: string;
  blocks: ScheduleBlock[];
}

/** Color palette for schedule blocks — maximally distinct, never adjacent similar hues (globals.css --block-*) */
export const BLOCK_COLORS = [
  { pill: 'bg-block-1', pillText: 'text-block-1-foreground', bar: 'bg-block-1-bar', label: 'text-block-1-ink' },
  { pill: 'bg-block-2', pillText: 'text-block-2-foreground', bar: 'bg-block-2-bar', label: 'text-block-2-ink' },
  { pill: 'bg-block-3', pillText: 'text-block-3-foreground', bar: 'bg-block-3-bar', label: 'text-block-3-ink' },
  { pill: 'bg-block-4', pillText: 'text-block-4-foreground', bar: 'bg-block-4-bar', label: 'text-block-4-ink' },
  { pill: 'bg-block-5', pillText: 'text-block-5-foreground', bar: 'bg-block-5-bar', label: 'text-block-5-ink' },
  { pill: 'bg-block-6', pillText: 'text-block-6-foreground', bar: 'bg-block-6-bar', label: 'text-block-6-ink' },
  { pill: 'bg-block-7', pillText: 'text-block-7-foreground', bar: 'bg-block-7-bar', label: 'text-block-7-ink' },
  { pill: 'bg-block-8', pillText: 'text-block-8-foreground', bar: 'bg-block-8-bar', label: 'text-block-8-ink' },
] as const;

/** Ensure all blocks have unique colorIndex values assigned */
export function ensureBlockColors(blocks: ScheduleBlock[]): ScheduleBlock[] {
  const usedColors = new Set<number>();
  const result: ScheduleBlock[] = [];

  // First pass: collect already-assigned colors
  for (const block of blocks) {
    if (block.colorIndex != null) {
      usedColors.add(block.colorIndex);
    }
  }

  // Second pass: assign missing colors
  for (const block of blocks) {
    if (block.colorIndex != null) {
      result.push(block);
    } else {
      let nextColor = 0;
      while (usedColors.has(nextColor)) nextColor++;
      usedColors.add(nextColor);
      result.push({ ...block, colorIndex: nextColor });
    }
  }

  return result;
}

/** Default schedule applied when first activating "Scheduled" mode */
export const DEFAULT_SCHEDULE: ScheduleBlock[] = [
  { days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: [{ start: '09:00', stop: '17:00' }] },
];

/** Built-in preset definitions seeded into Firestore */
export const BUILT_IN_PRESETS: SchedulePresetDefinition[] = [
  {
    name: 'business hours',
    description: 'weekdays 9 am – 5 pm',
    blocks: [
      { days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: [{ start: '09:00', stop: '17:00' }] },
    ],
  },
  {
    name: 'extended hours',
    description: 'weekdays 7 am – 10 pm',
    blocks: [
      { days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: [{ start: '07:00', stop: '22:00' }] },
    ],
  },
  {
    name: 'weekday 24h',
    description: 'weekdays around the clock',
    blocks: [
      { days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: [{ start: '00:00', stop: '23:59' }] },
    ],
  },
  {
    name: '24/7',
    description: 'every day, all day',
    blocks: [
      { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], ranges: [{ start: '00:00', stop: '23:59' }] },
    ],
  },
];
