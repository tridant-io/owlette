'use client';

import { useState, useMemo, useRef, useCallback } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ChevronDown, Search, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getAllTimezones, getTimezoneOffset, COMMON_TIMEZONES, type TimezoneOption } from '@/lib/timeUtils';

interface TimezoneSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
}

const COMMON_TZ_SET = new Set<string>(COMMON_TIMEZONES.map((tz) => tz.value));

export function TimezoneSelect({ value, onValueChange, disabled, className, id }: TimezoneSelectProps) {
  const [open, setOpenRaw] = useState(false);
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset search + focus input when the popover opens. Handled in the
  // onOpenChange callback rather than an effect so we don't trip
  // react-hooks/set-state-in-effect.
  const setOpen = useCallback((next: boolean) => {
    setOpenRaw(next);
    if (next) {
      setSearch('');
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, []);

  const allTimezones = useMemo(() => getAllTimezones(), []);

  const displayLabel = useMemo(() => {
    if (!value) return 'select timezone';
    const common = COMMON_TIMEZONES.find((tz) => tz.value === value);
    if (common) return common.label;
    const { offsetLabel } = getTimezoneOffset(value);
    const city = value.includes('/') ? value.split('/').pop()!.replace(/_/g, ' ') : value;
    return `${city} (${offsetLabel})`;
  }, [value]);

  const filtered = useMemo(() => {
    if (!search.trim()) return null; // null = show grouped view
    const q = search.toLowerCase();
    return allTimezones.filter(
      (tz) =>
        tz.value.toLowerCase().includes(q) ||
        tz.label.toLowerCase().includes(q) ||
        tz.offsetLabel.toLowerCase().includes(q) ||
        tz.aliases?.some((a) => a.includes(q))
    );
  }, [search, allTimezones]);

  const grouped = useMemo(() => {
    if (filtered !== null) return null; // searching, no groups
    const groups: Record<string, TimezoneOption[]> = {};
    for (const tz of allTimezones) {
      if (COMMON_TZ_SET.has(tz.value)) continue; // skip, shown in pinned section
      if (!groups[tz.region]) groups[tz.region] = [];
      groups[tz.region].push(tz);
    }
    return groups;
  }, [filtered, allTimezones]);

  const commonOptions = useMemo(() => {
    return allTimezones.filter((tz) => COMMON_TZ_SET.has(tz.value));
  }, [allTimezones]);

  function handleSelect(tzValue: string) {
    onValueChange(tzValue);
    setOpen(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      // Select first visible result
      const items = filtered ?? commonOptions;
      if (items.length > 0) {
        handleSelect(items[0].value);
      }
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            'flex h-9 w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm whitespace-nowrap shadow-xs disabled:cursor-not-allowed disabled:opacity-50',
            'border-input dark:bg-input/30 dark:hover:bg-input/50 bg-transparent',
            className
          )}
        >
          <span className="truncate">{displayLabel}</span>
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] min-w-[280px] p-0 border-border dark:bg-secondary"
        align="start"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex items-center border-b border-border px-3 py-2">
          <Search className="mr-2 size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="search timezones..."
            aria-label="search timezones"
            className="flex-1 bg-transparent text-base md:text-sm text-foreground placeholder:text-muted-foreground"
          />
        </div>
        <div
          ref={listRef}
          className="max-h-[300px] overflow-y-auto p-1 [&::-webkit-scrollbar]:w-3 [&::-webkit-scrollbar-track]:bg-background [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-thumb]:rounded-md [&::-webkit-scrollbar-thumb:hover]:bg-accent"
        >
          {filtered !== null ? (
            // Search results (flat list)
            filtered.length === 0 ? (
              <div className="px-2 py-6 text-center text-sm text-muted-foreground">no timezones found</div>
            ) : (
              filtered.map((tz) => (
                <TimezoneItem key={tz.value} tz={tz} selected={value === tz.value} onSelect={handleSelect} />
              ))
            )
          ) : (
            // Grouped view with pinned common timezones
            <>
              <div className="px-2 py-1.5 text-xs text-muted-foreground font-medium">common</div>
              {commonOptions.map((tz) => (
                <TimezoneItem key={tz.value} tz={tz} selected={value === tz.value} onSelect={handleSelect} />
              ))}
              {grouped &&
                Object.keys(grouped)
                  .sort()
                  .map((region) => (
                    <div key={region}>
                      <div className="px-2 py-1.5 mt-1 text-xs text-muted-foreground font-medium">{region}</div>
                      {grouped[region].map((tz) => (
                        <TimezoneItem key={tz.value} tz={tz} selected={value === tz.value} onSelect={handleSelect} />
                      ))}
                    </div>
                  ))}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TimezoneItem({ tz, selected, onSelect }: { tz: TimezoneOption; selected: boolean; onSelect: (v: string) => void }) {
  const city = tz.value.includes('/') ? tz.value.split('/').pop()!.replace(/_/g, ' ') : tz.value;
  return (
    <button
      type="button"
      onClick={() => onSelect(tz.value)}
      // the check icon is aria-hidden, so the chosen zone needs its own state
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm cursor-pointer',
        'text-foreground hover:bg-muted focus-visible:outline-none focus-visible:bg-muted',
        selected && 'bg-muted'
      )}
    >
      <span className="flex items-center gap-2 truncate">
        {selected && <Check className="size-3.5 shrink-0" />}
        <span className={cn(!selected && 'ml-[22px]')}>{city}</span>
      </span>
      <span className="ml-2 shrink-0 text-xs text-muted-foreground">{tz.offsetLabel}</span>
    </button>
  );
}
