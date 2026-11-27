'use client';

import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { MENU_SURFACE, SiteSwitcherList, siteFilterHostProps } from '@/components/SiteSwitcherList';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAuth } from '@/contexts/AuthContext';
import { useSiteMachineCounts } from '@/hooks/useSiteMachineCounts';
import { cn } from '@/lib/utils';

/**
 * a site field: the header switcher's list, with its filter past ten sites and
 * each site's machine count, behind a trigger that looks like a select.
 * owlette swoop's picker and the admin pages pick their site with it.
 * `className` sizes the trigger.
 */
export function SitePicker({
  sites,
  value,
  onChange,
  className,
  'data-testid': testId,
}: {
  sites: readonly { id: string; name: string }[];
  value: string;
  onChange: (siteId: string) => void;
  className?: string;
  'data-testid'?: string;
}) {
  const { machineScope } = useAuth();
  const [open, setOpen] = useState(false);
  const counts = useSiteMachineCounts(sites.map((s) => s.id), machineScope, open);
  const listId = useId();
  const name = sites.find((s) => s.id === value)?.name;

  return (
    // a popover, not a select, because a select cannot hold the site filter. modal, as the
    // select was, so a click outside closes the list and opens nothing under it
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* still a combobox: a screen reader hears the site beside the "site" label, which a
            button named "site" would hide, and down opens the list as it did */}
        <button
          type="button"
          role="combobox"
          data-testid={testId}
          aria-label="site"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowDown') return;
            e.preventDefault();
            setOpen(true);
          }}
          className={cn(
            'flex h-9 w-fit min-w-0 max-w-full items-center justify-between gap-2 whitespace-nowrap rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50',
            className,
          )}
        >
          <span className={cn('truncate', !name && 'text-muted-foreground')}>{name ?? 'select site'}</span>
          <ChevronDown aria-hidden className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        id={listId}
        align="start"
        aria-label="sites"
        className={cn(MENU_SURFACE, 'w-64 min-w-(--radix-popover-trigger-width) max-w-[calc(100vw-2rem)] p-0')}
        {...siteFilterHostProps}
      >
        <SiteSwitcherList
          surface="popover"
          sites={sites}
          currentSiteId={value}
          onPick={(next) => {
            setOpen(false);
            if (next !== value) onChange(next);
          }}
          counts={counts}
        />
      </PopoverContent>
    </Popover>
  );
}
