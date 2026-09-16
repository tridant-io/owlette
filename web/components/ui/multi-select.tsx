'use client';

import { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export interface MultiSelectGroup {
  /** Section heading, or `null` for options that need none. */
  group: string | null;
  options: { value: string; label: string }[];
}

/**
 * Checkbox filter over a long, grouped catalogue: searchable, with select-all
 * and none.
 *
 * EMPTY MEANS ALL. A filter nobody has touched should not have to enumerate
 * every option to mean "don't narrow anything", and the caller can pass an empty
 * selection straight through as "no where clause". It also keeps reset trivial.
 *
 * A Popover rather than a Select or DropdownMenu: Radix's Select closes on pick
 * (wrong for multi-select) and both hijack typing for their own typeahead, which
 * a search field inside them would fight for every keystroke.
 */
export function MultiSelect({
  groups,
  selected,
  onChange,
  allLabel,
  itemNoun,
  searchPlaceholder = 'search…',
  'data-testid': testId,
}: {
  groups: MultiSelectGroup[];
  /** Selected values. Empty means every option — see above. */
  selected: string[];
  onChange: (next: string[]) => void;
  /** Trigger text when nothing is selected, e.g. "all actions". */
  allLabel: string;
  /** Plural noun for the count, e.g. "actions" in "3 actions". */
  itemNoun: string;
  searchPlaceholder?: string;
  'data-testid'?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const allOptions = useMemo(() => groups.flatMap((g) => g.options), [groups]);

  const visibleGroups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return groups;
    return groups
      .map((g) => ({
        ...g,
        // Match the value too: someone who knows the wire name ("process_crash")
        // should not have to guess the display label.
        options: g.options.filter(
          (o) =>
            o.label.toLowerCase().includes(needle) || o.value.toLowerCase().includes(needle),
        ),
      }))
      .filter((g) => g.options.length > 0);
  }, [groups, search]);

  const visibleValues = useMemo(
    () => visibleGroups.flatMap((g) => g.options.map((o) => o.value)),
    [visibleGroups],
  );

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const triggerLabel =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? (allOptions.find((o) => o.value === selected[0])?.label ?? selected[0])
        : `${selected.length} ${itemNoun}`;

  const toggle = (value: string) => {
    onChange(
      selectedSet.has(value) ? selected.filter((v) => v !== value) : [...selected, value],
    );
  };

  // Acts on what is VISIBLE, so with a search active it means "all matches" —
  // the spreadsheet-filter convention, and the only reading that makes the
  // search field useful for bulk selection.
  const selectVisible = () => {
    const next = [...selected];
    for (const value of visibleValues) if (!selectedSet.has(value)) next.push(value);
    onChange(next);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch('');
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          // Not `role="combobox"`: this opens a panel of checkboxes, not a list
          // of options, and that role obliges `aria-controls` + listbox children.
          aria-haspopup="dialog"
          aria-expanded={open}
          data-testid={testId}
          className="w-full justify-between bg-muted border-border font-normal"
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown className="h-4 w-4 opacity-50 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-56 p-0">
        <div className="border-b border-border p-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            data-testid={testId ? `${testId}-search` : undefined}
            className="h-8"
          />
          <div className="mt-2 flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={selectVisible}
              disabled={visibleValues.length === 0}
              data-testid={testId ? `${testId}-select-all` : undefined}
              className="h-7 px-2 text-xs"
            >
              {search.trim() ? 'select matches' : 'select all'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange([])}
              disabled={selected.length === 0}
              data-testid={testId ? `${testId}-select-none` : undefined}
              className="h-7 px-2 text-xs"
            >
              none
            </Button>
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {selected.length === 0 ? allLabel : `${selected.length} selected`}
            </span>
          </div>
        </div>

        <div className="max-h-64 overflow-y-auto p-1">
          {visibleGroups.length === 0 ? (
            <p className="px-2 py-3 text-center text-sm text-muted-foreground">no matches</p>
          ) : (
            visibleGroups.map((group) => (
              <div key={group.group ?? '_'} className="py-1">
                {group.group && (
                  <p className="px-2 py-1 text-xs text-muted-foreground">{group.group}</p>
                )}
                {group.options.map((option) => (
                  <label
                    key={option.value}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm',
                      'hover:bg-accent/50',
                    )}
                  >
                    <Checkbox
                      checked={selectedSet.has(option.value)}
                      onCheckedChange={() => toggle(option.value)}
                    />
                    <span className="truncate">{option.label}</span>
                  </label>
                ))}
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
