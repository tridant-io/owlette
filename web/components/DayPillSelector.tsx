'use client';

import { useEffect, useRef, useState } from 'react';

export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

const DAYS: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const FULL_NAMES: Record<DayKey, string> = {
  mon: 'monday',
  tue: 'tuesday',
  wed: 'wednesday',
  thu: 'thursday',
  fri: 'friday',
  sat: 'saturday',
  sun: 'sunday',
};
const SHORT_LABELS: Record<DayKey, string> = {
  mon: 'mon', tue: 'tue', wed: 'wed', thu: 'thu', fri: 'fri', sat: 'sat', sun: 'sun',
};
// Tue/Thu and Sat/Sun share initials; the title attribute disambiguates, as in
// ScheduleEditor's pill variant.
const SINGLE_LABELS: Record<DayKey, string> = {
  mon: 'M', tue: 'T', wed: 'W', thu: 'T', fri: 'F', sat: 'S', sun: 'S',
};

interface DayPillSelectorProps {
  value: string[];
  onChange: (days: string[]) => void;
  /**
   * 'rect' = three-letter labels in rounded rectangles (default — used in RestartScheduleDialog)
   * 'pill' = single-letter labels in circles (used in ScheduleEditor blocks)
   */
  variant?: 'rect' | 'pill';
  /** Tailwind classes applied when a day is active. Defaults to the primary (signal) style. */
  activeClassName?: string;
  /** Tailwind classes applied when a day is inactive. Has a sensible default. */
  inactiveClassName?: string;
  /** Smaller pills (used by ScheduleEditor's compact mode). */
  compact?: boolean;
  /** Disable click-drag (defaults to true on fine-pointer devices). */
  enableDragSelect?: boolean;
}

/**
 * Day-of-week toggle row for RestartScheduleDialog and ScheduleEditor.
 * Click-drag on desktop: mouseDown captures the mode, mouseEnter applies it
 * across pills, window mouseUp ends the drag.
 */
export default function DayPillSelector({
  value,
  onChange,
  variant = 'rect',
  activeClassName,
  inactiveClassName,
  compact = false,
  enableDragSelect = true,
}: DayPillSelectorProps) {
  // Drag-select state. dragModeRef avoids re-render churn during drag.
  const [isDragging, setIsDragging] = useState(false);
  const dragModeRef = useRef<'add' | 'remove' | null>(null);

  // Coarse pointers skip drag wiring. Lazy initializer avoids a
  // setState-in-effect sync; SSR-guarded, and fineness never changes at runtime.
  const [supportsDrag] = useState(
    () =>
      enableDragSelect &&
      typeof window !== 'undefined' &&
      window.matchMedia('(pointer: fine)').matches,
  );

  // End drag on any mouseup, even outside the component.
  useEffect(() => {
    if (!isDragging) return;
    const handleUp = () => {
      setIsDragging(false);
      dragModeRef.current = null;
    };
    window.addEventListener('mouseup', handleUp);
    return () => window.removeEventListener('mouseup', handleUp);
  }, [isDragging]);

  const setDay = (day: DayKey, mode: 'add' | 'remove') => {
    const has = value.includes(day);
    if (mode === 'add' && !has) onChange([...value, day]);
    else if (mode === 'remove' && has) onChange(value.filter((d) => d !== day));
  };

  const toggleDay = (day: DayKey) => {
    onChange(value.includes(day) ? value.filter((d) => d !== day) : [...value, day]);
  };

  const handleMouseDown = (day: DayKey, e: React.MouseEvent) => {
    if (!supportsDrag) {
      // Coarse pointer — onClick handles the toggle.
      return;
    }
    e.preventDefault(); // suppress focus + drag-select of text
    const wasSelected = value.includes(day);
    const mode: 'add' | 'remove' = wasSelected ? 'remove' : 'add';
    dragModeRef.current = mode;
    setIsDragging(true);
    setDay(day, mode);
  };

  const handleMouseEnter = (day: DayKey) => {
    if (!isDragging || !dragModeRef.current) return;
    setDay(day, dragModeRef.current);
  };

  // Coarse pointers and the keyboard toggle on click. A mouse click (detail > 0) on a
  // drag-capable device was already handled by mouseDown; Enter/Space click with detail 0.
  const handleClick = (day: DayKey, e: React.MouseEvent) => {
    if (supportsDrag && e.detail > 0) return;
    toggleDay(day);
  };

  const baseClasses =
    variant === 'pill'
      ? `${compact ? 'w-7 h-7 text-[10px]' : 'w-8 h-8 text-xs'} rounded-full font-medium transition-colors cursor-pointer flex items-center justify-center select-none`
      : `px-2.5 py-1 text-xs rounded-md border cursor-pointer transition-colors select-none`;

  const defaultActive =
    variant === 'pill'
      ? 'bg-primary text-primary-foreground'
      : 'bg-primary border-primary text-primary-foreground';
  const defaultInactive =
    variant === 'pill'
      ? 'bg-muted text-muted-foreground hover:bg-muted/80'
      : 'bg-secondary border-border text-muted-foreground hover:text-foreground';

  const activeCls = activeClassName ?? defaultActive;
  const inactiveCls = inactiveClassName ?? defaultInactive;
  const labels = variant === 'pill' ? SINGLE_LABELS : SHORT_LABELS;
  const gap = variant === 'pill' ? 'gap-1' : 'gap-1.5';

  return (
    <div className={`flex flex-wrap ${gap}`}>
      {DAYS.map((day) => {
        const isActive = value.includes(day);
        return (
          <button
            key={day}
            type="button"
            onMouseDown={(e) => handleMouseDown(day, e)}
            onMouseEnter={() => handleMouseEnter(day)}
            onClick={(e) => handleClick(day, e)}
            aria-label={FULL_NAMES[day]}
            aria-pressed={isActive}
            className={`${baseClasses} ${isActive ? activeCls : inactiveCls}`}
            title={FULL_NAMES[day]}
          >
            {labels[day]}
          </button>
        );
      })}
    </div>
  );
}
