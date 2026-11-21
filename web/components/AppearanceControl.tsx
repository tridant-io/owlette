'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';
import { THEMES, type ThemeChoice } from '@/lib/theme';
import { useThemePreference } from '@/hooks/useThemePreference';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

const LABELS: Record<ThemeChoice, string> = { system: 'system', dark: 'dark', light: 'light' };

// the indicator slides first and the room changes after it lands: next-themes
// suspends transitions while it swaps the theme class, which would cut the slide
const SLIDE_MS = 180;
const APPLY_AFTER_MS = 200;

/**
 * one disc, three states. dark bites a crescent out of it, light lets it go
 * whole and blooms the rays, system shades half of it. every state is the same
 * shapes moved, so a change reads as the mark turning, not an icon swap.
 */
function AppearanceGlyph({ choice }: { choice: ThemeChoice }) {
  const maskId = useId();
  const bite = choice === 'dark' ? 'translate(0px, 0px)' : 'translate(9px, -9px)';
  const shade = choice === 'system' ? 'translateX(0px)' : 'translateX(12px)';
  const rays = choice === 'light';

  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" className="shrink-0 text-foreground">
      <defs>
        <mask id={maskId}>
          <rect width="24" height="24" fill="white" />
          <circle cx="16" cy="8" r="6" fill="black" className="appearance-glyph-part" style={{ transform: bite }} />
          <rect x="12" y="0" width="12" height="24" fill="black" className="appearance-glyph-part" style={{ transform: shade }} />
        </mask>
      </defs>
      <circle cx="12" cy="12" r="6" fill="currentColor" mask={`url(#${maskId})`} />
      <circle
        cx="12"
        cy="12"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        className="appearance-glyph-part"
        style={{ opacity: choice === 'system' ? 1 : 0 }}
      />
      <g
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        className="appearance-glyph-part"
        style={{ opacity: rays ? 1 : 0, transform: rays ? 'scale(1)' : 'scale(0.6)', transformOrigin: '12px 12px' }}
      >
        <line x1="12" y1="1.75" x2="12" y2="3.5" />
        <line x1="12" y1="20.5" x2="12" y2="22.25" />
        <line x1="1.75" y1="12" x2="3.5" y2="12" />
        <line x1="20.5" y1="12" x2="22.25" y2="12" />
        <line x1="4.75" y1="4.75" x2="6" y2="6" />
        <line x1="18" y1="18" x2="19.25" y2="19.25" />
        <line x1="4.75" y1="19.25" x2="6" y2="18" />
        <line x1="18" y1="6" x2="19.25" y2="4.75" />
      </g>
    </svg>
  );
}

/**
 * the appearance setting in a user's profile: follow the system, or pin dark or
 * light. it applies at once (no save) and follows the user to every device.
 */
export function AppearanceControl() {
  const { choice, resolved, setChoice } = useThemePreference();
  const reducedMotion = usePrefersReducedMotion(true);
  const labelId = useId();
  const helpId = useId();
  // the control moves at once and the theme follows a beat later (APPLY_AFTER_MS):
  // until then the pending choice is what the control shows
  const [pendingChoice, setPendingChoice] = useState<ThemeChoice | null>(null);
  const selected = pendingChoice ?? choice;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const radios = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const choose = (next: ThemeChoice) => {
    if (next === selected) return;
    setPendingChoice(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setChoice(next);
      setPendingChoice(null);
    }, reducedMotion ? 0 : APPLY_AFTER_MS);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    const index = THEMES.indexOf(selected);
    let target: number | null = null;
    if (step) target = (index + step + THEMES.length) % THEMES.length;
    if (event.key === 'Home') target = 0;
    if (event.key === 'End') target = THEMES.length - 1;
    if (target === null) return;
    event.preventDefault();
    choose(THEMES[target]);
    radios.current[target]?.focus();
  };

  const index = THEMES.indexOf(selected);

  return (
    <div className="space-y-2">
      <p id={labelId} className="text-sm leading-none font-medium text-foreground">appearance</p>
      <p id={helpId} className="text-xs text-muted-foreground">
        follows your system unless you pick one. changes apply at once and follow you to every device.
      </p>
      <div className="flex items-center gap-3 pt-1">
        <AppearanceGlyph choice={selected} />
        <div
          role="radiogroup"
          aria-labelledby={labelId}
          aria-describedby={helpId}
          onKeyDown={onKeyDown}
          className="relative grid grid-cols-3 rounded-md border border-border bg-background/50 p-0.5"
        >
          <span
            aria-hidden="true"
            className="absolute inset-y-0.5 left-0.5 w-[calc((100%-0.25rem)/3)] rounded-[calc(var(--radius)-3px)] bg-secondary shadow-xs ring-1 ring-border/70"
            style={{
              transform: `translateX(${index * 100}%)`,
              transition: reducedMotion ? 'none' : `transform ${SLIDE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
            }}
          />
          {THEMES.map((option, i) => (
            <button
              key={option}
              ref={(el) => { radios.current[i] = el; }}
              type="button"
              role="radio"
              aria-checked={selected === option}
              tabIndex={selected === option ? 0 : -1}
              onClick={() => choose(option)}
              className={cn(
                'relative z-[1] h-7 min-w-16 px-3 text-xs font-medium cursor-pointer transition-colors',
                selected === option ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {LABELS[option]}
            </button>
          ))}
        </div>
        {selected === 'system' && (
          <span className="text-xs text-muted-foreground tabular-nums">now {resolved}</span>
        )}
      </div>
    </div>
  );
}
